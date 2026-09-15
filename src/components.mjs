import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { paths } from './paths.mjs';
import { readJson, writeJson, withLock } from './storage.mjs';

// Exact native/API versions, shared by every adapter. Pi itself is not a dependency.
export const COMPONENTS = Object.freeze({
  engine: { name: 'transcribe-cpp', version: '0.2.2' },
  microphone: { name: '@picovoice/pvrecorder-node', version: '1.2.9' },
  terminal: { name: '@lydell/node-pty', version: '1.2.0-beta.15' },
});

async function compatible(root, spec) {
  if (!root) return undefined;
  try {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (manifest.name !== spec.name || manifest.version !== spec.version) return undefined;
    const entry = manifest.exports?.['.']?.import || manifest.main || 'index.js';
    if (!existsSync(join(root, entry))) return undefined;
    return { root: await realpath(root), entry, version: manifest.version, name: manifest.name };
  } catch { return undefined; }
}

async function piRoots(p) {
  const roots = [join(p.pi, 'npm', 'node_modules', '@earendil-works', 'pi-transcribe')];
  // Discover git installations without assuming a GitHub owner or a fork name.
  const hostRoot = join(p.pi, 'git');
  for (const host of await readdir(hostRoot).catch(() => [])) {
    for (const owner of await readdir(join(hostRoot, host)).catch(() => [])) {
      for (const repo of await readdir(join(hostRoot, host, owner)).catch(() => [])) {
        roots.push(join(hostRoot, host, owner, repo));
      }
    }
  }
  const settings = await readJson(join(p.pi, 'settings.json'), {});
  for (const item of settings.packages || []) {
    const source = typeof item === 'string' ? item : item?.source;
    if (typeof source === 'string' && (source.startsWith('/') || /^[A-Za-z]:[\\/]/.test(source))) roots.push(source);
  }
  return roots;
}

export async function discoverComponent(id, { locations = paths(), extraRoots = [] } = {}) {
  const spec = COMPONENTS[id];
  if (!spec) throw new Error(`Unknown component: ${id}`);
  const registry = await readJson(locations.registry, { version: 1, components: {}, roots: [] });
  const candidates = [registry.components?.[id]?.root,
    join(locations.root, 'runtime', id, spec.version, 'node_modules', spec.name)];
  for (const root of [...(registry.roots || []), ...extraRoots, ...await piRoots(locations)]) {
    candidates.push(join(root, 'node_modules', spec.name));
  }
  // npm can hoist packages beside an installed extension.
  candidates.push(join(locations.pi, 'npm', 'node_modules', spec.name));
  for (const candidate of candidates) {
    const match = await compatible(candidate, spec);
    if (match) return match;
  }
}

/** Other integrations can advertise their package root without copying anything. */
export async function registerInstallation(root, { locations = paths() } = {}) {
  const canonical = await realpath(root);
  await withLock(`${locations.registry}.lock`, async () => {
    const registry = await readJson(locations.registry, { version: 1, components: {}, roots: [] });
    registry.roots = [...new Set([...(registry.roots || []), canonical])];
    await writeJson(locations.registry, registry);
  });
}

export async function npmInstall(prefix, spec, { signal, onStatus = () => {} } = {}) {
  await mkdir(prefix, { recursive: true, mode: 0o700 });
  onStatus(`Installing ${spec.name} ${spec.version}…`);
  const args = ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', `${spec.name}@${spec.version}`];
  // Invoke npm's JS CLI through the current Node on Windows (no shell interpolation).
  const npmCli = [process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    process.env.APPDATA && join(process.env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find(path => path?.endsWith('.js') && existsSync(path));
  if (process.platform === 'win32' && !npmCli) throw new Error('npm-cli.js not found. Install Node.js with npm.');
  const executable = npmCli ? process.execPath : 'npm';
  const fullArgs = npmCli ? [npmCli, ...args] : args;
  await new Promise((resolve, reject) => {
    const child = spawn(executable, fullArgs, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    let output = '';
    const collect = chunk => { output = (output + chunk).slice(-12_000); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Failed to install ${spec.name} (${code}):\n${output}`)));
  });
}

export async function ensureComponent(id, options = {}) {
  const p = options.locations || paths();
  const spec = COMPONENTS[id];
  if (!spec) throw new Error(`Unknown component: ${id}`);
  return withLock(join(p.root, 'locks', `install-${id}`), async () => {
    let found = await discoverComponent(id, { ...options, locations: p });
    if (!found) {
      const prefix = join(p.root, 'runtime', id, spec.version);
      await (options.install || npmInstall)(prefix, spec, options);
      found = await compatible(join(prefix, 'node_modules', spec.name), spec);
      if (!found) throw new Error(`Incomplete installation: ${spec.name}`);
    }
    await withLock(`${p.registry}.lock`, async () => {
      const registry = await readJson(p.registry, { version: 1, components: {}, roots: [] });
      (registry.components ||= {})[id] = found;
      await writeJson(p.registry, registry);
    }, options);
    return found;
  }, options);
}

export async function loadComponent(id, options = {}) {
  const found = await ensureComponent(id, options);
  try {
    const module = await import(pathToFileURL(join(found.root, found.entry)).href);
    return { ...module.default, ...module };
  } catch (error) {
    throw new Error(`Cannot load ${found.name} from ${found.root}: ${error.message}`, { cause: error });
  }
}
