import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { constants } from 'node:fs';
import { open, mkdtemp, stat, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ssh2SftpSession } from '../src/ssh2/sftp-client';

test('SFTP in-place save retains inode, owner, group and executable mode and truncates old content', { skip: process.platform === 'win32' ? 'POSIX inode and permission semantics' : false }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'safs-save-'));
  const handles = new Map<string, Awaited<ReturnType<typeof open>>>();
  let sequence = 0;
  const sftp = {
    open: (name: string, flags: number, attrs: { mode: number }, done: Function) => {
      const native = constants.O_WRONLY | (flags & 0x10 ? constants.O_TRUNC : 0)
        | (flags & 0x08 ? constants.O_CREAT : 0) | (flags & 0x20 ? constants.O_EXCL : 0);
      open(name, native, attrs.mode).then(file => {
        const key = String(++sequence); handles.set(key, file); done(undefined, Buffer.from(key));
      }, error => done(error));
    },
    write: (handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, done: Function) => {
      handles.get(handle.toString())!.write(buffer, offset, length, position).then(() => done(), error => done(error));
    },
    close: (handle: Buffer, done: Function) => {
      const file = handles.get(handle.toString())!; handles.delete(handle.toString());
      file.close().then(() => done(), error => done(error));
    }
  };
  const session = new Ssh2SftpSession('test', new EventEmitter() as any, sftp as any, () => {});
  try {
    const target = join(root, 'script');
    await writeFile(target, 'original longer content'); await chmod(target, 0o750);
    const before = await stat(target);
    await session.writeFile(target, Buffer.from('short'), { create: false, overwrite: true });
    const after = await stat(target);
    assert.equal(await readFile(target, 'utf8'), 'short');
    assert.deepEqual([after.ino, after.uid, after.gid, after.mode], [before.ino, before.uid, before.gid, before.mode]);
    await session.writeFile(target, Buffer.alloc(0), { create: false, overwrite: true });
    assert.equal((await stat(target)).size, 0);
    const fresh = join(root, 'new');
    await session.writeFile(fresh, Buffer.from('new'), { create: true, overwrite: false, mode: 0o600 });
    assert.equal((await stat(fresh)).mode & 0o777, 0o600);
    await assert.rejects(session.writeFile(fresh, Buffer.from('replace'), { create: true, overwrite: false }));
    await assert.rejects(session.writeFile(join(root, 'missing'), Buffer.from('data'), { create: false, overwrite: true }));
    assert.equal(handles.size, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('editor saves overwrite the original file rather than renaming a temporary inode', async () => {
  Object.assign(require('vscode'), { FileChangeType: { Changed: 1 }, Uri: { joinPath: () => ({}) }, FileSystemError: class extends Error { static NoPermissions(message: string) { return new this(message); } } });
  const { SftpFileSystemProvider } = require('../src/ssh2/filesystem-provider');
  const calls: unknown[] = [];
  const metadata = { type: 'file', permissions: 0o100750, size: 4 };
  const session = {
    isAlive: () => true,
    stat: async () => metadata,
    writeFile: async (...args: unknown[]) => { calls.push(args); }
  };
  const provider = Object.create(SftpFileSystemProvider.prototype) as any;
  provider.resolve = async () => ({ session, remotePath: '/project/script' });
  provider.invalidate = () => {};
  provider.changes = { fire: () => {} };
  await provider.writeFile({}, Buffer.from('data'), { create: true, overwrite: true });
  assert.equal(calls.length, 1);
  assert.deepEqual((calls[0] as unknown[]).slice(0, 3), ['/project/script', Buffer.from('data'), { create: false, overwrite: true }]);
});

test('SCP fallback saves preserve existing executable permissions for small and large files', { skip: process.platform === 'win32' ? 'POSIX SSH shell fixture' : false }, async () => {
  const { ScpSession } = await import('../src/ssh2/scp-session');
  const { spawn } = await import('node:child_process');
  const root = await mkdtemp(join(tmpdir(), 'safs-scp-save-'));
  const target = join(root, 'script');
  const session = new ScpSession('test', new EventEmitter() as any, () => {}) as any;
  session.stat = async () => ({ type: 'file', permissions: (await stat(target)).mode });
  session.exec = (command: string, data: Buffer) => new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command]);
    const stderr: Buffer[] = [];
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout: Buffer.alloc(0), stderr: Buffer.concat(stderr) }));
    child.stdin.end(data);
  });
  try {
    await writeFile(target, 'original'); await chmod(target, 0o750);
    const before = await stat(target);
    for (const content of [Buffer.from('short'), Buffer.alloc(3 * 1024 * 1024, 65)]) {
      await session.writeFile(target, content, { create: false, overwrite: true });
      const after = await stat(target);
      assert.deepEqual([after.ino, after.uid, after.gid, after.mode], [before.ino, before.uid, before.gid, before.mode]);
      assert.deepEqual(await readFile(target), content);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an uncertain save with different remote contents adopts remote without overwriting', async () => {
  const { saveConfirmation } = await import('../src/remote/save-confirmation');
  const { SftpFileSystemProvider } = require('../src/ssh2/filesystem-provider');
  const key = 'safs://test/project/file';
  await assert.rejects(saveConfirmation.run(key, Buffer.from('local'), 0o600,
    async () => { throw new Error('connection reset'); }, () => true));
  let writes = 0;
  let accepted = false;
  const provider = Object.create(SftpFileSystemProvider.prototype) as any;
  provider.resolve = async () => ({ remotePath: '/project/file', session: {
    readFile: async () => Buffer.from('remote'),
    stat: async () => ({ size: 6, permissions: 0o600 }),
    writeFile: async () => { writes++; }
  } });
  provider.invalidate = () => {};
  provider.changes = { fire: () => {} };
  provider.remoteAccepted = { fire: () => { accepted = true; } };
  assert.deepEqual(await provider.saveFile({ toString: () => key }, Buffer.from('local'),
    { create: true, overwrite: true }), { remotePreferred: true, bytes: 6, remoteContent: Buffer.from('remote'), permissions: 0o600 });
  assert.equal(writes, 0);
  assert.equal(accepted, true);
  assert.equal(saveConfirmation.attempts.has(key), false);
});

