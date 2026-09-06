import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeCaptured } from '../src/process';
import { searchCommand, RemoteSearchOptions } from '../src/remote-search';

test('search executes literal queries, file filters and count mode without hiding errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safs-search-'));
  try {
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'a.ts'), 'before\nhello.*\nafter\n');
    await writeFile(join(root, 'b.txt'), 'hello\n');
    await writeFile(join(root, 'dist', 'c.ts'), 'hello\n');
    const run = (input: RemoteSearchOptions) => executeCaptured({ command: 'sh', args: ['-c', searchCommand(root, input).command] });
    const literal = await run({ query: 'hello.*', fixedStrings: true, contextLines: 1 });
    assert.equal(literal.exitCode, 0);
    assert.match(literal.stdout, /before/);
    assert.match(literal.stdout, /after/);
    const files = await run({ query: 'hello', mode: 'files', include: ['*.ts'] });
    assert.equal(files.stdout.trim(), join(root, 'a.ts'));
    assert.match((await run({ query: 'hello', mode: 'count', include: ['*.ts'] })).stdout, /a.ts:1/);
    assert.match((await run({ query: 'hello', mode: 'files', excludeDirs: [] })).stdout, /c.ts/);
    assert.equal((await run({ query: '[' })).exitCode, 2);
    assert.equal((await run({ query: '$(touch should-not-exist)', fixedStrings: true })).exitCode, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
