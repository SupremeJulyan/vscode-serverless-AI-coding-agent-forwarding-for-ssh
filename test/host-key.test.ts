import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import fsPromises, { readFile, readdir, writeFile } from 'node:fs/promises';
import { symlinkOrSkip } from './symlink-helper';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { HostConfig } from '../src/config/config';
import {
  appendKnownHostsFile, appendLoadBalancedKnownHostsFile,
  changedKeyDecision, changedKeyPromptMessage,
  firstConnectionDecision, firstConnectionPromptMessage,
  hostEntryName, hostEntryNames, isLoadBalancedKnownHost, keyTypeFromBlob,
  readTrustedFingerprints, replaceKnownHostsForHost,
  setKnownHostsFilePath, sha256Fingerprint,
  verifyHostKeyWithPrompt
} from '../src/security/host-key';


/** 每个测试使用独立临时 known_hosts 文件，避免模块级路径串扰。 */
function tempKnownHosts(): { file: string; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'safs-kh-'));
  return { file: path.join(dir, 'known_hosts'), dir };
}

function hostAt(port: number): HostConfig {
  return { name: 'dev', ip: '10.0.0.2', user: 'alice', port };
}

/** 直接构造 known_hosts 行（测试预置已确认密钥用）。 */
function lineFor(host: HostConfig, type: string, blob: string): string {
  return `${hostEntryName(host)} ${type} ${blob}`;
}

const blobA = 'QUFBQUNOemFoQzFsWkRJMU5URTVBQUFBSWZha2VB'; // ssh-ed25519 类型开头的假 blob
const blobB = 'QUFBQUNOemFoQzFsWkRJMU5URTVBQUFBSWZha2VC';
const blobC = 'QUFBQUNOemFoQzFsWkRJMU5URTVBQUFBSWZha2VD';

test('first-connection prompt highlights the target host IP, port and user', () => {
  const message = firstConnectionPromptMessage(hostAt(2222), ['SHA256:abc', 'SHA256:def']);
  assert.ok(message.includes('⚠️ 请确认目标主机：10.0.0.2:2222'));
  assert.ok(message.includes('登录用户 alice'));
  assert.ok(message.includes('SHA256:abc'));
  assert.ok(message.includes('SHA256:def'));
  assert.ok(message.includes('是否信任这些密钥并继续连接？'));
});

test('changed-key prompt shows old/new fingerprints and the highlighted host IP', () => {
  const message = changedKeyPromptMessage(
    hostAt(2222), ['SHA256:old1', 'SHA256:old2'], ['SHA256:new1']
  );
  assert.ok(message.includes('⚠️ 目标主机：10.0.0.2:2222'));
  assert.ok(message.includes('旧密钥：SHA256:old1'));
  assert.ok(message.includes('SHA256:old2'));
  assert.ok(message.includes('新密钥：SHA256:new1'));
  assert.ok(message.includes(
    '请选择替换旧密钥（SSH主机重装），或追加新密钥（SSH主机为负载节点）。'
  ));
  assert.equal(message.includes('拒绝（不信任该主机）'), false);
});

test('changed-key prompt collapses long trusted key lists', () => {
  const manyOld = ['SHA256:1', 'SHA256:2', 'SHA256:3', 'SHA256:4', 'SHA256:5'];
  const message = changedKeyPromptMessage(hostAt(2222), manyOld, ['SHA256:new']);
  assert.ok(message.includes('…（共 5 个）'));
});

test('dialog decisions: closing with X/Esc (undefined) refuses, never accepts', () => {
  assert.equal(firstConnectionDecision('信任并连接'), 'accept');
  assert.equal(firstConnectionDecision(undefined), 'refuse');
  assert.equal(changedKeyDecision('替换旧密钥'), 'replace');
  assert.equal(changedKeyDecision('追加新密钥'), 'accept');
  // 安全回归：X / Esc 关闭弹窗绝不能默认接受新密钥。
  assert.equal(changedKeyDecision(undefined), 'refuse');
});

test('host entry names follow OpenSSH conventions for port 22 and custom ports', () => {
  assert.equal(hostEntryName(hostAt(22)), '10.0.0.2');
  assert.equal(hostEntryName(hostAt(2222)), '[10.0.0.2]:2222');
  assert.deepEqual(hostEntryNames(hostAt(2222)), ['[10.0.0.2]:2222', '10.0.0.2']);
  const ipv6: HostConfig = { name: 'v6', ip: '2001:db8::1', user: 'a', port: 22 };
  assert.equal(hostEntryName(ipv6), '2001:db8::1');
  assert.deepEqual(hostEntryNames(ipv6), ['2001:db8::1']);
  assert.equal(hostEntryName({ ...ipv6, port: 2222 }), '[2001:db8::1]:2222');
});

