import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRemoteDirectory } from '../src/remote/resolve-directory';

test('remote directory resolution stats and returns the canonical directory', async () => {
  const result = await resolveRemoteDirectory({
    realpath: async candidate => {
      assert.equal(candidate, '/work/link');
      return '/work/project';
    },
    stat: async canonical => {
      assert.equal(canonical, '/work/project');
      return { type: 'directory' };
    }
  }, '/work', '/work/link');
  assert.equal(result, '/work/project');
});

test('remote directory resolution rejects a canonical path outside the mount before stat', async () => {
  await assert.rejects(resolveRemoteDirectory({
    realpath: async () => '/other/project',
    stat: async () => assert.fail('stat was called outside the mount')
  }, '/work', '/work/link'), /挂载根目录/);
});

test('remote directory resolution rejects a file', async () => {
  await assert.rejects(resolveRemoteDirectory({
    realpath: async candidate => candidate,
    stat: async () => ({ type: 'file' })
  }, '/work', '/work/file'), /不是目录/);
});
