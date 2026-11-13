import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  ensureAgentCwdPlaceholder, ensureAgentCwdSubdirectory, readLastRemoteDirectory,
  safeAgentCwdName, writeLastRemoteDirectory
} from '../src/agent/agent-cwd';

test('creates a real cwd below the SAFS remote workspace directory', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'agent-cwd-'));
  const storageRoot = path.join(temporary, 'storage');
  const result = await ensureAgentCwdPlaceholder('/home/share/project', storageRoot, 'project-' + path.basename(temporary));
  assert.equal(result.localPath.startsWith(path.join(os.homedir(), '.safs', 'remote_workspace')), true);
  assert.equal(path.basename(result.localPath), 'project-' + path.basename(temporary));
  assert.equal((await lstat(result.localPath)).isDirectory(), true);

  const repeated = await ensureAgentCwdPlaceholder('/home/share/project', storageRoot, 'project-' + path.basename(temporary));
  assert.equal(repeated.created, false);
  assert.equal(repeated.localPath, result.localPath);
});

test('uses a readable filesystem-safe mount name below the cwd hash', () => {
  assert.equal(safeAgentCwdName('node37'), 'node37');
  assert.equal(safeAgentCwdName('192.0.2.12@dev_carol'), '192.0.2.12@dev_carol');
  assert.equal(safeAgentCwdName('计算节点 / project'), '计算节点_project');
  assert.equal(safeAgentCwdName('CON'), '_CON');
  assert.equal(safeAgentCwdName('...'), 'mount');
});

test('uses separate cwd directories for mounts with the same remote root', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'agent-cwd-mounts-'));
  const first = await ensureAgentCwdPlaceholder('/srv/project', temporary, 'first');
  const second = await ensureAgentCwdPlaceholder('/srv/project', temporary, 'second');
  assert.notEqual(first.localPath, second.localPath);
});

test('creates a real cwd for a switched remote subdirectory', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'agent-cwd-subdirectory-'));
  const root = await ensureAgentCwdPlaceholder('/home/user', temporary, 'home');
  const nested = await ensureAgentCwdSubdirectory(
    root.localPath, '/home/user', '/home/user/alice/project'
  );
  assert.equal(nested, path.join(root.localPath, 'alice', 'project'));
  assert.equal((await lstat(nested)).isDirectory(), true);
  await assert.rejects(
    ensureAgentCwdSubdirectory(root.localPath, '/home/user', '/home/other'),
    /outside the remote root/
  );
});

test('caches the last remote directory beside the empty cwd placeholder', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'agent-cwd-cache-'));
  const root = await ensureAgentCwdPlaceholder('/home/share/alice', temporary, 'dev-' + path.basename(temporary));
  assert.equal(await readLastRemoteDirectory(root.localPath), undefined);

  await writeLastRemoteDirectory(
    root.localPath, '/home/share/alice', '/home/share/alice/dir1'
  );
  assert.equal(
    await readLastRemoteDirectory(root.localPath), '/home/share/alice/dir1'
  );
  await writeLastRemoteDirectory(
    root.localPath, '/home/share/alice', '/home/share/alice/dir2'
  );
  assert.equal(
    await readLastRemoteDirectory(root.localPath), '/home/share/alice/dir2'
  );
  assert.deepEqual(await readdir(root.localPath), []);
  await assert.rejects(
    writeLastRemoteDirectory(root.localPath, '/home/share/alice', '/home/share/other'),
    /outside the remote root/
  );
});


test('new placeholders use readable endpoint and remote directory names', async () => {
  const { agentCwdDirectoryName } = await import('../src/agent/agent-cwd');
  const storage = await mkdtemp(path.join(os.tmpdir(), 'safs-readable-'));
  try {
    const root = await ensureAgentCwdPlaceholder('/', storage, 'alias', '192.0.2.1', 'user', 22);
    const remote = '/home/share/user/folder1';
    const cwd = await ensureAgentCwdSubdirectory(root.localPath, '/', remote);
    assert.equal(path.basename(cwd), 'user@192.0.2.1@22home-share-user-folder1');
    assert.equal(await ensureAgentCwdSubdirectory(root.localPath, '/', remote), cwd);
    const other = await ensureAgentCwdPlaceholder(remote, storage, 'renamed', '192.0.2.1', 'user', 2222);
    assert.notEqual(cwd, other.localPath);
    assert.notEqual(agentCwdDirectoryName('host', 22, 'user', '/a-b/c'), agentCwdDirectoryName('host', 22, 'user', '/a/b-c'));
    const { workspacePathForRemote, remotePathForUri } = await import('../src/ssh2/filesystem-provider');
    const folder = { mountName: 'alias', hostName: 'alias', remoteRoot: '/', workspaceRoot: root.localPath };
    const uriPath = process.platform === 'win32' ? '/' + cwd.replaceAll('\\', '/') : cwd;
    assert.equal(workspacePathForRemote(folder, remote), uriPath);
    assert.equal(remotePathForUri(folder, uriPath + '/file.txt'), remote + '/file.txt');
  } finally { await rm(storage, { recursive: true, force: true }); }
});

test('existing legacy placeholders are no longer reused', async () => {
  const { legacyAgentCwdPath, agentCwdDirectoryName } = await import('../src/agent/agent-cwd');
  const storage = await mkdtemp(path.join(os.tmpdir(), 'safs-reuse-'));
  try {
    const oldRoot = legacyAgentCwdPath('/', storage, '192.0.2.1', 'user');
    const remote = '/home/share/user/folder1';
    const oldProject = path.join(oldRoot, ...remote.split('/').filter(Boolean));
    await mkdir(oldProject, { recursive: true });
    const root = await ensureAgentCwdPlaceholder('/', storage, 'alias', '192.0.2.1', 'user');
    assert.notEqual(root.localPath, oldRoot);

    assert.notEqual(await ensureAgentCwdSubdirectory(root.localPath, '/', remote), oldProject);
    await assert.rejects(lstat(path.join(storage, 'agent-cwd', agentCwdDirectoryName('192.0.2.1', 22, 'user', remote))), { code: 'ENOENT' });
    assert.equal((await ensureAgentCwdPlaceholder(remote, storage, 'otherAlias', '192.0.2.1', 'user')).localPath, await ensureAgentCwdSubdirectory(root.localPath, '/', remote));
  } finally { await rm(storage, { recursive: true, force: true }); }
});
