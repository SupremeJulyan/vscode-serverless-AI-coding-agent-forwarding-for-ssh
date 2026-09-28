import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, readdir, copyFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { RemoteGit, GitRunner } from '../src/remote-git';
import { localGitRunner, validateFetchUrl } from '../src/local-git-push';
import { describeFetchFailure, pullThroughLocalGit, resolvePullTarget } from '../src/local-git-pull';

const exec = promisify(execFile);

async function fixture(t: any) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'safs-pull-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = path.join(root, 'upstream.git');
  const seed = path.join(root, 'seed');
  const source = path.join(root, 'remote');
  const storagePath = path.join(root, 'cache');
  await exec('git', ['init', '--bare', '-b', 'main', upstream]);
  await exec('git', ['clone', '-q', upstream, seed]);
  for (const [key, value] of [['user.name', 'Relay Test'], ['user.email', 'relay@example.test']]) {
    await exec('git', ['-C', seed, 'config', key, value]);
  }
  await writeFile(path.join(seed, 'file.txt'), 'first\n');
  await exec('git', ['-C', seed, 'add', '.']);
  await exec('git', ['-C', seed, 'commit', '-m', 'first']);
  await exec('git', ['-C', seed, 'push', '-q', 'origin', 'main']);
  // 远端从上游克隆后即与上游断网：URL 换成网络地址，本地中转才允许使用。
  await exec('git', ['clone', '-q', upstream, source]);
  await exec('git', ['-C', source, 'remote', 'set-url', 'origin', 'https://example.test/project.git']);
  const runner: GitRunner = async command => {
    try { const result = await exec('/bin/sh', ['-c', command], { cwd: source }); return { ...result, exitCode: 0 }; }
    catch (error) { const result = error as any; return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr }; }
  };
  const advanceUpstream = async (content: string) => {
    await writeFile(path.join(seed, 'file.txt'), content);
    await exec('git', ['-C', seed, 'commit', '-qam', content.trim()]);
    await exec('git', ['-C', seed, 'push', '-q', 'origin', 'main']);
  };
  return { root, upstream, seed, source, storagePath, advanceUpstream, git: new RemoteGit(runner), local: localGitRunner() };
}

test('relay pulls the upstream branch into the remote without touching upstream', async t => {
  const { root, upstream, source, storagePath, advanceUpstream, git, local } = await fixture(t);
  await advanceUpstream('first\nsecond\n');
  const expected = (await local(['-C', upstream, 'rev-parse', 'refs/heads/main'])).trim();
  const target = { ...await resolvePullTarget(git), url: upstream };
  let downloads = 0;
  const result = await pullThroughLocalGit({
    storagePath, local, target,
    downloadBundle: async file => { downloads++; await git.run(['bundle', 'create', file, 'refs/heads/main']); },
    deliverBundle: async (bundle, oid) => {
      const uploaded = path.join(root, 'uploaded.bundle');
      await copyFile(bundle, uploaded);
      await git.run(['fetch', uploaded, '+refs/heads/safs-pull:refs/remotes/origin/main']);
      await git.run(['merge', '--ff-only', 'refs/remotes/origin/main']);
      assert.equal((await git.run(['rev-parse', '--verify', 'refs/heads/main^{commit}'])).trim(), oid);
    }
  });
  assert.deepEqual(result, { status: 'merged', oid: expected });
  assert.equal((await git.run(['rev-parse', 'refs/heads/main'])).trim(), expected);
  assert.equal(await readFile(path.join(source, 'file.txt'), 'utf8'), 'first\nsecond\n');
  assert.equal((await local(['-C', upstream, 'rev-parse', 'refs/heads/main'])).trim(), expected);
  assert.deepEqual(await readdir(storagePath), []);
  // 已经是最新时不下载远端 bundle，也不再合并。
  const again = await pullThroughLocalGit({
    storagePath, local, target: { ...await resolvePullTarget(git), url: upstream },
    downloadBundle: async () => { downloads++; throw new Error('不应下载'); },
    deliverBundle: async () => { throw new Error('不应回传'); }
  });
  assert.deepEqual(again, { status: 'up-to-date', oid: expected });
  assert.equal(downloads, 1);
  assert.deepEqual(await readdir(storagePath), []);
});

