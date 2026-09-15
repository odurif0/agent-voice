import { spawn } from 'node:child_process';
import { constants } from 'node:os';

const valueOptions = new Set(['-C', '--directory', '--sandbox', '--agent', '--conversation-id', '--cid']);

/** Only known interactive invocations are wrapped. Subcommands, -p, pipes and
 * unknown/new options keep Forge's own parsing and unmodified stdio. */
export function isInteractiveForge(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--verbose') continue;
    if (arg === '--') return i === args.length - 1;
    if (valueOptions.has(arg)) {
      if (++i === args.length || args[i].startsWith('-')) return false;
      continue;
    }
    const equals = arg.indexOf('=');
    if (equals > 0 && valueOptions.has(arg.slice(0, equals)) && arg.length > equals + 1) continue;
    if (arg.startsWith('-C') && arg.length > 2) continue;
    return false;
  }
  return true;
}

export function passthrough(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = (options.spawn || spawn)(command, args, { stdio: 'inherit' });
    const handlers = Object.fromEntries(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => child.kill(signal)]));
    const cleanup = () => { for (const [signal, fn] of Object.entries(handlers)) process.off(signal, fn); };
    for (const [signal, fn] of Object.entries(handlers)) process.on(signal, fn);
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => { cleanup(); resolve(code ?? (128 + (constants.signals[signal] || 0))); });
  });
}

export async function runForge(args, options = {}) {
  const input = options.input || process.stdin, output = options.output || process.stdout;
  const command = options.command || 'forge';
  if (!input.isTTY || !output.isTTY || process.env.AGENT_VOICE_ACTIVE || !isInteractiveForge(args)) {
    return (options.passthrough || passthrough)(command, args, options);
  }
  const { prepare, runTerminal } = options;
  const settings = await prepare({ terminal: true });
  return runTerminal(command, args, settings, options);
}
