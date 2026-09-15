import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import xterm from '@xterm/headless';

export async function checkJobControl({ pty, root, env, packageRoot }) {
  const terminal = new xterm.Terminal({ cols: 100, rows: 30, allowProposedApi: true });
  const shell = pty.spawn('/bin/bash', ['--noprofile', '--norc'], {
    name: 'xterm-256color', cols: 100, rows: 30, cwd: root,
    env: { ...env, PS1: 'VOICE_TEST> ', LC_ALL: 'C' },
  });
  let raw = '', exited = false;
  shell.onData(data => { raw += data; terminal.write(data); });
  shell.onExit(() => { exited = true; });
  terminal.onData(data => { if (!exited) shell.write(data); });
  const screen = () => Array.from({ length: terminal.rows }, (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + i)?.translateToString(true) || '').join('\n');
  const wait = async (predicate, label) => {
    const start = Date.now();
    while (!predicate()) {
      if (exited || Date.now() - start > 15_000) throw new Error(`Job control: ${label}\n${screen()}`);
      await sleep(60);
    }
  };
  const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
  try {
    await wait(() => raw.includes('VOICE_TEST> '), 'shell ready');
    shell.write(`${quote(process.execPath)} ${quote(join(packageRoot, 'bin', 'forge-voice.mjs'))}\r`);
    await wait(() => raw.includes('Initialize'), 'Forge ready');
    await sleep(500); shell.write('preserved text'); await sleep(150); shell.write('\x1a');
    await wait(() => raw.includes('Stopped'), 'Ctrl+Z suspends the job');
    await sleep(150); shell.write('fg\r'); await sleep(500); shell.write('!'); await sleep(200);
    assert.ok(screen().includes('preserved text!'), 'fg restores the editor, buffer and physical cursor');
    await writeFile(join(root, 'forge-resumed.txt'), screen());
    const end = raw.length;
    shell.write('\x03');
    // Ctrl+C closes the current Rustyline editor and can flush queued input.
    // Wait for the next editor before sending EOF, rather than racing both keys.
    await wait(() => raw.slice(end).includes('\x1b[?2004h'), 'new editor after Ctrl+C');
    shell.write('\x04');
    await wait(() => raw.slice(end).includes('VOICE_TEST> '), 'Forge exits back to the shell');
    console.log('forge: Ctrl+Z/fg preserves the prompt and restores the terminal.');
  } finally {
    shell.kill(); await sleep(200); terminal.dispose();
    await writeFile(join(root, 'job-control.raw'), raw);
  }
}
