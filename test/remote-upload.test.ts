import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import { uploadRemoteTree } from '../src/transfer/remote-upload';
import { SftpSession } from '../src/ssh2/session';

function remote(failWrite = false, failCommit = false, existingPermissions = 0o640) {
  const files = new Map<string, string>([['/dest/source/a', 'old']]);
  const dirs = new Set(['/', '/dest']);
  const committed: Array<{ to: string; mode?: number }> = [];
  let active = 0, peak = 0;
  const session = {
    transport: 'sftp',
    stat: async (name: string) => {
      if (dirs.has(name)) return { type: 'directory' };
      if (files.has(name)) return { type: 'file', permissions: existingPermissions };
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
    replaceFile: async (from: string, to: string, mode?: number) => {
      if (failCommit) throw new Error('commit failed');
      committed.push({ to, mode });
      files.set(to, files.get(from)!); files.delete(from);
    },
    deleteFile: async (name: string) => { files.delete(name); }
  } as unknown as SftpSession;
  return { session, files, dirs, committed, peak: () => peak };
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
  assert.ok([...r.files.keys()].every((name) => !name.endsWith('.tmp')));
});

for (const phase of ['write', 'commit']) {
  test(`${phase} failure preserves old target and cleans temporary files`, async (t) => {
    const r = remote(phase === 'write', phase === 'commit');
    await assert.rejects(uploadRemoteTree({
      session: r.session, sources: await sources(t), targetDir: '/dest'
    }), new RegExp(`${phase} failed`));
    assert.equal(r.files.get('/dest/source/a'), 'old');
    assert.ok([...r.files.keys()].every((name) => !name.endsWith('.tmp')));
  });
}

test('cancelling during transfer preserves old files and removes temporary files', async (t) => {
  const r = remote();
  const controller = new AbortController();
  await assert.rejects(uploadRemoteTree({
    session: r.session, sources: await sources(t), targetDir: '/dest', signal: controller.signal,
    onProgress: (state) => { if (state.bytes) controller.abort(); }
  }));
  assert.equal(r.files.get('/dest/source/a'), 'old');
  assert.ok([...r.files.keys()].every((name) => !name.endsWith('.tmp')));
});

test('a fresh upload of an executable source lands executable', async (t) => {
  const r = remote();
  const [source] = await sources(t);
  const script = path.join(source, 'run.sh');
  await writeFile(script, '#!/bin/sh\necho ok\n');
  if (process.platform === 'win32') return t.skip('Windows has no executable bit');
  await chmod(script, 0o755);
  await uploadRemoteTree({ session: r.session, sources: [source], targetDir: '/dest' });
  assert.equal(r.committed.find((entry) => entry.to === '/dest/source/run.sh')?.mode, 0o755);
});

test('a fresh upload of a non-executable source keeps the remote default', async (t) => {
  const r = remote();
  const [source] = await sources(t);
  await uploadRemoteTree({ session: r.session, sources: [source], targetDir: '/dest' });
  assert.equal(r.committed.find((entry) => entry.to === '/dest/source/b')?.mode, 0o644);
});

test('replacing an existing remote file keeps its permissions', async (t) => {
  const r = remote();
  const [source] = await sources(t);
  await uploadRemoteTree({ session: r.session, sources: [source], targetDir: '/dest' });
  assert.equal(r.committed.find((entry) => entry.to === '/dest/source/a')?.mode, 0o640);
});

test('re-uploading repairs executable bits dropped by an earlier upload', async (t) => {
  const r = remote(false, false, 0o644);
  const [source] = await sources(t);
  const script = path.join(source, 'run.sh');
  await writeFile(script, '#!/bin/sh\n');
  if (process.platform === 'win32') return t.skip('Windows has no executable bit');
  await chmod(script, 0o755);
  r.files.set('/dest/source/run.sh', 'stale');
  await uploadRemoteTree({ session: r.session, sources: [source], targetDir: '/dest' });
  assert.equal(r.committed.find((entry) => entry.to === '/dest/source/run.sh')?.mode, 0o755);
});
