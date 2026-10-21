import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';

export interface AgentCwdPlaceholder {
  localPath: string;
  created: boolean;
}

export function safeAgentCwdName(mountName: string): string {
  const normalized = mountName.normalize('NFKC').trim();
  const encoded = [...normalized].map((character) =>
    /[\p{L}\p{N}._@-]/u.test(character) ? character : '_'
  ).join('').replace(/_+/g, '_').replace(/^[. ]+|[. ]+$/g, '');
  const shortened = [...encoded].slice(0, 48).join('') || 'mount';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(shortened)
    ? `_${shortened}`
    : shortened;
}

function ipPathSegment(ip: string): string {
  const ipv4 = ip.split('.');
  if (ipv4.length === 4 && ipv4.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part)
    && Number(part) <= 255)) {
    return ipv4.map((part) => Number(part).toString(16).padStart(2, '0')).join('');
  }
  return Buffer.from(ip, 'utf8').toString('hex');
}

function remotePathSegments(remoteRoot: string): string[] {
  const segments = path.posix.normalize(remoteRoot).split('/').filter(Boolean);
  return segments.length > 0 ? segments.map(safeAgentCwdName) : ['root'];
}

async function exists(value: string): Promise<boolean> {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Creates a real, user-writable directory for native Agents to use as cwd.
 * The SFTP provider maps this directory-shaped URI namespace to remoteRoot;
 * no directory or symlink is created at the remote machine's absolute path.
 */
export async function ensureAgentCwdPlaceholder(
  remoteRoot: string, storageRoot: string, mountName = '', hostIp?: string, user?: string
): Promise<AgentCwdPlaceholder> {
  if (!path.posix.isAbsolute(remoteRoot)) {
    throw new Error(`Agent cwd requires an absolute remote path: ${remoteRoot}`);
  }
  const localPath = hostIp && user !== undefined
    ? path.join(storageRoot, 'agent-cwd', ipPathSegment(hostIp),
      safeAgentCwdName(user), ...remotePathSegments(remoteRoot))
    : path.join(storageRoot, 'agent-cwd', createHash('sha256')
      .update(mountName).update('\0').update(path.posix.normalize(remoteRoot))
      .digest('hex').slice(0, 16), safeAgentCwdName(mountName));
  const created = !await exists(localPath);
  await mkdir(localPath, { recursive: true });
  return { localPath, created };
}

/** Creates the local empty directory that represents a remote workspace subdirectory. */
export async function ensureAgentCwdSubdirectory(
  localRoot: string, remoteRoot: string, remotePath: string
): Promise<string> {
  const relative = path.posix.relative(
    path.posix.normalize(remoteRoot), path.posix.normalize(remotePath)
  );
  if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
    throw new Error(`Agent cwd path is outside the remote root: ${remotePath}`);
  }
  const localPath = relative
    ? path.join(localRoot, ...relative.split('/'))
    : localRoot;
  await mkdir(localPath, { recursive: true });
  return localPath;
}

function lastRemoteDirectoryPath(localRoot: string): string {
  // Keep metadata beside the directory exposed as the Agent cwd so the cwd
  // itself remains an empty mirror of the remote namespace.
  return path.join(path.dirname(localRoot), 'last-remote-directory');
}

export async function readLastRemoteDirectory(localRoot: string): Promise<string | undefined> {
  try {
    const value = (await readFile(lastRemoteDirectoryPath(localRoot), 'utf8')).trim();
    return value && path.posix.isAbsolute(value) ? path.posix.normalize(value) : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function writeLastRemoteDirectory(
  localRoot: string, remoteRoot: string, remotePath: string
): Promise<void> {
  const normalizedRoot = path.posix.normalize(remoteRoot);
  const normalizedPath = path.posix.normalize(remotePath);
  const relative = path.posix.relative(normalizedRoot, normalizedPath);
  if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
    throw new Error(`Cached Agent cwd path is outside the remote root: ${remotePath}`);
  }
  await writeFile(lastRemoteDirectoryPath(localRoot), `${normalizedPath}\n`, {
    encoding: 'utf8', mode: 0o600
  });
}
