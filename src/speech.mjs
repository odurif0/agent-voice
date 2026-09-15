import { createWriteStream } from 'node:fs';
import { mkdir, stat, mkdtemp, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { paths } from './paths.mjs';
import { readJson, writeJson, withLock } from './storage.mjs';
import { ensureComponent, loadComponent } from './components.mjs';

const exec = promisify(execFile);
export const MAX_SPEECH_TEXT = 1200;
export const DEFAULT_VOICE = 'fr_FR-siwis-medium';
// Digests published by the upstream GitHub release API, not inferred from filenames.
export const VOICES = Object.freeze([
  { id: DEFAULT_VOICE, name: 'French · Siwis', size: 67207459, sha256: '375909aa30842b3a4efa10b1beb1d761af792960ae6873b4d53889f96c66195b' },
  { id: 'en_US-amy-low', name: 'English · Amy', size: 67095344, sha256: 'c70f5284a09a7fd4ed203b39b2ff51cac1432b422b852eb647b481dade3cf639' },
]);
const speechSettingsPath = locations => join(locations.root, 'speech.json');
export const readSpeechSettings = (locations = paths()) => readJson(speechSettingsPath(locations), undefined);

export async function validVoice(config) {
  if (config?.version !== 1 || typeof config.path !== 'string' || !VOICES.some(voice => voice.id === config.voice)) return false;
  return voiceFiles(config.path, config.voice);
}
async function voiceFiles(path, voice) {
  const files = [`${voice}.onnx`, `${voice}.onnx.json`, 'tokens.txt', 'MODEL_CARD', 'espeak-ng-data/phontab'];
  return (await Promise.all(files.map(file => stat(join(path, file)).then(info => info.isFile() && info.size > 0).catch(() => false)))).every(Boolean);
}

/** One shared voice installation, independent of the desktop application's files. */
export async function ensureSpeech(options = {}) {
  const locations = options.locations || paths();
  const previous = await readSpeechSettings(locations);
  const voice = (options.catalog || VOICES).find(item => item.id === (options.voice || previous?.voice || DEFAULT_VOICE));
  if (!voice) throw new Error('Unknown speech voice. Run agent-voice voices.');
  const directory = join(locations.root, 'models', 'speech', `vits-piper-${voice.id}`);
  const config = { version: 1, voice: voice.id, path: directory };
  await withLock(join(locations.root, 'locks', 'speech-install'), async () => {
    if (!await voiceFiles(directory, voice.id)) {
      if (!options.yes && !await options.confirmDownload?.(voice)) throw new Error('Speech voice download not confirmed. Use --yes to allow it.');
      options.onStatus?.(`Downloading ${voice.name} (${Math.ceil(voice.size / 1048576)} MiB)…`);
      const parent = join(locations.root, 'models', 'speech');
      await mkdir(parent, { recursive: true });
      const temporary = await mkdtemp(join(parent, '.download-'));
      const archive = join(temporary, 'voice.tar.bz2');
      try {
        const url = `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-${voice.id}.tar.bz2`;
        const response = await (options.fetchImpl || fetch)(url, { signal: options.signal });
        if (!response.ok || !response.body) throw new Error(`Speech voice download failed (HTTP ${response.status}).`);
        const hash = createHash('sha256'); let size = 0;
        await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, callback) {
          size += chunk.length;
          if (size > voice.size) { callback(new Error('Speech voice archive exceeds its expected size.')); return; }
          hash.update(chunk); callback(null, chunk);
        } }), createWriteStream(archive, { mode: 0o600, flags: 'wx' }), { signal: options.signal });
        if (size !== voice.size || hash.digest('hex') !== voice.sha256) throw new Error('Speech voice archive checksum mismatch.');
        // Only an archive with the pinned upstream digest reaches the extractor.
        await exec('tar', ['-xjf', archive, '-C', temporary, '--no-same-owner', '--no-same-permissions'], { signal: options.signal });
        const extracted = join(temporary, `vits-piper-${voice.id}`);
        if (!await voiceFiles(extracted, voice.id)) throw new Error('The speech voice archive is incomplete.');
        await rm(directory, { recursive: true, force: true });
        await rename(extracted, directory);
      } finally { await rm(temporary, { recursive: true, force: true }); }
    }
    await (options.ensureComponent || ensureComponent)('speech', options);
    await writeJson(speechSettingsPath(locations), config);
  }, options);
  return config;
}

/** Standard PCM16 WAV; audio is returned in memory, never saved by the service. */
export function speechWav({ samples, sampleRate }) {
  if (!(samples instanceof Float32Array) || !samples.length || samples.length > sampleRate * 180
    || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000) throw new Error('Invalid synthesized audio.');
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    if (!Number.isFinite(samples[i])) throw new Error('Invalid synthesized audio sample.');
    const value = Math.max(-1, Math.min(1, samples[i]));
    wav.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), 44 + i * 2);
  }
  return wav;
}

let cached;
export async function synthesizeSpeech(text, options = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_SPEECH_TEXT) throw new Error(`Speech input must contain 1–${MAX_SPEECH_TEXT} characters.`);
  const locations = options.locations || paths();
  return withLock(join(locations.root, 'locks', 'speech'), async () => {
    options.signal?.throwIfAborted();
    const config = await readSpeechSettings(locations);
    if (!await validVoice(config)) throw new Error('Speech voice is not installed. Run agent-voice install gooeypi --yes.');
    const { OfflineTts } = await (options.loadComponent || loadComponent)('speech', options);
    // Retain only the current voice. The service does not accumulate models.
    if (cached?.path !== config.path || cached?.constructor !== OfflineTts) {
      cached = undefined;
      const model = await OfflineTts.createAsync({ model: {
        vits: { model: join(config.path, `${config.voice}.onnx`), tokens: join(config.path, 'tokens.txt'), dataDir: join(config.path, 'espeak-ng-data') },
        numThreads: 2, provider: 'cpu', debug: 0,
      }, maxNumSentences: 1 });
      cached = { path: config.path, constructor: OfflineTts, model };
    }
    options.signal?.throwIfAborted();
    const audio = await cached.model.generateAsync({ text: text.trim(), sid: 0, speed: 1, onProgress: () => !options.signal?.aborted });
    options.signal?.throwIfAborted();
    return speechWav(audio);
  }, options);
}
