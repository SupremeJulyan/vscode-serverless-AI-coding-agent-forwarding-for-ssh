import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import { uploadRemoteTree } from '../src/remote-upload';
import { uploadPartName } from '../src/resume-plan';
import { SftpSession } from '../src/sftp/session';

function remote(failWrite = false, failCommit = false) {
  const files = new Map<string, string>([['/dest/source/a', 'old']]);
  const dirs = new Set(['/', '/dest']);
  let active = 0, peak = 0;
  const session = {
    transport: 'sftp',
    stat: async (name: string) => {
      if (dirs.has(name)) return { type: 'directory' };
      if (files.has(name)) return { type: 'file', permissions: 0o640 };
      throw Object.assign(new Error('missing'), { code: 2 });
    },
    createDirectory: async (name: string) => { dirs.add(name); },
    writeFileStream: async (name: string) => {
      active++; peak = Math.max(peak, active);
      files.set(name, '');
      return new Writable({
        write(chunk, _encoding, done) {
          files.set(name, files.get(name)! + chunk.toString());
          setTimeout(() => done(failWrite ? new Error('write failed') : undefined), 10);
        },
        destroy(error, done) { active--; done(error); }
      });
    },
    replaceFile: async (from: string, to: string) => {
      if (failCommit) throw new Error('commit failed');
      files.set(to, files.get(from)!); files.delete(from);
    },
    deleteFile: async (name: string) => { files.delete(name); }
  } as unknown as SftpSession;
  return { session, files, dirs, peak: () => peak };
}

