import * as path from 'node:path';
import { homedir } from 'node:os';
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { agentCwdDirectoryName } from '../agent/agent-cwd';

export function needsSessionMigration(version: string | undefined): boolean {
  if (!version) return true; // Releases before this patch did not record a version.
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major < 2 || major === 2 && (minor < 1 || minor === 1 && patch <= 5);
}

async function* files(root: string): AsyncGenerator<string> {
  const entries = await readdir(root, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) yield* files(file);
    else if (entry.isFile()) yield file;
  }
}

/** Only structured cwd fields are rewritten; conversation text is preserved. */
export async function migrateSessionCwds(storageRoot: string, home = homedir()): Promise<void> {
  const oldRoot = path.join(storageRoot, 'agent-cwd');
  const targetRoot = path.join(home, '.safs', 'remote_workspace');
  const mappings = new Map<string, string>();
  for await (const file of files(oldRoot)) {
    if (path.basename(file) !== '.safs-placeholder.json') continue;
    const record = JSON.parse(await readFile(file, 'utf8'));
    const target = path.join(targetRoot, agentCwdDirectoryName(record.host, record.port, record.user, record.remoteRoot));
    mappings.set(path.dirname(file), target);
  }
  const mapCwd = (cwd: string): string => {
    if (mappings.has(cwd)) return mappings.get(cwd)!;
    const relative = path.relative(oldRoot, cwd);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return cwd;
    const [endpoint, user, ...remote] = relative.split(path.sep);
    // <=2.1.5 also used hex-host/user/root and nested absolute remote paths.
    if (/^(?:[a-f0-9]{2})+$/i.test(endpoint ?? '') && user && remote.length) {
      const host = endpoint.length === 8
        ? endpoint.match(/../g)!.map(part => parseInt(part, 16)).join('.')
        : Buffer.from(endpoint, 'hex').toString('utf8');
      const rootIndex = remote[0] === 'root' ? 1 : 0;
      return path.join(targetRoot, agentCwdDirectoryName(host, 22, user, '/' + remote.slice(rootIndex).join('/')));
    }
    // Readable placeholders kept the same directory name in the new location.
    if (endpoint?.includes('@')) return path.join(targetRoot, relative);
    return cwd;
  };
  const codex = process.env.CODEX_HOME || path.join(home, '.codex');
  const claude = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  for (const root of [path.join(codex, 'sessions'), path.join(codex, 'archived_sessions'), path.join(claude, 'projects')]) {
    for await (const file of files(root)) {
      if (!file.endsWith('.jsonl')) continue;
      let newCwd: string | undefined;
      const original = await readFile(file, 'utf8');
      const updated = original.split('\n').map(line => {
        if (!line.trim()) return line;
        let record: any;
        try { record = JSON.parse(line); } catch { return line; }
        let changed = false;
        for (const object of [record, record.type === 'session_meta' || record.type === 'turn_context' ? record.payload : undefined]) {
          if (typeof object?.cwd !== 'string') continue;
          const next = mapCwd(object.cwd);
          if (next === object.cwd) continue;
          mappings.set(object.cwd, next);
          object.cwd = next;
          newCwd = next;
          changed = true;
        }
        return changed ? JSON.stringify(record) : line;
      }).join('\n');
      if (updated === original) continue;
      await copyFile(file, file + '.safs-pre-2.1.5.bak', 1).catch(error => { if (error.code !== 'EEXIST') throw error; });
      await writeFile(file + '.safs-tmp', updated, { mode: 0o600 });
      await rename(file + '.safs-tmp', file);
      if (newCwd) await mkdir(newCwd, { recursive: true });
      if (root === path.join(claude, 'projects') && newCwd) {
        const destination = path.join(root, newCwd.replace(/[^a-zA-Z0-9]/g, '-'));
        const relative = path.relative(root, file).split(path.sep).slice(1);
        const target = path.join(destination, ...relative);
        await mkdir(path.dirname(target), { recursive: true });
        // Exclusive copy prevents overwriting an existing session on retry.
        await copyFile(file, target, 1).catch(error => { if (error.code !== 'EEXIST') throw error; });
      }
    }
  }
  // Codex's history picker reads the SQLite thread index as well as JSONL.
  const sqliteModule = 'node:sqlite';
  for (const name of await readdir(codex).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
    if (!/^state_\d+\.sqlite$/.test(name)) continue;
    const { DatabaseSync } = await import(sqliteModule);
    const db = new DatabaseSync(path.join(codex, name));
    try {
      const rows = db.prepare('SELECT id, cwd FROM threads').all();
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of rows) {
          const next = mapCwd(row.cwd);
          if (next !== row.cwd) db.prepare('UPDATE threads SET cwd = ? WHERE id = ?').run(next, row.id);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } finally { db.close(); }
  }
}
