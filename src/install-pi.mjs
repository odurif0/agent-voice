import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { paths } from './paths.mjs';
import { readJson, writeJson, withLock } from './storage.mjs';

export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceOf = entry => typeof entry === 'string' ? entry : entry?.source;
const isOriginal = entry => /(?:^|[/@:])pi-transcribe(?:\.git)?(?:[@#][^\s/]+)?$/.test(sourceOf(entry) || '');

export async function installPi({ locations = paths(), packageRoot = PACKAGE_ROOT } = {}) {
  const path = join(locations.pi, 'settings.json');
  const statePath = join(locations.root, 'pi-install.json');
  await withLock(`${path}.agent-voice-lock`, async () => {
    const settings = await readJson(path, {});
    const packages = settings.packages || [];
    const state = await readJson(statePath, { version: 1, disabled: [] });
    settings.packages = packages.map(entry => {
      if (!isOriginal(entry) || (typeof entry === 'object' && entry.extensions?.length === 0)) return entry;
      state.disabled.push({ original: entry, source: sourceOf(entry) });
      return { ...(typeof entry === 'object' ? entry : { source: entry }), extensions: [] };
    });
    if (!settings.packages.some(entry => sourceOf(entry) === packageRoot)) settings.packages.push(packageRoot);
    // Write recovery information first, preserving unrelated settings on every run.
    await writeJson(statePath, state);
    await writeJson(path, settings);
  });
}

export async function uninstallPi({ locations = paths(), packageRoot = PACKAGE_ROOT } = {}) {
  const path = join(locations.pi, 'settings.json');
  if (!existsSync(path)) return;
  await withLock(`${path}.agent-voice-lock`, async () => {
    const settings = await readJson(path, {});
    const state = await readJson(join(locations.root, 'pi-install.json'), { disabled: [] });
    settings.packages = (settings.packages || []).filter(entry => sourceOf(entry) !== packageRoot).map(entry => {
      const saved = state.disabled.find(value => value.source === sourceOf(entry));
      // Do not overwrite an intervening user change.
      const expected = saved && { ...(typeof saved.original === 'object' ? saved.original : { source: saved.source }), extensions: [] };
      return saved && JSON.stringify(entry) === JSON.stringify(expected) ? saved.original : entry;
    });
    await writeJson(path, settings);
    await writeJson(join(locations.root, 'pi-install.json'), { version: 1, disabled: [] });
  });
}