test('SFTP save keeps a bounded 1 MiB write window with correct offsets', async () => {
  const bytes = Buffer.alloc(2 * 1024 * 1024, 65);
  const written = Buffer.alloc(bytes.length);
  let active = 0, peak = 0, calls = 0;
  const sftp = {
    open: (_path: string, _flags: number, _attrs: unknown, done: Function) => done(undefined, Buffer.from('handle')),
    write: (_handle: Buffer, data: Buffer, offset: number, length: number, position: number, done: Function) => {
      active++; calls++; peak = Math.max(peak, active);
      assert.ok(length <= 256 * 1024);
      setImmediate(() => { data.copy(written, position, offset, offset + length); active--; done(); });
    },
    close: (_handle: Buffer, done: Function) => { assert.equal(active, 0); done(); }
  };
  const session = new Ssh2SftpSession('test', new EventEmitter() as any, sftp as any, () => {});
  await session.writeFile('/project/file', bytes, { create: false, overwrite: true });
  assert.equal(peak, 4);
  assert.equal(calls, 8);
  assert.deepEqual(written, bytes);
});

test('a failed write drains outstanding requests before closing and stops the next window', async () => {
  let active = 0, calls = 0, closed = false;
  const sftp = {
    open: (_path: string, _flags: number, _attrs: unknown, done: Function) => done(undefined, Buffer.from('handle')),
    write: (_handle: Buffer, _data: Buffer, _offset: number, _length: number, position: number, done: Function) => {
      active++; calls++;
      setImmediate(() => { active--; done(position === 0 ? new Error('write failed') : undefined); });
    },
    close: (_handle: Buffer, done: Function) => { assert.equal(active, 0); closed = true; done(); }
  };
  const session = new Ssh2SftpSession('test', new EventEmitter() as any, sftp as any, () => {});
  await assert.rejects(session.writeFile('/project/file', Buffer.alloc(2 * 1024 * 1024),
    { create: false, overwrite: true }), /write failed/);
  assert.equal(calls, 4);
  assert.equal(closed, true);
});

test('save rejects a canonical path outside the CLI workspace before writing', async () => {
  const { SftpFileSystemProvider } = require('../src/ssh2/filesystem-provider');
  const provider = Object.create(SftpFileSystemProvider.prototype) as any;
  let writes = 0, resolutions = 0;
  provider.resolve = async () => {
    resolutions++;
    return { remotePath: '/outside/file', session: { writeFile: async () => { writes++; } } };
  };
  await assert.rejects(provider.saveFile({ toString: () => 'safs://test/outside' }, Buffer.from('data'),
    { create: true, overwrite: true }, false, '/project'), /escapes workspaceRoot/);
  assert.equal(resolutions, 1);
  assert.equal(writes, 0);
});
