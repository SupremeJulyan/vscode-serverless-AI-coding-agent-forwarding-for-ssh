import assert from 'node:assert/strict';
import test from 'node:test';
import { accountTargetIndex } from '../src/config/host-accounts';
import { BridgeConfig, deriveMounts, removeHostGroupAccounts } from '../src/config/config';

const config = (hosts: Array<{ name: string; ip: string; user: string }>): BridgeConfig => ({
  hosts, mounts: []
});

test('adding an account to a host group appends instead of overwriting', () => {
  const single = config([{ name: '192.0.2.10(a)', ip: '192.0.2.10', user: 'a' }]);
  // 单账号主机：仍然返回 -1（新增），不再复用已有账号的位置。
  assert.equal(accountTargetIndex(single, { ip: '192.0.2.10' }), -1);
  const many = config([
    { name: '192.0.2.40(a)', ip: '192.0.2.40', user: 'a' },
    { name: '192.0.2.40(b)', ip: '192.0.2.40', user: 'b' },
    { name: '192.0.2.10(c)', ip: '192.0.2.10', user: 'c' }
  ]);
  assert.equal(accountTargetIndex(many, { ip: '192.0.2.40' }), -1);
  // 追加不会影响同组已有记录。
  assert.equal(many.hosts.length, 3);
});

test('fills in the pending account of a host created without credentials', () => {
  const pending = config([{ name: '10.0.0.9', ip: '10.0.0.9', user: '' }]);
  assert.equal(accountTargetIndex(pending, { ip: '10.0.0.9' }), 0);
});

test('locates the named host for account nodes and the legacy view', () => {
  const hosts = config([
    { name: 'a', ip: '10.0.0.1', user: 'a' },
    { name: 'b', ip: '10.0.0.2', user: 'b' }
  ]);
  assert.equal(accountTargetIndex(hosts, { name: 'b' }), 1);
  assert.equal(accountTargetIndex(hosts, { name: 'missing' }), -1);
  assert.equal(accountTargetIndex(hosts, {}), -1);
});

test('deleting a host group removes all selected accounts and mounts and preserves other hosts', () => {
  const a = { name: 'dev(a)', ip: '192.0.2.10', user: 'a' };
  const b = { name: 'dev(b)', ip: '192.0.2.10', user: 'b' };
  const other = { name: 'staging(a)', ip: '192.0.2.20', user: 'a' };
  const current = { hosts: [a, b, other], mounts: deriveMounts([a, other]) };
  removeHostGroupAccounts(current, [a.name, b.name]);
  assert.deepEqual(current.hosts, [other]);
  assert.deepEqual(current.mounts, deriveMounts([other]));
});