async function sources(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(tmpdir(), 'safs-upload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await mkdir(path.join(source, 'empty'), { recursive: true });
  for (const name of ['a', 'b', 'c', 'd', 'e']) await writeFile(path.join(source, name), 'new');
  return [source];
}

test('uploads with bounded concurrency, preserves empty directories and commits files', async (t) => {
  const r = remote();
  const result = await uploadRemoteTree({ session: r.session, sources: await sources(t), targetDir: '/dest' });
  assert.equal(result.completed, 5);
  assert.equal(result.bytes, 15);
  assert.ok(r.peak() > 1 && r.peak() <= 4);
  assert.ok(r.dirs.has('/dest/source/empty'));
  assert.equal(r.files.get('/dest/source/a'), 'new');
  assert.ok([...r.files.keys()].every((name) => !name.endsWith('.part')));
});

for (const phase of ['write', 'commit']) {
  test(`${phase} failure preserves old target and cleans temporary files`, async (t) => {
    const r = remote(phase === 'write', phase === 'commit');
    await assert.rejects(uploadRemoteTree({
      session: r.session, sources: await sources(t), targetDir: '/dest'
    }), new RegExp(`${phase} failed`));
    assert.equal(r.files.get('/dest/source/a'), 'old');
    assert.ok([...r.files.keys()].every((name) => !name.endsWith('.part')));
  });
}

test('cancelling during transfer preserves old files and drains active tasks', async (t) => {
  const r = remote();
  const controller = new AbortController();
  await assert.rejects(uploadRemoteTree({
    session: r.session, sources: await sources(t), targetDir: '/dest', signal: controller.signal,
    onProgress: (state) => { if (state.bytes) controller.abort(); }
  }));
  assert.equal(r.files.get('/dest/source/a'), 'old');
  assert.ok([...r.files.keys()].every((name) => !name.endsWith('.part')));
});

/** 一个够大的源文件：只有大残片才值得保留续传（阈值 1 MiB）。 */
async function bigSource(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'safs-upload-big-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'big.bin');
  await writeFile(source, Buffer.alloc(2 * 1024 * 1024, 0x41));
  return source;
}

function resumableSession() {
  const partSizes = new Map<string, number>();
  const partMtimes = new Map<string, number>();
  const opened: Array<{ path: string; startOffset?: number }> = [];
  const deleted: string[] = [];
  // 默认残片 mtime：一个「写过的文件」的时间，与源文件 mtime 必然不同。
  const writtenMtime = 1_700_000_000_000;
  const session = {
    transport: 'sftp',
    stat: async (name: string) => {
      const size = partSizes.get(name);
      if (size === undefined) throw Object.assign(new Error('missing'), { code: 2 });
      return { type: 'file', size, mtime: partMtimes.get(name) ?? writtenMtime };
    },
    createDirectory: async () => undefined,
    writeFileStream: async (name: string, options: { startOffset?: number }) => {
      opened.push({ path: name, startOffset: options.startOffset });
      let size = options.startOffset ?? 0;
      return new Writable({
        write(chunk: Buffer, _encoding, done) {
          size += chunk.length;
          partSizes.set(name, size);
          done();
        }
      });
    },
    replaceFile: async () => undefined,
    deleteFile: async (name: string) => { deleted.push(name); partSizes.delete(name); }
  } as unknown as SftpSession;
  return { session, partSizes, partMtimes, opened, deleted };
}

test('resumes an interrupted upload from the byte count already on the remote', async (t) => {
  const source = await bigSource(t);
  const signature = await stat(source);
  const part = uploadPartName('/dest/big.bin', { size: signature.size, mtimeMs: signature.mtimeMs });
  const r = resumableSession();
  r.partSizes.set(part, 1024 * 1024);

  const result = await uploadRemoteTree({
    session: r.session, sources: [source], targetDir: '/dest', targetFile: '/dest/big.bin'
  });

  assert.equal(r.opened.length, 1);
  assert.equal(r.opened[0].path, part);
  // 关键：写出位置不是 0，而是远端残片已有的长度。
  assert.equal(r.opened[0].startOffset, 1024 * 1024);
  // bytes 只统计本轮新传的，不含续传起点。
  assert.equal(result.bytes, 1024 * 1024);
  assert.equal(result.completed, 1);
});

test('a partial from a different source signature is discarded instead of resumed', async (t) => {
  const source = await bigSource(t);
  const signature = await stat(source);
  // 本地源在两次尝试之间被改过：远端躺着一个属于**旧签名**的残片（不同名字）。
  const stale = uploadPartName('/dest/big.bin', {
    size: signature.size, mtimeMs: signature.mtimeMs - 1
  });
  const r = resumableSession();
  r.partSizes.set(stale, 1024 * 1024);
  // 当前签名对应的残片名不存在（stat 会 ENOENT），所以这一轮应当全量重传。
  const result = await uploadRemoteTree({
    session: r.session, sources: [source], targetDir: '/dest', targetFile: '/dest/big.bin'
  });

  assert.equal(r.opened.length, 1);
  assert.equal(r.opened[0].startOffset, undefined);
  assert.equal(result.bytes, signature.size);
  assert.equal(r.opened[0].path, uploadPartName('/dest/big.bin', {
    size: signature.size, mtimeMs: signature.mtimeMs
  }));
  // 旧残片不在本轮的名称推导里，本轮不动它（陈旧残片由机会清理负责）。
  assert.deepEqual(r.deleted, []);
});

test('a same-name part with an implausible signature is deleted before rewriting', async (t) => {
  const source = await bigSource(t);
  const signature = await stat(source);
  const part = uploadPartName('/dest/big.bin', {
    size: signature.size, mtimeMs: signature.mtimeMs
  });
  const r = resumableSession();
  // 名字对得上，但残片 mtime 与源相同 = 可疑（源曾被改成同大小同时间的内容）。
  r.partSizes.set(part, 1024 * 1024);
  r.partMtimes.set(part, signature.mtimeMs);

  const result = await uploadRemoteTree({
    session: r.session, sources: [source], targetDir: '/dest', targetFile: '/dest/big.bin'
  });

  assert.equal(r.opened[0].startOffset, undefined);
  assert.equal(result.bytes, signature.size);
  assert.deepEqual(r.deleted, [part]);
});

test('stale parts from an earlier session are pruned after a successful upload', async (t) => {
  const source = await bigSource(t);
  const directory = '/dest';
  const day = 86_400_000;
  const stale = '.big.bin.safs-part-00000000deadbeef';
  const fresh = '.other.bin.safs-part-1111111122222222';
  const removed: string[] = [];
  const session = {
    transport: 'sftp',
    stat: async () => { throw Object.assign(new Error('missing'), { code: 2 }); },
    createDirectory: async () => undefined,
    writeFileStream: async () => new Writable({ write: (_c, _e, done) => done() }),
    replaceFile: async () => undefined,
    deleteFile: async (name: string) => { removed.push(name); },
    readDirectory: async () => [
      { name: stale, type: 'file', size: 1, mtime: Date.now() - 8 * day, ctime: 0 },
      { name: fresh, type: 'file', size: 1, mtime: Date.now() - day, ctime: 0 },
      { name: 'big.bin', type: 'file', size: 1, mtime: 0, ctime: 0 }
    ]
  } as unknown as SftpSession;

  await uploadRemoteTree({
    session, sources: [source], targetDir: directory, targetFile: '/dest/big.bin'
  });

  // 只清超过保留期的残片；普通文件和刚写的残片都不动。
  assert.deepEqual(removed, [`${directory}/${stale}`]);
});

test('an interrupted large upload keeps its part for the next attempt', async (t) => {
  const source = await bigSource(t);
  const signature = await stat(source);
  const part = uploadPartName('/dest/big.bin', { size: signature.size, mtimeMs: signature.mtimeMs });
  const controller = new AbortController();
  let written = 0;
  const session = {
    transport: 'sftp',
    stat: async (name: string) => {
      if (name === part) throw Object.assign(new Error('missing'), { code: 2 });
      throw Object.assign(new Error('missing'), { code: 2 });
    },
    createDirectory: async () => undefined,
    writeFileStream: async () => new Writable({
      write(chunk: Buffer, _encoding, done) {
        written += chunk.length;
        if (written >= 1024 * 1024) controller.abort();
        done();
      }
    }),
    replaceFile: async () => { throw new Error('must not commit an aborted upload'); },
    deleteFile: async () => { throw new Error('must not delete a keepable part'); }
  } as unknown as SftpSession;

  await assert.rejects(uploadRemoteTree({
    session, sources: [source], targetDir: '/dest', targetFile: '/dest/big.bin',
    signal: controller.signal
  }));
  assert.ok(written >= 1024 * 1024, `expected a keepable part, wrote ${written}`);
});
