import { randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
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

interface ResumeSession {
  token: string;
  persistent: boolean;
}

let session: Promise<ResumeSession> | undefined;
let storageDirectory: string | undefined;
let log: ((message: string) => void) | undefined;

export function configureResumeSession(directory: string, logger: (message: string) => void): void {
  storageDirectory = directory;
  log = logger;
}

/** Idle windows never claim the shared token. Keep the lease alive until the host exits. */
export function transferResumeSession(): Promise<ResumeSession> | undefined {
  const directory = storageDirectory;
  if (!directory) return undefined;
  return session ??= acquire(directory).catch((error: unknown) => {
    log?.(`无法获取共享续传令牌，当前进程使用临时令牌：${String(error)}`);
    return { token: randomBytes(8).toString('hex'), persistent: false };
  });
}

async function acquire(directory: string): Promise<ResumeSession> {
  const lease = createServer(socket => socket.destroy());
  let key = path.resolve(directory);
  if (process.platform === 'win32') key = key.toLowerCase();
  try {
    await listenIpc(lease, ipcPath(`transfer-resume:${key}`));
  } catch (error) {
    if (lease.listening) lease.close();
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      return { token: randomBytes(8).toString('hex'), persistent: false };
    }
    throw error;
  }
  lease.unref();

  try {
    await mkdir(directory, { recursive: true });
    // A fixed token lets us keep using parts from the previous primary host.
    const ownerFile = path.join(directory, 'transfer-resume-owner.json');
    let owner: { token?: unknown; pid?: unknown } | undefined;
    try {
      owner = JSON.parse(await readFile(ownerFile, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    if (typeof owner?.pid === 'number' && Number.isInteger(owner.pid) && owner.pid > 0
      && owner.pid !== process.pid) {
      try {
        process.kill(owner.pid, 0);
        // An older version may still be writing with this token.
        lease.close();
        return { token: randomBytes(8).toString('hex'), persistent: false };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    const validToken = typeof owner?.token === 'string' && /^[0-9a-f]{16}$/.test(owner.token)
      ? owner.token : undefined;
    const token = validToken ?? randomBytes(8).toString('hex');
    if (!validToken || owner?.pid !== undefined) {
      const temporary = `${ownerFile}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ token }), { flag: 'wx', mode: 0o600 });
        await rename(temporary, ownerFile);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    return { token, persistent: true };
  } catch (error) {
    lease.close();
    throw error;
  }
}
