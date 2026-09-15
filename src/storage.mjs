import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`Cannot read ${path}: ${error.message}`, { cause: error });
  }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

/** Same-user interprocess lock. A dead owner's lock is recovered after a crash. */
export async function acquireLock(path, { signal, timeout = 300_000 } = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const started = Date.now();
  for (;;) {
    signal?.throwIfAborted();
    try { await mkdir(path, { mode: 0o700 }); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const owner = await readJson(join(path, 'owner.json'), undefined);
    const age = await stat(path).then(s => Date.now() - s.mtimeMs, () => 0);
    if ((owner && !alive(owner.pid)) || (!owner && age > 300_000)) {
      // Serialize recovery and re-read ownership. Two waiters must not both
      // rename a stale lock, accidentally removing the first waiter's NEW lock.
      const recovery = `${path}.recovery`;
      let acquired = false, recovered = false;
      try {
        await mkdir(recovery); acquired = true;
        const fresh = await readJson(join(path, 'owner.json'), undefined);
        const freshAge = await stat(path).then(s => Date.now() - s.mtimeMs, () => 0);
        if ((fresh && !alive(fresh.pid)) || (!fresh && freshAge > 300_000)) {
          const stale = `${path}.stale-${randomUUID()}`;
          try { await rename(path, stale); await rm(stale, { recursive: true, force: true }); recovered = true; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const recoveryAge = await stat(recovery).then(s => Date.now() - s.mtimeMs, () => 0);
        if (recoveryAge > 300_000) await rm(recovery, { recursive: true, force: true });
      } finally { if (acquired) await rm(recovery, { recursive: true, force: true }); }
      // timeout: 0 forbids waiting for a LIVE owner; after recovery, retry the
      // now-free resource immediately instead of reporting it as still busy.
      if (recovered) continue;
    }
    if (Date.now() - started >= timeout) throw new Error(`Resource busy: ${path}`);
    await sleep(60, undefined, { signal });
  }
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await rm(path, { recursive: true, force: true });
  };
  try {
    await writeJson(join(path, 'owner.json'), { pid: process.pid });
    signal?.throwIfAborted();
    return release;
  } catch (error) { await release(); throw error; }
}

export async function withLock(path, fn, options = {}) {
  const release = await acquireLock(path, options);
  try { return await fn(); } finally { await release(); }
}
