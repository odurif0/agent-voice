import { readFile, readlink, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { paths } from './paths.mjs';
import { readJson, writeJson, withLock } from './storage.mjs';
import { PACKAGE_ROOT } from './install-pi.mjs';
import { SERVER_MODEL, serverBaseUrl, serverConfigPath, validateServerConfig } from './server.mjs';
import { findFFmpeg, serviceDefinition, serviceManager, waitForServer } from './service.mjs';

const STATE_FILE = 'prime-work-state-v4.json';
const FIELDS = ['voiceTranscriptionProvider', 'voiceSelfHostedUrl', 'voiceSelfHostedModel'];
const optionalText = async path => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return; throw error; });
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const exec = promisify(execFile);

export function gooeyPiDirectory(env = process.env, home = homedir(), platform = process.platform) {
  return resolve(env.AGENT_VOICE_GOOEYPI_DIR || join(platform === 'darwin'
    ? join(home, 'Library', 'Application Support') : env.XDG_CONFIG_HOME || join(home, '.config'), 'gooeypi'));
}

export async function gooeyPiRunning(directory, platform = process.platform) {
  const lock = await readlink(join(directory, 'SingletonLock')).catch(error => { if (error.code === 'ENOENT') return; throw error; });
  if (lock) {
    const pid = Number(lock.match(/-(\d+)$/)?.[1]);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Cannot verify the GooeyPi instance lock. Quit GooeyPi before installing.');
    try { process.kill(pid, 0); return true; } catch (error) { if (error.code !== 'ESRCH') return true; }
  }
  if (platform === 'darwin') {
    // Electron on macOS does not always use Chromium's SingletonLock file.
    const { stdout } = await exec('ps', ['-axo', 'comm='], { timeout: 5000 });
    return stdout.split('\n').some(command => /\/GooeyPi\.app\/Contents\/MacOS\/GooeyPi\s*$/i.test(command));
  }
  return false;
}

export async function checkGooeyPi(options = {}) {
  const env = options.env || process.env, home = options.home || homedir(), platform = options.platform || process.platform;
  if (!['linux', 'darwin'].includes(platform)) throw new Error('Automatic GooeyPi integration supports Linux and macOS only.');
  const directory = options.directory || gooeyPiDirectory(env, home, platform), path = join(directory, STATE_FILE);
  if (await (options.isRunning || gooeyPiRunning)(directory, platform)) throw new Error('Quit GooeyPi, then run the installer again. Its running settings must not be overwritten.');
  const text = await optionalText(path);
  if (text === undefined) throw new Error('GooeyPi settings not found. Install and open GooeyPi once, then quit it before installing Agent Voice.');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Invalid GooeyPi settings; the file was left unchanged.'); }
  if (data?.version !== 4 || !record(data.settings)) throw new Error('Unsupported GooeyPi settings schema; the file was left unchanged.');
  return { path, directory, data, text };
}

async function atomicText(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, content, { mode: 0o600 }); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

