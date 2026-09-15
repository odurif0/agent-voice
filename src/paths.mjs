import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function paths(env = process.env, home = homedir(), platform = process.platform) {
  const data = platform === 'win32'
    ? env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    : platform === 'darwin' ? join(home, 'Library', 'Application Support')
      : env.XDG_DATA_HOME || join(home, '.local', 'share');
  const root = resolve(env.AGENT_VOICE_HOME || join(data, 'agent-voice'));
  const hf = env.HF_HUB_CACHE || env.HUGGINGFACE_HUB_CACHE || join(
    env.HF_HOME || join(env.XDG_CACHE_HOME || join(home, '.cache'), 'huggingface'), 'hub');
  return {
    root,
    config: join(root, 'settings.json'),
    registry: join(root, 'components.json'),
    pi: resolve(env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent')),
    hf: resolve(hf),
  };
}
