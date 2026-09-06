import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';

export function cliConfigPath(storageRoot: string) { return path.join(storageRoot, 'cli-connection.json'); }

export async function writeCliConnection(storageRoot: string, url: string) {
  await mkdir(storageRoot, { recursive: true });
  await writeCliConnectionFile(cliConfigPath(storageRoot), url);
}

export async function writeCliConnectionFile(target: string, url: string) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, url }) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(() => {}); }
}

const begin = '<!-- SAFS CLI BEGIN -->';
const end = '<!-- SAFS CLI END -->';
/** Remove instruction blocks written by pre-global-CLI releases. */
export async function updateCliInstructions(parent: string) {
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const target = path.join(parent, name);
    let previous = '';
    try {
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing non-regular instruction file: ${target}`);
      previous = await readFile(target, 'utf8');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const a = previous.indexOf(begin), b = previous.indexOf(end);
    if ((a < 0) !== (b < 0) || (a >= 0 && b < a)) throw new Error(`Malformed SAFS instruction block: ${target}`);
    const unrelated = a < 0 ? previous : previous.slice(0, a) + previous.slice(b + end.length).replace(/^\n/, '');
    const next = unrelated;
    if (next === previous) continue;
    if (!next) await unlink(target);
    else await writeFile(target, next, { mode: 0o600 });
  }
}
