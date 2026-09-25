import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { downloadRemoteDirectoryTree } from '../src/remote-download';
import { downloadPartPath } from '../src/resume-plan';
import { SftpSession } from '../src/sftp/session';

interface FakeEntry {
  type: 'file' | 'directory' | 'symbolic-link';
  content?: string;
  mtimeMs?: number;
}

function fakeSession(
  entries: Record<string, FakeEntry>, delayMs = 0, remoteMtimeMs = 5_000
): {
  session: SftpSession;
  maxActive: () => number;
  events: string[];
  starts: Array<{ remotePath: string; start?: number }>;
} {
  let active = 0;
  let maximum = 0;
  const events: string[] = [];
  const starts: Array<{ remotePath: string; start?: number }> = [];
  const session = {
    hostName: 'fake',
    transport: 'sftp',
    isAlive: () => true,
    readDirectory: async (remotePath: string) => {
      events.push(`list:${remotePath}`);
      const prefix = `${remotePath.replace(/\/$/, '')}/`;
      return Object.entries(entries).filter(([candidate]) =>
        candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes('/')
      ).map(([candidate, entry]) => ({
        name: candidate.slice(prefix.length), type: entry.type,
        size: entry.content?.length ?? 0, mtime: remoteMtimeMs, ctime: 0
      }));
    },
    readFileStream: async (remotePath: string, _signal?: AbortSignal, start?: number) => {
      active += 1;
      maximum = Math.max(maximum, active);
      events.push(`start:${remotePath}`);
      starts.push({ remotePath, start });
      const content = entries[remotePath].content ?? '';
      async function* chunks() {
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        yield Buffer.from(content.slice(start ?? 0));
        active -= 1;
        events.push(`finish:${remotePath}`);
      }
      return Readable.from(chunks());
    },
    // 续传判定要读远端 size+mtime：签名一致才允许复用残片。
    stat: async (remotePath: string) => ({
      type: entries[remotePath]?.type ?? 'file',
      size: entries[remotePath]?.content?.length ?? 0,
      mtime: entries[remotePath]?.mtimeMs ?? remoteMtimeMs, ctime: 0
    })
  } as unknown as SftpSession;
  return { session, maxActive: () => maximum, events, starts };
}

test('downloads while discovering with bounded concurrency and preserves empty directories', async () => {
  const remote = fakeSession({
    '/root/a.txt': { type: 'file', content: 'a' },
    '/root/b.txt': { type: 'file', content: 'bb' },
    '/root/empty': { type: 'directory' },
    '/root/sub': { type: 'directory' },
    '/root/sub/c.txt': { type: 'file', content: 'ccc' },
    '/root/link': { type: 'symbolic-link' }
  }, 15);
  const localRoot = path.join(await mkdtemp(path.join(os.tmpdir(), 'safs-download-')), 'copy');
  const result = await downloadRemoteDirectoryTree({
    session: remote.session, remoteRoot: '/root', localRoot, concurrency: 2
  });

  assert.equal(remote.maxActive(), 2);
  assert.ok(remote.events.indexOf('start:/root/a.txt') < remote.events.indexOf('list:/root/sub'));
  assert.deepEqual(result, { files: 3, directories: 2, transferredBytes: 6 });
  assert.equal(await readFile(path.join(localRoot, 'sub/c.txt'), 'utf8'), 'ccc');
  assert.deepEqual(await readdir(path.join(localRoot, 'empty')), []);
  await assert.rejects(readFile(path.join(localRoot, 'link')));
});

test('stops the queue on the first file failure without leaving a partial file', async () => {
  const session = {
    hostName: 'fake', transport: 'sftp', isAlive: () => true,
    readDirectory: async () => [
      { name: 'bad', type: 'file', size: 1, mtime: 0, ctime: 0 },
      { name: 'later', type: 'file', size: 1, mtime: 0, ctime: 0 }
    ],
    readFileStream: async () => Readable.from((async function* () {
      yield Buffer.from('partial');
      throw new Error('remote read failed');
    })()),
    stat: async () => ({ type: 'file', size: 1, mtime: 0, ctime: 0 })
  } as unknown as SftpSession;
  const localRoot = path.join(await mkdtemp(path.join(os.tmpdir(), 'safs-download-')), 'copy');
  await assert.rejects(
    downloadRemoteDirectoryTree({
      session, remoteRoot: '/root', localRoot, concurrency: 1
    }),
    /remote read failed/
  );
  await assert.rejects(readFile(path.join(localRoot, 'bad')));
  await assert.rejects(readFile(path.join(localRoot, 'later')));
});

