import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { RemoteSyncManager, RemoteSyncTask } from '../src/remote-sync';
import { SftpSession } from '../src/sftp/session';

async function setup(t: { after(fn: () => Promise<void>): void }, failScan = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'safs-sync-transfer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events: string[] = [];
  let active = 0, peak = 0;
  const session = {
    transport: 'sftp',
    stat: async () => ({ type: 'directory', size: 0, mtime: 1 }),
    readDirectory: async (remote: string) => {
      events.push(`list:${remote}`);
      if (failScan) throw new Error('scan failed');
      if (remote !== '/remote') return [];
      return ['a', 'b', 'c', 'd', 'e', 'zdir'].map(name => ({
        name, type: name === 'zdir' ? 'directory' : 'file', size: 3, mtime: 1
      }));
    },
    readFileStream: async (remote: string) => {
      events.push(`read:${remote}`);
      active++; peak = Math.max(peak, active);
      return Readable.from((async function* () {
        try {
          await new Promise(resolve => setTimeout(resolve, 20));
          yield Buffer.from('new');
        } finally { active--; }
      })());
    }
  } as unknown as SftpSession;
  const manager = new RemoteSyncManager(async () => session, () => undefined);
  const task: RemoteSyncTask = { mountName: 'fake', remotePath: '/remote', localDir: root };
  // Exercise transfer internals without starting VS Code watchers or timers.
  return { root, session, manager: manager as any, task, events, peak: () => peak };
}

test('initial sync transfers during discovery and publishes a complete fingerprint', async t => {
  const s = await setup(t);
  assert.equal(await s.manager.baseline(s.task, false), true);
  assert.ok(s.events.indexOf('read:/remote/a') < s.events.indexOf('list:/remote/zdir'));
  assert.ok(s.peak() > 1 && s.peak() <= 4);
  assert.equal(s.task.fingerprintLines?.length, 6);
  assert.equal(await readFile(path.join(s.root, 'a'), 'utf8'), 'new');
});

test('failed incremental scan preserves local files and the previous fingerprint', async t => {
  const s = await setup(t, true);
  await writeFile(path.join(s.root, 'a'), 'old');
  s.task.fingerprintLines = ['f:a:3:1'];
  assert.equal(await s.manager.baseline(s.task, false), false);
  assert.deepEqual(s.task.fingerprintLines, ['f:a:3:1']);
  assert.equal(await readFile(path.join(s.root, 'a'), 'utf8'), 'old');
});

test('an edit made during download is retained', async t => {
  const s = await setup(t);
  const local = path.join(s.root, 'a');
  await writeFile(local, 'old');
  const downloading = s.manager.downloadOne(s.session, '/remote/a', s.root, local);
  while (!s.events.includes('read:/remote/a')) await new Promise(resolve => setTimeout(resolve, 1));
  await writeFile(local, 'user edit');
  await downloading;
  assert.equal(await readFile(local, 'utf8'), 'user edit');
});

test('same-path downloads remain serial with multiple waiting callers', async t => {
  const s = await setup(t);
  let active = 0, peak = 0;
  await Promise.all(Array.from({ length: 4 }, () => s.manager.withDownload('same', async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
  })));
  assert.equal(peak, 1);
});

test('cancelled initial sync never publishes a baseline or replaces existing files', async t => {
  const s = await setup(t);
  await writeFile(path.join(s.root, 'a'), 'old');
  const controller = new AbortController();
  const running = s.manager.baseline(s.task, false, { signal: controller.signal });
  while (!s.events.includes('read:/remote/a')) await new Promise(resolve => setTimeout(resolve, 1));
  controller.abort();
  assert.equal(await running, false);
  assert.equal(s.task.fingerprintLines, undefined);
  assert.equal(await readFile(path.join(s.root, 'a'), 'utf8'), 'old');
});
