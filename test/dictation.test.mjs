import test from 'node:test';
import assert from 'node:assert/strict';
import { Dictation } from '../src/dictation.mjs';
import { deferred } from './helpers.mjs';

const settings = { microphone: { type: 'system-default' } };
const tick = () => new Promise(resolve => setImmediate(resolve));
test('Start/stop: one microphone, one transcription, one result', async () => {
  let captures = 0, stops = 0, transcriptions = 0;
  const states = [];
  const d = new Dictation(settings, {
    createCapture: async () => { captures++; return { stop: async () => { stops++; return new Float32Array(160); } }; },
    transcribe: async () => { transcriptions++; return 'Hello.'; }, onState: (state, detail) => states.push([state, detail]),
  });
  await Promise.all([d.start(), d.start()]);
  const [a, b] = await Promise.all([d.stop(), d.stop()]);
  assert.equal(a, 'Hello.'); assert.equal(b, a);
  assert.equal(captures, 1); assert.equal(stops, 1); assert.equal(transcriptions, 1);
  assert.equal(states.filter(([s]) => s === 'result').length, 1); assert.equal(d.state, 'idle');
});
test('Cancel while opening: release the microphone without transcription', async () => {
  const gate = deferred(); let stops = 0;
  const d = new Dictation(settings, { createCapture: () => gate.promise, transcribe: () => assert.fail('transcription after cancellation') });
  const start = d.start(), cancel = d.cancel();
  // Real capture.stop() is idempotent, even if stop and cancel overlap.
  let stopped = false;
  gate.resolve({ stop: async () => { if (!stopped) stops++; stopped = true; return new Float32Array(1); } });
  await Promise.all([start, cancel]);
  assert.equal(stops, 1); assert.equal(d.state, 'idle');
});
test('Stop while opening: do not lose the second keypress', async () => {
  const gate = deferred();
  const d = new Dictation(settings, { createCapture: () => gate.promise, transcribe: async () => 'Text' });
  const start = d.start(); const stop = d.stop();
  gate.resolve({ stop: async () => new Float32Array(1) });
  await start; assert.equal(await stop, 'Text');
});
test('Cancel during transcription: pass the signal, ignore a late result', async () => {
  const gate = deferred(); let signal; const results = [];
  const d = new Dictation(settings, {
    createCapture: async () => ({ stop: async () => new Float32Array(10) }),
    transcribe: async (_s, _p, options) => { signal = options.signal; return gate.promise; },
    onState: (state, data) => { if (state === 'result') results.push(data); },
  });
  await d.start(); const work = d.stop(); await tick(); const cancelled = d.cancel();
  assert.equal(signal.aborted, true); gate.resolve('Do not insert');
  await Promise.all([work, cancelled]); assert.deepEqual(results, []);
});
test('Microphone error followed by a retry', async () => {
  let fail = true;
  const d = new Dictation(settings, { createCapture: async () => { if (fail) throw new Error('microphone missing'); return { stop: async () => new Float32Array(2) }; }, transcribe: async () => 'OK' });
  await d.start(); assert.equal(d.state, 'error'); fail = false;
  await d.start(); assert.equal(await d.stop(), 'OK');
});
test('Close during dictation: no transcription and no restart', async () => {
  let captures = 0;
  const d = new Dictation(settings, { createCapture: async () => { captures++; return { stop: async () => new Float32Array(1) }; }, transcribe: () => assert.fail() });
  await d.start(); await d.dispose(); await d.start(); assert.equal(captures, 1);
});
