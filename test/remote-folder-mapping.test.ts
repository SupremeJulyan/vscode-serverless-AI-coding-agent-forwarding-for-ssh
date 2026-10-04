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
