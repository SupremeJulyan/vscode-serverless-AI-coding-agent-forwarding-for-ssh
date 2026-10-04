import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { commitDownloadPart, prepareDownloadResume } from '../src/resume-store';
import { downloadPartPath, RESUME_MIN_BYTES } from '../src/resume-plan';

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


test('saving under another local name still resumes the matching part', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'safs-renamed-resume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const localTarget = path.join(root, 'local.bin');
  const remote = { size: 3 * RESUME_MIN_BYTES, mtimeMs: 5000 };
  const partPath = downloadPartPath(localTarget, remote);
  await writeFile(partPath, Buffer.alloc(RESUME_MIN_BYTES));
  await utimes(partPath, new Date(), new Date(1000));
  const resume = await prepareDownloadResume({
    remoteName: '/remote/remote.bin', remote, localTarget, canRange: true
  });
  assert.equal(resume.partPath, partPath);
  assert.equal(resume.offset, RESUME_MIN_BYTES);
});
