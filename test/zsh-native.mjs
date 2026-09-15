import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, readdir, rm, symlink, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import xterm from '@xterm/headless';
import { installZsh, uninstallZsh } from '../src/install-zsh.mjs';
import { paths } from '../src/paths.mjs';
import { readJson, writeJson } from '../src/storage.mjs';

const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
const key = '\x1b\x1a', probeKey = '\x1b[24~';

export async function checkZsh({ pty, root, env, packageRoot, play, phrase }) {
  const folder = join(root, 'zsh'), custom = join(folder, 'custom'), snapshot = join(folder, 'snapshot');
  const omz = env.ZSH || join(homedir(), '.oh-my-zsh');
  await access(join(omz, 'oh-my-zsh.sh'));
  await mkdir(join(custom, 'plugins'), { recursive: true });
  await mkdir(join(folder, 'tmp'), { recursive: true });
  const dualHistory = join(env.ZSH_CUSTOM || join(omz, 'custom'), 'plugins/zsh-dual-history');
  let plugins = 'git fzf';
  try { await access(dualHistory); await symlink(dualHistory, join(custom, 'plugins/zsh-dual-history')); plugins += ' zsh-dual-history'; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const zenv = { ...env, SHELL: '/bin/zsh', ZDOTDIR: folder, ZSH: omz, ZSH_CUSTOM: custom, TMPDIR: join(folder, 'tmp'),
    DISABLE_AUTO_UPDATE: 'true', FORGE_SYNC_ENABLED: 'false', DUAL_HISTORY_AI_FILE: join(folder, 'ai-history'),
    ZSH_COMPDUMP: join(folder, '.zcompdump'), ZSH_CACHE_DIR: join(folder, 'cache') };
  const rc = `export ZSH=${quote(omz)}\nZSH_CUSTOM=${quote(custom)}\nZSH_THEME=robbyrussell\nDISABLE_AUTO_UPDATE=true\nzstyle ':omz:update' mode disabled\nplugins=(${plugins})\nsource "$ZSH/oh-my-zsh.sh"\nHISTFILE=${quote(join(folder, 'history'))}\nHISTSIZE=1000\nSAVEHIST=1000\n# >>> forge initialize >>>\neval "$(forge zsh plugin)"\neval "$(forge zsh theme)"\n# <<< forge initialize <<<\nfunction _av_test_probe() {\n    print -rn -- "$BUFFER"$'\\0'"$CURSOR"$'\\0'"$KEYMAP" > ${quote(snapshot)}\n}\nzle -N _av_test_probe\nfor map in emacs viins vicmd; do bindkey -M "$map" $'\\e[24~' _av_test_probe; done\nfunction _av_test_ready() {\n    { bindkey '^M'; bindkey '^I'; bindkey '^R'; whence -w forge; } > ${quote(join(folder, 'bindings'))}\n}\nautoload -Uz add-zle-hook-widget\nadd-zle-hook-widget line-init _av_test_ready\n`;
  await writeFile(join(folder, '.zshrc'), rc);
  const p = paths(zenv), originalConfig = await readJson(p.config);
  const installed = await installZsh({ env: zenv, locations: p, packageRoot });
  assert.equal(installed.ohMyZsh, true);
  const installedRc = await readFile(join(folder, '.zshrc'), 'utf8');
  await installZsh({ env: zenv, locations: p, packageRoot });
  assert.equal(await readFile(join(folder, '.zshrc'), 'utf8'), installedRc);

  async function shell(label, exercise) {
    await rm(join(folder, 'bindings'), { force: true });
    const terminal = new xterm.Terminal({ cols: 110, rows: 30, allowProposedApi: true, scrollback: 2000 });
    const child = pty.spawn('zsh', ['-i'], { name: 'xterm-256color', cols: 110, rows: 30, cwd: root, env: zenv });
    let raw = '', exited = false;
    terminal.onData(data => { if (!exited) child.write(data); });
    child.onData(data => { raw += data; terminal.write(data); });
    child.onExit(() => { exited = true; });
    const screen = () => Array.from({ length: terminal.rows }, (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + i)?.translateToString(true) || '').join('\n');
    const save = async name => {
      await sleep(80); await writeFile(join(root, `${label}-${name}.txt`), screen()); await writeFile(join(root, `${label}.raw`), raw);
    };
    const wait = async (fn, name, timeout = 25_000) => {
      const start = Date.now();
      while (!await fn()) {
        if (exited || Date.now() - start > timeout) { await save('FAILED'); throw new Error(`${label}: ${name}\n${screen()}`); }
        await sleep(60);
      }
    };
    const probe = async () => {
      await rm(snapshot, { force: true });
      await wait(async () => {
        child.write(probeKey); await sleep(50);
        return access(snapshot).then(() => true, () => false);
      }, 'probe widget responds (editor not stuck)');
      return (await readFile(snapshot, 'utf8')).split('\0');
    };
    const clear = async () => { child.write('\x03'); await sleep(150); assert.equal((await probe())[0], ''); };
    try {
      await wait(() => access(join(folder, 'bindings')).then(() => true, () => false), 'Zsh fully initialized');
      await sleep(250);
      const bindings = await readFile(join(folder, 'bindings'), 'utf8');
      assert.ok(bindings.includes('forge-accept-line')); assert.ok(bindings.includes('forge-completion'));
      assert.ok(bindings.includes('forge: function'));
      await exercise({ child, terminal, screen, save, wait, probe, clear, raw: () => raw, bindings, exited: () => exited });
    } finally {
      child.kill(); await sleep(400); terminal.dispose();
      await writeFile(join(root, `${label}.raw`), raw);
    }
  }
  try {
    await shell('zsh', async ({ child, terminal, screen, save, wait, probe, clear, raw, bindings }) => {
      if (plugins.includes('zsh-dual-history')) assert.match(bindings, /dual.history/);
      // Shell commands are deliberately outside the scope of Forge dictation.
      child.write('printf preserve'); await sleep(100); child.write(key); await sleep(150);
      assert.equal((await probe())[0], 'printf preserve'); await save('shell-command-preserved'); await clear();
      // Cancelling on an empty prompt must not even insert the ": " prefix.
      child.write(key); await wait(() => screen().includes('● Recording'), 'recording on empty line');
      child.write('\t\x1b[D' + '\x1b[200~pasted text\r\x1b[201~'); await sleep(100);
      assert.ok(screen().includes('● Recording'), 'a pasted newline must not stop recording');
      child.write('\x1b'); await sleep(300); assert.equal((await probe())[0], '');
      // An Enter queued immediately after the shortcut also stops initialization.
      child.write(': immediate stop'); const immediate = await probe(); child.write(key + '\r');
      await sleep(100); assert.deepEqual(await probe(), immediate); await clear();
      // Ctrl+C interrupts ZLE itself; the next line-init must recover the buffer.
      child.write(': cancellation'); const cancelled = await probe(); child.write(key);
      await wait(() => screen().includes('● Recording'), 'Ctrl+C cancellation'); child.write('\x03'); await sleep(250);
      assert.deepEqual(await probe(), cancelled); await clear();
      // Empty Zsh prompt -> Forge request, never a shell command or auto-send.
      child.write(key); await wait(() => screen().includes('● Recording'), 'first dictated request');
      assert.ok(screen().includes('Enter or Ctrl+Alt+Z: stop'));
      await save('recording'); await play(); await sleep(150); child.write('\r\n');
      await wait(() => screen().replaceAll('\n', '').includes(`: ${phrase}`), 'Enter stops and inserts with automatic Forge prefix');
      const empty = await probe(); assert.equal(empty[0], `: ${phrase}`); assert.equal(Number(empty[1]), empty[0].length);
      await save('transcribed'); await clear();
      // Preserve typed agent, Unicode, surrounding text and cursor position.
      child.write(':muse BEFORE \u00e9  AFTER' + '\x1b[D'.repeat(6)); await sleep(100); child.write(key);
      await wait(() => screen().includes('● Recording'), 'dictation inside existing request');
      child.write('\t'); await play(); await sleep(150); child.write(key);
      await wait(() => screen().replaceAll('\n', '').includes(`:muse BEFORE \u00e9 ${phrase} AFTER`), 'cursor insertion');
      const inserted = await probe(); assert.equal(inserted[0], `:muse BEFORE \u00e9 ${phrase} AFTER`);
      assert.equal(Number(inserted[1]), `:muse BEFORE \u00e9 ${phrase}`.length);
      child.write(key); await wait(() => screen().includes('● Recording'), 'cancel populated line'); child.write('\x03');
      await sleep(250); assert.deepEqual(await probe(), inserted); await save('cancelled');
      terminal.resize(75, 24); child.resize(75, 24); await sleep(250); assert.deepEqual(await probe(), inserted);
      await save('resized'); await clear();
      // Ordinary Forge CLI and shell history remain ordinary shell operations.
      let start = raw().length; child.write('forge --version\r');
      await wait(() => /forge \d+\.\d+/.test(raw().slice(start)), 'Forge --version unchanged');
      await sleep(150); child.write('\x1b[A'); assert.equal((await probe())[0], 'forge --version'); await clear();
      child.write('cat definitely-unique-completion-fixture');
      await writeFile(join(root, 'definitely-unique-completion-fixture.txt'), 'test'); child.write('\t');
      await sleep(250); assert.ok((await probe())[0].includes('definitely-unique-completion-fixture.txt')); await clear();
      // Native Forge must enter its voice-enabled PTY via the normal command.
      start = raw().length; child.write('forge\r');
      await wait(() => raw().slice(start).includes('\x1b[?2004h'), 'ordinary forge starts');
      await wait(() => screen().includes('Voice: Ctrl+Alt+Z'), 'automatic voice launcher');
      child.write('preserved text'); await sleep(100); child.write(key);
      await wait(() => screen().includes('● Recording'), 'microphone inside ordinary forge');
      child.write('\x1b'); await sleep(300); assert.ok(screen().includes('preserved text'));
      await wait(() => screen().includes('Voice: Ctrl+Alt+Z to dictate'), 'Forge ready after cancellation');
      await save('forge-automatic'); start = raw().length; child.write('\x03');
      await wait(() => raw().slice(start).includes('\x1b[?2004h'), 'new Forge editor after Ctrl+C');
      child.write('\x04'); await sleep(500); assert.equal((await probe())[0], '');
      // Vi-mode keymaps are restored after recording, including vim-style edits.
      child.write('bindkey -v; _forge_apply_keybindings; _agent_voice_bind_keys\r'); await sleep(250);
      child.write(': preserve\x1b'); assert.equal((await probe())[2], 'vicmd');
      child.write('A'); const vi = await probe();
      // Zsh may report "main" (an alias of viins), not the canonical map name.
      assert.equal(vi[0], ': preserve'); assert.equal(Number(vi[1]), vi[0].length);
      child.write(key); await wait(() => screen().includes('● Recording'), 'vi-mode recording'); child.write('\x1b'); await sleep(250);
      assert.deepEqual(await probe(), vi); child.write('!'); assert.equal((await probe())[0], ': preserve!'); await clear();
      console.log('zsh: real OMZ/Forge plugin, Enter stops (also during initialization) without submitting, shortcut still works, paste blocked, Unicode/cursor insertion, cancellation, resize, completion, history, ordinary forge, vi-mode OK.');
    });
    await shell('zsh-disconnect', async ({ child, screen, wait, probe, save, clear, exited }) => {
      const pid = () => {
        try { return execFileSync('ps', ['-o', 'pid=,args=', '--ppid', String(child.pid)], { encoding: 'utf8' })
          .split('\n').find(line => line.includes('/bin/agent-voice.mjs zsh-session'))?.trim().split(/\s+/)[0]; }
        catch { return undefined; }
      };
      const alive = id => readFile(`/proc/${id}/status`, 'utf8').then(text => !/State:\s+Z/.test(text), () => false);
      const channels = async () => (await readdir(zenv.TMPDIR)).filter(name => name.startsWith('agent-voice-zsh.'));
      child.write(': preserve after crash'); const before = await probe(); child.write(key);
      await wait(() => screen().includes('● Recording'), 'worker ready before forced crash');
      const crashed = pid(); assert.ok(crashed); process.kill(Number(crashed), 'SIGKILL');
      await wait(() => screen().includes('Voice: worker interrupted.'), 'crash reported');
      assert.deepEqual(await probe(), before); assert.deepEqual(await channels(), []); await save('crash-recovered');
      // A stale microphone lock left by SIGKILL must not prevent the next take.
      child.write(key); await wait(() => screen().includes('● Recording'), 'microphone recovered after crash');
      child.write('\x1b'); await sleep(250); assert.deepEqual(await probe(), before); await clear();
      // EOF bypasses ZLE key bindings on an empty line: zshexit must release it.
      child.write(key); await wait(() => screen().includes('● Recording'), 'recording before shell exit');
      const closing = pid(); assert.ok(closing); child.write('\x04');
      await wait(exited, 'shell exits normally');
      const deadline = Date.now() + 5_000;
      while (await alive(closing) && Date.now() < deadline) await sleep(50);
      assert.equal(await alive(closing), false, 'worker exits with its shell');
      assert.deepEqual(await channels(), []);
      console.log('zsh: crashed worker recovered; shell EOF releases microphone and control channels.');
    });
    await writeJson(p.config, { ...originalConfig, shortcut: 'f2' });
    await shell('zsh-f2', async ({ child, screen, wait, probe, save }) => {
      child.write(': F2'); const before = await probe(); child.write('\x1bOQ');
      await wait(() => screen().includes('● Recording'), 'configured F2 shortcut'); child.write('\x1b'); await sleep(250);
      assert.deepEqual(await probe(), before); await save('cancelled');
      console.log('zsh: shared F2 setting respected.');
    });
  } finally {
    await writeJson(p.config, originalConfig);
    await uninstallZsh({ locations: p });
    assert.equal(await readFile(join(folder, '.zshrc'), 'utf8'), rc);
  }
  console.log('zsh: installation/reinstallation/uninstallation preserve the original rc exactly.');
  // Also exercise the official-plugin auto-loader, with and without Oh My Zsh.
  const autoRc = rc.replace(/# >>> forge initialize >>>\n[\s\S]*?# <<< forge initialize <<<\n/, '');
  for (const [label, startup, expectedOmz] of [
    ['zsh-autoload', autoRc, true],
    ['zsh-plain', autoRc.replace('source "$ZSH/oh-my-zsh.sh"', 'autoload -Uz add-zsh-hook'), false],
  ]) {
    await writeFile(join(folder, '.zshrc'), startup);
    const added = await installZsh({ env: zenv, locations: p, packageRoot }); assert.equal(added.ohMyZsh, expectedOmz);
    try {
      await shell(label, async ({ child, screen, wait, probe, save }) => {
        child.write(': automatic loading'); const before = await probe(); child.write(key);
        await wait(() => screen().includes('● Recording'), 'automatically loaded Forge plugin');
        child.write('\x1b'); await sleep(250); assert.deepEqual(await probe(), before); await save('working');
      });
    } finally {
      await uninstallZsh({ locations: p }); assert.equal(await readFile(join(folder, '.zshrc'), 'utf8'), startup);
    }
  }
  console.log('zsh: official Forge plugin auto-loaded when absent, both with and without OMZ.');
}
