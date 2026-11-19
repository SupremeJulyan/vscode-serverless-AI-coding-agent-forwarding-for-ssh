import { realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import * as path from 'node:path';
import { ipcPath, listenIpc } from '../agent/agent-ipc';

/** Hold the destination until the file stream and its cleanup have finished. */
export async function withLocalDownloadLease<T>(
  target: string, transfer: (canonicalTarget: string) => Promise<T>
): Promise<T> {
  const directory = await realpath(path.dirname(target));
  const canonicalTarget = path.join(directory, path.basename(target));
  const key = process.platform === 'win32' ? canonicalTarget.toLowerCase() : canonicalTarget;
  const lease = createServer(socket => socket.destroy());
  try {
    await listenIpc(lease, ipcPath(`download-target:${key}`));
  } catch (error) {
    if (lease.listening) lease.close();
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error(`已有下载正在写入此目标：${target}`);
    }
    throw error;
  }
  try {
    return await transfer(canonicalTarget);
  } finally {
    await new Promise<void>(resolve => lease.close(() => resolve()));
  }
}
