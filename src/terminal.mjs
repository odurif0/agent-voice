import { loadComponent } from './components.mjs';
import { Dictation } from './dictation.mjs';
import { InputRouter, PasteReadiness, pastedTranscript, cleanTranscript, fitStatus } from './terminal-input.mjs';

export function statusText(state, shortcut, detail, enterStops = false) {
  const key = shortcut === 'f2' ? 'F2' : 'Ctrl+Alt+Z';
  if (state === 'starting') return 'Voice: opening microphone… · Esc: cancel';
  if (state === 'listening') return `● Recording ${detail || ''} · ${enterStops ? 'Enter or ' : ''}${key}: stop · Esc: cancel`;
  if (state === 'transcribing') return 'Voice: transcribing locally… · Esc: cancel';
  if (state === 'cancelling') return 'Voice: cancelling…';
  if (state === 'error') return `Voice: ${cleanTranscript(detail?.message || detail || 'error')}`;
  return `Voice: ${key} to dictate · Enter to submit`;
}

export async function runTerminal(command, args, settings, options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  if (!input.isTTY || !output.isTTY) throw new Error('Dictation requires an interactive terminal.');
  const pty = options.pty || await loadComponent('terminal', options);
  const readiness = new PasteReadiness();
  let child, router, ending = false, suspended = false, finish, stickyStatus = false;
  let status = statusText('idle', settings.shortcut);
  let rows = Math.max(3, output.rows || 24), cols = Math.max(10, output.columns || 80);
  let lastMeter = 0;
  const wasRaw = Boolean(input.isRaw);
  const save = '\x1b7', restore = '\x1b8';
  const draw = () => {
    if (!ending && !suspended && readiness.safeToDraw) output.write(`${save}\x1b[${rows};1H\x1b[2K\x1b[0;2m${fitStatus(status, cols - 1)}\x1b[0m${restore}`);
  };
  let marginsPending = false;
  const margins = () => {
    if (!readiness.safeToDraw) { marginsPending = true; return; }
    marginsPending = false;
    output.write(`${save}\x1b[1;${rows - 1}r${restore}`); draw();
  };
  const busy = () => ['starting', 'listening', 'transcribing', 'cancelling'].includes(dictation.state);
  const dictation = (options.createDictation || ((s, o) => new Dictation(s, o)))(settings, {
    ...options,
    onState(state, detail) {
      if (ending) return;
      if (state === 'result') {
        if (readiness.enabled) {
          const text = cleanTranscript(detail.text);
          if (text) child.write(pastedTranscript(text));
          else { stickyStatus = true; status = 'Voice: no speech recognized.'; draw(); }
        } else { stickyStatus = true; status = 'Voice: editor closed; dictation not inserted.'; draw(); }
        return;
      }
      // Keep errors visible until the next action instead of immediately clearing them.
      if (state === 'idle' && stickyStatus) return;
      stickyStatus = state === 'error';
      status = statusText(state, settings.shortcut, detail, true); draw();
    },
    onLevel(level, seconds) {
      if (Date.now() - lastMeter < 120) return;
      lastMeter = Date.now();
      status = statusText('listening', settings.shortcut, `${seconds.toFixed(0)} s [${'='.repeat(Math.round(level * 8)).padEnd(8, ' ')}]`, true); draw();
    },
  });
  const resize = () => {
    rows = Math.max(3, output.rows || 24); cols = Math.max(10, output.columns || 80);
    child.resize(cols, rows - 1); margins();
  };
  const onInput = data => router.feed(data);
  const resetTerminal = () => {
    input.setRawMode(wasRaw); input.pause();
    output.write(`\x18${save}\x1b[r\x1b[${rows};1H\x1b[2K\x1b[0m${restore}`);
  };
  const suspend = async () => {
    if (process.platform === 'win32' || ending || suspended) return;
    suspended = true;
    await dictation.cancel();
    if (ending) return;
    resetTerminal();
    child.kill('SIGSTOP');
    process.kill(process.pid, 'SIGSTOP');
  };
  const resume = () => {
    if (!suspended || ending) return;
    suspended = false; child.kill('SIGCONT');
    input.setRawMode(true); input.resume(); resize();
    // The shell moved the physical cursor while our child PTY was suspended.
    // Rustyline's ClearScreen binding redraws its existing buffer, without submission.
    if (readiness.enabled) child.write('\x0c');
  };
  const signals = {
    SIGTERM: () => terminate(143), SIGHUP: () => terminate(129), SIGINT: () => terminate(130),
    ...(process.platform === 'win32' ? {} : { SIGTSTP: () => { void suspend(); }, SIGCONT: resume }),
  };
  const drained = () => { if (!ending) child?.resume(); };
  const cleanup = async code => {
    if (ending) return;
    ending = true;
    router?.dispose();
    input.off('data', onInput); input.off('end', endInput);
    output.off('resize', resize); output.off('drain', drained);
    for (const [signal, handler] of Object.entries(signals)) process.off(signal, handler);
    try { await dictation.dispose(); } finally { resetTerminal(); finish?.(code); }
  };
  const terminate = code => {
    if (suspended) child?.kill('SIGCONT');
    child?.kill(); void cleanup(code);
  };
  const endInput = () => terminate(0);
  try {
    child = pty.spawn(command, args, {
      name: process.env.TERM || 'xterm-256color', cols, rows: rows - 1,
      cwd: process.cwd(), env: { ...process.env, AGENT_VOICE_ACTIVE: '1' },
    });
    router = new InputRouter({
      shortcut: settings.shortcut,
      onData(data) {
        if (data === '\x1a') { void suspend(); return; }
        if (!busy() && !suspended) child.write(data);
      },
      onEnter(key) {
        if (suspended || ending) return;
        if (!busy()) child.write(key);
        else if (['starting', 'listening'].includes(dictation.state)) void dictation.stop();
        // During transcription/cancellation, never queue an Enter for the agent.
      },
      onToggle() {
        if (suspended || ending) return;
        if (!busy() && !readiness.enabled) { status = 'Voice: wait for the agent prompt.'; draw(); return; }
        void dictation.toggle();
      },
      onCancel(key) { if (busy()) void dictation.cancel(); else child.write(key); },
    });
    const done = new Promise(resolve => { finish = resolve; });
    child.onData(data => {
      const wasReady = readiness.enabled;
      readiness.feed(data);
      if (wasReady && !readiness.enabled && busy()) void dictation.cancel();
      if (!output.write(data)) child.pause();
      if (marginsPending) margins();
      else draw();
    });
    child.onExit(({ exitCode, signal }) => { void cleanup(signal ? 128 + signal : exitCode); });
    input.setRawMode(true); input.resume(); input.on('data', onInput);
    input.on('end', endInput); output.on('resize', resize); output.on('drain', drained);
    for (const [signal, handler] of Object.entries(signals)) process.on(signal, handler);
    margins();
    return await done;
  } catch (error) {
    child?.kill(); await cleanup(1); throw error;
  }
}
