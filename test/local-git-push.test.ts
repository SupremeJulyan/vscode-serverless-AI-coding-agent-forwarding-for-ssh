import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { RemoteGit, GitRunner } from '../src/remote-git';
import { localGitRunner, pushThroughLocalGit, resolvePushTarget, validatePushUrl } from '../src/local-git-push';

const exec = promisify(execFile);
async function fixture(t: any) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'safs-relay-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'remote');
  const destination = path.join(root, 'upstream.git');
  const storagePath = path.join(root, 'cache');
  await exec('git', ['init', '-b', 'topic', source]);
  await exec('git', ['init', '--bare', destination]);
  for (const [key, value] of [['user.name', 'Relay Test'], ['user.email', 'relay@example.test']]) {
    await exec('git', ['-C', source, 'config', key, value]);
  }
  await writeFile(path.join(source, 'file.txt'), 'committed');
  await exec('git', ['-C', source, 'add', '.']);
  await exec('git', ['-C', source, 'commit', '-m', 'initial']);
  await exec('git', ['-C', source, 'remote', 'add', 'origin', 'https://example.test/project.git']);
  const runner: GitRunner = async command => {
    try { const result = await exec('/bin/sh', ['-c', command], { cwd: source }); return { ...result, exitCode: 0 }; }
    catch (error) { const result = error as any; return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr }; }
  };
  return { root, source, destination, storagePath, git: new RemoteGit(runner), local: localGitRunner() };
}

test('relay pushes exact committed history, leaves working changes behind, cleans up', async t => {
  const fixtureData = await fixture(t);
  const { source, destination, storagePath, git, local } = fixtureData;
  const target = await resolvePushTarget(git);
  assert.equal(target.destination, 'refs/heads/topic');
  await writeFile(path.join(source, 'file.txt'), 'uncommitted');
  await pushThroughLocalGit({ storagePath, local, target: { ...target, url: destination },
    downloadBundle: async file => { await git.run(['bundle', 'create', file, 'refs/heads/topic']); }
  });
  assert.equal((await local(['-C', destination, 'rev-parse', 'refs/heads/topic'])).trim(), target.oid);
  assert.equal(await local(['-C', destination, 'show', 'topic:file.txt']), 'committed');
  assert.equal((await git.status())[0].working, 'M');
  assert.deepEqual(await readdir(storagePath), []);
});

test('target uses upstream branch, pushRemote, push URL and explicit override', async t => {
  const { git } = await fixture(t);
  await git.run(['config', 'branch.topic.remote', 'origin']);
  await git.run(['config', 'branch.topic.merge', 'refs/heads/review']);
  await git.run(['config', 'remote.origin.pushurl', 'ssh://git@example.test/project.git']);
  assert.equal((await resolvePushTarget(git)).destination, 'refs/heads/review');
  assert.equal((await resolvePushTarget(git)).url, 'ssh://git@example.test/project.git');
  await git.run(['remote', 'add', 'fork', 'git@example.test:fork.git']);
  await git.run(['config', 'branch.topic.pushRemote', 'fork']);
  const fork = await resolvePushTarget(git);
  assert.equal(fork.destination, 'refs/heads/topic');
  assert.equal(fork.url, 'git@example.test:fork.git');
  assert.equal((await resolvePushTarget(git, 'https://local.example/project.git')).url, 'https://local.example/project.git');
  await git.run(['config', '--add', 'remote.fork.pushurl', 'ssh://git@example.test/one.git']);
  await git.run(['config', '--add', 'remote.fork.pushurl', 'ssh://git@example.test/two.git']);
  await assert.rejects(resolvePushTarget(git), /多个 push URL/);
});

test('relay rejects branch changes during transfer and cleans failed downloads', async t => {
  const { source, destination, storagePath, git, local } = await fixture(t);
  const target = { ...await resolvePushTarget(git), url: destination };
  await assert.rejects(pushThroughLocalGit({ storagePath, local, target, downloadBundle: async file => {
    await writeFile(path.join(source, 'file.txt'), 'new commit');
    await git.run(['add', '.']); await git.commit('changed');
    await git.run(['bundle', 'create', file, 'refs/heads/topic']);
  } }), /分支发生变化/);
  await assert.rejects(local(['-C', destination, 'rev-parse', '--verify', 'refs/heads/topic']));
  assert.deepEqual(await readdir(storagePath), []);
  await assert.rejects(pushThroughLocalGit({ storagePath, local, target, downloadBundle: async () => { throw new Error('SFTP failed'); } }), /SFTP failed/);
  assert.deepEqual(await readdir(storagePath), []);
});

test('relay never force pushes over divergent upstream history', async t => {
  const { source, destination, storagePath, git, local } = await fixture(t);
  const push = async () => pushThroughLocalGit({ storagePath, local, target: { ...await resolvePushTarget(git), url: destination },
    downloadBundle: async file => { await git.run(['bundle', 'create', file, 'refs/heads/topic']); } });
  await push();
  const first = (await git.run(['rev-parse', 'HEAD'])).trim();
  await writeFile(path.join(source, 'file.txt'), 'second'); await git.run(['add', '.']); await git.commit('second');
  await push();
  const upstream = (await git.run(['rev-parse', 'HEAD'])).trim();
  await git.run(['reset', '--hard', first]);
  await writeFile(path.join(source, 'file.txt'), 'divergent'); await git.run(['add', '.']); await git.commit('divergent');
  await assert.rejects(push(), /rejected|failed/);
  assert.equal((await local(['-C', destination, 'rev-parse', 'refs/heads/topic'])).trim(), upstream);
  assert.deepEqual(await readdir(storagePath), []);
});

test('local push destinations reject remote paths and executable helpers', () => {
  for (const url of ['/srv/repo', '../repo', 'file:///repo', 'C:/repo', 'ext::sh command', '--receive-pack=evil', 'https://host/repo\nother']) {
    assert.throws(() => validatePushUrl(url));
  }
  for (const url of ['https://host/repo', 'ssh://user@host:2222/repo', 'git@host:repo.git']) validatePushUrl(url);
});
