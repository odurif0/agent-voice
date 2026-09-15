import { loadComponent } from './components.mjs';
import { acquireLock } from './storage.mjs';
import { paths } from './paths.mjs';
import { join } from 'node:path';

export const SAMPLE_RATE = 16000;
export const MAX_SECONDS = 600;

export async function microphones(options = {}) {
  const { PvRecorder } = await loadComponent('microphone', options);
  return PvRecorder.getAvailableDevices();
}

export function pcmFloat(frames) {
  const pcm = new Float32Array(frames.reduce((n, frame) => n + frame.length, 0));
  let offset = 0;
  for (const frame of frames) for (const sample of frame) pcm[offset++] = sample / 32768;
  return pcm;
}

export async function createCapture(setting, options = {}) {
  const { PvRecorder } = await loadComponent('microphone', options);
  let device = -1;
  if (setting.type === 'device') {
    let occurrence = 0;
    device = PvRecorder.getAvailableDevices().findIndex(name => name === setting.name && occurrence++ === setting.occurrence);
    if (device < 0) throw new Error(`Microphone not found: ${setting.name}. Run agent-voice microphones.`);
  }
  options.signal?.throwIfAborted();
  const release = await acquireLock(join((options.locations || paths()).root, 'locks', 'microphone'), { signal: options.signal, timeout: 0 });
  let recorder;
  try { recorder = new PvRecorder(512, device); }
  catch (error) { await release(); throw error; }
  let stopping = false, loop, stopPromise, failure;
  const frames = [];
  let samples = 0;
  try {
    if (recorder.sampleRate !== SAMPLE_RATE) throw new Error('The microphone does not provide 16 kHz mono PCM.');
    recorder.start();
    loop = (async () => {
      try {
        while (!stopping && recorder.isRecording) {
          const frame = await recorder.read();
          if (stopping) break;
          samples += frame.length;
          if (samples > SAMPLE_RATE * MAX_SECONDS) throw new Error(`Dictation is limited to ${MAX_SECONDS / 60} minutes.`);
          frames.push(frame);
          const level = Math.sqrt(frame.reduce((s, x) => s + (x / 32768) ** 2, 0) / frame.length);
          try { options.onLevel?.(Math.min(1, level * 8), samples / SAMPLE_RATE); } catch { /* UI only. */ }
        }
      } catch (error) {
        if (!stopping) { failure = error; options.onError?.(error); }
      }
    })();
  } catch (error) { try { recorder.release(); } finally { await release(); } throw error; }
  return {
    stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      stopPromise = (async () => {
        try {
          let stopError;
          try { if (recorder.isRecording) recorder.stop(); } catch (error) { stopError = error; }
          await loop;
          if (stopError || failure) throw stopError || failure;
          return pcmFloat(frames);
        } finally {
          try { recorder.release(); frames.length = 0; } finally { await release(); }
        }
      })();
      return stopPromise;
    },
  };
}
