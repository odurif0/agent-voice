import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../src/paths.mjs';

export async function sandbox(t) {
  // macOS exposes /private/var through /var. Compare physical paths everywhere.
  const home = await realpath(await mkdtemp(join(tmpdir(), 'agent-voice-test-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  return paths({ AGENT_VOICE_HOME: join(home, 'shared'), PI_CODING_AGENT_DIR: join(home, 'pi') }, home, 'linux');
}
export async function fakePackage(prefix, spec) {
  const root = join(prefix, 'node_modules', spec.name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: spec.name, version: spec.version, main: 'index.js' }));
  await writeFile(join(root, 'index.js'), 'module.exports = { fake: true };');
  return root;
}
export function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
export const gguf = Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(28, 1)]);
