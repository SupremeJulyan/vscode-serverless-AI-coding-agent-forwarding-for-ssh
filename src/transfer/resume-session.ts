import { randomBytes } from 'node:crypto';
import { open, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

interface ResumeOwner {
  pid: number;
  token: string;
}

const TOKEN_PATTERN = /^[0-9a-f]{16}$/;
const STALE_EMPTY_CLAIM_MS = 5_000;

function newToken(): string {
  return randomBytes(8).toString('hex');
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readOwner(file: string): Promise<ResumeOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as Partial<ResumeOwner>;
    if (Number.isInteger(value.pid) && (value.pid ?? 0) > 0
      && typeof value.token === 'string' && TOKEN_PATTERN.test(value.token)) {
      return { pid: value.pid!, token: value.token };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT'
      && !(error instanceof SyntaxError)) throw error;
  }
  return undefined;
}

async function claim(file: string): Promise<boolean> {
  try {
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(`${process.pid}\n`); }
    finally { await handle.close(); }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  let stale = false;
  try {
    const pid = Number.parseInt(await readFile(file, 'utf8'), 10);
    if (Number.isInteger(pid) && pid > 0) stale = !isProcessAlive(pid);
    else stale = Date.now() - (await stat(file)).mtimeMs > STALE_EMPTY_CLAIM_MS;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return claim(file);
    throw error;
  }
  if (!stale) return false;

  await unlink(file).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
  try {
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(`${process.pid}\n`); }
    finally { await handle.close(); }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * The first live extension host owns the persistent resume token. Concurrent
 * hosts get private tokens; after the owner exits, the next host adopts its
 * token and can continue the same partial transfers.
 */
export async function acquireResumeSessionToken(storageDirectory: string): Promise<string> {
  await mkdir(storageDirectory, { recursive: true });
  const ownerFile = path.join(storageDirectory, 'transfer-resume-owner.json');
  const claimFile = path.join(storageDirectory, 'transfer-resume-owner.claim');
  if (!await claim(claimFile)) return newToken();

  try {
    const owner = await readOwner(ownerFile);
    if (owner && isProcessAlive(owner.pid)) {
      // Re-activation inside the owning extension host keeps its lease.
      return owner.pid === process.pid ? owner.token : newToken();
    }

    const token = owner?.token ?? newToken();
    await writeFile(ownerFile, `${JSON.stringify({ pid: process.pid, token })}\n`, {
      encoding: 'utf8', mode: 0o600
    });
    return token;
  } finally {
    await unlink(claimFile).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}
