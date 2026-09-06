import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { downloadRemoteDirectoryTree } from '../src/remote-download';
import { SftpSession } from '../src/sftp/session';

interface FakeEntry {
  type: 'file' | 'directory' | 'symbolic-link';
  content?: string;
}

function fakeSession(entries: Record<string, FakeEntry>, delayMs = 0): {
  session: SftpSession;
  maxActive: () => number;
  events: string[];
} {
  let active = 0;
  let maximum = 0;
  const events: string[] = [];
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
        size: entry.content?.length ?? 0, mtime: 0, ctime: 0
      }));
    },
    readFileStream: async (remotePath: string) => {
      active += 1;
      maximum = Math.max(maximum, active);
      events.push(`start:${remotePath}`);
      const content = entries[remotePath].content ?? '';
      async function* chunks() {
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        yield Buffer.from(content);
        active -= 1;
        events.push(`finish:${remotePath}`);
      }
      return Readable.from(chunks());
    }
  } as unknown as SftpSession;
  return { session, maxActive: () => maximum, events };
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
    })())
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
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(downloading, /取消/);
  await assert.rejects(readFile(path.join(localRoot, 'slow')));
});
