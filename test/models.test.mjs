import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, stat, realpath, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { downloadModel, ensureSettings, modelCachePath, validModel } from '../src/models.mjs';
import { writeJson } from '../src/storage.mjs';
import { sandbox, gguf } from './helpers.mjs';

const fixture = { id: 'test', name: 'Test', repository: 'owner/model', filename: 'model.gguf', revision: '012345', size: gguf.length, sha256: createHash('sha256').update(gguf).digest('hex') };
const forbidden = () => { throw new Error('No HTTP request expected'); };
test('Populated HF cache → no download; compatibility in both directions', async t => {
  const p = await sandbox(t), path = modelCachePath(fixture, p);
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, gguf);
  assert.equal(await downloadModel(fixture, { locations: p, fetchImpl: forbidden }), path);
});
test('Verified download: HF snapshot and blob are the same physical file', async t => {
  const p = await sandbox(t); let requests = 0;
  const path = await downloadModel(fixture, { locations: p, fetchImpl: async () => { requests++; return new Response(gguf); } });
  assert.equal(requests, 1); assert.equal(await validModel(path, gguf.length), true);
  const blob = join(p.hf, 'models--owner--model', 'blobs', fixture.sha256);
  assert.equal((await stat(path)).ino, (await stat(blob)).ino);
  assert.equal(await realpath(path), blob);
  assert.equal(await downloadModel(fixture, { locations: p, fetchImpl: forbidden }), path);
});
test('Chunked response: write every chunk in order without overwriting', async t => {
  const p = await sandbox(t);
  const body = new ReadableStream({ start(controller) {
    for (let i = 0; i < gguf.length; i += 3) controller.enqueue(gguf.subarray(i, i + 3));
    controller.close();
  } });
  const path = await downloadModel(fixture, { locations: p, fetchImpl: async () => new Response(body) });
  assert.equal(await validModel(path, gguf.length), true);
});
test('Concurrent downloads → a single transfer', async t => {
  const p = await sandbox(t); let requests = 0;
  const options = { locations: p, fetchImpl: async () => { requests++; return new Response(gguf); } };
  const results = await Promise.all([downloadModel(fixture, options), downloadModel(fixture, options)]);
  assert.equal(results[0], results[1]); assert.equal(requests, 1);
});
test('Corrupted file: reject SHA-256, publish no model or partial file', async t => {
  const p = await sandbox(t), bad = Buffer.from(gguf); bad[7] = 2;
  await assert.rejects(downloadModel(fixture, { locations: p, fetchImpl: async () => new Response(bad) }), /SHA-256/);
  assert.equal(await validModel(modelCachePath(fixture, p)), false);
  assert.deepEqual(await readdir(join(p.hf, 'models--owner--model', 'blobs')), []);
});
test('Download declined: no request or incomplete settings', async t => {
  const p = await sandbox(t);
  await assert.rejects(ensureSettings({ locations: p, confirmDownload: async () => false, fetchImpl: forbidden }), /not downloaded/);
});
test('Pi → Forge: preserve model, language and microphone; leave Pi settings unchanged', async t => {
  const p = await sandbox(t), model = join(p.root, 'existing.gguf');
  await mkdir(p.root); await writeFile(model, gguf);
  const pi = { version: 1, backend: { type: 'transcribe-cpp' }, model: { id: 'local', path: model }, transcriptionLanguage: 'fr', shortcut: 'ctrl+alt+z', microphone: { type: 'device', name: 'USB', occurrence: 0 } };
  await writeJson(join(p.pi, 'pi-transcribe.json'), pi);
  const first = await ensureSettings({ locations: p, confirmDownload: forbidden });
  const second = await ensureSettings({ locations: p, confirmDownload: forbidden });
  assert.equal(first.model.path, model); assert.equal(first.language, 'fr'); assert.deepEqual(first.microphone, pi.microphone); assert.deepEqual(first, second);
});
test('Forge → Pi installed later: shared settings unchanged', async t => {
  const p = await sandbox(t), model = join(p.root, 'local.gguf');
  await mkdir(p.root); await writeFile(model, gguf);
  const forge = await ensureSettings({ locations: p, model, language: 'fr', confirmDownload: forbidden });
  await mkdir(p.pi);
  const pi = await ensureSettings({ locations: p, confirmDownload: forbidden });
  assert.deepEqual(forge, pi);
});
test('Reject invalid language and shortcut before any download', async t => {
  const p = await sandbox(t);
  await assert.rejects(ensureSettings({ locations: p, language: 'fr; echo', confirmDownload: forbidden }), /Invalid/);
  await assert.rejects(ensureSettings({ locations: p, shortcut: 'not-a-key', confirmDownload: forbidden }), /Invalid/);
});
