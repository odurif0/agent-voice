import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, open, stat, rename, rm, symlink, link } from 'node:fs/promises';
import { join, dirname, relative, resolve } from 'node:path';
import { paths } from './paths.mjs';
import { readJson, writeJson, withLock } from './storage.mjs';

export const CATALOG = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'));
export const DEFAULT_MODEL = 'parakeet-tdt-0.6b-v3';
export const DEFAULT_SHORTCUT = 'ctrl+alt+z';

export function modelCachePath(model, locations = paths()) {
  return join(locations.hf, `models--${model.repository.replaceAll('/', '--')}`, 'snapshots', model.revision, model.filename);
}

export async function validModel(path, size) {
  if (typeof path !== 'string') return false;
  let handle;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size < 16 || (size !== undefined && info.size !== size)) return false;
    handle = await open(path, 'r');
    const magic = Buffer.alloc(4);
    await handle.read(magic, 0, 4, 0);
    return magic.toString() === 'GGUF';
  } catch { return false; }
  finally { await handle?.close(); }
}

export async function downloadModel(model, { locations = paths(), signal, onStatus = () => {}, fetchImpl = fetch } = {}) {
  const pointer = modelCachePath(model, locations);
  return withLock(join(locations.root, 'locks', `model-${model.sha256}`), async () => {
    if (await validModel(pointer, model.size)) return pointer;
    const storage = join(locations.hf, `models--${model.repository.replaceAll('/', '--')}`);
    const blob = join(storage, 'blobs', model.sha256);
    await mkdir(dirname(blob), { recursive: true });
    await mkdir(dirname(pointer), { recursive: true });
    if (!(await validModel(blob, model.size))) {
      const temp = `${blob}.agent-voice-${process.pid}.incomplete`;
      const url = `https://huggingface.co/${model.repository}/resolve/${model.revision}/${model.filename}`;
      onStatus(`Downloading ${model.name} (${Math.ceil(model.size / 1048576)} MiB)…`);
      let file;
      try {
        const response = await fetchImpl(url, { signal });
        if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
        file = await open(temp, 'w', 0o600);
        let bytes = 0, last = 0;
        const hash = createHash('sha256');
        for await (const chunk of response.body) {
          signal?.throwIfAborted();
          bytes += chunk.length;
          if (bytes > model.size) throw new Error('The downloaded file exceeds the expected size.');
          hash.update(chunk);
          await file.writeFile(chunk);
          if (Date.now() - last > 1000) {
            onStatus(`${model.name}: ${Math.floor(bytes / model.size * 100)}%`); last = Date.now();
          }
        }
        await file.close(); file = undefined;
        if (bytes !== model.size || hash.digest('hex') !== model.sha256) throw new Error('Incomplete model or SHA-256 checksum mismatch.');
        if (!(await validModel(temp, model.size))) throw new Error('The downloaded model is not a GGUF file.');
        await rename(temp, blob);
      } finally { await file?.close(); await rm(temp, { force: true }); }
    }
    // Standard HF snapshots → blobs. Hard link fallback avoids Windows duplication.
    if (!(await validModel(pointer, model.size))) {
      const temp = `${pointer}.agent-voice-${process.pid}`;
      try {
        try { await symlink(relative(dirname(pointer), blob), temp); }
        catch { await link(blob, temp); }
        await rename(temp, pointer);
      } finally { await rm(temp, { force: true }); }
    }
    return pointer;
  }, { signal });
}

export function validateSettings(value) {
  if (!value || value.version !== 1 || typeof value.model?.path !== 'string' ||
      !['ctrl+alt+z', 'f2'].includes(value.shortcut) ||
      typeof value.language !== 'string' || !/^(auto|[a-z]{2,3}(-[A-Za-z]+)?)$/.test(value.language)) {
    throw new Error('Invalid agent-voice settings; run agent-voice setup.');
  }
  const mic = value.microphone;
  if (!mic || !(mic.type === 'system-default' || (mic.type === 'device' && typeof mic.name === 'string' && Number.isInteger(mic.occurrence) && mic.occurrence >= 0))) {
    throw new Error('Invalid microphone settings.');
  }
  return value;
}

export async function readSettings(locations = paths()) {
  const config = await readJson(locations.config, undefined);
  return config ? validateSettings(config) : undefined;
}

/** Read-only adoption: never overwrite Pi's settings or move an existing model. */
export async function ensureSettings(options = {}) {
  const p = options.locations || paths();
  return withLock(`${p.config}.lock`, async () => {
    let current = await readSettings(p);
    if (!current) {
      const pi = await readJson(join(p.pi, 'pi-transcribe.json'), undefined);
      if (pi?.version === 1 && pi.backend?.type === 'transcribe-cpp' && await validModel(pi.model?.path)) {
        current = {
          version: 1, model: { id: pi.model.id, path: pi.model.path },
          language: pi.transcriptionLanguage || 'auto',
          shortcut: ['ctrl+alt+z', 'f2'].includes(pi.shortcut) ? pi.shortcut : DEFAULT_SHORTCUT,
          microphone: pi.microphone || { type: 'system-default' },
        };
      }
    }
    current ||= { version: 1, model: { id: DEFAULT_MODEL, path: '' }, language: 'auto', shortcut: DEFAULT_SHORTCUT, microphone: { type: 'system-default' } };
    if (options.model) {
      const selected = CATALOG.find(m => m.id === options.model);
      current.model = selected ? { id: selected.id, path: modelCachePath(selected, p) }
        : { id: 'local', path: resolve(options.model) };
    }
    if (options.language) current.language = options.language;
    if (options.shortcut) current.shortcut = options.shortcut;
    if (options.microphone) current.microphone = options.microphone;
    validateSettings(current);
    const known = CATALOG.find(m => m.id === current.model.id);
    if (known && current.language !== 'auto' && !known.languages.includes(current.language)) throw new Error(`Model ${known.id} does not support ${current.language}.`);
    if (!(await validModel(current.model.path, known?.size))) {
      if (!known) throw new Error(`Model missing or invalid: ${current.model.path}`);
      const cached = modelCachePath(known, p);
      if (await validModel(cached, known.size)) current.model.path = cached;
      else {
        if (!await options.confirmDownload?.(known)) throw new Error('Model not downloaded. Run agent-voice setup to select one.');
        current.model.path = await downloadModel(known, { ...options, locations: p });
      }
    }
    await writeJson(p.config, current);
    return current;
  }, options);
}
