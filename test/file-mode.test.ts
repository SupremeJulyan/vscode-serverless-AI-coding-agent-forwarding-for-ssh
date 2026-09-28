import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { applyLocalExecutableBits, executableBits, grantExecutableBits } from '../src/file-mode';

test('executable bits mirror the source mode class by class', () => {
  assert.equal(executableBits(0o644), 0, '普通文件不该凭空得到可执行位');
  assert.equal(executableBits(0o755), 0o111);
  assert.equal(executableBits(0o700), 0o100);
  assert.equal(executableBits(0o750), 0o110);
  // Windows 上 lstat().mode 是合成值（普通文件恒 0o100666），没有可执行位可搬。
  assert.equal(executableBits(0o100666), 0);
});

test('executable bits are only granted where the target is readable', () => {
  assert.equal(grantExecutableBits(0o644, 0o755), 0o755);
  // 目标权限比默认更严（0600）：只在属主位上补，不造出「可执行但不可读」的 0711。
  assert.equal(grantExecutableBits(0o600, 0o755), 0o700);
  assert.equal(grantExecutableBits(0o640, 0o755), 0o750);
  // 源不可执行：目标权限一个位都不动，也不放宽读写范围。
  assert.equal(grantExecutableBits(0o600, 0o644), 0o600);
  assert.equal(grantExecutableBits(0o644, 0o644), 0o644);
});

async function scratch(t: { after(fn: () => Promise<void>): void }, name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'safs-mode-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, name);
  await writeFile(target, '#!/bin/sh\n');
  return target;
}

test('downloaded executable bits never widen the local read range', async (t) => {
  if (process.platform === 'win32') return t.skip('Windows has no executable bit');
  const target = await scratch(t, 'run.sh');
  // 本地 umask 偏严时的典型结果：只有属主可读写。
  await chmod(target, 0o600);

  await applyLocalExecutableBits(target, 0o755);

  // 远端的 0755 不该把本地文件放宽成组/其他人可读，只补属主可执行位。
  assert.equal((await stat(target)).mode & 0o777, 0o700);
});

test('a remote stat without executable bits leaves the local file alone', async (t) => {
  const target = await scratch(t, 'a.txt');
  const before = (await stat(target)).mode & 0o777;

  await applyLocalExecutableBits(target, 0o644);
  await applyLocalExecutableBits(target, undefined);

  assert.equal((await stat(target)).mode & 0o777, before);
  assert.equal(before & 0o111, 0, '普通文件落盘后不该带可执行位');
});

test('a failing chmod is logged instead of failing the completed download', async (t) => {
  const target = await scratch(t, 'missing.sh');
  await rm(target);
  const logs: string[] = [];

  // 目标不存在：补权限失败，但不能抛出——内容已经落盘，调用方不该因此报传输失败。
  await applyLocalExecutableBits(target, 0o755, (message) => logs.push(message));

  assert.equal(logs.length, 1);
  assert.match(logs[0], /补可执行位失败/);
});
