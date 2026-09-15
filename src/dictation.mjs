import { loadComponent } from './components.mjs';
import { createCapture } from './audio.mjs';
import { paths } from './paths.mjs';
import { withLock } from './storage.mjs';
import { join } from 'node:path';

/** One state machine for both integrations; no terminal or Pi dependency. */
export class Dictation {
  state = 'idle';
  #take;
  #disposed = false;
  constructor(settings, options = {}) {
    this.settings = settings;
    this.options = options;
  }
  #emit(state, detail) {
    this.state = state;
    try { this.options.onState?.(state, detail); } catch { /* Rendering must not strand the mic. */ }
  }
  async start() {
    if (this.#disposed || this.#take) return;
    const take = { abort: new AbortController(), cancel: false };
    this.#take = take;
    this.#emit('starting');
    take.ready = (async () => {
      const capture = await (this.options.createCapture || createCapture)(this.settings.microphone, {
        ...this.options,
        signal: take.abort.signal,
        onLevel: (level, seconds) => {
          if (this.#take === take && !take.cancel) this.options.onLevel?.(level, seconds);
        },
        onError: error => { if (this.#take === take) void this.cancel().then(() => this.#emit('error', error)); },
      });
      take.capture = capture;
      if (take.cancel || this.#disposed) { await capture.stop(); return; }
      this.#emit('listening');
    })();
    try { await take.ready; }
    catch (error) {
      if (this.#take === take) this.#take = undefined;
      if (!take.cancel) this.#emit('error', error);
    }
  }
  async stop() {
    const take = this.#take;
    if (!take || take.cancel) return;
    if (take.result) return take.result;
    take.result = (async () => {
      await take.ready;
      if (take.cancel || !take.capture) return;
      this.#emit('transcribing');
      const pcm = await take.capture.stop();
      if (take.cancel || pcm.length === 0) return;
      const started = performance.now();
      const text = await (this.options.transcribe || transcribePcm)(this.settings, pcm, { ...this.options, signal: take.abort.signal });
      if (!take.cancel && !this.#disposed) {
        this.#emit('result', { text, seconds: pcm.length / 16000, latency: (performance.now() - started) / 1000 });
        return text;
      }
    })().catch(error => { if (!take.cancel) this.#emit('error', error); }).finally(() => {
      if (this.#take === take) { this.#take = undefined; this.#emit('idle'); }
    });
    return take.result;
  }
  async toggle() {
    if (!this.#take) return this.start();
    if (['starting', 'listening'].includes(this.state)) return this.stop();
  }
  async cancel() {
    const take = this.#take;
    if (!take) return;
    take.cancel = true;
    take.abort.abort();
    this.#emit('cancelling');
    await take.ready?.catch(() => {});
    await take.capture?.stop().catch(() => {});
    await take.result;
    if (this.#take === take) { this.#take = undefined; this.#emit('idle'); }
  }
  async dispose() { this.#disposed = true; await this.cancel(); }
}

export async function transcribePcm(settings, pcm, options = {}) {
  if (!(pcm instanceof Float32Array) || !pcm.length) throw new Error('No audio samples.');
  const locations = options.locations || paths();
  // Serializes model work across agents; memory does not grow with simultaneous clients.
  return withLock(join(locations.root, 'locks', 'transcription'), async () => {
    options.signal?.throwIfAborted();
    const { TranscribeModel, setLogHandler } = await loadComponent('engine', options);
    setLogHandler?.(() => {});
    const model = await TranscribeModel.load(settings.model.path);
    try {
      options.signal?.throwIfAborted();
      const language = settings.language === 'auto' ? undefined : settings.language;
      if (language && !model.capabilities.languages.includes(language)) throw new Error(`Unsupported language: ${language}`);
      const result = await model.transcribe(pcm, { language, timestamps: 'none', signal: options.signal });
      options.signal?.throwIfAborted();
      return result.text.trim();
    } finally { model.dispose(); }
  }, options);
}
