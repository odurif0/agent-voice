import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, isAbsolute, delimiter } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const exec = promisify(execFile);
const LABEL = 'dev.agent-voice.transcription';
const UNIT = 'agent-voice-transcription.service';
const plain = text => {
  if (typeof text !== 'string' || /[\0\r\n]/.test(text)) throw new Error('Invalid service path or environment value.');
  return text;
};
const systemd = text => `"${plain(text).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
const xml = text => plain(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

export async function findFFmpeg(env = process.env) {
  const name = env.PI_TRANSCRIBE_FFMPEG_PATH || 'ffmpeg';
  const candidates = isAbsolute(name) ? [name] : (env.PATH || '').split(delimiter).filter(Boolean).map(path => join(path, name));
  for (const path of candidates) {
    try { await access(path, constants.X_OK); await exec(path, ['-version'], { timeout: 10_000 }); return path; }
    catch {}
  }
  throw new Error('FFmpeg is required for GooeyPi. Install FFmpeg, then run the installer again. No GooeyPi settings were changed.');
}

/** User services only: no root privileges or global runtime changes. */
export function serviceDefinition({ platform, home, env, locations, packageRoot, ffmpeg, uid = process.getuid?.() }) {
  if (!['linux', 'darwin'].includes(platform)) throw new Error('Automatic GooeyPi integration supports Linux and macOS only.');
  const executable = join(packageRoot, 'bin', 'launch.sh');
  const environment = {
    HOME: home, PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin',
    AGENT_VOICE_HOME: locations.root, PI_CODING_AGENT_DIR: locations.pi,
    HF_HUB_CACHE: locations.hf, PI_TRANSCRIBE_FFMPEG_PATH: ffmpeg,
  };
  if (platform === 'linux') {
    const path = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'systemd', 'user', UNIT);
    return { platform, path, name: UNIT, content: `[Unit]\nDescription=Agent Voice local transcription\n\n[Service]\nType=simple\nExecStart=${systemd(executable).replaceAll('$', () => '$$')} agent-voice serve\n${Object.entries(environment).map(([k, v]) => `Environment=${systemd(`${k}=${v}`)}`).join('\n')}\nRestart=on-failure\nRestartSec=2\nUMask=0077\nNoNewPrivileges=true\n\n[Install]\nWantedBy=default.target\n` };
  }
  if (!Number.isInteger(uid)) throw new Error('Cannot determine the current macOS user.');
  const path = join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const args = [executable, 'agent-voice', 'serve'].map(value => `<string>${xml(value)}</string>`).join('');
  const variables = Object.entries(environment).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join('');
  return { platform, path, name: LABEL, domain: `gui/${uid}`, content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${LABEL}</string>\n<key>ProgramArguments</key><array>${args}</array>\n<key>EnvironmentVariables</key><dict>${variables}</dict>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>2</integer>\n<key>Umask</key><integer>63</integer>\n</dict></plist>\n` };
}

export function serviceManager(execute = (file, args) => exec(file, args, { timeout: 20_000 })) {
  const active = async definition => {
    try {
      await execute(definition.platform === 'linux' ? 'systemctl' : 'launchctl', definition.platform === 'linux'
        ? ['--user', 'is-active', '--quiet', definition.name] : ['print', `${definition.domain}/${definition.name}`]);
      return true;
    } catch { return false; }
  };
  return {
    active,
    async check(definition) {
      try {
        await execute(definition.platform === 'linux' ? 'systemctl' : 'launchctl', definition.platform === 'linux'
          ? ['--user', 'show-environment'] : ['print', definition.domain]);
      } catch { throw new Error('The user service manager is unavailable. Run the installer in your desktop login session.'); }
    },
    async start(definition) {
      if (definition.platform === 'linux') {
        await execute('systemctl', ['--user', 'daemon-reload']);
        await execute('systemctl', ['--user', 'enable', definition.name]);
        await execute('systemctl', ['--user', 'restart', definition.name]);
      } else {
        if (await active(definition)) await execute('launchctl', ['bootout', `${definition.domain}/${definition.name}`]);
        await execute('launchctl', ['enable', `${definition.domain}/${definition.name}`]);
        await execute('launchctl', ['bootstrap', definition.domain, definition.path]);
      }
    },
    async stop(definition) {
      if (definition.platform === 'linux') await execute('systemctl', ['--user', 'disable', '--now', definition.name]);
      else if (await active(definition)) await execute('launchctl', ['bootout', `${definition.domain}/${definition.name}`]);
    },
    async reload(definition) {
      if (definition.platform === 'linux') await execute('systemctl', ['--user', 'daemon-reload']);
    },
  };
}

export async function waitForServer(url, { timeout = 15_000 } = {}) {
  const deadline = Date.now() + timeout;
  do {
    try {
      const response = await fetch(`${url}/models`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
      const body = await response.json();
      if (response.ok && body.data?.some(model => model.id === 'agent-voice')) return;
    } catch {}
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error('The local transcription service did not become ready. GooeyPi settings were left unchanged.');
}
