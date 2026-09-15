import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { paths } from './paths.mjs';
import { COMPONENTS, ensureComponent, discoverComponent, loadComponent } from './components.mjs';
import { CATALOG, ensureSettings, readSettings, validModel } from './models.mjs';
import { microphones } from './audio.mjs';
import { decodeFile } from './file-audio.mjs';
import { transcribePcm } from './dictation.mjs';
import { installPi, uninstallPi } from './install-pi.mjs';
import { runForge, passthrough } from './forge.mjs';
import { SHORTCUTS } from './terminal-input.mjs';
import { installZsh, uninstallZsh, zshStatus } from './install-zsh.mjs';
import { checkGooeyPi, installGooeyPi, uninstallGooeyPi, gooeyPiStatus } from './install-gooeypi.mjs';

const help = `agent-voice: shared local dictation\n\n  forge-voice [Forge arguments]       Launch Forge with dictation\n  agent-voice install <target>        Install forge, pi or gooeypi\n  agent-voice uninstall <target>      Remove the integration, keep the models\n  agent-voice serve                   Run the managed local transcription service\n  agent-voice setup                   Configure the model, language or shortcut\n    --model <id|file.gguf>            --language auto|en|fr\n    --shortcut ctrl+alt+z|f2           --microphone <index>\n    --yes                            Allow the model download\n  agent-voice models                  List available models\n  agent-voice microphones             List available microphones\n  agent-voice doctor                  Check shared resources\n  agent-voice transcribe <file>       Transcribe a file (requires FFmpeg)\n  agent-voice run -- <agent> [args]    Run a compatible terminal agent unchanged\n\nDictation: Ctrl+Alt+Z to start/stop, Esc to cancel.\nIn Zsh/Forge: Enter also stops dictation; press it again after transcription to submit.\n`;

export async function prepare({ terminal = false, microphoneComponent = true, ...options } = {}) {
  const onStatus = options.onStatus || (text => process.stderr.write(`${text}\n`));
  const settings = await ensureSettings({ ...options, onStatus });
  for (const id of ['engine', ...(microphoneComponent ? ['microphone'] : []), ...(terminal ? ['terminal'] : [])]) await ensureComponent(id, { ...options, onStatus });
  return settings;
}

async function confirmDownload(model) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^(y|yes)$/i.test((await rl.question(`Download ${model.name} (${Math.ceil(model.size / 1048576)} MiB), once? [y/N] `)).trim()); }
  finally { rl.close(); }
}

