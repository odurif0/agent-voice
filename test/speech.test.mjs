import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { ensureSpeech, speechWav, synthesizeSpeech, DEFAULT_VOICE } from '../src/speech.mjs';
import { createTranscriptionServer } from '../src/server.mjs';
import { sandbox, deferred } from './helpers.mjs';
const exec = promisify(execFile);

async function archiveFixture(t) {
  const locations = await sandbox(t);
  await mkdir(locations.root, { recursive: true });
  const root = await mkdtemp(join(locations.root, 'archive-'));
  const name = `vits-piper-${DEFAULT_VOICE}`;
  const directory = join(root, name);
  await mkdir(join(directory, 'espeak-ng-data'), { recursive: true });
  for (const file of [`${DEFAULT_VOICE}.onnx`, `${DEFAULT_VOICE}.onnx.json`, 'tokens.txt', 'MODEL_CARD', 'espeak-ng-data/phontab']) await writeFile(join(directory, file), 'fixture');
  const archive = join(root, 'fixture.tar.bz2');
  await exec('tar', ['-cjf', archive, '-C', root, name]);
  const data = await readFile(archive);
  const voice = { id: DEFAULT_VOICE, name: 'Test voice', size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
  let requests = 0, components = 0;
  const options = { locations, catalog: [voice], yes: true,
    fetchImpl: async () => { requests++; return new Response(data); }, ensureComponent: async id => { assert.equal(id, 'speech'); components++; } };
  return { options, data, voice, locations, counts: () => ({ requests, components }) };
}

test('Speech install verifies the archive, retains attribution and reuses shared model files', async t => {
  const f = await archiveFixture(t);
  const first = await ensureSpeech(f.options), second = await ensureSpeech(f.options);
  assert.deepEqual(first, second);
  assert.deepEqual(f.counts(), { requests: 1, components: 2 });
  assert.equal(await readFile(join(first.path, 'MODEL_CARD'), 'utf8'), 'fixture');
  assert.deepEqual(JSON.parse(await readFile(join(f.locations.root, 'speech.json'), 'utf8')), first);
});
test('Speech install rejects checksum and size errors without extracting or selecting a voice', async t => {
  const f = await archiveFixture(t);
  for (const data of [Buffer.alloc(f.data.length), f.data.subarray(1), Buffer.concat([f.data, Buffer.from('x')])]) {
    await assert.rejects(ensureSpeech({ ...f.options, fetchImpl: async () => new Response(data) }), /checksum|size/);
    await assert.rejects(readFile(join(f.locations.root, 'speech.json')), { code: 'ENOENT' });
    assert.deepEqual(await readdir(join(f.locations.root, 'models', 'speech')), []);
  }
});
test('Speech install requires consent and serializes concurrent downloads', async t => {
  const f = await archiveFixture(t);
  await assert.rejects(ensureSpeech({ ...f.options, yes: false }), /not confirmed/);
  assert.equal(f.counts().requests, 0);
  await Promise.all([ensureSpeech(f.options), ensureSpeech(f.options)]);
  assert.equal(f.counts().requests, 1);
  await assert.rejects(ensureSpeech({ ...f.options, voice: 'missing' }), /Unknown/);
});
test('WAV synthesis uses bounded mono PCM16 and rejects invalid native output', () => {
  const wav = speechWav({ samples: new Float32Array([-1, 0, 1]), sampleRate: 22050 });
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 22050);
  assert.equal(wav.readInt16LE(44), -32768); assert.equal(wav.readInt16LE(48), 32767);
  assert.throws(() => speechWav({ samples: new Float32Array([NaN]), sampleRate: 22050 }), /sample/);
  assert.throws(() => speechWav({ samples: new Float32Array([0]), sampleRate: 1 }), /Invalid/);
});
test('Speech synthesis retains one model, respects cancellation and preserves shared configuration', async t => {
  const f = await archiveFixture(t);
  await ensureSpeech(f.options);
  const before = await readFile(join(f.locations.root, 'speech.json'), 'utf8');
  let loads = 0;
  const model = { generateAsync: async ({ onProgress }) => { assert.equal(onProgress(), true); return { samples: new Float32Array([0.2]), sampleRate: 22050 }; } };
  const OfflineTts = { createAsync: async () => { loads++; return model; } };
  const options = { locations: f.locations, loadComponent: async () => ({ OfflineTts }) };
  await synthesizeSpeech('A response.', options); await synthesizeSpeech('Another response.', options);
  assert.equal(loads, 1);
  await assert.rejects(synthesizeSpeech('Cancelled.', { ...options, signal: AbortSignal.abort() }), { name: 'AbortError' });
  await assert.rejects(synthesizeSpeech('x'.repeat(1201), options), /characters/);
  assert.equal(await readFile(join(f.locations.root, 'speech.json'), 'utf8'), before);
});

const speechPost = (server, payload = { model: 'agent-voice', input: 'Read this answer.', response_format: 'wav' }, extra = {}) => fetch(`${server.url}/audio/speech`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), ...extra,
});
async function serverFixture(t, options = {}) {
  const calls = [];
  const wav = speechWav({ samples: new Float32Array([0.1, 0]), sampleRate: 22050 });
  const server = await createTranscriptionServer({ token: randomBytes(32).toString('hex'), availableVoice: async () => DEFAULT_VOICE,
    synthesize: async (...args) => { calls.push(args); return wav; }, ...options });
  t.after(() => server.close());
  return { ...server, calls, wav };
}
test('Local speech endpoint returns WAV without provider keys, URLs or audio files', async t => {
  const server = await serverFixture(t);
  assert.equal((await (await fetch(`${server.url}/voices`)).json()).data[0].id, DEFAULT_VOICE);
  const response = await speechPost(server);
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), server.wav);
  assert.equal(server.calls[0][0], 'Read this answer.');
  assert.equal((await speechPost(server, {}, { headers: { Origin: 'https://example.invalid' } })).status, 403);
});
test('Speech endpoint bounds input and rejects format, model, JSON and missing voice errors', async t => {
  const server = await serverFixture(t);
  for (const payload of [[], null, {}, { input: '' }, { input: 'x'.repeat(1201) }, { input: 'Hello', model: 'cloud' }, { input: 'Hello', response_format: 'mp3' }, { input: 'Hello', instructions: 'extra' }]) {
    assert.equal((await speechPost(server, payload)).status, 400);
  }
  assert.equal((await speechPost(server, {}, { body: '{' })).status, 400);
  assert.equal((await speechPost(server, {}, { body: ' '.repeat(8193) })).status, 413);
  const missing = await serverFixture(t, { availableVoice: async () => undefined });
  assert.equal((await speechPost(missing)).status, 503);
  assert.equal(server.calls.length, 0);
});
test('Speech cancellation releases admission; synthesis errors never expose text or local paths', async t => {
  const entered = deferred(), cancelled = deferred(); let count = 0;
  const server = await serverFixture(t, { synthesize: async (_, { signal }) => {
    if (count++) throw new Error('private input and /private/model');
    entered.resolve();
    return new Promise((_, reject) => signal.addEventListener('abort', () => { cancelled.resolve(); reject(signal.reason); }, { once: true }));
  } });
  const controller = new AbortController(), first = speechPost(server, undefined, { signal: controller.signal });
  await entered.promise;
  assert.equal((await speechPost(server)).status, 429);
  controller.abort(); await assert.rejects(first); await cancelled.promise;
  const failure = await speechPost(server);
  assert.equal(failure.status, 500); assert.doesNotMatch(await failure.text(), /private/);
});
