import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { LocalGitRunner } from './local-git-push';

/** Cache objects by network destination and object format; never persist credential-bearing URLs. */
export function relayCachePath(storagePath: string, url: string, format: string): string {
  const key = createHash('sha256').update(format).update('\0').update(url).digest('hex');
  return path.join(`${storagePath}-objects`, `${key}.git`);
}

async function lockCache(directory: string, signal?: AbortSignal): Promise<() => Promise<void>> {
  const lock = `${directory}.lock`;
  await mkdir(path.dirname(directory), { recursive: true });
  while (true) {
    signal?.throwIfAborted();
    try {
      await mkdir(lock);
      try { await writeFile(path.join(lock, 'owner'), String(process.pid), { flag: 'wx' }); }
      catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
      return () => rm(lock, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Only reclaim a lock with a recorded owner that no longer exists.
      const pid = Number(await readFile(path.join(lock, 'owner'), 'utf8').catch(() => ''));
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); }
        catch (failure) {
          if ((failure as NodeJS.ErrnoException).code === 'ESRCH') {
            await rm(lock, { recursive: true, force: true });
            continue;
          }
        }
      }
      await new Promise<void>((resolve, reject) => {
        const aborted = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); reject(signal?.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, 50);
        signal?.addEventListener('abort', aborted, { once: true });
        if (signal?.aborted) aborted();
      });
    }
  }
}

/** Each operation keeps its own refs; a per-cache lock protects shared objects across windows. */
export async function attachRelayCache(options: {
  storagePath: string; repository: string; url: string; format: string;
  local: LocalGitRunner; signal?: AbortSignal; shallow?: boolean;
  log?: (message: string) => void;
}): Promise<(publish: boolean) => Promise<void>> {
  // Shallow boundaries belong to each remote; sharing them with a full-history cache is unsafe.
  if (options.shallow) return async () => {};
  const cache = relayCachePath(options.storagePath, options.url, options.format);
  if (/[\r\n]/.test(cache)) return async () => {};
  const release = await lockCache(cache, options.signal);
  try {
    await options.local(['init', '--bare', `--object-format=${options.format}`, cache], options.signal);
    await options.local(['-C', cache, 'config', 'gc.auto', '0'], options.signal);
    await writeFile(path.join(options.repository, 'objects', 'info', 'alternates'), `${cache}/objects\n`);
    await options.local(['-C', options.repository, 'fetch', '--no-tags', cache,
      '+refs/heads/*:refs/safs-cache/*'], options.signal);
  } catch (error) { await release(); throw error; }
  return async (publish) => {
    try {
      // Cache publication is optional; an aborted operation must not delay shutdown.
      if (publish && !options.signal?.aborted) {
        await options.local(['-C', cache, 'fetch', '--no-tags', options.repository,
          '+refs/heads/*:refs/heads/*'], options.signal);
      }
    } catch (error) { options.log?.(`Git 对象缓存更新失败：${String(error)}`); }
    finally { await release(); }
  };
}

export async function relayHasCommit(
  local: LocalGitRunner, repository: string, oid: string, signal?: AbortSignal
): Promise<boolean> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) throw new Error('Invalid Git commit ID');
  try { await local(['-C', repository, 'cat-file', '-e', `${oid}^{commit}`], signal); return true; }
  catch (error) { signal?.throwIfAborted(); return false; }
}
