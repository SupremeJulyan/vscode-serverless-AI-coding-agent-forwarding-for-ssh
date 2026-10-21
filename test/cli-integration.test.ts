import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliConfigPath, updateCliInstructions, writeCliConnection, writeCliConnectionFile } from '../src/cli-integration';

test('refreshes stale CLI connection settings and recreates a missing connection file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safs-cli-refresh-'));
  const target = join(root, '.safs-connection.json');
  try {
    await writeCliConnectionFile(target, 'http://127.0.0.1:9848/mcp?token=old', 125_000);
    const url = 'http://127.0.0.1:19999/mcp?token=new&source=cli';
    await writeCliConnectionFile(target, url, 65_000);
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { version: 1, url, timeoutMs: 65_000 });
    await rm(target);
    await writeCliConnectionFile(target, url, 0);
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { version: 1, url, timeoutMs: 0 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI configuration is private and legacy instructions are removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safs-cli-integration-'));
  try {
    await writeCliConnection(root, 'http://127.0.0.1:9848/mcp?token=secret', 42_000);
    assert.deepEqual(JSON.parse(await readFile(cliConfigPath(root), 'utf8')), {
      version: 1,
      url: 'http://127.0.0.1:9848/mcp?token=secret',
      timeoutMs: 42_000
    });
    if (process.platform !== 'win32') assert.equal((await stat(cliConfigPath(root))).mode & 0o777, 0o600);
    await writeFile(join(root, 'AGENTS.md'), 'User rules\n<!-- SAFS CLI BEGIN -->\nold\n<!-- SAFS CLI END -->\n');
    await updateCliInstructions(root);
    assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), 'User rules\n');
    await assert.rejects(readFile(join(root, 'CLAUDE.md')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
