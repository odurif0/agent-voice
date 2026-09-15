import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { isInteractiveForge, runForge, passthrough } from '../src/forge.mjs';

for (const args of [[], ['--agent', 'muse'], ['-C', '/tmp'], ['-C/tmp'], ['--directory=/tmp'], ['--sandbox', 'speech', '--verbose'], ['--cid', 'abc'], ['--']]) {
  test(`Interactive Forge recognized: ${JSON.stringify(args)}`, () => assert.equal(isInteractiveForge(args), true));
}
for (const args of [['--help'], ['--version'], ['list', 'models'], ['zsh', 'plugin'], ['-p', 'Hello'], ['--agent', 'forge', '-p', 'Hello'], ['--conversation', '/tmp/x'], ['--event', '{}'], ['--unknown'], ['--agent'], ['--agent', '--help'], ['--directory='], ['--', 'help']]) {
  test(`Forge forwarded without a PTY: ${JSON.stringify(args)}`, () => assert.equal(isInteractiveForge(args), false));
}
test('Pipes and non-interactive calls: no model or microphone; preserve arguments and exit code', async () => {
  for (const [input, output, args] of [[false, true, []], [true, false, []], [true, true, ['--agent', 'forge', 'config', 'list']]]) {
    assert.equal(await runForge(args, {
      input: { isTTY: input }, output: { isTTY: output },
      prepare: () => assert.fail('unexpected audio setup'),
      passthrough: (command, forwarded) => { assert.equal(command, 'forge'); assert.equal(forwarded, args); return 23; },
    }), 23);
  }
});
test('Interactive Forge: forward the same terminal and arguments to the existing engine', async () => {
  const args = ['--agent', 'muse'], settings = { model: 'shared' };
  assert.equal(await runForge(args, {
    input: { isTTY: true }, output: { isTTY: true },
    prepare: async options => { assert.deepEqual(options, { terminal: true }); return settings; },
    runTerminal: (command, forwarded, actual) => { assert.equal(command, 'forge'); assert.equal(forwarded, args); assert.equal(actual, settings); return 7; },
    passthrough: () => assert.fail(),
  }), 7);
});
test('Passthrough: exit code and signal handler cleanup', async () => {
  const before = process.listenerCount('SIGTERM'), child = new EventEmitter(); child.kill = () => {};
  const work = passthrough('forge', ['config'], { spawn: (command, args, options) => {
    assert.equal(command, 'forge'); assert.deepEqual(args, ['config']); assert.deepEqual(options, { stdio: 'inherit' });
    setImmediate(() => child.emit('exit', null, 'SIGTERM')); return child;
  } });
  assert.equal(await work, 143); assert.equal(process.listenerCount('SIGTERM'), before);
});
