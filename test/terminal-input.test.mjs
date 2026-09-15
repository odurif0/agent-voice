import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { InputRouter, PasteReadiness, PASTE_START, PASTE_END, cleanTranscript, pastedTranscript, fitStatus } from '../src/terminal-input.mjs';

function router(shortcut = 'ctrl+alt+z') {
  let text = '', toggles = 0, cancels = 0;
  const input = new InputRouter({ shortcut, onData: data => { text += data; }, onToggle: () => toggles++, onCancel: () => cancels++, escapeTimeout: 5 });
  return { input, result: () => ({ text, toggles, cancels }) };
}
test('Fragmented shortcuts and Kitty sequences', () => {
  for (const key of ['\x1b\x1a', '\x1b[122;7u', '\x1b[122;7:1u', '\x1b[27;7;122~']) {
    const r = router(); for (const char of key) r.input.feed(char);
    assert.equal(r.result().toggles, 1); assert.equal(r.result().text, ''); r.input.dispose();
  }
});
test('F2 in SS3 and CSI terminals', () => {
  const r = router('f2'); r.input.feed('\x1bOQ\x1b[12~'); assert.equal(r.result().toggles, 2); r.input.dispose();
});
test('Escape alone cancels; preserve arrow keys and Alt', async () => {
  const r = router(); r.input.feed('\x1b[D\x1bx'); r.input.feed('\x1b'); await sleep(20);
  assert.deepEqual(r.result(), { text: '\x1b[D\x1bx', toggles: 0, cancels: 1 }); r.input.dispose();
});
test('Fragmented UTF-8: preserve accents and emoji', () => {
  const r = router(), text = 'Unicode \u00e9 👨‍🔬 works!';
  for (const byte of Buffer.from(text)) r.input.feed(Buffer.from([byte]));
  assert.equal(r.result().text, text); r.input.dispose();
});
test('Paste containing the shortcut: never treat it as a voice command', () => {
  const r = router(), paste = `${PASTE_START}A\x1b\x1aB${PASTE_END}`;
  for (const byte of Buffer.from(paste)) r.input.feed(Buffer.from([byte]));
  assert.deepEqual(r.result(), { text: paste, toggles: 0, cancels: 0 }); r.input.dispose();
});
test('Distinguish keyboard Enter from pasted newlines, even when fragmented', () => {
  let text = ''; const enters = [];
  const input = new InputRouter({ shortcut: 'ctrl+alt+z', onData: data => { text += data; },
    onToggle() {}, onCancel() {}, onEnter: key => enters.push(key) });
  try {
    input.feed('\r\n');
    assert.deepEqual(enters, ['\r', '\n']); assert.equal(text, '');
    const paste = PASTE_START + 'pasted\r\ntext' + PASTE_END;
    for (const char of paste) input.feed(char);
    assert.equal(text, paste); assert.deepEqual(enters, ['\r', '\n']);
  } finally { input.dispose(); }
});
test('Without an Enter handler, leave newlines unchanged', () => {
  const r = router(); r.input.feed('\r\n');
  assert.equal(r.result().text, '\r\n'); r.input.dispose();
});
test('Insert transcription as data, never as submission', () => {
  const text = cleanTranscript('Hello\r\n\x1b[201~\x1b[31m:shell\x03\x7f\x9b test');
  assert.equal(text, 'Hello :shell test');
  const pasted = pastedTranscript('Hello\nworld');
  assert.equal(pasted, `${PASTE_START}Hello world${PASTE_END}`);
  assert.equal(/[\r\n]/.test(pasted), false);
});
test('Detect the editor without depending on prompt text', () => {
  const p = new PasteReadiness();
  for (const c of 'hello\x1b[?2004h') p.feed(c);
  assert.equal(p.enabled, true); p.feed('\x1b[?2004l'); assert.equal(p.enabled, false);
});
test('Status bar: do not interrupt an ANSI sequence or the cursor saved by Forge', () => {
  const p = new PasteReadiness();
  p.feed('\x1b['); assert.equal(p.safeToDraw, false);
  p.feed('s'); assert.equal(p.safeToDraw, false);
  p.feed('\x1b[999Cright prompt'); assert.equal(p.safeToDraw, false);
  p.feed('\x1b[u'); assert.equal(p.safeToDraw, true);
  p.feed('\x1b]0;window title'); assert.equal(p.safeToDraw, false);
  p.feed('\x07'); assert.equal(p.safeToDraw, true);
  p.feed('\x1bPpayload'); assert.equal(p.safeToDraw, false);
  p.feed('\x1b\\'); assert.equal(p.safeToDraw, true);
});
test('Status bar: conservative width budget for wide and combining characters', () => {
  assert.equal(fitStatus('na\u00efve UI', 8), 'na\u00efve UI');
  assert.equal(fitStatus('AB\u6c49\u5b57CD', 6), 'AB\u6c49\u5b57');
  assert.equal(fitStatus('A👨‍🔬B', 3), 'A👨‍🔬');
  assert.equal(fitStatus('e\u0301xtra', 2), 'e\u0301x');
});
