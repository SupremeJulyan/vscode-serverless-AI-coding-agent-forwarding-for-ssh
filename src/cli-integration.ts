import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';

export function cliConfigPath(storageRoot: string) { return path.join(storageRoot, 'cli-connection.json'); }

export async function writeCliConnection(storageRoot: string, url: string) {
  await mkdir(storageRoot, { recursive: true });
  const target = cliConfigPath(storageRoot);
  const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, url }) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(() => {}); }
}

const begin = '<!-- SAFS CLI BEGIN -->';
const end = '<!-- SAFS CLI END -->';
export function cliInstructions(cliPath: string, configPath: string, windows = false) {
  const quote = (value: string) => windows ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, `'"'"'`)}'`;
  const command = `${windows ? '& ' : ''}node ${quote(cliPath)} --config ${quote(configPath)}`;
  return [
    'This is a SAFS remote workspace. Local files here are only staging files, not remote source files.',
    `Use the local shell solely as a transport: ${command} --help`,
    `Bind once with ${command} bind --cwd <actual-local-cwd> and reuse bindingId explicitly.`,
    'Use CLI list/read/search to inspect remote evidence; edit/write for changes; upload/download for transfers. Use bounded reads and output continuation.',
    'If bind returns candidates, ask the user first. Only after their answer run switch --workspace ID --confirmed true, then stop the previous task and await a new request.',
    'Never automatically rebind after expiry, choose a host from focus for subsequent operations, or run local file tools on remote paths.',
    'The connection file contains a token: the CLI reads it; do not print it or place it in model context.',
    'Do not register SAFS MCP in this CLI mode. Node.js 18+ must be available to the local Agent.'
  ].join('\n');
}

/** Only call for a SAFS-owned placeholder parent, never a remote or synced project. */
export async function updateCliInstructions(parent: string, instructions?: string) {
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
    const next = instructions ? `${unrelated}${unrelated && !unrelated.endsWith('\n') ? '\n' : ''}${begin}\n${instructions}\n${end}\n` : unrelated;
    if (next === previous) continue;
    if (!next) await unlink(target);
    else await writeFile(target, next, { mode: 0o600 });
  }
}
