import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { runTerminal, statusText } from '../src/terminal.mjs';
import { PASTE_START, PASTE_END } from '../src/terminal-input.mjs';

async function harness() {
  const input = Object.assign(new EventEmitter(), { isTTY: true, isRaw: false, resume() {}, pause() {}, setRawMode(raw) { this.isRaw = raw; } });
  const output = Object.assign(new EventEmitter(), { isTTY: true, rows: 30, columns: 100, text: '', write(text) { this.text += text; return true; } });
  const child = { written: '', sizes: [], killed: false, onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; }, write(text) { this.written += text; }, resize(c, r) { this.sizes.push([c, r]); }, kill() { this.killed = true; }, pause() {}, resume() {} };
  let dictation;
  const done = runTerminal('forge', [], { shortcut: 'ctrl+alt+z' }, {
    input, output, pty: { spawn: () => child },
    createDictation(_s, options) {
      dictation = { state: 'idle', disposed: false, stops: 0,
        emit(state, detail) { this.state = state; options.onState(state, detail); },
        async stop() { this.stops++; this.emit('transcribing'); },
        async toggle() { if (this.state === 'idle') this.emit('listening'); else if (['starting', 'listening'].includes(this.state)) await this.stop(); },
        async cancel() { this.emit('idle'); },
        async dispose() { this.disposed = true; this.emit('idle'); },
      }; return dictation;
    },
  });
  await sleep(1);
  return { input, output, child, dictation, done };
}
test('No dictation outside the editor; ordinary input unchanged', async () => {
  const h = await harness();
  h.input.emit('data', Buffer.from('abc\x1b\x1a'));
  assert.equal(h.child.written, 'abc'); assert.equal(h.dictation.state, 'idle');
  assert.match(h.output.text, /wait for the agent prompt/);
  h.child.exit({ exitCode: 0 }); assert.equal(await h.done, 0); assert.equal(h.input.isRaw, false);
});
test('Enter stops dictation without submitting; a new Enter submits after transcription', async () => {
  const h = await harness(); h.child.data('\x1b[?2004h');
  h.input.emit('data', Buffer.from('\x1b\x1a'));
  assert.equal(h.dictation.state, 'listening');
  h.input.emit('data', Buffer.from('\r\ntext\x1b[D'));
  assert.equal(h.child.written, '');
  assert.equal(h.dictation.state, 'transcribing'); assert.equal(h.dictation.stops, 1);
  h.input.emit('data', Buffer.from('\r')); assert.equal(h.child.written, '');
  assert.equal(h.dictation.stops, 1);
  h.dictation.emit('result', { text: 'Hello\nworld' }); h.dictation.emit('idle');
  assert.equal(h.child.written, PASTE_START + 'Hello world' + PASTE_END);
  h.input.emit('data', Buffer.from('\r')); assert.ok(h.child.written.endsWith('\r'));
  h.child.exit({ exitCode: 0 }); await h.done;
});
test('Enter works while opening the microphone; pasted newlines do not stop it', async () => {
  const h = await harness(); h.child.data('\x1b[?2004h');
  try {
    h.dictation.emit('starting');
    for (const char of PASTE_START + '\r\n' + PASTE_END) h.input.emit('data', Buffer.from(char));
    assert.equal(h.dictation.state, 'starting'); assert.equal(h.child.written, '');
    h.input.emit('data', Buffer.from('\n'));
    assert.equal(h.dictation.state, 'transcribing'); assert.equal(h.dictation.stops, 1);
    h.dictation.emit('cancelling'); h.input.emit('data', Buffer.from('\r'));
    assert.equal(h.dictation.state, 'cancelling'); assert.equal(h.dictation.stops, 1); assert.equal(h.child.written, '');
  } finally { h.child.exit({ exitCode: 0 }); await h.done; }
});
test('The original shortcut still stops dictation', async () => {
  const h = await harness(); h.child.data('\x1b[?2004h');
  h.input.emit('data', Buffer.from('\x1b\x1a\x1b\x1a'));
  assert.equal(h.dictation.state, 'transcribing'); assert.equal(h.dictation.stops, 1); assert.equal(h.child.written, '');
  h.child.exit({ exitCode: 0 }); await h.done;
});
test('Help advertises Enter only in interfaces that support it', () => {
  assert.match(statusText('listening', 'ctrl+alt+z', '', true), /Enter or Ctrl\+Alt\+Z: stop/);
  assert.match(statusText('listening', 'f2', '', true), /Enter or F2: stop/);
  assert.doesNotMatch(statusText('listening', 'ctrl+alt+z'), /Enter/);
});
test('Editor closes: cancel without injecting a result elsewhere', async () => {
  const h = await harness(); h.child.data('\x1b[?2004h'); h.input.emit('data', Buffer.from('\x1b\x1a'));
  h.child.data('\x1b[?2004l'); assert.equal(h.dictation.state, 'idle');
  h.dictation.emit('result', { text: 'Do not inject' });
  assert.equal(h.child.written, '');
  h.child.exit({ exitCode: 0 }); await h.done;
});
test('Ctrl+C: cancel dictation, otherwise forward normally to Forge', async () => {
  const h = await harness(); h.child.data('\x1b[?2004h');
  h.input.emit('data', Buffer.from('\x1b\x1a\x03')); assert.equal(h.dictation.state, 'idle'); assert.equal(h.child.written, '');
  h.input.emit('data', Buffer.from('\x03')); assert.equal(h.child.written, '\x03');
  h.child.exit({ exitCode: 0 }); await h.done;
});
test('Resize and close: restore the terminal, preserve the exit code', async () => {
  const h = await harness(); assert.equal(h.input.isRaw, true);
  h.output.columns = 72; h.output.rows = 20; h.output.emit('resize');
  assert.deepEqual(h.child.sizes.at(-1), [72, 19]);
  h.child.exit({ exitCode: 7 }); assert.equal(await h.done, 7);
  assert.equal(h.input.isRaw, false); assert.equal(h.dictation.disposed, true);
  assert.equal(h.input.listenerCount('data'), 0); assert.equal(h.output.listenerCount('resize'), 0);
});
test('stdin closes: do not leave Forge orphaned', async () => {
  const h = await harness(); h.input.emit('end');
  await h.done; assert.equal(h.child.killed, true); assert.equal(h.input.isRaw, false);
});
