import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

export const workspaceIdFileName = '.safs-workspace-id';

export async function writeWorkspaceId(directory: string, id: string): Promise<void> {
  if (!id.trim() || /\s/.test(id)) throw new Error('Invalid workspace ID');
  const target = join(directory, workspaceIdFileName);
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing non-regular workspace ID file: ${target}`);
    if ((await readFile(target, 'utf8')).trim() === id) return;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, id + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function findWorkspaceId(cwd: string): Promise<{ directory: string; id: string } | undefined> {
  const directory = resolve(cwd);
  const target = join(directory, workspaceIdFileName);
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid workspace ID file: ${target}. Use --id ID.`);
    return { directory, id: (await readFile(target, 'utf8')).trim() };
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
