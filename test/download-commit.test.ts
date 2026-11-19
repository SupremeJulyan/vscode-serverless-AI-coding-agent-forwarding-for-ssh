import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { commitDownloadPart } from '../src/transfer/download-commit';

test('failed download commit preserves the old target and complete part and rejects', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'safs-commit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'file');
  const partPath = path.join(root, 'part');
  await writeFile(target, 'old content');
  await writeFile(partPath, 'new content');
  const failure = new Error('rename failed');
  await assert.rejects(commitDownloadPart({
    target, partPath, renamePart: async () => { throw failure; }
  }), (error) => error === failure);
  assert.equal(await readFile(target, 'utf8'), 'old content');
  assert.equal(await readFile(partPath, 'utf8'), 'new content');
});

test('download commit replaces an existing file', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'safs-commit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'file');
  const partPath = path.join(root, 'part');
  await writeFile(target, 'old content');
  await writeFile(partPath, 'new content');
  await commitDownloadPart({ target, partPath, renamePart: rename });
  assert.equal(await readFile(target, 'utf8'), 'new content');
  await assert.rejects(readFile(partPath), { code: 'ENOENT' });
});


