import * as path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

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

export function legacyAgentCwdPath(remoteRoot: string, storageRoot: string, host: string, user: string): string {
  const segments = path.posix.normalize(remoteRoot).split('/').filter(Boolean);
  return path.join(storageRoot, 'agent-cwd', ipPathSegment(host), safeAgentCwdName(user),
    ...(segments.length ? segments.map(safeAgentCwdName) : ['root']));
}

export function agentCwdDirectoryName(host: string, port: number, user: string, remoteRoot: string): string {
  const normalized = path.posix.normalize(remoteRoot);
  if (!path.posix.isAbsolute(normalized)) throw new Error('Expected an absolute remote path');
  const segments = normalized.split('/').filter(Boolean);
  const name = `${safeAgentCwdName(user)}@${safeAgentCwdName(host)}@${port}${segments.map(safeAgentCwdName).join('-') || 'root'}`;
  const lossy = [host, user, ...segments].some(value => safeAgentCwdName(value) !== value || /[-@]/.test(value))
    || normalized === '/root' || Buffer.byteLength(name) > 180;
  const hash = createHash('sha256').update(JSON.stringify([host, port, user, normalized])).digest('hex').slice(0, 12);
  return lossy ? `${name.slice(0, 140)}-${hash}` : name;
}

interface PlaceholderIdentity { host: string; port: number; user: string; storageRoot: string; }
export interface PlaceholderMapping { localPath: string; remoteRoot: string; }
const identities = new Map<string, PlaceholderIdentity>();
const mappings = new Map<string, PlaceholderMapping[]>();
function mappingKey(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\/(?=[A-Za-z]:\/)/, '');
  return process.platform === 'win32' || /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}
function identityKey(identity: PlaceholderIdentity): string {
  return JSON.stringify([identity.storageRoot, identity.host, identity.port, identity.user]);
}
export function agentCwdMappings(localRoot: string): PlaceholderMapping[] {
  const identity = identities.get(mappingKey(localRoot));
  return identity ? mappings.get(identityKey(identity)) ?? [] : [];
}

async function readablePlaceholder(remoteRoot: string, identity: PlaceholderIdentity): Promise<AgentCwdPlaceholder> {
  const parent = path.join(homedir(), '.safs', 'remote_workspace');
  const key = identityKey(identity);
  if (!mappings.has(key)) {
    mappings.set(key, []);
    const restored: PlaceholderMapping[] = [];
    const entries = await readdir(parent, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const record = JSON.parse(await readFile(path.join(parent, entry.name, '.safs-placeholder.json'), 'utf8'));
        if (record.host !== identity.host || record.port !== identity.port || record.user !== identity.user) continue;
        if (entry.name !== agentCwdDirectoryName(identity.host, identity.port, identity.user, record.remoteRoot)) continue;
        restored.push({ localPath: path.join(parent, entry.name), remoteRoot: record.remoteRoot });
      } catch { /* Other directories are not SAFS placeholder mappings. */ }
    }
    for (const item of restored) {
      if (!mappings.get(key)!.some(existing => existing.localPath === item.localPath)) mappings.get(key)!.push(item);
    }
  }
  const registered = mappings.get(key)!.find(item => item.remoteRoot === remoteRoot);
  const namedPath = path.join(parent, agentCwdDirectoryName(identity.host, identity.port, identity.user, remoteRoot));
  const candidates = [registered?.localPath, namedPath]
    .filter((value): value is string => Boolean(value));
  let localPath = namedPath;
  for (const candidate of candidates) {
    if (mappings.get(key)!.some(item => item.localPath === candidate && item.remoteRoot !== remoteRoot)) continue;
    if (await exists(candidate)) {
      if (!(await lstat(candidate)).isDirectory()) continue;
      localPath = candidate;
      break;
    }
  }
  const created = !await exists(localPath);
  if (!created && !(await lstat(localPath)).isDirectory()) throw new Error('Placeholder path is not a directory');
  await mkdir(localPath, { recursive: true });
  await writeFile(path.join(localPath, '.safs-placeholder.json'), JSON.stringify({
    host: identity.host, port: identity.port, user: identity.user, remoteRoot
  }) + '\n', { mode: 0o600 });
  identities.set(mappingKey(localPath), identity);
  const items = mappings.get(key)!;
  if (!items.some(item => item.localPath === localPath)) items.push({ localPath, remoteRoot });
  return { localPath, created };
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
  remoteRoot: string, storageRoot: string, mountName = '', hostIp?: string, user?: string, port = 22
): Promise<AgentCwdPlaceholder> {
  if (!path.posix.isAbsolute(remoteRoot)) {
    throw new Error(`Agent cwd requires an absolute remote path: ${remoteRoot}`);
  }
  if (hostIp && user !== undefined) {
    return readablePlaceholder(path.posix.normalize(remoteRoot), { host: hostIp, port, user, storageRoot });
  }
  const localPath = path.join(homedir(), '.safs', 'remote_workspace', createHash('sha256')
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
  const identity = identities.get(mappingKey(localRoot));
  if (identity) return (await readablePlaceholder(path.posix.normalize(remotePath), identity)).localPath;
  const localPath = relative
    ? path.join(localRoot, ...relative.split('/'))
    : localRoot;
  await mkdir(localPath, { recursive: true });
  return localPath;
}

function lastRemoteDirectoryPath(localRoot: string): string {
  // Keep metadata beside the directory exposed as the Agent cwd so the cwd
  // itself remains an empty mirror of the remote namespace.
  return localRoot + '.last-remote-directory';
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
