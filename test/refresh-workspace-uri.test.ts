import assert from 'node:assert/strict';
import test from 'node:test';
import { refreshWorkspaceUri } from '../src/remote/refresh-workspace-uri';

test('workspace refresh ignores local and equivalent URIs and reopens a renamed remote folder once', async () => {
  const local = { uri: { scheme: 'file', authority: '', path: '/local', query: '' } };
  const unchanged = { uri: { scheme: 'safs', authority: 'current', path: '/work', query: 'mount%3Dcurrent' } };
  const old = { uri: { ...unchanged.uri, authority: 'old' } };
  const newer = { ...old.uri, authority: 'new' };
  const opened: unknown[][] = [];
  await refreshWorkspaceUri([local, unchanged, old, old], folder => {
    assert.notEqual(folder, local);
    return folder === unchanged ? { ...folder.uri, query: 'mount=current' } : newer;
  }, async (...args) => { opened.push(args); });
  assert.deepEqual(opened, [[old, newer, { forceReuseWindow: true }]]);
});