test('keyTypeFromBlob extracts the key type from an OpenSSH blob', () => {
  const blob = Buffer.alloc(4 + 'ssh-ed25519'.length + 8);
  blob.writeUInt32BE('ssh-ed25519'.length, 0);
  blob.write('ssh-ed25519', 4, 'utf8');
  assert.equal(keyTypeFromBlob(blob), 'ssh-ed25519');
  assert.equal(keyTypeFromBlob(Buffer.from('tooshort')), 'unknown');
});

test('appendKnownHostsFile writes standard known_hosts lines idempotently with 0600', async () => {
  const { file } = tempKnownHosts();
  const host = hostAt(2222);
  const keys = [
    { host: hostEntryName(host), type: 'ssh-ed25519', blob: blobA },
    { host: hostEntryName(host), type: 'ssh-rsa', blob: blobB }
  ];
  await appendKnownHostsFile(file, keys);
  await appendKnownHostsFile(file, keys); // 幂等
  const content = await readFile(file, 'utf8');
  assert.equal(content.split(/\r?\n/).filter((line) => line.trim()).length, 2);
  assert.ok(content.includes(lineFor(host, 'ssh-ed25519', blobA)));
  assert.ok(content.includes(lineFor(host, 'ssh-rsa', blobB)));
  if (process.platform !== 'win32') assert.equal((statSync(file).mode & 0o777), 0o600);
});

test('concurrent known_hosts updates preserve every writer and leave no lock artifacts', async () => {
  const { file, dir } = tempKnownHosts();
  const keys = Array.from({ length: 12 }, (_, index) => ({
    host: hostEntryName(hostAt(2222)),
    type: 'ssh-ed25519',
    blob: Buffer.from(`backend-${index}`).toString('base64')
  }));
  await Promise.all(keys.map((key) => appendKnownHostsFile(file, [key])));

  const content = await readFile(file, 'utf8');
  for (const key of keys) assert.ok(content.includes(key.blob));
  assert.equal(content.trim().split(/\r?\n/).length, keys.length);
  assert.deepEqual((await readdir(dir)).sort(), ['known_hosts']);
});

test('Windows lock creation retries transient access-denied errors without losing entries', async t => {
  const { file, dir } = tempKnownHosts();
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const originalMkdir = fsPromises.mkdir;
  let attempts = 0;
  t.mock.method(fsPromises, 'mkdir', async (...args: Parameters<typeof originalMkdir>) => {
    if (args[0] === `${file}.lock` && ++attempts <= 2) {
      throw Object.assign(new Error('directory pending deletion'), { code: attempts === 1 ? 'EPERM' : 'EACCES' });
    }
    return originalMkdir(...args);
  });
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
  try {
    await appendKnownHostsFile(file, [{ host: hostEntryName(hostAt(22)), type: 'ssh-ed25519', blob: blobA }]);
    assert.equal(attempts, 3);
    assert.match(await readFile(file, 'utf8'), /ssh-ed25519/);
    assert.deepEqual(await readdir(dir), ['known_hosts']);
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
    t.mock.restoreAll();
  }
});

test('atomic known_hosts writes replace a symlink without modifying its target', async (t) => {
  const { file, dir } = tempKnownHosts();
  const target = path.join(dir, 'do-not-modify');
  await writeFile(target, 'original\n');
  if (!await symlinkOrSkip(t, target, file)) return;

  await appendKnownHostsFile(file, [{
    host: hostEntryName(hostAt(22)), type: 'ssh-ed25519', blob: blobA
  }]);

  assert.equal(await readFile(target, 'utf8'), 'original\n');
  assert.match(await readFile(file, 'utf8'), /ssh-ed25519/);
});

test('readTrustedFingerprints filters entries by host', async () => {
  const { file } = tempKnownHosts();
  const hostA = hostAt(2222);
  const hostB = hostAt(2223);
  await writeFile(file, [
    lineFor(hostA, 'ssh-ed25519', blobA),
    lineFor(hostB, 'ssh-ed25519', blobB),
    '# comment line'
  ].join('\n') + '\n');
  const fpsA = await readTrustedFingerprints(file, hostA);
  assert.equal(fpsA.length, 1);
  assert.ok(fpsA.includes(sha256Fingerprint(Buffer.from(blobA, 'base64'))));
  // 另一个主机不受影响
  assert.deepEqual(
    await readTrustedFingerprints(file, { ...hostA, port: 2224 }), []
  );
});

