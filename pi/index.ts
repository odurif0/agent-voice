import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { matchesKey } from '@earendil-works/pi-tui';
import { Type } from '@sinclair/typebox';
import { readFileSync } from 'node:fs';
import { paths } from '../src/paths.mjs';
import { ensureSettings, readSettings, CATALOG } from '../src/models.mjs';
import { Dictation, transcribePcm } from '../src/dictation.mjs';
import { microphones } from '../src/audio.mjs';
import { decodeFile } from '../src/file-audio.mjs';
import { cleanTranscript } from '../src/terminal-input.mjs';
import { statusText } from '../src/terminal.mjs';

export default function (pi: ExtensionAPI) {
  let shortcut = 'ctrl+alt+z';
  try { shortcut = JSON.parse(readFileSync(paths().config, 'utf8')).shortcut || shortcut; } catch { /* First use. */ }
  let dictation: Dictation | undefined;
  let initializing = false;
  let cancelInit: AbortController | undefined;
  let unsubscribe: (() => void) | undefined;
  let context: ExtensionContext | undefined;
  let lastMeter = 0;

  const clear = () => { unsubscribe?.(); unsubscribe = undefined; context?.ui.setStatus('agent-voice', undefined); };
  async function cancel() { cancelInit?.abort(); await dictation?.cancel(); clear(); }
  async function settings(ctx: ExtensionContext, overrides = {}) {
    return ensureSettings({ ...overrides,
      confirmDownload: (model) => ctx.ui.confirm('Local dictation', `Download ${model.name} (${Math.ceil(model.size / 1048576)} MiB)?`),
      onStatus: (text) => ctx.ui.setStatus('agent-voice', text),
    });
  }
  async function toggle(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (dictation && ['starting', 'listening'].includes(dictation.state)) { await dictation.stop(); clear(); return; }
    if (initializing || (dictation && ['transcribing', 'cancelling'].includes(dictation.state))) return;
    initializing = true; context = ctx; cancelInit = new AbortController();
    try {
      const configured = await settings(ctx, { signal: cancelInit.signal });
      if (cancelInit.signal.aborted) return;
      await dictation?.dispose();
      dictation = new Dictation(configured, {
        onState(state, detail) {
          if (state === 'result') {
            const text = cleanTranscript(detail.text);
            if (text) ctx.ui.pasteToEditor(text);
            else ctx.ui.notify('No speech recognized.', 'warning');
          } else if (state === 'error') { clear(); ctx.ui.notify(detail.message || String(detail), 'error'); }
          else if (state === 'idle') clear();
          else ctx.ui.setStatus('agent-voice', statusText(state, shortcut, detail));
        },
        onLevel(level, seconds) {
          if (Date.now() - lastMeter < 120) return;
          lastMeter = Date.now();
          ctx.ui.setStatus('agent-voice', statusText('listening', shortcut, `${seconds.toFixed(0)} s [${'='.repeat(Math.round(level * 8)).padEnd(8, ' ')}]`));
        },
      });
      unsubscribe?.();
      unsubscribe = ctx.ui.onTerminalInput(data => {
        if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) { void cancel(); return { consume: true }; }
        if (matchesKey(data, shortcut)) { void toggle(ctx); return { consume: true }; }
        // Freeze editor/cursor while recording or transcribing: never submit on a stray Enter.
        return { consume: true };
      });
      await dictation.start();
    } catch (error) {
      clear(); if (!cancelInit.signal.aborted) ctx.ui.notify(error.message || String(error), 'error');
    } finally { initializing = false; cancelInit = undefined; }
  }

  pi.registerShortcut(shortcut, { description: 'Dictate with the shared voice engine', handler: toggle });
  pi.registerCommand('voice', {
    description: 'Local dictation: start or configure shared resources',
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      if (args.trim() === 'start') { await toggle(ctx); return; }
      if (dictation && !['idle', 'error'].includes(dictation.state)) { await toggle(ctx); return; }
      const choice = await ctx.ui.select('Voice — settings shared with Forge', ['Dictate', 'Language', 'Microphone', 'Model', 'Shortcut']);
      if (!choice) return;
      if (choice === 'Dictate') { await toggle(ctx); return; }
      try {
        if (choice === 'Language') {
          const language = await ctx.ui.input('Language: auto, en, fr…', (await readSettings())?.language || 'auto');
          if (language) await settings(ctx, { language });
        } else if (choice === 'Model') {
          const labels = CATALOG.map(model => `${model.id} (${Math.ceil(model.size / 1048576)} MiB)`);
          const selected = await ctx.ui.select('Local model', labels);
          if (selected) await settings(ctx, { model: CATALOG[labels.indexOf(selected)].id });
        } else if (choice === 'Microphone') {
          const names = await microphones();
          const labels = ['Default microphone', ...names.map((name, i) => `${i} : ${name}`)];
          const selected = await ctx.ui.select('Microphone', labels);
          if (selected) {
            const i = labels.indexOf(selected) - 1;
            await settings(ctx, { microphone: i < 0 ? { type: 'system-default' } : { type: 'device', name: names[i], occurrence: names.slice(0, i).filter(name => name === names[i]).length } });
          }
        } else if (choice === 'Shortcut') {
          const selected = await ctx.ui.select('Shared shortcut', ['ctrl+alt+z', 'f2']);
          if (selected) { await settings(ctx, { shortcut: selected }); ctx.ui.notify('Setting saved. Use /reload to apply the shortcut in Pi.', 'info'); }
        }
      } catch (error) { ctx.ui.notify(error.message || String(error), 'error'); }
      finally { ctx.ui.setStatus('agent-voice', undefined); }
    },
  });

  pi.registerTool({
    name: 'transcribe_file', label: 'Local transcription',
    description: 'Transcribe a local audio/video file with the shared voice engine (10 minutes maximum, FFmpeg required).',
    parameters: Type.Object({ path: Type.String({ description: 'Audio/video file path' }) }),
    async execute(_id, params, signal) {
      const configured = await readSettings();
      if (!configured) throw new Error('Configure dictation with /voice before transcribing a file.');
      const text = await transcribePcm(configured, await decodeFile(params.path, { signal }), { signal });
      return { content: [{ type: 'text', text }], details: {} };
    },
  });

  pi.on('session_start', async (_event, ctx) => { context = ctx; });
  pi.on('session_switch', async () => { await cancel(); });
  pi.on('session_shutdown', async () => { cancelInit?.abort(); await dictation?.dispose(); clear(); });
}
