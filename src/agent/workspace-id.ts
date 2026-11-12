import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

export const workspaceIdFileName = '.awm/workspace.json';

export async function writeWorkspaceId(directory: string, id: string, metadata?: {
  remoteRoot: string; host: string; port: number; user: string; terminalOnly: boolean;
}): Promise<void> {
  if (!id.trim() || /\s/.test(id)) throw new Error('Invalid workspace ID');
  const bindingDirectory = join(directory, '.awm');
  await mkdir(bindingDirectory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(bindingDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Invalid workspace binding directory');
  const target = join(directory, workspaceIdFileName);
  let previous: Record<string, unknown> = {};
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing non-regular workspace ID file: ${target}`);
    previous = JSON.parse(await readFile(target, 'utf8'));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({
      ...previous, version: 2, kind: 'remote', ...metadata, workspaceId: id
    }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function findWorkspaceId(cwd: string): Promise<{ directory: string; id: string } | undefined> {
  const directory = resolve(cwd);
  const target = join(directory, workspaceIdFileName);
  try {
    const metadata = await lstat(join(directory, '.awm'));
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Invalid workspace binding directory');
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid workspace ID file: ${target}. Use --id ID.`);
    const binding = JSON.parse(await readFile(target, 'utf8'));
    if (binding?.version !== 2 || binding.kind !== 'remote'
      || typeof binding.workspaceId !== 'string' || !binding.workspaceId.trim()) {
      throw new Error(`Invalid workspace binding: ${target}. Reopen the remote workspace.`);
    }
    return { directory, id: binding.workspaceId };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export interface LocalWorkspace { workspaceId: string; localRoot?: string }
export async function resolveWorkspaceId(
  cwd: string, discover: () => Promise<LocalWorkspace[]>
): Promise<string> {
  const marker = await findWorkspaceId(cwd);
  if (!marker) throw new Error(`No ${workspaceIdFileName} found. Run safs workspaces and pass --id ID; use explicit --id for operations across multiple workspaces.`);
  const workspaces = await discover();
  if (marker.id && workspaces.some(w => w.workspaceId === marker.id)) return marker.id;
  const matches = workspaces.filter(w => {
    if (!w.localRoot) return false;
    const rel = relative(resolve(w.localRoot), resolve(cwd));
    return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
  });
  if (matches.length !== 1) throw new Error(`Workspace ID is expired or invalid; ${matches.length ? 'multiple placeholder workspaces match' : 'no active placeholder workspace matches'}. Run safs workspaces and pass --id ID.`);
  await writeWorkspaceId(marker.directory, matches[0].workspaceId);
  return matches[0].workspaceId;
}
