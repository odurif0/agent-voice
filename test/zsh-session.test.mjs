import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { runZshSession } from '../src/zsh-session.mjs';
import { deferred } from './helpers.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const settings = { shortcut: 'ctrl+alt+z', microphone: { type: 'system-default' } };
function session(t, options = {}) {
  const input = new PassThrough(), output = new PassThrough(); let text = '';
  output.on('data', chunk => { text += chunk; });
  const done = runZshSession({ input, output, signals: false, readSettings: async () => settings,
    createCapture: async () => ({ stop: async () => new Float32Array(160) }),
    transcribe: async () => 'Hello.', ...options });
  t.after(() => { input.end(); output.destroy(); });
  return { input, output, done, text: () => text, async wait(part) {
    for (let i = 0; i < 100; i++) { if (text.includes(part)) return; await tick(); }
    assert.fail(`Missing event: ${part}\n${text}`);
  } };
}
test('Zsh: a single data result without terminal codes or newlines', async t => {
  const s = session(t, { transcribe: async () => 'Hello\n$(do_not_execute)\x1b[31m\ttext.' });
  await s.wait('● Recording'); s.input.write('stop\nstop\n'); await s.done;
  assert.ok(s.text().includes('result\tHello $(do_not_execute) text.\n'));
  assert.equal(s.text().match(/^result\t/gm).length, 1);
  assert.equal(s.text().match(/^done\t/gm).length, 1);
});
test('Zsh: preserve a second keypress while Node starts', async t => {
  const ready = deferred(); let count = 0;
  const s = session(t, { readSettings: () => ready.promise, transcribe: async () => { count++; return 'Text'; } });
  s.input.write('stop\n'); ready.resolve(settings); await s.done;
  assert.equal(count, 1); assert.ok(s.text().includes('result\tText\n'));
});
test('Zsh: cancel before initialization without opening the microphone', async t => {
  const ready = deferred();
  const s = session(t, { readSettings: () => ready.promise, createCapture: () => assert.fail('microphone opened after cancellation') });
  s.input.write('cancel\n'); ready.resolve(settings); await s.done;
  assert.ok(!s.text().includes('result\t'));
});
test('Zsh: cancel during transcription and ignore late results', async t => {
  const transcribed = deferred();
  const s = session(t, { transcribe: () => transcribed.promise });
  await s.wait('● Recording'); s.input.write('stop\n'); await s.wait('transcribing locally');
  s.input.write('cancel\n'); transcribed.resolve('Do not insert'); await s.done;
  assert.ok(!s.text().includes('result\t'));
});
test('Zsh: closing the shell releases capture without transcription', async t => {
  let stops = 0;
  const s = session(t, { createCapture: async () => ({ stop: async () => { stops++; return new Float32Array(5); } }), transcribe: () => assert.fail() });
  await s.wait('● Recording'); s.input.end(); await s.done;
  assert.equal(stops, 1); assert.ok(!s.text().includes('result\t'));
});
test('Zsh: disconnecting the result channel cancels capture', async t => {
  const s = session(t, { transcribe: () => assert.fail() });
  await s.wait('● Recording'); s.output.destroy(new Error('pipe closed')); await s.done;
});
test('Zsh: a late EPIPE on the final write does not become an unhandled exception', async () => {
  const input = new PassThrough();
  const output = new Writable({ write(chunk, _encoding, callback) {
    callback(chunk.toString().startsWith('done\t') ? new Error('EPIPE') : undefined);
  } });
  const done = runZshSession({ input, output, signals: false, readSettings: async () => settings,
    createCapture: async () => ({ stop: async () => new Float32Array(1) }), transcribe: async () => 'Text' });
  input.write('stop\n'); await done; await tick(); input.destroy();
  assert.equal(output.destroyed, true);
});
test('Zsh: readable microphone error and clean shutdown', async t => {
  const s = session(t, { createCapture: async () => { throw new Error('microphone missing'); } });
  await s.done; assert.ok(s.text().includes('Voice: microphone missing')); assert.ok(s.text().endsWith('done\t\n'));
});
test('Zsh: preserve a capture error after startup despite returning to idle', async t => {
  let fail;
  const s = session(t, { createCapture: async (_microphone, options) => { fail = options.onError; return { stop: async () => new Float32Array() }; } });
  await s.wait('● Recording'); fail(new Error('capture interrupted')); await s.done;
  assert.ok(s.text().includes('Voice: capture interrupted'));
});
test('Zsh: silence does not create an empty Forge request', async t => {
  const s = session(t, { transcribe: async () => ' \n ' });
  await s.wait('● Recording'); s.input.write('stop\n'); await s.done;
  assert.ok(s.text().includes('no speech recognized')); assert.ok(!s.text().includes('result\t'));
});
