import { readdir, readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('..', import.meta.url));
for (const dir of ['src', 'bin', 'test', 'scripts']) {
  for (const name of await readdir(join(root, dir))) {
    if (name.endsWith('.mjs')) execFileSync(process.execPath, ['--check', join(root, dir, name)], { stdio: 'inherit' });
  }
}
execFileSync('zsh', ['-n', join(root, 'zsh/agent-voice.plugin.zsh')], { stdio: 'inherit' });
for (const script of ['install.sh', 'bin/launch.sh']) execFileSync('sh', ['-n', join(root, script)], { stdio: 'inherit' });
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
for (const path of [...Object.values(manifest.bin), ...Object.values(manifest.exports), ...manifest.pi.extensions]) await access(join(root, path));
const catalog = JSON.parse(await readFile(join(root, 'src', 'catalog.json'), 'utf8'));
assert.equal(new Set(catalog.map(m => m.id)).size, catalog.length);
for (const model of catalog) {
  assert.match(model.sha256, /^[a-f0-9]{64}$/);
  assert.match(model.revision, /^[a-f0-9]{40}$/);
  assert.ok(Number.isSafeInteger(model.size) && model.size > 0);
}
console.log('Syntax, manifest and catalogue: OK.');
