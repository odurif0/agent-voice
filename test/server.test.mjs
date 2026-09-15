import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createTranscriptionServer, validateServerConfig, SERVER_MODEL } from '../src/server.mjs';
import { deferred } from './helpers.mjs';

const settings = { model: { id: 'parakeet-tdt-0.6b-v3', path: '/test/model.gguf' }, language: 'auto' };
async function fixture(t, options = {}) {
  const calls = [];
  const server = await createTranscriptionServer({
    token: randomBytes(32).toString('hex'), settings: async () => structuredClone(settings),
    decode: async () => new Float32Array([0.2, 0.1]),
    transcribe: async (...args) => { calls.push(args); return 'Dictation works.'; }, ...options,
  });
  t.after(() => server.close());
  return { ...server, calls };
}
function form(extra = {}, size = 50) {
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(size)], { type: 'audio/wav' }), 'dictation.wav');
  form.set('model', SERVER_MODEL); form.set('response_format', 'json');
  for (const [name, value] of Object.entries(extra)) form.set(name, value);
  return form;
}
const post = (server, body = form(), options = {}) => fetch(`${server.url}/audio/transcriptions`, { method: 'POST', body, ...options });

test('GooeyPi multipart contract: shared model, automatic language, JSON transcript', async t => {
  const server = await fixture(t);
  const response = await post(server);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: 'Dictation works.' });
  assert.equal(server.calls[0][0].language, 'auto');
  assert.equal(server.calls[0][0].model.path, settings.model.path);
  assert.equal(server.address.address, '127.0.0.1');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});
test('Explicit locale is normalized without changing shared settings', async t => {
  const server = await fixture(t);
  assert.equal((await post(server, form({ language: 'fr-FR' }))).status, 200);
  assert.equal(server.calls[0][0].language, 'fr');
  assert.equal(settings.language, 'auto');
});
test('Connection-test silence returns an empty transcript without loading the model', async t => {
  const server = await fixture(t, { decode: async () => new Float32Array(1600) });
  assert.deepEqual(await (await post(server)).json(), { text: '' });
  assert.equal(server.calls.length, 0);
});
test('Stable model alias still works after a shared model change', async t => {
  let current = settings;
  const server = await fixture(t, { settings: async () => current });
  await post(server);
  current = { ...settings, model: { id: 'another-model', path: '/test/other.gguf' } };
  await post(server);
  assert.equal(server.calls[1][0].model.path, '/test/other.gguf');
  const response = await fetch(`${server.url}/models`);
  assert.equal((await response.json()).data[0].id, SERVER_MODEL);
});
test('Reject missing capability, browser origins and forged Host headers', async t => {
  const server = await fixture(t);
  const wrong = new URL('/v1/audio/transcriptions', server.url);
  assert.equal((await fetch(wrong, { method: 'POST', body: form() })).status, 404);
  assert.equal((await post(server, form(), { headers: { Origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await post(server, form(), { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const status = await new Promise((resolve, reject) => {
    const req = request(`${server.url}/models`, { headers: { Host: 'rebind.example.invalid' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 403); assert.equal(server.calls.length, 0);
});
test('Reject malformed forms, invalid models, formats, languages and duplicate fields', async t => {
  const server = await fixture(t);
  for (const fields of [{ model: 'missing' }, { language: 'not-a-language' }, { response_format: 'text' }, { prompt: 'ignored?' }]) {
    assert.equal((await post(server, form(fields))).status, 400);
  }
  const duplicate = form(); duplicate.append('model', SERVER_MODEL);
  assert.equal((await post(server, duplicate)).status, 400);
  const noFile = form(); noFile.delete('file');
  assert.equal((await post(server, noFile)).status, 400);
  assert.equal((await post(server, 'not a form')).status, 415);
  assert.equal((await post(server, 'broken', { headers: { 'Content-Type': 'multipart/form-data; boundary=missing' } })).status, 400);
  assert.equal(server.calls.length, 0);
});
test('Bound uploaded file size independently of Content-Length', async t => {
  const server = await fixture(t, { maxAudioBytes: 48 });
  assert.equal((await post(server, form({}, 49))).status, 413);
  assert.equal(server.calls.length, 0);
});
test('A second transcription is rejected, not queued with another model in memory', async t => {
  const entered = deferred(), release = deferred();
  const server = await fixture(t, { transcribe: async () => { entered.resolve(); await release.promise; return 'Done.'; } });
  const first = post(server);
  await entered.promise;
  assert.equal((await post(server)).status, 429);
  release.resolve(); assert.equal((await first).status, 200);
  assert.equal((await post(server)).status, 200);
});
test('Client cancellation aborts work and frees the next request', async t => {
  const entered = deferred(), cancelled = deferred();
  let count = 0;
  const server = await fixture(t, { transcribe: async (_, __, { signal }) => {
    if (count++) return 'Next request.';
    entered.resolve();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => { cancelled.resolve(); reject(signal.reason); }, { once: true }));
  } });
  const controller = new AbortController();
  const first = post(server, form(), { signal: controller.signal });
  await entered.promise; controller.abort(); await assert.rejects(first);
  await cancelled.promise;
  assert.equal((await post(server)).status, 200);
});
test('Deadline aborts decoding with a JSON timeout response', async t => {
  const server = await fixture(t, { timeout: 30, decode: async (_, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  assert.equal((await post(server)).status, 504);
});
test('Backend errors do not expose local paths or transcripts', async t => {
  const server = await fixture(t, { transcribe: async () => { throw new Error('/private/model: sensitive data'); } });
  const response = await post(server);
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /private|sensitive/);
});
test('Reject invalid persisted listener configuration', () => {
  const valid = { version: 1, port: 40000, token: 'a'.repeat(64) };
  assert.equal(validateServerConfig(valid), valid);
  for (const invalid of [undefined, { ...valid, port: 80 }, { ...valid, token: '' }, { ...valid, version: 2 }]) {
    assert.throws(() => validateServerConfig(invalid));
  }
});
