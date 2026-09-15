import { readFile, writeFile, mkdir, lstat, readlink, realpath, rename, rm, symlink } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute, basename } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { paths } from './paths.mjs';
import { readJson, writeJson, withLock } from './storage.mjs';
import { PACKAGE_ROOT } from './install-pi.mjs';

const BEGIN = '# >>> agent-voice initialize >>>';
const END = '# <<< agent-voice initialize <<<';
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
const optionalText = async path => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
const info = async path => lstat(path).catch(error => { if (error.code === 'ENOENT') return; throw error; });
const syntaxCheck = text => execFileSync('zsh', ['-n'], { input: text, stdio: ['pipe', 'pipe', 'pipe'] });

// Resolve ordinary shell path assignments WITHOUT evaluating the user's rc.
// Command substitutions, globs and expressions are intentionally not executed.
export function shellPath(word, variables) {
  let result = '', quoted = '', i = 0;
  word = word.trim();
  while (i < word.length) {
    const c = word[i++];
    if (quoted === "'") { if (c === "'") quoted = ''; else result += c; continue; }
    if (c === '"') { quoted = quoted === '"' ? '' : '"'; continue; }
    if (c === "'" && !quoted) { quoted = "'"; continue; }
    if (!quoted && /\s/.test(c)) {
      if (word.slice(i).trim() && !word.slice(i).trim().startsWith('#')) throw new Error('Complex Zsh path assignment.');
      break;
    }
    if (c === '\\') { if (i >= word.length) throw new Error('Incomplete Zsh escape sequence.'); result += word[i++]; continue; }
    if (c === '$') {
      const match = word.slice(i).match(/^(?:\{([A-Za-z_][A-Za-z_0-9]*)\}|([A-Za-z_][A-Za-z_0-9]*))/);
      if (!match || variables[match[1] || match[2]] === undefined) throw new Error('Unresolved dynamic Zsh path; settings left unchanged.');
      result += variables[match[1] || match[2]]; i += match[0].length; continue;
    }
    if (c === '`' || (!quoted && /[;|&<>*?(){}]/.test(c))) throw new Error('Unsupported Zsh path expression.');
    if (c === '~' && i === 1 && !quoted) result += variables.HOME;
    else result += c;
  }
  if (quoted || !isAbsolute(result) || /[\r\n\0]/.test(result)) throw new Error('A static absolute Zsh path is required.');
  return resolve(result);
}
function assigned(name, text, variables, fallback) {
  const matches = [...text.matchAll(new RegExp(`^[\\t ]*(?:export[\\t ]+)?${name}=([^\\n]*)$`, 'gm'))];
  return matches.length ? shellPath(matches.at(-1)[1], variables) : fallback;
}

async function atomicText(path, text, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, text, { mode }); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
async function setLink(path, target) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await symlink(target, temp); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
function withoutOwnedBlock(text, state) {
  if (state?.block && text.includes(state.block)) return text.replace(state.block, '');
  if (text.includes(BEGIN) || text.includes(END)) throw new Error('The Agent Voice block was edited manually; it has been preserved.');
  return text;
}

