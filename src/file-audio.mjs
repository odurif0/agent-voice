import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { SAMPLE_RATE, MAX_SECONDS } from './audio.mjs';

/** File decoding only; microphone dictation does not require FFmpeg. */
export async function decodeFile(path, { signal, ffmpeg = process.env.PI_TRANSCRIBE_FFMPEG_PATH || 'ffmpeg' } = {}) {
  const absolute = resolve(path);
  if (!(await stat(absolute)).isFile()) throw new Error(`Invalid audio file: ${absolute}`);
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-nostdin', '-v', 'error', '-i', absolute, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1'], { signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let size = 0, stderr = '', failure;
    const chunks = [];
    child.on('error', error => reject(error.code === 'ENOENT' ? new Error('FFmpeg is required for files, not for the microphone.') : error));
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > SAMPLE_RATE * 4 * MAX_SECONDS) { failure = new Error(`The file exceeds ${MAX_SECONDS / 60} minutes.`); child.kill(); }
      else chunks.push(chunk);
    });
    child.on('close', code => {
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`Audio decoding failed: ${stderr || code}`));
      if (!size || size % 4 !== 0) return reject(new Error('No valid PCM audio data.'));
      const bytes = Buffer.concat(chunks);
      const pcm = new Float32Array(bytes.length / 4);
      for (let n = 0; n < pcm.length; n++) pcm[n] = bytes.readFloatLE(n * 4);
      resolve(pcm);
    });
  });
}
