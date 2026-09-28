import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, readdir, copyFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { RemoteGit, GitRunner } from '../src/remote-git';
import { localGitRunner, validateFetchUrl } from '../src/local-git-push';
import { describeFetchFailure, fetchThroughLocalGit, pullThroughLocalGit, resolveFetchTarget, resolvePullTarget } from '../src/local-git-pull';

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
  // CI runner 没有全局 git 身份：远端仓库也显式配置，避免用例依赖宿主机 ~/.gitconfig。
  for (const [key, value] of [['user.name', 'Relay Test'], ['user.email', 'relay@example.test']]) {
    await exec('git', ['-C', source, 'config', key, value]);
  }
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

test('relay treats a remote branch ahead of upstream as up to date', async t => {
  const { upstream, source, storagePath, git, local } = await fixture(t);
  await writeFile(path.join(source, 'file.txt'), 'first\nlocal\n');
  await git.run(['add', '.']); await git.commit('local work');
  const target = { ...await resolvePullTarget(git), url: upstream };
  let downloads = 0;
  const result = await pullThroughLocalGit({
    storagePath, local, target,
    downloadBundle: async file => { downloads++; await git.run(['bundle', 'create', file, 'refs/heads/main']); },
    deliverBundle: async () => { throw new Error('远端更靠前时不应回传'); }
  });
  // 与 git pull --ff-only 一致：上游提交已经在远端分支里，什么都不做。
  assert.deepEqual(result, { status: 'up-to-date', oid: target.oid });
  assert.equal((await git.run(['rev-parse', 'refs/heads/main'])).trim(), target.oid);
  assert.equal(downloads, 1); // 判定需要远端对象，这一次下载无法省。
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
  // 远端自己的文件路径不能作为本地拉取地址，报错要带上读到的地址与来源。
  await git.run(['config', '--unset-all', 'remote.origin.url']);
  await git.run(['config', '--add', 'remote.origin.url', source]);
  await assert.rejects(resolvePullTarget(git),
    /本地中转需要[\s\S]*读到：[\s\S]*来源：远端 remote\.origin\.url/);
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

/** 复刻扩展在远端做的那几步（bundle 走本地文件，其余与 extension.ts 相同）。 */
async function runFetch(data: any, counts: { downloads?: () => void; deliveries?: () => void; refUpdates?: () => void } = {}) {
  const { root, upstream, storagePath, git, local } = data;
  const target = { ...await resolveFetchTarget(git), url: upstream };
  const result = await fetchThroughLocalGit({
    storagePath, local, target,
    downloadBundle: async file => {
      counts.downloads?.();
      await git.run(['bundle', 'create', file, target.tracking]);
    },
    deliverBundle: async (bundle, expected) => {
      counts.deliveries?.();
      const uploaded = path.join(root, 'fetched.bundle');
      await copyFile(bundle, uploaded);
      await git.run(['fetch', uploaded, `+refs/heads/safs-pull:${target.tracking}`]);
      assert.equal((await git.run(['rev-parse', '--verify', `${target.tracking}^{commit}`])).trim(), expected);
    },
    updateRef: async oid => {
      counts.refUpdates?.();
      await git.run(['update-ref', target.tracking, oid]);
      assert.equal((await git.run(['rev-parse', '--verify', `${target.tracking}^{commit}`])).trim(), oid);
    }
  });
  return { result, target };
}

test('relay fetch updates only the remote tracking ref', async t => {
  const data = await fixture(t);
  const { upstream, source, storagePath, advanceUpstream, git, local } = data;
  await advanceUpstream('first\nsecond\n');
  const tip = (await local(['-C', upstream, 'rev-parse', 'refs/heads/main'])).trim();
  const branch = (await git.run(['rev-parse', 'refs/heads/main'])).trim();
  const working = await readFile(path.join(source, 'file.txt'), 'utf8');
  const counts = { downloads: 0, deliveries: 0, refUpdates: 0 };
  const { result, target } = await runFetch(data, {
    downloads: () => counts.downloads++, deliveries: () => counts.deliveries++, refUpdates: () => counts.refUpdates++
  });
  assert.equal(target.tracking, 'refs/remotes/origin/main');
  assert.deepEqual(result, { status: 'fetched', oid: tip });
  assert.deepEqual(counts, { downloads: 1, deliveries: 1, refUpdates: 0 });
  assert.equal((await git.run(['rev-parse', 'refs/remotes/origin/main'])).trim(), tip);
  // 提取不动工作区、也不动当前分支。
  assert.equal((await git.run(['rev-parse', 'refs/heads/main'])).trim(), branch);
  assert.equal(await readFile(path.join(source, 'file.txt'), 'utf8'), working);
  assert.deepEqual(await readdir(storagePath), []);
  const again = await fetchThroughLocalGit({
    storagePath, local, target: { ...await resolveFetchTarget(git), url: upstream },
    downloadBundle: async () => { throw new Error('不应下载'); },
    deliverBundle: async () => { throw new Error('不应回传'); },
    updateRef: async () => { throw new Error('不应更新'); }
  });
  assert.deepEqual(again, { status: 'up-to-date', oid: tip });
  assert.deepEqual(await readdir(storagePath), []);
});

test('relay fetch creates a missing tracking ref with a full bundle', async t => {
  const data = await fixture(t);
  const { upstream, storagePath, advanceUpstream, git, local } = data;
  await advanceUpstream('first\nsecond\n');
  await git.run(['update-ref', '-d', 'refs/remotes/origin/main']);
  const tip = (await local(['-C', upstream, 'rev-parse', 'refs/heads/main'])).trim();
  const counts = { downloads: 0, deliveries: 0, refUpdates: 0 };
  const { result } = await runFetch(data, {
    downloads: () => counts.downloads++, deliveries: () => counts.deliveries++, refUpdates: () => counts.refUpdates++
  });
  assert.deepEqual(result, { status: 'fetched', oid: tip });
  // 远端没有跟踪 ref 时没有可用的前置提交，不发下载、直接全量包。
  assert.deepEqual(counts, { downloads: 0, deliveries: 1, refUpdates: 0 });
  assert.equal((await git.run(['rev-parse', 'refs/remotes/origin/main'])).trim(), tip);
  assert.deepEqual(await readdir(storagePath), []);
});

test('relay fetch tolerates a rewritten upstream', async t => {
  const data = await fixture(t);
  const { upstream, seed, storagePath, advanceUpstream, git, local } = data;
  await advanceUpstream('first\nsecond\n');
  await runFetch(data);
  await exec('git', ['-C', seed, 'reset', '--hard', 'HEAD~1']);
  await exec('git', ['-C', seed, 'push', '-q', '--force', 'origin', 'main']);
  const rewound = (await local(['-C', upstream, 'rev-parse', 'refs/heads/main'])).trim();
  const counts = { downloads: 0, deliveries: 0, refUpdates: 0 };
  const { result } = await runFetch(data, {
    downloads: () => counts.downloads++, deliveries: () => counts.deliveries++, refUpdates: () => counts.refUpdates++
  });
  assert.deepEqual(result, { status: 'fetched', oid: rewound });
  // 回退到远端已有的提交：没有对象要传，只更新跟踪 ref（bundle 不允许为空）。
  assert.deepEqual(counts, { downloads: 1, deliveries: 0, refUpdates: 1 });
  assert.equal((await git.run(['rev-parse', 'refs/remotes/origin/main'])).trim(), rewound);
  assert.deepEqual(await readdir(storagePath), []);
});
