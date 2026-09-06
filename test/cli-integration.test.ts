import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliConfigPath, cliInstructions, updateCliInstructions, writeCliConnection } from '../src/cli-integration';

test('CLI configuration is private and generated instructions preserve unrelated content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safs-cli-integration-'));
  try {
    await writeCliConnection(root, 'http://127.0.0.1:9848/mcp?token=secret');
    assert.equal(JSON.parse(await readFile(cliConfigPath(root), 'utf8')).version, 1);
    if (process.platform !== 'win32') assert.equal((await stat(cliConfigPath(root))).mode & 0o777, 0o600);
    await writeFile(join(root, 'AGENTS.md'), 'User rules\n');
    const instructions = cliInstructions('/path with space/cli.js', cliConfigPath(root));
    assert.ok(!instructions.includes('secret'));
    await updateCliInstructions(root, instructions);
    const first = await readFile(join(root, 'AGENTS.md'), 'utf8');
    await updateCliInstructions(root, instructions);
    assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), first);
    await updateCliInstructions(root);
    assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), 'User rules\n');
    await assert.rejects(readFile(join(root, 'CLAUDE.md')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
