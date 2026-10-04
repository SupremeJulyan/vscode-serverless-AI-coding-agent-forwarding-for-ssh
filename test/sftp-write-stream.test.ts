import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough, Readable } from 'node:stream';
import { Client, SFTPWrapper } from 'ssh2';
import { Ssh2SftpSession } from '../src/sftp/client';

function fakeClient(): Client {
  return { on: () => fakeClient() } as unknown as Client;
}

function makeSession(sftp: Partial<SFTPWrapper>): Ssh2SftpSession {
  return new Ssh2SftpSession('dev', fakeClient(), sftp as unknown as SFTPWrapper);
}

test('replaceFile uses atomic rename without deleting the existing target', async () => {
  const calls: string[] = [];
  const session = makeSession({
    ext_openssh_rename: (_from, _to, done) => { calls.push('atomic'); done(); },
    unlink: () => { throw new Error('must not unlink target'); }
  });
  await session.replaceFile('/temp', '/existing');
  assert.deepEqual(calls, ['atomic']);
});

test('unsupported atomic rename falls back without unlinking an existing target', async () => {
  const session = makeSession({
    ext_openssh_rename: (_from, _to, done) => done(Object.assign(new Error('unsupported'), { code: 8 })),
    rename: (_from, _to, done) => done(new Error('target exists')),
    unlink: () => { throw new Error('must not unlink target'); }
  });
  await assert.rejects(session.replaceFile('/temp', '/existing'), /target exists/);
});

test('writeFileStream writes chunks with advancing offsets and closes the handle', async () => {
  const writes: Array<{ position: number; data: Buffer }> = [];
  let closed = 0;
  const sftp: Partial<SFTPWrapper> = {
    open: (_path, _flag, callback) => callback(undefined, Buffer.from('h1')),
    write: (_handle, buffer, offset, length, position, callback) => {
      writes.push({ position, data: Buffer.from(buffer.subarray(offset, offset + length)) });
      callback();
    },
    close: (_handle, callback) => {
      closed += 1;
      callback();
    }
  };
  const session = makeSession(sftp);
  const stream = await session.writeFileStream('/x', { create: true, overwrite: true });
  await new Promise<void>((resolve, reject) => {
    stream.once('error', reject);
    stream.once('finish', resolve);
    Readable.from([Buffer.from('aaa'), Buffer.from('bbb')]).pipe(stream);
  });
  assert.deepEqual(writes.map((write) => write.position), [0, 3]);
  assert.equal(Buffer.concat(writes.map((write) => write.data)).toString(), 'aaabbb');
  assert.equal(closed, 1);
});

test('writeFileStream rejects when open fails', async () => {
  const sftp: Partial<SFTPWrapper> = {
    open: (_path, _flag, callback) => callback(new Error('EEXIST'))
  };
  const session = makeSession(sftp);
  await assert.rejects(
    session.writeFileStream('/x', { create: true, overwrite: false }),
    /EEXIST/
  );
});

test('writeFileStream surfaces a write error', async () => {
  const sftp: Partial<SFTPWrapper> = {
    open: (_path, _flag, callback) => callback(undefined, Buffer.from('h')),
    write: (_handle, _buffer, _offset, _length, _position, callback) => callback(new Error('磁盘已满')),
    close: (_handle, callback) => callback()
  };
  const session = makeSession(sftp);
  const stream = await session.writeFileStream('/x', { create: true, overwrite: true });
  await assert.rejects(new Promise<void>((resolve, reject) => {
    stream.once('error', reject);
    stream.once('finish', resolve);
    stream.end(Buffer.from('data'));
  }), /磁盘已满/);
});

test('writeFileStream abort destroys the stream and closes the handle', async () => {
  let closed = 0;
  const controller = new AbortController();
  const sftp: Partial<SFTPWrapper> = {
    open: (_path, _flag, callback) => callback(undefined, Buffer.from('h')),
    // 写不确认：等待 abort 触发 destroy。
    write: () => undefined,
    close: (_handle, callback) => {
      closed += 1;
      callback();
    }
  };
  const session = makeSession(sftp);
  const stream = await session.writeFileStream(
    '/x', { create: true, overwrite: true }, controller.signal
  );
  const errored = new Promise<Error>((resolve) => stream.once('error', resolve));
  stream.write(Buffer.from('data'));
  setTimeout(() => controller.abort(), 10);
  const error = await errored;
  assert.equal((error as Error & { name?: string }).name, 'AbortError');
  assert.equal(closed, 1);
});

test('writeFileStream resumes at startOffset without truncating the part', async () => {
  const writes: Array<{ position: number; data: string }> = [];
  let flag: string | undefined;
  const sftp: Partial<SFTPWrapper> = {
    open: (_path, openFlag, callback) => { flag = openFlag; callback(undefined, Buffer.from('h')); },
    write: (_handle, buffer, offset, length, position, callback) => {
      writes.push({ position, data: Buffer.from(buffer.subarray(offset, offset + length)).toString() });
      callback();
    },
    close: (_handle, callback) => callback()
  };
  const session = makeSession(sftp);
  // 残片已有 1024 字节：从 1024 继续写，且必须用 'r+'（'w' 会截断，'a' 会让服务端
  // 忽略 offset 永远追加，两者都会毁掉断点续传）。
  const stream = await session.writeFileStream(
    '/part', { create: true, overwrite: false, startOffset: 1024 }
  );
  await new Promise<void>((resolve, reject) => {
    stream.once('error', reject);
    stream.once('finish', resolve);
    Readable.from([Buffer.from('tail')]).pipe(stream);
  });
  assert.equal(flag, 'r+');
  assert.deepEqual(writes, [{ position: 1024, data: 'tail' }]);
});

test('writeFileStream rejects an impossible resume offset', async () => {
  const session = makeSession({
    open: () => { throw new Error('must not open with an invalid offset'); }
  });
  await assert.rejects(
    session.writeFileStream('/x', { create: true, overwrite: false, startOffset: -1 }),
    /无效的续传起始偏移/
  );
});

test('readFileStream asks the server for the bytes after the resume offset', async () => {
  const asked: Array<{ path: string; start?: number; highWaterMark?: number }> = [];
  const session = makeSession({
    createReadStream: (path, options) => {
      asked.push({ path, start: options.start, highWaterMark: options.highWaterMark });
      // readFileStream 等 'open' 才 resolve（真实 ssh2 打开远程文件后触发）。
      const stream = new PassThrough();
      setImmediate(() => stream.emit('open'));
      return stream as never;
    }
  });
  await session.readFileStream('/remote/big.bin', undefined, 2048);
  assert.deepEqual(asked.map(({ path, start }) => ({ path, start })), [
    { path: '/remote/big.bin', start: 2048 }
  ]);
  // 全量读取不带 start：让 ssh2 走默认起始位置。
  await session.readFileStream('/remote/small.bin', undefined, 0);
  assert.deepEqual(asked[1], {
    path: '/remote/small.bin', start: undefined, highWaterMark: asked[0].highWaterMark
  });
  await assert.rejects(session.readFileStream('/remote/x', undefined, -5), /无效的读取起始偏移/);
});