export async function installGooeyPi(options = {}) {
  const env = options.env || process.env, home = options.home || homedir(), platform = options.platform || process.platform;
  const locations = options.locations || paths(env, home, platform), manager = options.manager || serviceManager();
  return withLock(join(locations.root, 'locks', 'gooeypi-install'), async () => {
    const current = await checkGooeyPi({ ...options, env, home, platform });
    const statePath = join(locations.root, 'gooeypi-install.json'), previous = await readJson(statePath, undefined);
    if (previous && (previous.version !== 1 || previous.path !== current.path)) throw new Error('A different GooeyPi integration is already registered.');
    const ffmpeg = await (options.findFFmpeg || findFFmpeg)(env);
    const service = serviceDefinition({ platform, home, env, locations, packageRoot: resolve(options.packageRoot || PACKAGE_ROOT), ffmpeg, uid: options.uid });
    const oldUnit = await optionalText(service.path);
    if (oldUnit !== undefined && (!previous || oldUnit !== previous.service.content)) throw new Error('The transcription service was created or edited outside this installer; it was preserved.');
    if (previous && previous.service.path !== service.path) throw new Error('The service directory changed; the existing integration was preserved.');
    await manager.check(service);
    const configPath = serverConfigPath(locations), oldConfig = await readJson(configPath, undefined);
    if (previous && JSON.stringify(oldConfig) !== JSON.stringify(previous.server)) throw new Error('The server configuration was edited; it was preserved.');
    const config = oldConfig ? validateServerConfig(oldConfig) : { version: 1, port: await (options.availablePort || availablePort)(), token: randomBytes(32).toString('hex') };
    validateServerConfig(config);
    const installed = { voiceTranscriptionProvider: 'self-hosted', voiceSelfHostedUrl: serverBaseUrl(config), voiceSelfHostedModel: SERVER_MODEL };
    const before = previous?.before || Object.fromEntries(FIELDS.map(key => [key, { present: Object.hasOwn(current.data.settings, key), value: current.data.settings[key] }]));
    const state = { version: 1, path: current.path, directory: current.directory, before, installed, service, server: config, ownsServer: previous?.ownsServer ?? !oldConfig };
    const wasActive = previous ? await manager.active(previous.service) : false;
    let changedUnit = false, started = false;
    try {
      // Journal ownership before changing the service or GooeyPi settings.
      await writeJson(statePath, state);
      if (!oldConfig) await writeJson(configPath, config);
      await atomicText(service.path, service.content); changedUnit = true;
      started = true; await manager.start(service);
      await (options.waitForServer || waitForServer)(installed.voiceSelfHostedUrl);
      const latest = await checkGooeyPi({ ...options, directory: current.directory, env, home, platform });
      if (latest.text !== current.text) throw new Error('GooeyPi settings changed during installation. Try again after quitting the application.');
      await writeJson(current.path, { ...current.data, settings: { ...current.data.settings, ...installed } });
      return { installed: true, path: current.path };
    } catch (error) {
      const failures = [];
      const restore = async operation => { try { await operation(); } catch (error) { failures.push(error.message); } };
      if (started) await restore(() => manager.stop(service));
      if (changedUnit) await restore(() => oldUnit === undefined ? rm(service.path, { force: true }) : atomicText(service.path, oldUnit));
      if (!oldConfig) await restore(() => rm(configPath, { force: true }));
      await restore(() => manager.reload(service));
      if (wasActive) await restore(() => manager.start(previous.service));
      if (!failures.length) await restore(() => previous ? writeJson(statePath, previous) : rm(statePath, { force: true }));
      if (failures.length) throw new Error(`${error.message} Rollback needs attention: ${failures.join('; ')}`, { cause: error });
      throw error;
    }
  });
}

export async function uninstallGooeyPi(options = {}) {
  const locations = options.locations || paths(), manager = options.manager || serviceManager();
  return withLock(join(locations.root, 'locks', 'gooeypi-install'), async () => {
    const statePath = join(locations.root, 'gooeypi-install.json'), state = await readJson(statePath, undefined);
    if (!state) return;
    const current = await checkGooeyPi({ ...options, directory: state.directory, platform: state.service.platform });
    const unit = await optionalText(state.service.path);
    if (unit !== undefined && unit !== state.service.content) throw new Error('The transcription service was edited; it was preserved.');
    const config = await readJson(serverConfigPath(locations), undefined);
    if (config && JSON.stringify(config) !== JSON.stringify(state.server)) throw new Error('The server configuration was edited; it was preserved.');
    const settings = { ...current.data.settings };
    for (const key of FIELDS) if (settings[key] === state.installed[key]) {
      if (state.before[key].present) settings[key] = state.before[key].value;
      else delete settings[key];
    }
    if (unit !== undefined) await manager.stop(state.service);
    const latest = await checkGooeyPi({ ...options, directory: state.directory, platform: state.service.platform });
    if (latest.text !== current.text) throw new Error('GooeyPi settings changed during removal; they were preserved.');
    await writeJson(current.path, { ...current.data, settings });
    if (unit !== undefined) await rm(state.service.path);
    await manager.reload(state.service);
    if (state.ownsServer) await rm(serverConfigPath(locations), { force: true });
    await rm(statePath);
  });
}

export async function gooeyPiStatus(locations = paths()) {
  const state = await readJson(join(locations.root, 'gooeypi-install.json'), undefined);
  if (!state) return;
  const current = await readJson(state.path, undefined);
  const configured = FIELDS.every(key => current?.settings?.[key] === state.installed[key]);
  const service = await optionalText(state.service.path) === state.service.content;
  let responding = false;
  try { await waitForServer(state.installed.voiceSelfHostedUrl, { timeout: 1000 }); responding = true; } catch {}
  return { configured, service, responding, valid: configured && service && responding };
}