export async function installZsh(options = {}) {
  const env = options.env || process.env, home = options.home || env.HOME || homedir();
  if (!/^zsh(?:\.exe)?$/.test(basename(env.SHELL || ''))) return { installed: false };
  const locations = options.locations || paths(env, home), packageRoot = resolve(options.packageRoot || PACKAGE_ROOT);
  const rcInput = join(env.ZDOTDIR || home, '.zshrc');
  const rc = await realpath(rcInput).catch(error => { if (error.code === 'ENOENT') return rcInput; throw error; });
  const statePath = join(locations.root, 'zsh-install.json');
  return withLock(join(locations.root, 'locks', 'zsh-install'), async () => {
    const previous = await readJson(statePath, undefined), original = await optionalText(rc), rcInfo = await info(rc);
    if (previous && previous.rc !== rc) throw new Error(`Zsh integration already registered in ${previous.rc}.`);
    const base = withoutOwnedBlock(original, previous);
    if (base.includes(BEGIN) || base.includes(END)) throw new Error('Multiple Agent Voice blocks found.');
    const sources = [...base.matchAll(/^[\t ]*(?:source|\.)[\t ]+[^\n#]*oh-my-zsh\.sh[^\n]*$/gm)];
    if (sources.length > 1) throw new Error('Multiple Oh My Zsh loads found; settings left unchanged.');
    const binDir = env.AGENT_VOICE_BIN_DIR || previous?.binDir;
    if (binDir && (!isAbsolute(binDir) || /[\r\n\0]/.test(binDir))) throw new Error('The command directory must be an absolute path.');
    const addPath = binDir ? `[[ ":$PATH:" == *:${quote(binDir)}:* ]] || export PATH="$PATH":${quote(binDir)}\n` : '';
    let pluginLink, block, content;
    const pluginTarget = join(packageRoot, 'zsh');
    if (sources.length) {
      const prefix = base.slice(0, sources[0].index);
      const variables = { ...env, HOME: home };
      const zsh = assigned('ZSH', prefix, variables, env.ZSH || join(home, '.oh-my-zsh'));
      variables.ZSH = zsh;
      const custom = assigned('ZSH_CUSTOM', prefix, variables, env.ZSH_CUSTOM || join(zsh, 'custom'));
      if (!await info(join(zsh, 'oh-my-zsh.sh'))) throw new Error(`Oh My Zsh not found: ${zsh}`);
      pluginLink = join(custom, 'plugins', 'agent-voice');
      block = `${BEGIN}\n${addPath}if [[ -r ${quote(join(pluginLink, 'agent-voice.plugin.zsh'))} ]]; then\n    typeset -ga plugins\n    (( \${plugins[(Ie)agent-voice]} )) || plugins+=(agent-voice)\nfi\n${END}\n`;
      content = base.slice(0, sources[0].index) + block + base.slice(sources[0].index);
    } else {
      block = `${base && !base.endsWith('\n') ? '\n' : ''}${BEGIN}\n${addPath}[[ ! -r ${quote(join(pluginTarget, 'agent-voice.plugin.zsh'))} ]] || source ${quote(join(pluginTarget, 'agent-voice.plugin.zsh'))}\n${END}\n`;
      content = base + block;
    }
    if (previous?.pluginLink && previous.pluginLink !== pluginLink) throw new Error('The Oh My Zsh plugin directory changed; previous integration preserved.');
    let oldLink, ownsLink = previous?.ownsLink || false;
    if (pluginLink) {
      const existing = await info(pluginLink);
      if (existing && !existing.isSymbolicLink()) throw new Error(`Another plugin occupies ${pluginLink}.`);
      oldLink = existing ? await readlink(pluginLink) : undefined;
      const target = oldLink && resolve(dirname(pluginLink), oldLink);
      if (target && target !== pluginTarget && !(previous?.ownsLink && target === previous.pluginTarget)) throw new Error(`Existing plugin link preserved: ${pluginLink}`);
      if (!existing) ownsLink = true;
    }
    (options.checkSyntax || syntaxCheck)(content);
    const state = { version: 1, rc, createdRc: previous?.createdRc ?? !rcInfo, block, binDir, pluginLink, pluginTarget, ownsLink };
    let changedLink = false;
    try {
      // Save ownership before altering either the loader or the rc file.
      await writeJson(statePath, state);
      if (pluginLink && (!oldLink || resolve(dirname(pluginLink), oldLink) !== pluginTarget)) { await setLink(pluginLink, pluginTarget); changedLink = true; }
      if (await optionalText(rc) !== original) throw new Error('Zsh settings changed during installation; try again.');
      if (content !== original) await atomicText(rc, content, rcInfo ? rcInfo.mode & 0o777 : 0o600);
    } catch (error) {
      if (changedLink) {
        if (oldLink !== undefined) await setLink(pluginLink, oldLink);
        else await rm(pluginLink, { force: true });
      }
      if (previous) await writeJson(statePath, previous); else await rm(statePath, { force: true });
      throw error;
    }
    return { installed: true, ohMyZsh: Boolean(pluginLink), rc, pluginLink };
  });
}

export async function zshStatus(locations = paths()) {
  const state = await readJson(join(locations.root, 'zsh-install.json'), undefined);
  if (!state) return;
  const valid = (await optionalText(state.rc)).includes(state.block)
    && Boolean(await info(join(state.pluginLink || state.pluginTarget, 'agent-voice.plugin.zsh')));
  return { ...state, valid };
}

export async function uninstallZsh({ locations = paths(), checkSyntax = syntaxCheck } = {}) {
  return withLock(join(locations.root, 'locks', 'zsh-install'), async () => {
    const statePath = join(locations.root, 'zsh-install.json'), state = await readJson(statePath, undefined);
    if (!state) return;
    const original = await optionalText(state.rc), content = withoutOwnedBlock(original, state);
    checkSyntax(content);
    const file = await info(state.rc);
    if (file && original !== content) {
      if (!content && state.createdRc) await rm(state.rc);
      else await atomicText(state.rc, content, file.mode & 0o777);
    }
    if (state.pluginLink && state.ownsLink) {
      const existing = await info(state.pluginLink);
      // Never remove an intervening user replacement.
      if (existing?.isSymbolicLink() && resolve(dirname(state.pluginLink), await readlink(state.pluginLink)) === state.pluginTarget) await rm(state.pluginLink);
    }
    await rm(statePath, { force: true });
  });
}