export async function main(argv) {
  const [command = 'help', ...args] = argv;
  if (['help', '--help', '-h'].includes(command)) { console.log(help); return; }
  if (command === '--version') { console.log('agent-voice 0.4.0'); return; }
  if (command === 'serve') {
    if (args.length) throw new Error('The service uses its installed local configuration; no listen overrides are allowed.');
    return (await import('./server.mjs')).serve();
  }
  if (command === 'zsh-keys') {
    const settings = await readSettings();
    if (!settings || !SHORTCUTS[settings.shortcut]) throw new Error('Voice settings unavailable.');
    console.log(SHORTCUTS[settings.shortcut].join('\n')); return;
  }
  if (command === 'zsh-session') {
    const { runZshSession } = await import('./zsh-session.mjs');
    return runZshSession();
  }
  if (command === 'forge') {
    return runForge(args, {
      prepare: options => prepare({ ...options, confirmDownload }),
      runTerminal: async (...parameters) => (await import('./terminal.mjs')).runTerminal(...parameters),
    });
  }
  if (command === 'run') {
    const [agent, ...agentArgs] = args[0] === '--' ? args.slice(1) : args;
    if (!agent) throw new Error('Specify an agent after "run --".');
    if (agent === 'forge') return main(['forge', ...agentArgs]);
    if (process.env.AGENT_VOICE_ACTIVE) throw new Error('A voice launcher is already active; do not nest launchers.');
    if (agentArgs.some(arg => ['--help', '-h', '--version', '-V'].includes(arg))) {
      return passthrough(agent, agentArgs);
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run forge-voice in an interactive terminal.');
    const settings = await prepare({ terminal: true, confirmDownload });
    const { runTerminal } = await import('./terminal.mjs');
    return runTerminal(agent, agentArgs, settings);
  }
  if (command === 'models') {
    for (const model of CATALOG) console.log(`${model.id}\t${Math.ceil(model.size / 1048576)} MiB\t${model.languages.join(', ')}`);
    return;
  }
  if (command === 'microphones') {
    const devices = await microphones();
    devices.forEach((name, index) => console.log(`${index}\t${name}`));
    console.log('-1\tSystem default microphone'); return;
  }
  if (command === 'doctor') {
    const p = paths(), settings = await readSettings(p);
    console.log(`Shared resources: ${p.root}\nHugging Face cache: ${p.hf}`);
    let ok = true;
    const gooey = await gooeyPiStatus(p);
    for (const [id, spec] of Object.entries(COMPONENTS)) {
      const found = await discoverComponent(id);
      if (!found) { console.log(`${id}: missing (${spec.name})`); if (id === 'engine' || (id === 'microphone' && !gooey)) ok = false; continue; }
      try {
        const module = await loadComponent(id);
        if (id === 'engine') module.version();
        if (id === 'microphone') module.PvRecorder.getAvailableDevices();
        console.log(`${id}: ${found.root} (${found.version})`);
      } catch (error) { ok = false; console.log(`${id}: ${error.message}`); }
    }
    const valid = settings && await validModel(settings.model.path);
    console.log(`Model: ${valid ? settings.model.path : 'missing or invalid'}`);
    const zsh = await zshStatus(p);
    if (zsh) {
      console.log(`Zsh${zsh.pluginLink ? ' / Oh My Zsh' : ''}: ${zsh.valid ? 'ready' : 'incomplete installation'} (${zsh.rc})`);
      if (!zsh.valid) ok = false;
    }
    if (gooey) {
      console.log(`GooeyPi: ${gooey.valid ? 'ready (local service)' : 'incomplete integration or stopped service'}`);
      if (!gooey.valid) ok = false;
    }
    return ok && valid ? 0 : 1;
  }
  if (command === 'transcribe') {
    if (args.length !== 1) throw new Error('Specify a single audio/video file.');
    const settings = await readSettings();
    if (!settings) throw new Error('Run agent-voice setup before transcribing a file.');
    console.log(await transcribePcm(settings, await decodeFile(args[0]))); return;
  }
  if (command === 'uninstall') {
    if (args.length !== 1 || !['forge', 'pi', 'gooeypi'].includes(args[0])) throw new Error('Choose "uninstall forge", "uninstall pi" or "uninstall gooeypi".');
    if (args[0] === 'gooeypi') {
      await uninstallGooeyPi(); console.log('GooeyPi integration and local service removed. Shared resources preserved.');
    } else if (args[0] === 'pi') {
      await uninstallPi(); console.log('Pi integration removed. Shared resources preserved.');
    } else {
      await uninstallZsh(); console.log('Zsh integration removed for future terminals. Shared resources preserved.');
    }
    return;
  }
  if (command === 'setup' || command === 'install') {
    const target = command === 'install' ? args.shift() : undefined;
    if (command === 'install' && !['forge', 'pi', 'gooeypi'].includes(target)) throw new Error('Choose "install forge", "install pi" or "install gooeypi".');
    if (target === 'gooeypi') await checkGooeyPi();
    const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      model: { type: 'string' }, language: { type: 'string' }, shortcut: { type: 'string' },
      microphone: { type: 'string' }, yes: { type: 'boolean', default: false },
    } });
    if (positionals.length) throw new Error(`Unexpected argument: ${positionals[0]}`);
    let microphone;
    if (values.microphone !== undefined) {
      const index = Number(values.microphone);
      const names = await microphones();
      if (!Number.isInteger(index) || index < -1 || index >= names.length) throw new Error('Invalid microphone index.');
      microphone = index === -1 ? { type: 'system-default' } : { type: 'device', name: names[index], occurrence: names.slice(0, index).filter(n => n === names[index]).length };
    }
    const settings = await prepare({ ...values, microphone, terminal: target === 'forge', microphoneComponent: target !== 'gooeypi', confirmDownload: values.yes ? async () => true : confirmDownload });
    if (target === 'pi') await installPi();
    if (target === 'gooeypi') await installGooeyPi();
    const zsh = target === 'forge' ? await installZsh() : undefined;
    console.log(`Ready: ${settings.model.id} · ${settings.language} · ${settings.shortcut}`);
    if (target === 'pi') console.log('Pi integration enabled. Run /reload in Pi.');
    if (target === 'gooeypi') console.log('GooeyPi dictation enabled. Open GooeyPi and use its microphone button. The local service starts automatically at login.');
    if (target === 'forge') console.log(zsh.installed
      ? `${zsh.ohMyZsh ? 'Oh My Zsh' : 'Zsh'} integration enabled for new terminals: dictate at the prompt or launch forge normally.`
      : 'No Zsh shell detected. Run forge-voice instead of forge.');
    return;
  }
  throw new Error(`Unknown command: ${command}. Use agent-voice --help.`);
}
