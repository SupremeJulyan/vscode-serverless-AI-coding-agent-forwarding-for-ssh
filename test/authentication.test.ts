import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configEntryOffset, isAuthenticationFailure, isNetworkFailure, passwordValueOffset
} from '../src/authentication';

test('recognizes common SSH password authentication failures', () => {
  assert.equal(isAuthenticationFailure(new Error('Permission denied, please try again.')), true);
  assert.equal(isAuthenticationFailure(new Error('Authentication failed')), true);
  assert.equal(isAuthenticationFailure(new Error('Connection timed out')), false);
});

test('recognizes common SSH network failures separately from password failures', () => {
  assert.equal(isNetworkFailure(new Error('read: Connection reset by peer')), true);
  assert.equal(isNetworkFailure(new Error('ssh: connect to host x: Connection refused')), true);
  assert.equal(isNetworkFailure(new Error('Network is unreachable')), true);
  assert.equal(isNetworkFailure(new Error('Permission denied')), false);
});

test('finds the empty password value for a named host', () => {
  const content = JSON.stringify({
    hosts: [
      { name: 'first', password: 'enc:v1:old' },
      { name: 'dev.example', password: '' }
    ],
    mounts: []
  }, null, 2);
  const offset = passwordValueOffset(content, 'dev.example');
  assert.notEqual(offset, undefined);
  assert.equal(content.slice(offset!, offset! + 1), '"');
  assert.equal(content.slice(offset! - 13, offset! + 1), '"password": ""');
});

test('locates the config line of a named host for 打开配置', () => {
  const content = JSON.stringify({
    encrypt_passwords: true,
    hosts: [
      { name: 'first', ip: '10.0.0.1', user: 'a' },
      { name: 'dev.example', ip: '10.0.0.2', user: 'b' }
    ]
  }, null, 2);
  const offset = configEntryOffset(content, 'dev.example');
  assert.notEqual(offset, undefined);
  const line = content.slice(0, offset!).split('\n').length;
  assert.equal(content.split('\n')[line - 1].trim(), '"name": "dev.example",');
  assert.equal(configEntryOffset(content, 'missing'), undefined);
});

test('matches host names literally and still finds legacy mounts-only entries', () => {
  const tricky = JSON.stringify({ hosts: [{ name: 'a.b+c' }] }, null, 2);
  assert.notEqual(configEntryOffset(tricky, 'a.b+c'), undefined);
  assert.equal(configEntryOffset(tricky, 'axb+c'), undefined);
  // 保存配置时会省略 mounts；手工维护的历史配置仍可能只有 mounts 数组。
  const mountsOnly = JSON.stringify({ mounts: [{ name: 'legacy', host: 'legacy' }] }, null, 2);
  assert.notEqual(configEntryOffset(mountsOnly, 'legacy'), undefined);
});
