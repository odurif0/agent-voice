import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { COMPONENTS, ensureComponent, registerInstallation } from '../src/components.mjs';
import { sandbox, fakePackage } from './helpers.mjs';
import { readJson, writeJson, withLock, acquireLock } from '../src/storage.mjs';
import { paths } from '../src/paths.mjs';

const forbidden = () => { throw new Error('No download expected'); };
test('Pi → Forge: reuse the exact same files, without installation', async t => {
  const p = await sandbox(t);
  const piRoot = join(p.pi, 'git', 'github.com', 'earendil-works', 'pi-transcribe');
  const root = await fakePackage(piRoot, COMPONENTS.engine);
  const found = await ensureComponent('engine', { locations: p, install: forbidden });
  assert.equal(found.root, root);
  assert.equal((await readJson(p.registry)).components.engine.root, root);
});
test('Forge → Pi → another agent: one physical component, one installation', async t => {
  const p = await sandbox(t); let installs = 0;
  const options = { locations: p, install: async (...args) => { installs++; await fakePackage(...args); } };
  const forge = await ensureComponent('engine', options);
  await mkdir(p.pi, { recursive: true });
  const pi = await ensureComponent('engine', options);
  const other = await ensureComponent('engine', options);
  assert.equal(installs, 1); assert.equal(pi.root, forge.root); assert.equal(other.root, forge.root);
});
test('Another integration → Forge: register reusable components', async t => {
  const p = await sandbox(t), root = join(p.root, 'another-agent');
  const module = await fakePackage(root, COMPONENTS.microphone);
  await registerInstallation(root, { locations: p });
  assert.equal((await ensureComponent('microphone', { locations: p, install: forbidden })).root, module);
});
test('Different versions: do not load an untested native API', async t => {
  const p = await sandbox(t);
  await fakePackage(join(p.pi, 'npm'), { ...COMPONENTS.engine, version: '0.1.0' });
  let installs = 0;
  const found = await ensureComponent('engine', { locations: p, install: async (...args) => { installs++; await fakePackage(...args); } });
  assert.equal(installs, 1); assert.equal(found.version, COMPONENTS.engine.version);
});
test('Pi removed later: automatic repair, no persistent broken links', async t => {
  const p = await sandbox(t), root = join(p.pi, 'npm');
  await fakePackage(root, COMPONENTS.engine);
  const old = await ensureComponent('engine', { locations: p, install: forbidden });
  await rm(root, { recursive: true });
  const fixed = await ensureComponent('engine', { locations: p, install: fakePackage });
  assert.notEqual(fixed.root, old.root);
});
test('Concurrent installations: install once and keep the registry consistent', async t => {
  const p = await sandbox(t); let installs = 0;
  const options = { locations: p, install: async (...args) => { installs++; await sleep(40); await fakePackage(...args); } };
  const found = await Promise.all(Array.from({ length: 8 }, () => ensureComponent('engine', options)));
  assert.equal(installs, 1); assert.equal(new Set(found.map(x => x.root)).size, 1);
});
test('Lock: cancellation, release after errors and recovery after a crash', async t => {
  const p = await sandbox(t), lock = join(p.root, 'test.lock');
  await assert.rejects(withLock(lock, () => { throw new Error('failure'); }), /failure/);
  assert.equal(await withLock(lock, () => 12), 12);
  await mkdir(lock);
  await writeJson(join(lock, 'owner.json'), { pid: 2147483647 });
  assert.equal(await withLock(lock, () => 13), 13);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(withLock(lock, () => 99, { signal: abort.signal }), { name: 'AbortError' });
});
test('Concurrent stale-lock recovery: never two owners', async t => {
  const p = await sandbox(t), lock = join(p.root, 'crashed.lock');
  await mkdir(lock, { recursive: true }); await writeJson(join(lock, 'owner.json'), { pid: 2147483647 });
  let active = 0, maximum = 0;
  await Promise.all(Array.from({ length: 8 }, () => withLock(lock, async () => {
    active++; maximum = Math.max(maximum, active); await sleep(10); active--;
  })));
  assert.equal(maximum, 1);
});
test('Microphone: a zero timeout recovers a stale lock before refusing', async t => {
  const p = await sandbox(t), lock = join(p.root, 'microphone.lock');
  await mkdir(lock, { recursive: true }); await writeJson(join(lock, 'owner.json'), { pid: 2147483647 });
  assert.equal(await withLock(lock, () => 'recovered', { timeout: 0 }), 'recovered');
  await withLock(lock, async () => {
    await assert.rejects(withLock(lock, () => assert.fail('live lock stolen'), { timeout: 0 }), /Resource busy/);
  });
});
test('Concurrent recovery without waiting: only one winner keeps the lock', async t => {
  const p = await sandbox(t), lock = join(p.root, 'microphone.lock');
  await mkdir(lock, { recursive: true }); await writeJson(join(lock, 'owner.json'), { pid: 2147483647 });
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => acquireLock(lock, { timeout: 0 })));
  const owners = results.filter(result => result.status === 'fulfilled');
  try { assert.equal(owners.length, 1); }
  finally { await Promise.all(owners.map(result => result.value())); }
});
test('Paths: XDG, HF_HOME, HF_HUB_CACHE and custom Pi directory', () => {
  const p = paths({ XDG_DATA_HOME: '/data', HF_HOME: '/hf', PI_CODING_AGENT_DIR: '/pi' }, '/home/test', 'linux');
  assert.equal(p.root, '/data/agent-voice'); assert.equal(p.hf, '/hf/hub'); assert.equal(p.pi, '/pi');
  assert.equal(paths({ HF_HUB_CACHE: '/cache' }, '/home/test', 'linux').hf, '/cache');
});
