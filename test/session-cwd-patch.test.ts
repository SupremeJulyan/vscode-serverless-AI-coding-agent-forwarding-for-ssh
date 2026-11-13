import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { migrateSessionCwds, needsSessionMigration } from '../src/patches/session-cwd';

test('version gate covers old releases and excludes newer releases', () => {
  for (const version of [undefined, '1.9.9', '2.0.9', '2.1.5']) assert.equal(needsSessionMigration(version), true);
  for (const version of ['2.1.6', '2.2.0', '3.0.0']) assert.equal(needsSessionMigration(version), false);
});

test('migrates Codex and Claude cwd bindings with backups and repeat safety', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'safs-patch-'));
  const savedCodex = process.env.CODEX_HOME;
  const savedClaude = process.env.CLAUDE_CONFIG_DIR;
  process.env.CODEX_HOME = path.join(home, '.codex');
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  try {
    const storage = path.join(home, 'storage');
    const old = path.join(storage, 'agent-cwd', 'user@host@22project');
    const target = path.join(home, '.safs', 'remote_workspace', 'user@host@22project');
    const codexFile = path.join(home, '.codex', 'sessions', 'session.jsonl');
    const claudeFile = path.join(home, '.claude', 'projects', 'old-project', 'session.jsonl');
    for (const file of [codexFile, claudeFile]) await mkdir(path.dirname(file), { recursive: true });
    const original = JSON.stringify({ type: 'session_meta', payload: { cwd: old }, text: old }) + '\n';
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(home, '.codex', 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT)');
    db.prepare('INSERT INTO threads VALUES (?, ?)').run('session', old);
    await writeFile(codexFile, original);
    await writeFile(claudeFile, JSON.stringify({ cwd: old }) + '\n');
    await migrateSessionCwds(storage, home);
    assert.equal((db.prepare('SELECT cwd FROM threads').get() as { cwd: string }).cwd, target);
    db.close();
    const record = JSON.parse(await readFile(codexFile, 'utf8'));
    assert.equal(record.payload.cwd, target);
    assert.equal(record.text, old);
    assert.equal(await readFile(codexFile + '.safs-pre-2.1.5.bak', 'utf8'), original);
    const claudeTarget = path.join(home, '.claude', 'projects', target.replace(/[^a-zA-Z0-9]/g, '-'), 'session.jsonl');
    assert.equal(JSON.parse(await readFile(claudeTarget, 'utf8')).cwd, target);
    await migrateSessionCwds(storage, home);
    assert.equal(await readFile(codexFile + '.safs-pre-2.1.5.bak', 'utf8'), original);
  } finally {
    if (savedCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedCodex;
    if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedClaude;
    await rm(home, { recursive: true, force: true });
  }
});