test('readTrustedFingerprints ignores legacy bracketed IPv6 at the default port', async () => {
  const { file } = tempKnownHosts();
  const host: HostConfig = {
    name: 'v6', ip: '2001:db8::1', user: 'alice', port: 22
  };
  await writeFile(file, `[2001:db8::1] ssh-ed25519 ${blobA}\n`);
  assert.deepEqual(await readTrustedFingerprints(file, host), []);
});

test('replaceKnownHostsForHost removes stale keys but preserves other hosts', async () => {
  const { file } = tempKnownHosts();
  const hostA = hostAt(2222);
  const hostB = hostAt(2223);
  await writeFile(file, [
    '# retained comment',
    lineFor(hostA, 'ssh-ed25519', blobA),
    lineFor(hostA, 'ssh-rsa', blobB),
    lineFor(hostB, 'ssh-ed25519', blobC)
  ].join('\n') + '\n');

  await replaceKnownHostsForHost(file, hostA, [
    { host: 'ignored-scan-name', type: 'ssh-ed25519', blob: blobC }
  ]);

  const content = await readFile(file, 'utf8');
  assert.ok(content.includes('# retained comment'));
  assert.ok(content.includes(lineFor(hostB, 'ssh-ed25519', blobC)));
  assert.ok(content.includes(lineFor(hostA, 'ssh-ed25519', blobC)));
  assert.ok(!content.includes(lineFor(hostA, 'ssh-ed25519', blobA)));
  assert.ok(!content.includes(lineFor(hostA, 'ssh-rsa', blobB)));
  if (process.platform !== 'win32') assert.equal((statSync(file).mode & 0o777), 0o600);
});

test('replaceKnownHostsForHost migrates legacy bracketed IPv6 at port 22', async () => {
  const { file } = tempKnownHosts();
  const host: HostConfig = {
    name: 'v6', ip: '2001:db8::1', user: 'alice', port: 22
  };
  await writeFile(file, `[2001:db8::1] ssh-ed25519 ${blobA}\n`);

  await replaceKnownHostsForHost(file, host, [
    { host: host.ip, type: 'ssh-ed25519', blob: blobB }
  ]);

  const content = await readFile(file, 'utf8');
  assert.ok(!content.includes(`[2001:db8::1] ssh-ed25519 ${blobA}`));
  assert.ok(content.includes(`2001:db8::1 ssh-ed25519 ${blobB}`));
});

test('verifyHostKeyWithPrompt passes when the fingerprint is already in the file', async () => {
  const { file } = tempKnownHosts();
  setKnownHostsFilePath(file);
  const host = hostAt(3001);
  await writeFile(file, lineFor(host, 'ssh-ed25519', blobA) + '\n');
  const prompts = {
    firstConnection: async () => { throw new Error('must not prompt'); },
    changed: async () => { throw new Error('must not prompt'); }
  };
  const fps = sha256Fingerprint(Buffer.from(blobA, 'base64'));
  assert.equal(
    await verifyHostKeyWithPrompt(host, [fps], undefined, prompts), 'trusted'
  );
});

test('verifyHostKeyWithPrompt first connection prompts once and allows', async () => {
  const { file } = tempKnownHosts();
  setKnownHostsFilePath(file);
  const host = hostAt(3002);
  let prompts = 0;
  const injected = {
    firstConnection: async () => { prompts += 1; return 'accept' as const; },
    changed: async () => { throw new Error('must not prompt changed'); }
  };
  const fps = sha256Fingerprint(Buffer.from(blobA, 'base64'));
  assert.equal(await verifyHostKeyWithPrompt(host, [fps], undefined, injected), 'accept');
  assert.equal(prompts, 1);
});

test('verifyHostKeyWithPrompt first connection: refuse blocks', async () => {
  const { file } = tempKnownHosts();
  setKnownHostsFilePath(file);
  const host = hostAt(3003);
  const injected = {
    firstConnection: async () => 'refuse' as const,
    changed: async () => { throw new Error('must not prompt changed'); }
  };
  const fps = sha256Fingerprint(Buffer.from(blobA, 'base64'));
  assert.equal(await verifyHostKeyWithPrompt(host, [fps], undefined, injected), 'refuse');
});

test('verifyHostKeyWithPrompt prompts for untrusted keys in a mixed probe batch', async () => {
  const { file } = tempKnownHosts();
  setKnownHostsFilePath(file);
  const host = hostAt(3011);
  await writeFile(file, lineFor(host, 'ssh-ed25519', blobA) + '\n');
  const trusted = sha256Fingerprint(Buffer.from(blobA, 'base64'));
  const untrusted = sha256Fingerprint(Buffer.from(blobB, 'base64'));
  let shownNew: string[] = [];
  const injected = {
    firstConnection: async () => { throw new Error('must prompt changed'); },
    changed: async (_host: HostConfig, _old: string[], next: string[]) => {
      shownNew = next;
      return 'accept' as const;
    }
  };

  assert.equal(
    await verifyHostKeyWithPrompt(host, [trusted, untrusted], undefined, injected),
    'append'
  );
  assert.deepEqual(shownNew, [untrusted]);
});

