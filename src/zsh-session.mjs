import { createInterface } from 'node:readline';
import { Dictation } from './dictation.mjs';
import { readSettings } from './models.mjs';
import { cleanTranscript } from './terminal-input.mjs';
import { statusText } from './terminal.mjs';

/** One short-lived worker per take. stdin accepts stop/cancel; stdout contains
 * typed, single-line DATA (never shell code). Audio stays in the shared engine. */
export async function runZshSession(options = {}) {
  const input = options.input || process.stdin, output = options.output || process.stdout;
  const lines = createInterface({ input, terminal: false });
  let dictation, settings, closing = false, intent = 'start', hadResult = false, hadError = false;
  let complete, finishWork, lastMeter = 0;
  const done = new Promise(resolve => { complete = resolve; });
  const emit = (type, value = '') => {
    if (!output.destroyed && !output.writableEnded) output.write(`${type}\t${cleanTranscript(value)}\n`);
  };
  const finish = () => {
    if (closing) return finishWork;
    closing = true;
    finishWork = (async () => {
      try { await dictation?.dispose(); }
      finally {
        lines.off('line', onCommand); lines.off('close', onClose); lines.close(); input.pause();
        if (options.signals !== false) for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.off(signal, onClose);
        // The final write may report EPIPE asynchronously after this function
        // returns. Keep its error handler until the stream actually closes.
        output.once('close', () => output.off('error', onOutputError));
        emit('done'); complete();
      }
    })();
    return finishWork;
  };
  const onClose = () => { intent = 'cancel'; void finish(); };
  // When ZLE closes its pipe on cancellation, there is no client left to notify.
  const onOutputError = () => { intent = 'cancel'; void finish(); };
  const fail = error => {
    hadError = true;
    emit('status', statusText('error', settings?.shortcut, error));
    void finish();
  };
  const onCommand = line => {
    if (closing) return;
    if (line === 'cancel') { intent = 'cancel'; void finish(); }
    else if (line === 'stop') { intent = 'stop'; if (dictation) void dictation.stop(); }
    else fail(new Error('Invalid voice control command.'));
  };
  lines.on('line', onCommand); lines.on('close', onClose); output.on('error', onOutputError);
  if (options.signals !== false) for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(signal, onClose);
  try {
    settings = await (options.readSettings || readSettings)();
    if (!closing) {
      if (!settings) throw new Error('Run agent-voice install forge before dictating.');
      dictation = new Dictation(settings, {
        ...options,
        onState(state, detail) {
          if (closing) return;
          if (state === 'result') {
            const text = cleanTranscript(detail.text);
            if (text) { hadResult = true; emit('result', text); }
          } else if (state === 'idle') {
            // Let a capture error emitted just after cancel() reach the client.
            setImmediate(() => {
              if (closing) return;
              if (!hadResult && !hadError) emit('status', 'Voice: no speech recognized.');
              void finish();
            });
          } else if (state === 'error') fail(detail);
          else emit('status', statusText(state, settings.shortcut, detail, true));
        },
        onLevel(level, seconds) {
          if (closing || Date.now() - lastMeter < 150) return;
          lastMeter = Date.now();
          emit('status', statusText('listening', settings.shortcut, `${seconds.toFixed(0)} s [${'='.repeat(Math.round(level * 8)).padEnd(8, ' ')}]`, true));
        },
      });
      void dictation.start();
      // A second keypress during Node/model initialization must not be lost.
      if (intent === 'stop') void dictation.stop();
    }
  } catch (error) { if (!closing) fail(error); }
  await done;
}
