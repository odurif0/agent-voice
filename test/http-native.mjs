// Real HTTP/audio/ASR coverage, called by the opt-in native suite.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

export async function checkHttp({ locations, packageRoot, audioPath, phrase }) {
  const { createTranscriptionServer } = await import(pathToFileURL(join(packageRoot, 'src/server.mjs')));
  const { decodeWav } = await import(pathToFileURL(join(packageRoot, 'src/file-audio.mjs')));
  const bytes = execFileSync(process.env.PI_TRANSCRIBE_FFMPEG_PATH || 'ffmpeg', [
    '-v', 'error', '-i', audioPath, '-ar', '48000', '-ac', '2', '-f', 'wav', 'pipe:1',
  ], { maxBuffer: 10 * 1024 * 1024 });
  const pcm = await decodeWav(bytes);
  const { decodeFile } = await import(pathToFileURL(join(packageRoot, 'src/file-audio.mjs')));
  const original = await decodeFile(audioPath);
  assert.ok(Math.abs(pcm.length - original.length) <= 2, '48 kHz stereo is converted to the same 16 kHz mono duration');
  const server = await createTranscriptionServer({ token: randomBytes(32).toString('hex'), locations });
  try {
    const before = await readFile(locations.config, 'utf8');
    const form = new FormData();
    form.set('file', new Blob([bytes], { type: 'audio/wav' }), 'dictation.wav');
    form.set('model', 'agent-voice'); form.set('response_format', 'json');
    const response = await fetch(`${server.url}/audio/transcriptions`, { method: 'POST', body: form });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: phrase });
    assert.equal(await readFile(locations.config, 'utf8'), before, 'shared settings are unchanged');
    console.log('HTTP: 48 kHz stereo WAV → shared model → exact transcript; no model copy or configuration change.');
  } finally { await server.close(); }
}
