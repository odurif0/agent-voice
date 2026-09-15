import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, readlink, symlink, lstat, rm, chmod } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { installZsh, uninstallZsh, shellPath, zshStatus } from '../src/install-zsh.mjs';
import { PACKAGE_ROOT } from '../src/install-pi.mjs';
import { readJson } from '../src/storage.mjs';
import { sandbox } from './helpers.mjs';

const original = `export ZSH="$HOME/.oh-my-zsh"\nplugins=(git fzf)\nsource "$ZSH/oh-my-zsh.sh"\n# >>> forge initialize >>>\neval "$(forge zsh plugin)"\n# <<< forge initialize <<<\n`;
async function fixture(t, text = original) {
  const locations = await sandbox(t), home = dirname(locations.root);
  await mkdir(join(home, '.oh-my-zsh'), { recursive: true });
  await writeFile(join(home, '.oh-my-zsh/oh-my-zsh.sh'), '# fixture\n');
  const rc = join(home, '.zshrc');
  if (text !== null) await writeFile(rc, text);
  return { locations, home, rc, env: { HOME: home, SHELL: '/bin/zsh' } };
}
test('Oh My Zsh: add before loading, unique plugin, intact Forge block, exact removal', async t => {
  const f = await fixture(t); await chmod(f.rc, 0o644);
  const result = await installZsh(f);
  assert.equal(result.ohMyZsh, true);
  const after = await readFile(f.rc, 'utf8');
  assert.ok(after.indexOf('plugins+=(agent-voice)') < after.indexOf('source "$ZSH/oh-my-zsh.sh"'));
  assert.ok(after.endsWith(original.slice(original.indexOf('# >>> forge'))));
  assert.equal(await readlink(result.pluginLink), join(PACKAGE_ROOT, 'zsh'));
  assert.equal((await lstat(f.rc)).mode & 0o777, 0o644);
  assert.equal((await zshStatus(f.locations)).valid, true);
  await installZsh(f); assert.equal(await readFile(f.rc, 'utf8'), after);
  await uninstallZsh(f); assert.equal(await readFile(f.rc, 'utf8'), original);
  await assert.rejects(lstat(result.pluginLink), { code: 'ENOENT' });
  await uninstallZsh(f);
});
test('Oh My Zsh: custom directory with spaces and an apostrophe', async t => {
  const text = original.replace('plugins=', 'ZSH_CUSTOM="$HOME/a user\'s test plugins"\nplugins=');
  const f = await fixture(t, text), result = await installZsh(f);
  assert.equal(result.pluginLink, join(f.home, "a user's test plugins/plugins/agent-voice"));
  await uninstallZsh(f); assert.equal(await readFile(f.rc, 'utf8'), text);
});
test('ZDOTDIR and symlinked .zshrc: edit the target, preserve the link', async t => {
  const f = await fixture(t), folder = join(f.home, 'config'); await mkdir(folder);
  const link = join(folder, '.zshrc'); await symlink(f.rc, link);
  await installZsh({ ...f, env: { ...f.env, ZDOTDIR: folder } });
  assert.equal(await readlink(link), f.rc);
  await uninstallZsh(f); assert.equal(await readFile(f.rc, 'utf8'), original); assert.equal(await readlink(link), f.rc);
});
test('Zsh without Oh My Zsh: source once, restore missing final newline', async t => {
  const text = 'PROMPT="test> "', f = await fixture(t, text);
  const result = await installZsh(f); assert.equal(result.ohMyZsh, false);
  assert.ok((await readFile(f.rc, 'utf8')).includes('/zsh/agent-voice.plugin.zsh'));
  await uninstallZsh(f); assert.equal(await readFile(f.rc, 'utf8'), text);
});
test('Zsh without settings: create then remove only the created file', async t => {
  const f = await fixture(t, null); await installZsh(f); await uninstallZsh(f);
  await assert.rejects(lstat(f.rc), { code: 'ENOENT' });
});
test('User changes outside the block: preserve during removal', async t => {
  const f = await fixture(t); await installZsh(f);
  await writeFile(f.rc, (await readFile(f.rc, 'utf8')) + 'alias personal=true\n');
  await uninstallZsh(f); assert.equal(await readFile(f.rc, 'utf8'), original + 'alias personal=true\n');
});
test('Manually edited voice block: refuse removal or replacement', async t => {
  const f = await fixture(t); const result = await installZsh(f);
  const changed = (await readFile(f.rc, 'utf8')).replace('plugins+=(agent-voice)', 'plugins+=(agent-voice other)');
  await writeFile(f.rc, changed);
  await assert.rejects(uninstallZsh(f), /edited manually/);
  await assert.rejects(installZsh(f), /edited manually/);
  assert.equal(await readFile(f.rc, 'utf8'), changed); assert.ok(await readlink(result.pluginLink));
});
test('Plugin name collision: do not overwrite an existing directory', async t => {
  const f = await fixture(t), link = join(f.home, '.oh-my-zsh/custom/plugins/agent-voice');
  await mkdir(link, { recursive: true }); await writeFile(join(link, 'personal'), 'preserve');
  await assert.rejects(installZsh(f), /Another plugin/);
  assert.equal(await readFile(f.rc, 'utf8'), original); assert.equal(await readFile(join(link, 'personal'), 'utf8'), 'preserve');
});
test('Compatible existing link: neither rewrite nor remove it', async t => {
  const f = await fixture(t), link = join(f.home, '.oh-my-zsh/custom/plugins/agent-voice');
  await mkdir(dirname(link), { recursive: true });
  const target = relative(dirname(link), join(PACKAGE_ROOT, 'zsh')); await symlink(target, link);
  await installZsh(f); assert.equal(await readlink(link), target);
  await uninstallZsh(f); assert.equal(await readlink(link), target);
});
test('Link replaced by the user: preserve the replacement', async t => {
  const f = await fixture(t), result = await installZsh(f);
  await rm(result.pluginLink); await symlink('/another/plugin', result.pluginLink);
  await uninstallZsh(f); assert.equal(await readlink(result.pluginLink), '/another/plugin');
});
test('Dynamic path: do not execute .zshrc code or change anything', async t => {
  const f = await fixture(t), sentinel = join(f.home, 'DO_NOT_CREATE');
  const text = original.replace('plugins=', `ZSH_CUSTOM="$(touch '${sentinel}')/custom"\nplugins=`);
  await writeFile(f.rc, text);
  await assert.rejects(installZsh(f), /dynamic/);
  assert.equal(await readFile(f.rc, 'utf8'), text); await assert.rejects(lstat(sentinel), { code: 'ENOENT' });
});
test('Validation error: leave settings, plugin and registry unchanged', async t => {
  const f = await fixture(t);
  await assert.rejects(installZsh({ ...f, checkSyntax: () => { throw new Error('syntax'); } }), /syntax/);
  assert.equal(await readFile(f.rc, 'utf8'), original);
  assert.equal(await readJson(join(f.locations.root, 'zsh-install.json'), undefined), undefined);
});
test('Concurrent installations: a single block and exact removal', async t => {
  const f = await fixture(t); await Promise.all(Array.from({ length: 4 }, () => installZsh(f)));
  assert.equal((await readFile(f.rc, 'utf8')).match(/# >>> agent-voice initialize >>>/g).length, 1);
  await uninstallZsh(f); assert.equal(await readFile(f.rc, 'utf8'), original);
});
test('Other shell: do not force Zsh integration', async t => {
  const f = await fixture(t);
  assert.deepEqual(await installZsh({ ...f, env: { ...f.env, SHELL: '/bin/bash' } }), { installed: false });
  assert.equal(await readFile(f.rc, 'utf8'), original);
});
test('PATH: append once, literal paths, reinstall and reversible removal', async t => {
  const f = await fixture(t), binDir = join(f.home, "a user's test commands");
  await mkdir(binDir);
  await installZsh({ ...f, env: { ...f.env, AGENT_VOICE_BIN_DIR: binDir } });
  const state = await readJson(join(f.locations.root, 'zsh-install.json'));
  const result = execFileSync('zsh', ['-fc', state.block + state.block + 'print -r -- "$PATH"'], {
    env: { ...f.env, PATH: '/usr/bin:/bin' }, encoding: 'utf8',
  }).trim();
  assert.equal(result, `/usr/bin:/bin:${binDir}`);
  const installed = await readFile(f.rc, 'utf8');
  await installZsh(f); assert.equal(await readFile(f.rc, 'utf8'), installed);
  await uninstallZsh(f); assert.equal(await readFile(f.rc, 'utf8'), original);
});
test('PATH: reject relative paths and newline injection without changing Zsh', async t => {
  const f = await fixture(t);
  for (const binDir of ['relative/bin', '/tmp/bin\ncommand']) {
    await assert.rejects(installZsh({ ...f, env: { ...f.env, AGENT_VOICE_BIN_DIR: binDir } }), /absolute path/);
    assert.equal(await readFile(f.rc, 'utf8'), original);
  }
});
test('Path resolution: concatenate quotes, variables and tilde; never eval', () => {
  const vars = { HOME: '/home/test', ZSH: '/home/test/.oh-my-zsh' };
  assert.equal(shellPath('"$ZSH"/custom', vars), '/home/test/.oh-my-zsh/custom');
  assert.equal(shellPath('~/custom', vars), '/home/test/custom');
  assert.equal(shellPath('"${HOME}/my plugins" # comment', vars), '/home/test/my plugins');
  assert.equal(shellPath("'/literal/$HOME'", vars), '/literal/$HOME');
  assert.throws(() => shellPath('$(command)', vars));
  assert.throws(() => shellPath('/tmp/`command`', vars));
});
