import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const backupLifetimeMs = 7 * 24 * 60 * 60 * 1000;

export function localMutationBackupRoot(storage: string): string {
  return join(storage, 'mutation-backups');
}

const cleanupByStorage = new Map<string, Promise<void>>();

export function pruneLocalMutationBackups(storage: string): Promise<void> {
  const existing = cleanupByStorage.get(storage);
  if (existing) return existing;
  const cleanup = pruneExpiredBackups(storage).finally(() => cleanupByStorage.delete(storage));
  cleanupByStorage.set(storage, cleanup);
  return cleanup;
}

async function pruneExpiredBackups(storage: string): Promise<void> {
  const root = localMutationBackupRoot(storage);
  const directory = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (!directory?.isDirectory()) return;
  const cutoff = Date.now() - backupLifetimeMs;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^backup-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
    const target = join(root, entry.name);
    const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (info?.isDirectory() && info.mtimeMs <= cutoff) {
      await rm(target, { recursive: true, force: true });
    }
  }
}
