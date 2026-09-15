import { createServer } from 'node:http';
import { join } from 'node:path';
import { paths } from './paths.mjs';
import { readJson } from './storage.mjs';
import { readSettings, validModel } from './models.mjs';
import { decodeWav } from './file-audio.mjs';
import { transcribePcm } from './dictation.mjs';
import { MAX_SPEECH_TEXT, synthesizeSpeech, readSpeechSettings, validVoice } from './speech.mjs';

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const SERVER_MODEL = 'agent-voice';
export const serverConfigPath = locations => join(locations.root, 'server.json');
export const serverBaseUrl = config => `http://127.0.0.1:${config.port}/${config.token}/v1`;

export function validateServerConfig(config) {
  if (config?.version !== 1 || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535
    || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error('Invalid Agent Voice server configuration.');
  return config;
}

const failure = (status, message) => Object.assign(new Error(message), { status });
function reply(response, status, body) {
  if (response.destroyed) return;
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Connection': 'close' });
  response.end(JSON.stringify(body));
}

function readBody(request, maxBytes, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      request.off('data', data); request.off('end', end); request.off('error', error);
      signal.removeEventListener('abort', abort);
    };
    const error = error => { cleanup(); request.pause(); reject(error); };
    const abort = () => error(signal.reason);
    const data = chunk => {
      size += chunk.length;
      if (size > maxBytes) error(failure(413, 'Request exceeds its size limit.'));
      else chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    request.on('data', data); request.once('end', end); request.once('error', error);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** A small OpenAI-compatible WAV endpoint, never exposed beyond loopback.
 * The private base URL is a capability: GooeyPi needs no separate API key.
 * Do not log it, request bodies, audio or transcripts.
 */
export async function createTranscriptionServer({
  port = 0, token, locations = paths(), settings = () => readSettings(locations),
  decode = decodeWav, transcribe = transcribePcm, timeout = 90_000,
  maxAudioBytes = MAX_AUDIO_BYTES, onError = () => {},
  synthesize = synthesizeSpeech,
  availableVoice = async () => { const config = await readSpeechSettings(locations); return await validVoice(config) ? config.voice : undefined; },
} = {}) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('A private server token is required.');
  const prefix = `/${token}/v1`, controllers = new Set(), pending = new Set();
  let busy = false, closing = false;
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000, maxHeaderSize: 16_384 }, (request, response) => {
    const work = handle(request, response);
    pending.add(work); void work.finally(() => pending.delete(work));
  });
  server.maxConnections = 8;

  async function handle(request, response) {
    // Reject browser origins and DNS rebinding, even if the private URL leaks.
    const host = `127.0.0.1:${server.address()?.port}`;
    if (request.headers.host !== host || request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined) {
      reply(response, 403, { error: { message: 'Only local application clients are allowed.' } }); return;
    }
    if (request.method === 'GET' && request.url === `${prefix}/models`) {
      reply(response, 200, { object: 'list', data: [{ id: SERVER_MODEL, object: 'model', owned_by: 'agent-voice' }] }); return;
    }
    if (request.method === 'GET' && request.url === `${prefix}/voices`) {
      try {
        const id = await availableVoice();
        reply(response, 200, { object: 'list', data: id ? [{ id, object: 'voice', owned_by: 'agent-voice' }] : [] });
      } catch { reply(response, 503, { error: { message: 'Local speech voice is unavailable.' } }); }
      return;
    }
    const speech = request.url === `${prefix}/audio/speech`;
    if (!speech && request.url !== `${prefix}/audio/transcriptions`) {
      reply(response, 404, { error: { message: 'Not found.' } }); return;
    }
    if (request.method !== 'POST') { reply(response, 405, { error: { message: 'Use POST.' } }); return; }
    if (closing || busy) { reply(response, 429, { error: { message: 'Transcription is busy. Try again shortly.' } }); return; }
    busy = true;
    const controller = new AbortController(), { signal } = controller;
    controllers.add(controller);
    const cancel = () => { if (!response.writableFinished) controller.abort(new Error('Client disconnected.')); };
    response.once('close', cancel);
    const timer = setTimeout(() => controller.abort(failure(504, 'Transcription timed out.')), timeout);
    timer.unref();
    try {
      const type = request.headers['content-type'] || '';
      if (speech) {
        if (!/^application\/json(?:\s*;|$)/i.test(type)) throw failure(415, 'Use application/json for speech.');
        const body = await readBody(request, 8192, signal);
        let payload;
        try { payload = JSON.parse(body.toString('utf8')); } catch { throw failure(400, 'Invalid speech JSON.'); }
        if (!payload || Array.isArray(payload) || typeof payload !== 'object'
          || Object.keys(payload).some(key => !['model', 'input', 'response_format'].includes(key))
          || (payload.model !== undefined && payload.model !== SERVER_MODEL)
          || (payload.response_format !== undefined && payload.response_format !== 'wav')
          || typeof payload.input !== 'string' || !payload.input.trim() || payload.input.length > MAX_SPEECH_TEXT
          || payload.input.includes('\0')) throw failure(400, 'Invalid speech request. Use agent-voice, plain text and WAV.');
        if (!await availableVoice()) throw failure(503, 'Install a local speech voice with agent-voice install gooeypi --yes.');
        const wav = await synthesize(payload.input, { locations, signal });
        signal.throwIfAborted();
        if (!response.destroyed) {
          response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length, 'Cache-Control': 'no-store', Connection: 'close' });
          response.end(wav);
        }
        return;
      }
      if (!/^multipart\/form-data\s*;/i.test(type)) throw failure(415, 'Use multipart/form-data with a WAV file.');
      if (Number(request.headers['content-length']) > maxAudioBytes + 65_536) throw failure(413, 'Audio upload exceeds 25 MiB.');
      const body = await readBody(request, maxAudioBytes + 65_536, signal);
      let form;
      try { form = await new Response(body, { headers: { 'Content-Type': type } }).formData(); }
      catch { throw failure(400, 'Invalid multipart form.'); }
      for (const key of form.keys()) {
        if (!['file', 'model', 'language', 'response_format'].includes(key) || form.getAll(key).length !== 1) throw failure(400, `Unsupported or duplicate field: ${key.slice(0, 64)}.`);
      }
      const file = form.get('file');
      if (!file || typeof file.arrayBuffer !== 'function' || !file.size) throw failure(400, 'A WAV file is required.');
      if (file.size > maxAudioBytes) throw failure(413, 'Audio upload exceeds 25 MiB.');
      if (form.has('response_format') && form.get('response_format') !== 'json') throw failure(400, 'Only JSON responses are supported.');
      const current = await settings();
      if (!current) throw failure(503, 'Run agent-voice setup before transcribing.');
      const model = form.get('model');
      if (model !== null && model !== SERVER_MODEL && model !== current.model.id) throw failure(400, 'Unknown model. Use agent-voice.');
      let language = current.language;
      if (form.has('language')) {
        const requested = form.get('language');
        if (typeof requested !== 'string' || !/^(?:auto|[a-z]{2,3}(?:[-_][a-z]{2})?)$/i.test(requested)) throw failure(400, 'Invalid language.');
        language = requested.toLowerCase().split(/[-_]/)[0];
      }
      signal.throwIfAborted();
      let pcm;
      try { pcm = await decode(new Uint8Array(await file.arrayBuffer()), { signal }); }
      catch (error) { if (signal.aborted) throw signal.reason; throw failure(400, `Invalid WAV audio: ${error.message}`); }
      signal.throwIfAborted();
      // GooeyPi tests its connection with 0.1 s of digital silence. Do not load
      // a model or invent a transcript for an all-zero signal.
      const text = pcm.some(sample => sample !== 0)
        ? await transcribe({ ...current, language }, pcm, { locations, signal }) : '';
      signal.throwIfAborted();
      reply(response, 200, { text });
    } catch (error) {
      const status = signal.aborted && signal.reason?.status ? signal.reason.status : error.status || 500;
      if (status === 500) { try { onError(error); } catch {} }
      reply(response, status, { error: { message: status === 500 ? 'Local voice processing failed. Run agent-voice doctor.' : (signal.aborted ? signal.reason.message : error.message) } });
    } finally {
      clearTimeout(timer); response.off('close', cancel); controllers.delete(controller); busy = false;
    }
  }

  await new Promise((resolve, reject) => {
    const error = error => reject(error);
    server.once('error', error);
    server.listen(port, '127.0.0.1', () => { server.off('error', error); resolve(); });
  });
  return {
    url: serverBaseUrl({ token, port: server.address().port }),
    address: server.address(),
    async close() {
      closing = true;
      for (const controller of controllers) controller.abort(new Error('Server shutting down.'));
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await closed; await Promise.allSettled([...pending]);
    },
  };
}

export async function serve({ locations = paths(), signal } = {}) {
  const config = validateServerConfig(await readJson(serverConfigPath(locations), undefined));
  const settings = await readSettings(locations);
  if (!settings || !await validModel(settings.model.path)) throw new Error('Run agent-voice setup before starting the service.');
  const server = await createTranscriptionServer({ ...config, locations });
  process.stderr.write('Agent Voice local audio service ready on loopback.\n');
  await new Promise(resolve => {
    const stop = () => { signal?.removeEventListener('abort', stop); process.off('SIGINT', stop); process.off('SIGTERM', stop); resolve(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop); signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
  });
  await server.close();
}
