import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliConfigPath, updateCliInstructions, writeCliConnection } from '../src/cli-integration';

test('CLI configuration is private and legacy instructions are removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safs-cli-integration-'));
  try {
    await writeCliConnection(root, 'http://127.0.0.1:9848/mcp?token=secret');
    assert.equal(JSON.parse(await readFile(cliConfigPath(root), 'utf8')).version, 1);
    if (process.platform !== 'win32') assert.equal((await stat(cliConfigPath(root))).mode & 0o777, 0o600);
    await writeFile(join(root, 'AGENTS.md'), 'User rules\n<!-- SAFS CLI BEGIN -->\nold\n<!-- SAFS CLI END -->\n');
    await updateCliInstructions(root);
    assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), 'User rules\n');
    await assert.rejects(readFile(join(root, 'CLAUDE.md')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