test('cancellation aborts active downloads and removes their partial files', async () => {
  const remote = fakeSession({
    '/root/slow': { type: 'file', content: 'unfinished' }
  }, 50);
  const localRoot = path.join(await mkdtemp(path.join(os.tmpdir(), 'safs-download-')), 'copy');
  const controller = new AbortController();
  const downloading = downloadRemoteDirectoryTree({
    session: remote.session, remoteRoot: '/root', localRoot,
    concurrency: 4, signal: controller.signal
  });
  // 等这次读取真的开始再取消：固定 5ms 在机器忙时会晚于 50ms 的假读取，取消可能落到
  // 传输结束之后，断言就变成"半成品还在"（全量并行跑时偶发）。轮询有上限，不会挂死。
  const deadline = Date.now() + 5000;
  while (!remote.events.includes('start:/root/slow')) {
    assert.ok(Date.now() < deadline, 'download did not start reading /root/slow');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  controller.abort();
  await assert.rejects(downloading, /取消/);
  await assert.rejects(readFile(path.join(localRoot, 'slow')));
});

/** 造一个「同一远端文件、上一轮留下的残片」：名字由远端 size+mtime 推导。 */
async function seedPart(
  localRoot: string, remotePath: string, content: Buffer, signature: { size: number; mtimeMs: number },
  prefixLength: number
) {
  const target = path.join(localRoot, path.posix.basename(remotePath));
  await mkdir(path.dirname(target), { recursive: true });
  const partPath = downloadPartPath(target, signature);
  await writeFile(partPath, content.subarray(0, prefixLength));
  await utimes(partPath, new Date(), new Date(signature.mtimeMs - 60_000));
  return { target, partPath };
}

test('resumes an interrupted download from the bytes already on disk', async () => {
  const mtimeMs = 5_000;
  const content = Buffer.alloc(2 * 1024 * 1024, 0x42);
  const remote = fakeSession({ '/root/big.bin': { type: 'file', content: content.toString('latin1') } }, 0, mtimeMs);
  const localRoot = path.join(await mkdtemp(path.join(os.tmpdir(), 'safs-download-')), 'copy');
  const signature = { size: content.length, mtimeMs };
  const { target } = await seedPart(localRoot, '/root/big.bin', content, signature, 1024 * 1024);

  const result = await downloadRemoteDirectoryTree({
    session: remote.session, remoteRoot: '/root', localRoot, concurrency: 1
  });

  assert.equal(remote.starts[0].start, 1024 * 1024);
  assert.equal(result.transferredBytes, 1024 * 1024);
  assert.equal((await readFile(target)).length, content.length);
});

test('a part from an older remote version is not reused', async () => {
  const content = Buffer.alloc(2 * 1024 * 1024, 0x43);
  // 残片属于 mtime=5000 的旧版本；远端现在是 mtime=9000。
  const oldSignature = { size: content.length, mtimeMs: 5_000 };
  const remote = fakeSession({ '/root/big.bin': { type: 'file', content: content.toString('latin1') } }, 0, 9_000);
  const localRoot = path.join(await mkdtemp(path.join(os.tmpdir(), 'safs-download-')), 'copy');
  const { target } = await seedPart(localRoot, '/root/big.bin', content, oldSignature, 1024 * 1024);

  const result = await downloadRemoteDirectoryTree({
    session: remote.session, remoteRoot: '/root', localRoot, concurrency: 1
  });

  assert.equal(remote.starts[0].start, undefined);
  assert.equal(result.transferredBytes, content.length);
  assert.equal((await readFile(target)).length, content.length);
});
