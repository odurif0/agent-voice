import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, realpath, rm, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const installer = await readFile(join(root, 'install.sh'), 'utf8');
const launcher = await readFile(join(root, 'bin/launch.sh'), 'utf8');
const npmCli = await realpath(execFileSync('/bin/sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim());
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
const linuxSha = '9f5eb6ac21845a66c493c91a253b1da32fd684e89e9b7202d4936982336be4ca';
async function script(path, body) { await writeFile(path, '#!/bin/sh\nset -eu\n' + body + '\n', { mode: 0o755 }); }

async function fixture(t, { node = true, oldNode = false } = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'agent-voice-install-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const tools = join(home, 'tools'), source = join(home, 'source'), prefix = join(home, "a user's test folder"), calls = join(home, 'calls');
  for (const folder of [tools, join(source, 'bin'), join(source, 'src')]) await mkdir(folder, { recursive: true });
  // A restricted PATH simulates a machine without Node/npm. No system changes,
  // microphone, network request, or package-manager scripts are involved.
  for (const command of ['dirname', 'mktemp', 'rm', 'mkdir', 'tar', 'gzip', 'mv', 'ln', 'readlink', 'sh', 'cp', 'env']) {
    const executable = execFileSync('/bin/sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).trim();
    await symlink(executable, join(tools, command));
  }
  if (node || oldNode) {
    if (oldNode) await script(join(tools, 'node'), 'exit 1');
    else await symlink(process.execPath, join(tools, 'node'));
    await symlink(npmCli, join(tools, 'npm'));
  }
  await script(join(tools, 'uname'), 'case "$1" in -s) echo "${TEST_OS:-Linux}" ;; -m) echo x86_64 ;; esac');
  await script(join(tools, 'curl'), `url=''; output=''
while [ "$#" -gt 0 ]; do
  case "$1" in https://*) url=$1 ;; --output) shift; output=$1 ;; esac
  shift
done
printf '%s\\n' "$url" >> "$TEST_DOWNLOADS"
[ "\${TEST_DOWNLOAD_FAIL:-0}" = 0 ] || exit 22
case "$url" in
  https://github.com/odurif0/agent-voice/archive/refs/heads/main.tar.gz) cp "$TEST_SOURCE_ARCHIVE" "$output" ;;
  https://nodejs.org/dist/v24.18.1/node-v24.18.1-linux-x64.tar.gz) cp "$TEST_NODE_ARCHIVE" "$output" ;;
  *) echo "Unexpected URL: $url" >&2; exit 23 ;;
esac`);
  await script(join(tools, 'sha256sum'), `printf '%s  %s\\n' "\${TEST_CHECKSUM:-${linuxSha}}" "$1"`);
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'agent-voice', version: '0.3.0', type: 'module', bin: { 'agent-voice': 'bin/launch.sh', 'forge-voice': 'bin/launch.sh' }, files: ['bin', 'src'] }));
  await writeFile(join(source, 'src/cli.mjs'), '// Installer fixture: no agent is called.\n');
  await writeFile(join(source, 'bin/launch.sh'), launcher, { mode: 0o755 });
  const cli = `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.TEST_CALLS, JSON.stringify({ args: process.argv.slice(2), bin: process.env.AGENT_VOICE_BIN_DIR, executable: process.argv[1] }) + '\\n');
if (process.env.TEST_INSTALL_FAIL === '1') process.exit(17);
`;
  for (const name of ['agent-voice', 'forge-voice']) await writeFile(join(source, 'bin', `${name}.mjs`), cli);
  await writeFile(join(source, 'install.sh'), installer, { mode: 0o755 });
  const nodeFolder = join(home, 'node', 'bin'); await mkdir(nodeFolder, { recursive: true });
  await script(join(nodeFolder, 'node'), `exec ${quote(process.execPath)} "$@"`);
  await script(join(nodeFolder, 'npm'), `exec ${quote(process.execPath)} ${quote(npmCli)} "$@"`);
  const sourceArchive = join(home, 'source.tar.gz'), nodeArchive = join(home, 'node.tar.gz');
  execFileSync('tar', ['-czf', sourceArchive, '-C', home, 'source']);
  execFileSync('tar', ['-czf', nodeArchive, '-C', home, 'node']);
  const env = { ...process.env, HOME: home, PATH: tools, SHELL: '/bin/zsh', AGENT_VOICE_PREFIX: prefix,
    AGENT_VOICE_HOME: join(home, 'shared'), PI_CODING_AGENT_DIR: join(home, 'pi'),
    npm_config_cache: join(home, 'npm-cache'), npm_config_userconfig: join(home, 'npmrc'), npm_config_update_notifier: 'false',
    TEST_CALLS: calls, TEST_DOWNLOADS: join(home, 'downloads'), TEST_SOURCE_ARCHIVE: sourceArchive, TEST_NODE_ARCHIVE: nodeArchive };
  delete env.npm_config_prefix;
  // Shell startup hooks must not reintroduce a system Node into the sandbox.
  delete env.BASH_ENV; delete env.ENV;
  async function run(args = [], { pipe = false, overrides = {} } = {}) {
    const child = spawn('/bin/sh', pipe ? ['-s', '--', ...args] : [join(source, 'install.sh'), ...args], { cwd: home, env: { ...env, ...overrides }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', x => { output += x; }); child.stderr.on('data', x => { output += x; });
    child.stdin.on('error', () => {}); child.stdin.end(pipe ? installer : '');
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    return { code, output };
  }
  const records = async () => (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
  const downloads = async () => (await readFile(env.TEST_DOWNLOADS, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  return { home, source, prefix, tools, env, run, records, downloads };
}

test('Local installer: reuse existing Node, preserve arguments and paths with apostrophes', async t => {
  const f = await fixture(t), args = ['--yes', '--model', "/a user's test model.gguf"];
  const result = await f.run(['all', ...args]); assert.equal(result.code, 0, result.output);
  assert.deepEqual((await f.records()).map(x => x.args), [['install', 'gooeypi', ...args], ['install', 'forge', ...args], ['install', 'pi', ...args]]);
  assert.equal((await f.records())[0].bin, join(f.prefix, 'bin'));
  assert.deepEqual(await f.downloads(), []);
  await assert.rejects(lstat(join(f.prefix, 'lib/node_modules/agent-voice/.node-runtime')), { code: 'ENOENT' });
  const link = join(f.prefix, 'bin/forge-voice');
  execFileSync(link, ['--version'], { env: f.env });
  assert.ok((await f.records()).at(-1).executable.endsWith('/bin/forge-voice.mjs'));
});

test('curl | sh: download and install with npm, without cloning or letting children consume the script', async t => {
  const f = await fixture(t), result = await f.run(['forge', '--yes'], { pipe: true });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(await f.downloads(), ['https://github.com/odurif0/agent-voice/archive/refs/heads/main.tar.gz']);
  assert.deepEqual((await f.records())[0].args, ['install', 'forge', '--yes']);
});

test('No Node installed: private runtime, working commands, no download on reinstall', async t => {
  const f = await fixture(t, { node: false });
  for (let i = 0; i < 2; i++) {
    const result = await f.run(['forge', '--yes']); assert.equal(result.code, 0, result.output);
    execFileSync(join(f.prefix, 'bin/agent-voice'), ['--version'], { env: f.env });
    execFileSync(join(f.prefix, 'bin/forge-voice'), ['--version'], { env: f.env });
  }
  assert.equal((await f.downloads()).length, 1);
  assert.deepEqual((await readdir(join(f.prefix, 'bin'))).sort(), ['agent-voice', 'forge-voice']);
  assert.equal((await f.records()).filter(x => x.args[0] === '--version').length, 4);
});

test('Outdated Node: do not replace its executable or install a global node command', async t => {
  const f = await fixture(t, { oldNode: true, node: false }), before = await readFile(join(f.tools, 'node'));
  const result = await f.run(['pi', '--yes']); assert.equal(result.code, 0, result.output);
  assert.deepEqual(await readFile(join(f.tools, 'node')), before);
  await assert.rejects(lstat(join(f.prefix, 'bin/node')), { code: 'ENOENT' });
  assert.deepEqual((await f.records())[0].args, ['install', 'pi', '--yes']);
});

test('Incorrect Node checksum: stop before installing or enabling anything', async t => {
  const f = await fixture(t, { node: false });
  const result = await f.run(['forge', '--yes'], { overrides: { TEST_CHECKSUM: '0'.repeat(64) } });
  assert.notEqual(result.code, 0); assert.match(result.output, /SHA-256.*mismatch/);
  await assert.rejects(f.records(), { code: 'ENOENT' });
  await assert.rejects(lstat(join(f.prefix, 'bin')), { code: 'ENOENT' });
});

test('Download failure: do not report success or enable the module', async t => {
  const f = await fixture(t), result = await f.run(['forge', '--yes'], { pipe: true, overrides: { TEST_DOWNLOAD_FAIL: '1' } });
  assert.notEqual(result.code, 0); await assert.rejects(f.records(), { code: 'ENOENT' });
});

test('Setup failure: preserve the nonzero exit code', async t => {
  const f = await fixture(t), result = await f.run(['forge', '--yes'], { overrides: { TEST_INSTALL_FAIL: '1' } });
  assert.equal(result.code, 17, result.output);
});

test('Unsupported target or system: refuse before downloading anything', async t => {
  const f = await fixture(t);
  assert.equal((await f.run(['other'])).code, 2);
  assert.equal((await f.run(['--help'])).code, 0);
  const result = await f.run(['forge'], { overrides: { TEST_OS: 'MINGW64_NT' } });
  assert.notEqual(result.code, 0); assert.match(result.output, /Linux and macOS/);
  assert.deepEqual(await f.downloads(), []);
});
