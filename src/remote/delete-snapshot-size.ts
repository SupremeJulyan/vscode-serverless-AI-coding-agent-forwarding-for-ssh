import { posix } from 'node:path';
import type { SftpSession, SftpFileStat } from '../ssh2/session';
import { assertSafeRemoteEntryName } from '../ssh2/uri';

export const maxDeleteSnapshotBytes = 5 * 1024 * 1024;

export async function exceedsDeleteSnapshotLimit(
  session: Pick<SftpSession, 'readDirectory'>,
  path: string,
  stat: SftpFileStat,
  recursive: boolean,
  signal?: AbortSignal
): Promise<boolean> {
  signal?.throwIfAborted();
  if (stat.type === 'file') return stat.size > maxDeleteSnapshotBytes;
  if (stat.type !== 'directory' || !recursive) return false;
  const pending = [path];
  let bytes = 0;
  while (pending.length > 0) {
    signal?.throwIfAborted();
    const directory = pending.pop()!;
    for (const entry of await session.readDirectory(directory, signal)) {
      assertSafeRemoteEntryName(entry.name);
      if (entry.type === 'directory') pending.push(posix.join(directory, entry.name));
      if (entry.type === 'file') bytes += entry.size;
      if (bytes > maxDeleteSnapshotBytes) return true;
    }
  }
  return false;
}
