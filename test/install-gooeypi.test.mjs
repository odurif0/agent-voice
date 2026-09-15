import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { readFile, rm, symlink } from 'node:fs/promises';
import { sandbox } from './helpers.mjs';
import { readJson, writeJson } from '../src/storage.mjs';
import { checkGooeyPi, gooeyPiDirectory, gooeyPiRunning, installGooeyPi, uninstallGooeyPi } from '../src/install-gooeypi.mjs';
import { serviceDefinition, serviceManager } from '../src/service.mjs';
import { serverConfigPath } from '../src/server.mjs';

async function fixture(t, extra = {}) {
  const locations = await sandbox(t), home = dirname(locations.root);
  const directory = join(home, 'gooeypi'), path = join(directory, 'prime-work-state-v4.json');
  const original = { version: 4, projects: [{ id: 'keep-project' }], archivedSessions: ['keep-session'], settings: {
    theme: 'dark', voiceTranscriptionProvider: 'groq', voiceSelfHostedUrl: 'http://localhost:8000', voiceSelfHostedModel: 'previous-model', voiceGroqTranscriptionModel: 'keep-groq',
  } };
  await writeJson(path, original);
  const calls = [];
  const manager = Object.fromEntries(['check', 'start', 'stop', 'reload', 'active'].map(name => [name, async definition => { calls.push([name, definition]); return false; }]));
  const options = { locations, directory, home, platform: 'linux', env: { PATH: '/usr/bin:/bin' }, packageRoot: join(home, 'package'),
    isRunning: async () => false, findFFmpeg: async () => '/usr/bin/ffmpeg', availablePort: async () => 43210, waitForServer: async () => {}, manager, ...extra };
  return { locations, directory, path, original, options, calls };
}

