import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hierarchicalHostName, legacyMountNames, mountAliasCandidates, mountNameFor
} from '../src/mount-aliases';
import { HostConfig } from '../src/config';

const host = (overrides: Partial<HostConfig> = {}): HostConfig => ({
  name: '192.0.2.10(dev_alice)',
  ip: '192.0.2.10',
  user: 'dev_alice',
  ...overrides
});

test('uses any configured alias as the host label and falls back to the IP', () => {
  assert.equal(hierarchicalHostName(host(), { '192.0.2.10': 'devbox' }), 'devbox');
  assert.equal(hierarchicalHostName(host(), { '192.0.2.10': '测试主机' }), '测试主机');
  assert.equal(hierarchicalHostName(host()), '192.0.2.10');
});

test('lists the config names older releases could have generated', () => {
  assert.deepEqual(legacyMountNames(host(), { '192.0.2.10': 'devbox' }), [
    'dev_alice_devbox',
    'dev_alice_192.0.2.10',
    'devbox@dev_alice',
    '192.0.2.10@dev_alice'
  ]);
  // 中文别名同样成为当前主机名；IP 形式仍作为旧配置名保留。
  assert.deepEqual(legacyMountNames(host(), { '192.0.2.10': '测试主机' }), [
    'dev_alice_测试主机',
    'dev_alice_192.0.2.10',
    '测试主机@dev_alice',
    '192.0.2.10@dev_alice'
  ]);
});

test('never lists the current config name as a legacy alias', () => {
  // 迁移后再跑一次：候选里不含 `主机名(账号)` 这个当前名字。
  assert.equal(
    legacyMountNames(host(), { '192.0.2.10': 'devbox' }).includes('192.0.2.10(dev_alice)'),
    false
  );
});

test('names the config as alias(account), including Unicode aliases', () => {
  assert.equal(mountNameFor(host(), { '192.0.2.10': 'devbox' }), 'devbox(dev_alice)');
  assert.equal(mountNameFor(host(), { '192.0.2.10': '测试主机' }), '测试主机(dev_alice)');
  // 没配别名：也是 IP。
  assert.equal(mountNameFor(host()), '192.0.2.10(dev_alice)');
  // 同名账号换人时只用新账号名。
  assert.equal(
    mountNameFor({ ...host(), user: 'alice' }, { '192.0.2.10': 'devbox' }),
    'devbox(alice)'
  );
});

test('lists every name an already-saved URI could carry for that host', () => {
  const candidates = mountAliasCandidates(host(), { '192.0.2.10': 'devbox' });
  for (const expected of [
    'dev_alice_devbox',        // 1.9.4 之前：账号_别名
    'dev_alice_192.0.2.10',    // 别名是中文时：账号_IP
    'devbox@dev_alice',        // 更早：别名@账号
    '192.0.2.10@dev_alice',
    '192.0.2.10(dev_alice)',   // 上一版：IP(账号)
    '192.0.2.10_dev_alice'     // 上一版被 VS Code 转义后的样子
  ]) {
    assert.equal(candidates.includes(expected), true, expected);
  }
  // 候选里不会有当前名字自己（那是真实配置名，不需要别名）。
  assert.equal(candidates.includes('devbox(dev_alice)'), false);
});

test('keeps the former IP name as an alias after adopting a Unicode host name', () => {
  const candidates = mountAliasCandidates(host(), { '192.0.2.10': '测试主机' });
  assert.equal(candidates.includes('192.0.2.10(dev_alice)'), true);
  assert.equal(candidates.includes('测试主机(dev_alice)'), false);
});