test('choosing append remembers a load-balanced host and suppresses later prompts', async () => {
  const { file } = tempKnownHosts();
  setKnownHostsFilePath(file);
  const host = hostAt(3004);
  let firstPrompts = 0;
  let changedPrompts = 0;
  const injected = {
    firstConnection: async () => { firstPrompts += 1; return 'accept' as const; },
    changed: async () => { changedPrompts += 1; return 'accept' as const; }
  };
  // 首次连接：首次弹窗（确认后由调用方写文件——这里模拟写入）。
  const fpsA = sha256Fingerprint(Buffer.from(blobA, 'base64'));
  assert.equal(await verifyHostKeyWithPrompt(host, [fpsA], undefined, injected), 'accept');
  await appendKnownHostsFile(file, [{ host: hostEntryName(host), type: 'ssh-ed25519', blob: blobA }]);
  // 新后端：首次选择追加，并由调用方原子记录负载节点偏好和密钥。
  const fpsB = sha256Fingerprint(Buffer.from(blobB, 'base64'));
  assert.equal(await verifyHostKeyWithPrompt(host, [fpsB], undefined, injected), 'append');
  await appendLoadBalancedKnownHostsFile(file, host, [
    { host: hostEntryName(host), type: 'ssh-ed25519', blob: blobB }
  ]);
  assert.equal(await isLoadBalancedKnownHost(file, host), true);
  assert.equal(firstPrompts, 1);
  assert.equal(changedPrompts, 1);
  // 已确认过的后端再次出现：文件命中，不弹窗。
  assert.equal(await verifyHostKeyWithPrompt(host, [fpsA], undefined, injected), 'trusted');
  assert.equal(changedPrompts, 1);
  // 另一个新后端：沿用负载节点偏好，自动追加，不再弹窗。
  const fpsC = sha256Fingerprint(Buffer.from(blobC, 'base64'));
  assert.equal(await verifyHostKeyWithPrompt(host, [fpsC], undefined, injected), 'append');
  assert.equal(changedPrompts, 1);
});

test('load-balanced preference is scoped by host and cleared by replacement', async () => {
  const { file } = tempKnownHosts();
  const host = hostAt(2222);
  await appendLoadBalancedKnownHostsFile(file, host, [
    { host: hostEntryName(host), type: 'ssh-ed25519', blob: blobA }
  ]);
  assert.equal(await isLoadBalancedKnownHost(file, host), true);
  assert.equal(await isLoadBalancedKnownHost(file, hostAt(2223)), false);

  await replaceKnownHostsForHost(file, host, [
    { host: hostEntryName(host), type: 'ssh-ed25519', blob: blobB }
  ]);
  assert.equal(await isLoadBalancedKnownHost(file, host), false);
});

test('mixed-case host identities reuse legacy keys and load-balanced markers', async () => {
  const { file } = tempKnownHosts();
  const host = { ...hostAt(2222), ip: 'My-Cluster' };
  const legacyEntry = '[My-Cluster]:2222';
  const marker = '# SAFS_LOAD_BALANCED ' + Buffer.from(legacyEntry).toString('base64url');
  await writeFile(file, `${marker}\n${legacyEntry} ssh-ed25519 ${blobA}\n`);
  setKnownHostsFilePath(file);
  assert.equal(hostEntryName(host), '[my-cluster]:2222');
  assert.deepEqual(hostEntryNames(host), ['[my-cluster]:2222', 'my-cluster']);
  assert.deepEqual(await readTrustedFingerprints(file, host), [
    sha256Fingerprint(Buffer.from(blobA, 'base64'))
  ]);
  assert.equal(await isLoadBalancedKnownHost(file, host), true);
  const noPrompts = {
    firstConnection: async () => { throw new Error('must reuse legacy trust'); },
    changed: async () => { throw new Error('must reuse load-balanced preference'); }
  };
  assert.equal(await verifyHostKeyWithPrompt(host,
    [sha256Fingerprint(Buffer.from(blobB, 'base64'))], undefined, noPrompts), 'append');
  await replaceKnownHostsForHost(file, host, [
    { host: hostEntryName(host), type: 'ssh-ed25519', blob: blobB }
  ]);
  assert.equal(await isLoadBalancedKnownHost(file, host), false);
  assert.deepEqual(await readTrustedFingerprints(file, host), [
    sha256Fingerprint(Buffer.from(blobB, 'base64'))
  ]);
});
