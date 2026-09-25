import assert from 'node:assert/strict';
import test from 'node:test';
import type { Client } from 'ssh2';

import {
  ScpSession, parsePortableStatLine, remoteDirectoryChangeCommand
} from '../src/sftp/scp-session';

test('SCP fallback resolves the default remote path through the login home', () => {
  assert.equal(remoteDirectoryChangeCommand('.'), 'cd');
  assert.equal(remoteDirectoryChangeCommand('./'), 'cd');
  assert.equal(remoteDirectoryChangeCommand('~'), 'cd');
  assert.equal(remoteDirectoryChangeCommand('/'), "cd -- '/'");
  assert.equal(remoteDirectoryChangeCommand('/srv/project'), "cd -- '/srv/project'");
});

test('portable SCP stat parses locale-independent raw mode types', () => {
  assert.equal(parsePortableStatLine('41ed|4096|755|1720000000')?.type, 'directory');
  assert.equal(parsePortableStatLine('81a4|12|644|1720000000')?.type, 'file');
  assert.equal(parsePortableStatLine('a1ff|7|777|1720000000')?.type, 'symbolic-link');
});

test('portable SCP stat rejects unknown or malformed modes so callers can fall back', () => {
  assert.equal(parsePortableStatLine('目录|4096|755|1720000000'), undefined);
  assert.equal(parsePortableStatLine('c1ff|0|777|1720000000'), undefined);
  assert.equal(parsePortableStatLine('41ed|bad|755|1720000000'), undefined);
});

test('the SCP fallback refuses resume instead of silently rewriting from zero', async () => {
  // `scp -f` 不能从中间读、`scp -t` 不能定位写：续传在这条通道上不可能成立。
  // 静默忽略偏移会变成「表面续传、实际整传」，所以必须显式报错。
  const client = {
    on: () => client, exec: () => { throw new Error('must not exec'); }
  } as unknown as Client;
  const session = new ScpSession('fake', client);
  await assert.rejects(session.readFileStream('/big.bin', undefined, 1024), /不支持按偏移读取/);
  await assert.rejects(
    session.writeFileStream('/big.bin', { create: true, overwrite: false, startOffset: 1024 }),
    /不支持定位写/
  );
});
