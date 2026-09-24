import assert from 'node:assert/strict';
import test from 'node:test';
import { hierarchicalHostName, legacyMountNames, mountNameFor } from '../src/mount-aliases';
import { HostConfig } from '../src/config';

const host = (overrides: Partial<HostConfig> = {}): HostConfig => ({
  name: '10.68.0.1(nsgsx_zhangk)',
  ip: '10.68.0.1',
  user: 'nsgsx_zhangk',
  ...overrides
});

test('uses an ASCII alias as the host label and falls back to the IP', () => {
  assert.equal(hierarchicalHostName(host(), { '10.68.0.1': 'gsx01' }), 'gsx01');
  // 非 ASCII 别名只做展示，回退 IP。
  assert.equal(hierarchicalHostName(host(), { '10.68.0.1': '工业云' }), '10.68.0.1');
  assert.equal(hierarchicalHostName(host()), '10.68.0.1');
});

test('lists the config names older releases could have generated', () => {
  assert.deepEqual(legacyMountNames(host(), { '10.68.0.1': 'gsx01' }), [
    'nsgsx_zhangk_gsx01',
    'nsgsx_zhangk_10.68.0.1',
    'gsx01@nsgsx_zhangk',
    '10.68.0.1@nsgsx_zhangk'
  ]);
  // 中文别名：主机名回退 IP，但中文别名本身也拼进过旧配置名。
  assert.deepEqual(legacyMountNames(host(), { '10.68.0.1': '工业云' }), [
    'nsgsx_zhangk_10.68.0.1',
    'nsgsx_zhangk_工业云',
    '10.68.0.1@nsgsx_zhangk'
  ]);
});

test('never lists the current config name as a legacy alias', () => {
  // 迁移后再跑一次：候选里不含 `IP(账号)` 这个当前名字。
  assert.equal(
    legacyMountNames(host(), { '10.68.0.1': 'gsx01' }).includes('10.68.0.1(nsgsx_zhangk)'),
    false
  );
});

test('names the config as alias(account), falling back to the IP', () => {
  assert.equal(mountNameFor(host(), { '10.68.0.1': 'gsx01' }), 'gsx01(nsgsx_zhangk)');
  // 别名是中文：退回 IP。
  assert.equal(mountNameFor(host(), { '10.68.0.1': '工业云' }), '10.68.0.1(nsgsx_zhangk)');
  // 没配别名：也是 IP。
  assert.equal(mountNameFor(host()), '10.68.0.1(nsgsx_zhangk)');
  // 同名账号换人时只用新账号名。
  assert.equal(
    mountNameFor({ ...host(), user: 'zhuyuan' }, { '10.68.0.1': 'gsx01' }),
    'gsx01(zhuyuan)'
  );
});
