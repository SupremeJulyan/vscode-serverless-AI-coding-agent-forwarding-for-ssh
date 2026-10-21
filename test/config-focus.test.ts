import assert from 'node:assert/strict';
import test from 'node:test';
import { isConfigFocus } from '../src/config-focus';

test('accepts well-formed config focus arguments', () => {
  assert.equal(isConfigFocus({ kind: 'entry', name: '192.0.2.10(dev_alice)' }), true);
  assert.equal(isConfigFocus({ kind: 'password', name: 'alice_ws1' }), true);
});

test('rejects tree elements so they go through the tree mapping instead', () => {
  // 视图条目右键/标题栏聚焦项传进来的是树元素，没有 kind。
  assert.equal(isConfigFocus({ type: 'user', hostName: '192.0.2.10(a)', user: 'a' }), false);
  assert.equal(isConfigFocus({ type: 'history', mountName: 'gkn', path: '/home' }), false);
  assert.equal(isConfigFocus({ type: 'hostGroup', ip: '192.0.2.10', hosts: [], displayName: 'x' }), false);
  // MountConfig 有 name 但没有 kind。
  assert.equal(isConfigFocus({ name: 'gkn', host: 'gkn', remote_path: '.' }), false);
});

test('rejects malformed arguments instead of throwing later', () => {
  assert.equal(isConfigFocus({ kind: 'entry' }), false);
  assert.equal(isConfigFocus({ kind: 'entry', name: '' }), false);
  assert.equal(isConfigFocus({ kind: 'other', name: 'x' }), false);
  assert.equal(isConfigFocus(undefined), false);
  assert.equal(isConfigFocus(null), false);
  assert.equal(isConfigFocus('gkn'), false);
  assert.equal(isConfigFocus([]), false);
});
