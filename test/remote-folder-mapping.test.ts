import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isWorkspaceUriPath, remotePathForUri, workspacePathForRemote, RemoteFolder
} from '../src/sftp/filesystem-provider';
import { ensureAgentCwdPlaceholder, ensureAgentCwdSubdirectory } from '../src/agent-cwd';

test('root mount maps home and outside-home directories without colliding with restored URIs', async () => {
  const storage = await mkdtemp(path.join(os.tmpdir(), 'safs-root-mapping-'));
  try {
    const root = await ensureAgentCwdPlaceholder('/', storage, 'dev');
    const legacy = await ensureAgentCwdPlaceholder('/home/user', storage, 'dev');
    const folder: RemoteFolder = {
      mountName: 'dev', hostName: 'dev', remoteRoot: '/', defaultRemotePath: '/home/user',
      workspaceRoot: root.localPath.replace(/\\/g, '/'),
      legacyMapping: { workspaceRoot: legacy.localPath.replace(/\\/g, '/'), remoteRoot: '/home/user' }
    };
    for (const remote of ['/home/user', '/data/project', '/etc', '/']) {
      const uriPath = workspacePathForRemote(folder, remote);
      assert.equal(isWorkspaceUriPath(folder, uriPath), true);
      assert.equal(remotePathForUri(folder, uriPath), remote);
      const local = await ensureAgentCwdSubdirectory(root.localPath, '/', remote);
      assert.equal(local.replace(/\\/g, '/'), uriPath);
    }
    const oldTab = `${folder.legacyMapping!.workspaceRoot}/project/file.ts`;
    assert.equal(isWorkspaceUriPath(folder, oldTab), true);
    assert.equal(remotePathForUri(folder, oldTab), '/home/user/project/file.ts');
    assert.equal(isWorkspaceUriPath(folder, `${folder.workspaceRoot}-other/file`), false);
    assert.equal(isWorkspaceUriPath(folder, `${folder.workspaceRoot}/../file`), false);
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});

test('root login does not apply a conflicting home mapping to the root namespace', async () => {
  const storage = await mkdtemp(path.join(os.tmpdir(), 'safs-root-login-'));
  try {
    const root = await ensureAgentCwdPlaceholder('/', storage, 'dev(root)', '127.0.0.1', 'root');
    const home = await ensureAgentCwdPlaceholder('/root', storage, 'dev(root)', '127.0.0.1', 'root');
    assert.equal(root.localPath, home.localPath);
    // Covers restored folder metadata as well as current root-folder mapping.
    for (const workspaceRoot of [root.localPath.replace(/\\/g, '/'), '/c:/Users/admin/agent-cwd/7f000001/root/root']) {
      const folder: RemoteFolder = {
        mountName: 'dev(root)', hostName: 'dev(root)', remoteRoot: '/',
        defaultRemotePath: '/root', workspaceRoot,
        legacyMapping: { workspaceRoot, remoteRoot: '/root' }
      };
      for (const remote of ['/', '/root', '/root/project', '/etc']) {
        const uriPath = workspacePathForRemote(folder, remote);
        assert.equal(isWorkspaceUriPath(folder, uriPath), true);
        assert.equal(remotePathForUri(folder, uriPath), remote);
      }
    }
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
});
