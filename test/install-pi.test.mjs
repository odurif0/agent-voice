import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { installPi, uninstallPi } from '../src/install-pi.mjs';
import { writeJson, readJson } from '../src/storage.mjs';
import { sandbox } from './helpers.mjs';

test('Repeatable Pi install: preserve settings and disable only the previous extension', async t => {
  const p = await sandbox(t), path = join(p.pi, 'settings.json');
  const original = { defaultModel: 'test-model', theme: 'dark', packages: ['npm:unrelated', 'git:github.com/earendil-works/pi-transcribe'] };
  await writeJson(path, original);
  await installPi({ locations: p, packageRoot: '/test/agent-voice' });
  await installPi({ locations: p, packageRoot: '/test/agent-voice' });
  const installed = await readJson(path);
  assert.equal(installed.defaultModel, original.defaultModel); assert.equal(installed.theme, 'dark');
  assert.equal(installed.packages.length, 3);
  assert.deepEqual(installed.packages[1], { source: original.packages[1], extensions: [] });
  await uninstallPi({ locations: p, packageRoot: '/test/agent-voice' });
  assert.deepEqual(await readJson(path), original);
});
test('Previous extension pinned to an npm or Git version: no duplicate shortcut', async t => {
  const p = await sandbox(t), path = join(p.pi, 'settings.json');
  const packages = ['npm:@earendil-works/pi-transcribe@0.1.0', 'git:github.com/earendil-works/pi-transcribe.git@main'];
  await writeJson(path, { packages });
  await installPi({ locations: p, packageRoot: '/test/agent-voice' });
  for (const entry of (await readJson(path)).packages.slice(0, 2)) assert.deepEqual(entry.extensions, []);
  await uninstallPi({ locations: p, packageRoot: '/test/agent-voice' });
  assert.deepEqual((await readJson(path)).packages, packages);
});
test('Pi installed after Forge: no dependency on a previous extension', async t => {
  const p = await sandbox(t);
  await installPi({ locations: p, packageRoot: '/test/agent-voice' });
  assert.deepEqual((await readJson(join(p.pi, 'settings.json'))).packages, ['/test/agent-voice']);
});
test('Uninstall: preserve intervening user changes', async t => {
  const p = await sandbox(t), path = join(p.pi, 'settings.json');
  await writeJson(path, { packages: ['git:github.com/earendil-works/pi-transcribe'] });
  await installPi({ locations: p, packageRoot: '/test/agent-voice' });
  const settings = await readJson(path); settings.packages[0].extensions = ['some-extension.ts']; await writeJson(path, settings);
  await uninstallPi({ locations: p, packageRoot: '/test/agent-voice' });
  assert.deepEqual((await readJson(path)).packages[0].extensions, ['some-extension.ts']);
});
