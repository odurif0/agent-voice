import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { SAMPLE_RATE, MAX_SECONDS } from './audio.mjs';

/** File decoding only; microphone dictation does not require FFmpeg. */
export async function decodeFile(path, options = {}) {
  const absolute = resolve(path);
  if (!(await stat(absolute)).isFile()) throw new Error(`Invalid audio file: ${absolute}`);
  return decode(['-i', absolute], undefined, options);
}

/** Browser WAV audio stays in memory. FFmpeg resamples and mixes it to mono. */
export async function decodeWav(bytes, options = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 44
    || Buffer.from(bytes.subarray(0, 4)).toString() !== 'RIFF'
    || Buffer.from(bytes.subarray(8, 12)).toString() !== 'WAVE') throw new Error('Expected RIFF/WAVE audio.');
  // Force the WAV demuxer and disallow files/network URLs in uploaded input.
  return decode(['-protocol_whitelist', 'pipe', '-f', 'wav', '-i', 'pipe:0'], bytes, options);
}

function decode(input, bytes, { signal, ffmpeg = process.env.PI_TRANSCRIBE_FFMPEG_PATH || 'ffmpeg' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-nostdin', '-v', 'error', ...input, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1'], { signal, stdio: [bytes ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    if (bytes) {
      // A rejected WAV can close stdin early; the process result reports why.
      child.stdin.on('error', () => {});
      child.stdin.end(bytes);
    }
    let size = 0, stderr = '', failure;
    const chunks = [];
    child.on('error', error => reject(error.code === 'ENOENT' ? new Error('FFmpeg is required for audio files and GooeyPi, not for the microphone.') : error));
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