test('relay refuses to merge diverged history and leaves the remote branch alone', async t => {
  const { upstream, source, storagePath, advanceUpstream, git, local } = await fixture(t);
  await advanceUpstream('first\nupstream\n');
  const upstreamTip = (await local(['-C', upstream, 'rev-parse', 'refs/heads/main'])).trim();
  await writeFile(path.join(source, 'file.txt'), 'first\nlocal\n');
  await git.run(['add', '.']); await git.commit('local work');
  const localCommit = (await git.run(['rev-parse', 'refs/heads/main'])).trim();
  const target = { ...await resolvePullTarget(git), url: upstream };
  await assert.rejects(pullThroughLocalGit({
    storagePath, local, target,
    downloadBundle: async file => { await git.run(['bundle', 'create', file, 'refs/heads/main']); },
    deliverBundle: async () => { throw new Error('分叉时不应回传'); }
  }), /分叉/);
  assert.equal((await git.run(['rev-parse', 'refs/heads/main'])).trim(), localCommit);
  assert.notEqual(localCommit, upstreamTip);
  assert.deepEqual(await readdir(storagePath), []);
});

test('relay cleans up when the download fails and never force merges', async t => {
  const { upstream, storagePath, advanceUpstream, git, local } = await fixture(t);
  await advanceUpstream('first\nsecond\n');
  const target = { ...await resolvePullTarget(git), url: upstream };
  await assert.rejects(pullThroughLocalGit({
    storagePath, local, target,
    downloadBundle: async () => { throw new Error('SFTP failed'); },
    deliverBundle: async () => { throw new Error('不应回传'); }
  }), /SFTP failed/);
  assert.deepEqual(await readdir(storagePath), []);
  await assert.rejects(pullThroughLocalGit({
    storagePath, local, target: { ...target, url: upstream },
    downloadBundle: async file => { await git.run(['bundle', 'create', file, 'refs/heads/main']); },
    deliverBundle: async () => { throw new Error('网络中断'); }
  }), /网络中断/);
  assert.deepEqual(await readdir(storagePath), []);
});

test('pull target needs an upstream branch and a single network fetch URL', async t => {
  const { source, git } = await fixture(t);
  await git.run(['config', 'branch.main.merge', 'refs/heads/review']);
  const target = await resolvePullTarget(git);
  assert.equal(target.upstream, 'refs/heads/review');
  assert.equal(target.remote, 'origin');
  assert.equal(target.url, 'https://example.test/project.git');
  await git.run(['config', '--unset', 'branch.main.merge']);
  await assert.rejects(resolvePullTarget(git), /没有上游分支/);
  await git.run(['config', 'branch.main.merge', 'refs/heads/main']);
  await git.run(['remote', 'set-url', '--add', 'origin', 'ssh://git@example.test/two.git']);
  await assert.rejects(resolvePullTarget(git), /多个 fetch URL/);
  // 远端自己的文件路径不能作为本地拉取地址。
  await git.run(['config', '--unset-all', 'remote.origin.url']);
  await git.run(['config', '--add', 'remote.origin.url', source]);
  await assert.rejects(resolvePullTarget(git), /本地中转需要/);
});

test('fetch failures name the local credential problem', () => {
  const raw = "fatal: could not read Username for 'https://github.com/owner/repo.git': terminal prompts disabled";
  const described = describeFetchFailure('https://github.com/owner/repo.git', raw);
  assert.match(described, /credential helper/);
  assert.match(described, /credential helper[\s\S]*terminal prompts disabled/);
  assert.equal(describeFetchFailure('https://example.test/project.git', 'network unreachable'), 'network unreachable');
  for (const url of ['/srv/repo', '../repo', 'file:///repo', 'C:/repo', '--upload-pack=evil', 'https://host/repo\nother']) {
    assert.throws(() => validateFetchUrl(url));
  }
  for (const url of ['https://host/repo', 'ssh://user@host:2222/repo', 'git@host:repo.git']) validateFetchUrl(url);
});