test('GooeyPi install: only voice settings change; service starts with the existing shared resources', async t => {
  const f = await fixture(t);
  await installGooeyPi(f.options);
  const current = await readJson(f.path), state = await readJson(join(f.locations.root, 'gooeypi-install.json'));
  assert.equal(current.settings.voiceTranscriptionProvider, 'self-hosted');
  assert.equal(current.settings.voiceSelfHostedModel, 'agent-voice');
  assert.match(current.settings.voiceSelfHostedUrl, /^http:\/\/127\.0\.0\.1:43210\/[a-f0-9]{64}\/v1$/);
  for (const key of ['projects', 'archivedSessions']) assert.deepEqual(current[key], f.original[key]);
  assert.equal(current.settings.theme, 'dark'); assert.equal(current.settings.voiceGroqTranscriptionModel, 'keep-groq');
  const unit = await readFile(state.service.path, 'utf8');
  assert.ok(unit.includes(`AGENT_VOICE_HOME=${f.locations.root}`));
  assert.ok(unit.includes(`HF_HUB_CACHE=${f.locations.hf}`));
  assert.ok(unit.includes('PI_TRANSCRIBE_FFMPEG_PATH=/usr/bin/ffmpeg'));
  assert.deepEqual(f.calls.map(([name]) => name), ['check', 'start']);
});
test('Repeated install keeps its original settings, URL and token; uninstall restores them', async t => {
  const f = await fixture(t);
  await installGooeyPi(f.options);
  const first = await readJson(f.path), config = await readJson(serverConfigPath(f.locations));
  await installGooeyPi(f.options);
  assert.deepEqual(await readJson(f.path), first); assert.deepEqual(await readJson(serverConfigPath(f.locations)), config);
  await uninstallGooeyPi(f.options);
  assert.deepEqual(await readJson(f.path), f.original);
  assert.equal(await readJson(serverConfigPath(f.locations), undefined), undefined);
  assert.equal(await readJson(join(f.locations.root, 'gooeypi-install.json'), undefined), undefined);
  await uninstallGooeyPi(f.options);
});
test('Uninstall preserves intervening user changes and shared model settings', async t => {
  const f = await fixture(t);
  await writeJson(f.locations.config, { model: { path: '/shared/model.gguf' }, language: 'auto' });
  await installGooeyPi(f.options);
  const current = await readJson(f.path);
  current.settings.voiceSelfHostedModel = 'user-change'; current.settings.theme = 'light';
  current.projects.push({ id: 'new-project' }); await writeJson(f.path, current);
  await uninstallGooeyPi(f.options);
  const restored = await readJson(f.path);
  assert.equal(restored.settings.voiceSelfHostedModel, 'user-change'); assert.equal(restored.settings.theme, 'light');
  assert.equal(restored.projects.length, 2); assert.equal(restored.settings.voiceTranscriptionProvider, 'groq');
  assert.equal((await readJson(f.locations.config)).model.path, '/shared/model.gguf');
});
test('Absent voice fields stay absent after removal', async t => {
  const f = await fixture(t);
  const original = { version: 4, settings: { theme: 'dark' } }; await writeJson(f.path, original);
  await installGooeyPi(f.options); await uninstallGooeyPi(f.options);
  assert.deepEqual(await readJson(f.path), original);
});
test('Running GooeyPi blocks installation and removal without touching its state', async t => {
  const f = await fixture(t);
  await assert.rejects(installGooeyPi({ ...f.options, isRunning: async () => true }), /Quit GooeyPi/);
  assert.deepEqual(await readJson(f.path), f.original); assert.equal(f.calls.length, 0);
  await installGooeyPi(f.options); const installed = await readFile(f.path, 'utf8'); f.calls.length = 0;
  await assert.rejects(uninstallGooeyPi({ ...f.options, isRunning: async () => true }), /Quit GooeyPi/);
  assert.equal(await readFile(f.path, 'utf8'), installed); assert.equal(f.calls.length, 0);
});
test('Reject absent and unsupported GooeyPi state instead of constructing a replacement', async t => {
  const f = await fixture(t);
  await writeJson(f.path, { version: 5, settings: {} });
  await assert.rejects(checkGooeyPi(f.options), /Unsupported/);
  await rm(f.path); await assert.rejects(checkGooeyPi(f.options), /not found/);
});
test('Startup failure rolls back service, listener configuration and ownership journal', async t => {
  const f = await fixture(t, { waitForServer: async () => { throw new Error('Service failed.'); } });
  await assert.rejects(installGooeyPi(f.options), /Service failed/);
  assert.deepEqual(await readJson(f.path), f.original);
  assert.equal(await readJson(serverConfigPath(f.locations), undefined), undefined);
  assert.equal(await readJson(join(f.locations.root, 'gooeypi-install.json'), undefined), undefined);
  const service = f.calls.find(([name]) => name === 'start')[1];
  await assert.rejects(readFile(service.path), { code: 'ENOENT' });
});
test('Missing decoder fails before installing a service or changing GooeyPi', async t => {
  const f = await fixture(t, { findFFmpeg: async () => { throw new Error('FFmpeg missing.'); } });
  await assert.rejects(installGooeyPi(f.options), /FFmpeg/);
  assert.equal(f.calls.length, 0); assert.deepEqual(await readJson(f.path), f.original);
});
test('Concurrent GooeyPi update is preserved and service installation is rolled back', async t => {
  const f = await fixture(t);
  const changed = { ...f.original, settings: { ...f.original.settings, theme: 'light' } };
  f.options.waitForServer = async () => writeJson(f.path, changed);
  await assert.rejects(installGooeyPi(f.options), /changed during/);
  assert.deepEqual(await readJson(f.path), changed);
});
test('Manual service edits block reinstall and removal', async t => {
  const f = await fixture(t); await installGooeyPi(f.options);
  const state = await readJson(join(f.locations.root, 'gooeypi-install.json'));
  const { writeFile } = await import('node:fs/promises'); await writeFile(state.service.path, 'foreign service');
  await assert.rejects(installGooeyPi(f.options), /preserved/);
  await assert.rejects(uninstallGooeyPi(f.options), /preserved/);
  assert.equal(await readFile(state.service.path, 'utf8'), 'foreign service');
});
test('Live Electron SingletonLock is recognized; a dead PID is not', async t => {
  const f = await fixture(t);
  const lock = join(f.directory, 'SingletonLock'); await symlink(`host-${process.pid}`, lock);
  assert.equal(await gooeyPiRunning(f.directory, 'linux'), true);
  await rm(lock); await symlink('host-2147483647', lock);
  assert.equal(await gooeyPiRunning(f.directory, 'linux'), false);
});
test('GooeyPi paths follow XDG and macOS conventions, with one explicit override', () => {
  assert.equal(gooeyPiDirectory({ XDG_CONFIG_HOME: '/custom' }, '/home/test', 'linux'), '/custom/gooeypi');
  assert.equal(gooeyPiDirectory({}, '/Users/test', 'darwin'), '/Users/test/Library/Application Support/gooeypi');
  assert.equal(gooeyPiDirectory({ AGENT_VOICE_GOOEYPI_DIR: '/other' }, '/home/test', 'linux'), '/other');
});
test('Service definitions escape paths; macOS needs no shell or global Node', async t => {
  const f = await fixture(t);
  const args = { ...f.options, locations: f.locations, ffmpeg: '/tool & bin/ffmpeg', packageRoot: '/tool %$"/package', uid: 501 };
  const linux = serviceDefinition(args);
  assert.ok(linux.content.includes('%%$$\\"')); assert.ok(linux.content.includes('WantedBy=default.target'));
  const mac = serviceDefinition({ ...args, platform: 'darwin' });
  assert.ok(mac.content.includes('&amp;')); assert.ok(mac.content.includes('&quot;'));
  assert.equal(mac.domain, 'gui/501'); assert.ok(mac.path.endsWith('.plist'));
  assert.throws(() => serviceDefinition({ ...args, packageRoot: '/bad\npath' }), /Invalid service/);
});
test('User service manager issues no privileged commands on Linux or macOS', async () => {
  const calls = [], manager = serviceManager(async (file, args) => { calls.push([file, ...args]); });
  const linux = { platform: 'linux', name: 'agent-voice-transcription.service' };
  await manager.check(linux); await manager.start(linux); await manager.stop(linux);
  assert.ok(calls.every(call => call[0] === 'systemctl' && call[1] === '--user'));
  calls.length = 0;
  const mac = { platform: 'darwin', name: 'dev.agent-voice.transcription', domain: 'gui/501', path: '/test/agent.plist' };
  await manager.start(mac); await manager.stop(mac);
  assert.ok(calls.some(call => call[1] === 'bootstrap' && call[2] === 'gui/501'));
  assert.ok(calls.every(call => call[0] === 'launchctl'));
});
