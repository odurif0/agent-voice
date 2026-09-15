// Opt-in Linux integration test. Real PvRecorder → Parakeet → unmodified Forge/Pi.
// Creates a private virtual microphone. Never changes the system default or submits a prompt.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import xterm from '@xterm/headless';
import espeak from '@echogarden/espeak-ng-emscripten';
import { checkJobControl } from './job-control.mjs';
import { checkZsh } from './zsh-native.mjs';
import { paths } from '../src/paths.mjs';
import { readSettings } from '../src/models.mjs';
import { ensureComponent, loadComponent } from '../src/components.mjs';
import { prepare } from '../src/cli.mjs';
import { readJson, writeJson } from '../src/storage.mjs';
import { installPi, PACKAGE_ROOT } from '../src/install-pi.mjs';

const packageRoot = process.env.AGENT_VOICE_TEST_PACKAGE_ROOT || PACKAGE_ROOT;
const phrase = 'I would like to check that dictation works correctly in English.';
const root = await mkdtemp(join(tmpdir(), 'agent-voice-native-'));
const env = { ...process.env, AGENT_VOICE_HOME: join(root, 'shared'), PI_CODING_AGENT_DIR: join(root, 'pi'), PI_OFFLINE: '1', TERM: 'xterm-256color' };
delete env.AGENT_VOICE_ACTIVE;
const p = paths(env);
let moduleId, active;
try {
  const existing = await readSettings();
  if (!existing) throw new Error('Prepare a local model with agent-voice setup before running this test.');
  console.log('Artifacts:', root);
  console.log('Standalone installation with no Pi directory…');
  const settings = await prepare({ locations: p, model: existing.model.path, terminal: true, confirmDownload: async () => false });
  const before = await readJson(p.registry);
  const pty = await loadComponent('terminal', { locations: p });
  const recorder = await loadComponent('microphone', { locations: p });

  const synthModule = await espeak();
  const synth = new synthModule.eSpeakNGWorker();
  synth.set_voice('', 'en'); synth.set_rate(145);
  const chunks = [];
  synth.synthesize(phrase, audio => { chunks.push(Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength)); return false; });
  const pcm = Buffer.concat(chunks), header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(synth.samplerate, 24); header.writeUInt32LE(synth.samplerate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  const audioPath = join(root, 'synthetic-english.wav');
  await writeFile(audioPath, Buffer.concat([header, pcm])); synthModule.destroy(synth);
  const sink = `agent_voice_test_${process.pid}`;
  moduleId = execFileSync('pactl', ['load-module', 'module-null-sink', `sink_name=${sink}`, 'sink_properties=device.description=AgentVoiceTest', 'rate=16000', 'channels=1'], { encoding: 'utf8' }).trim();
  await sleep(300);
  const microphone = recorder.PvRecorder.getAvailableDevices().find(name => name.includes('AgentVoiceTest'));
  assert.ok(microphone, 'private virtual microphone is visible to PvRecorder');
  await writeJson(p.config, { ...settings, microphone: { type: 'device', name: microphone, occurrence: 0 } });

  async function play() {
    await new Promise((resolve, reject) => {
      const child = spawn('paplay', ['--device', sink, audioPath], { stdio: 'ignore' });
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`paplay ${code}`)));
    });
  }

  async function exercise(name, executable, args, stopKey = '\x1b\x1a') {
    const terminal = new xterm.Terminal({ cols: 100, rows: 30, allowProposedApi: true, scrollback: 2000 });
    const child = pty.spawn(executable, args, { name: 'xterm-256color', cols: 100, rows: 30, cwd: root, env });
    active = child;
    let raw = '', exited = false;
    terminal.onData(data => { if (!exited) child.write(data); });
    child.onData(data => { raw += data; terminal.write(data); });
    child.onExit(() => { exited = true; });
    const screen = () => Array.from({ length: terminal.rows }, (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + i)?.translateToString(true) || '').join('\n');
    const save = async label => {
      await sleep(100);
      await writeFile(join(root, `${name}-${label}.txt`), screen());
      await writeFile(join(root, `${name}.raw`), raw);
    };
    const wait = async (predicate, label, timeout = 25_000) => {
      const start = Date.now();
      while (!predicate()) {
        if (exited || Date.now() - start > timeout) { await save('FAILED'); throw new Error(`${name}: ${label}\n${screen()}`); }
        await sleep(80);
      }
    };
    try {
      await wait(() => raw.includes('\x1b[?2004h'), 'editor ready');
      await sleep(800);
      child.write('BEFORE  AFTER' + '\x1b[D'.repeat(6));
      await sleep(200);
      child.write('\x1b\x1a');
      await wait(() => screen().includes('● Recording'), 'microphone recording');
      await save('recording');
      if (stopKey === '\r\n') assert.ok(screen().includes('Enter or Ctrl+Alt+Z: stop'));
      await play(); await sleep(200); child.write(stopKey);
      await wait(() => screen().replaceAll('\n', '').includes(`BEFORE ${phrase} AFTER`), 'exact speech at cursor with surrounding text intact');
      // Prove this is still the editable prompt, not a submitted message in scrollback.
      child.write('!'); const expected = `BEFORE ${phrase}! AFTER`;
      await wait(() => screen().replaceAll('\n', '').includes(expected), 'prompt still editable at the insertion cursor');
      await save('transcribed');
      // A cancelled second take must not insert text or discard the existing prompt.
      child.write('\x1b\x1a'); await wait(() => screen().includes('● Recording'), 'second capture');
      child.write('\x1b'); await sleep(500);
      assert.ok(screen().replaceAll('\n', '').includes(expected), `${name}: cancellation preserves prompt`);
      await save('cancelled');
      terminal.resize(70, 24); child.resize(70, 24); await sleep(500);
      await save('resized');
      const all = screen().replaceAll('\n', '');
      assert.ok(all.includes('BEFORE') && all.includes('dictation works') && all.includes('AFTER'), `${name}: resize preserves text`);
      console.log(`${name}: microphone, ASR, cursor insertion, cancellation, resize OK; ${stopKey === '\r\n' ? 'Enter stops dictation' : 'shortcut stops dictation'}, prompt remains editable, no submission.`);
    } finally {
      child.kill(); await sleep(400); terminal.dispose(); active = undefined;
    }
  }
  await checkZsh({ pty, root, env, packageRoot, play, phrase });
  await exercise('forge', process.execPath, [join(packageRoot, 'bin', 'forge-voice.mjs')], '\r\n');
  await checkJobControl({ pty, root, env, packageRoot });
  // Pi installed AFTER the standalone module must use the exact same component roots.
  await installPi({ locations: p, packageRoot });
  for (const id of Object.keys(before.components)) {
    assert.equal((await ensureComponent(id, { locations: p, install: () => assert.fail('unexpected reinstallation') })).root, before.components[id].root);
  }
  await exercise('pi', 'pi', ['--no-session', '--no-skills', '--no-prompt-templates']);
  assert.deepEqual((await readJson(p.registry)).components, before.components);
  console.log('Forge → Pi: exact same installed components, zero reinstallations.');
} finally {
  active?.kill();
  if (moduleId) execFileSync('pactl', ['unload-module', moduleId]);
}
