import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { RemoteGit, GitRunner } from '../src/remote-git';
import { createRemoteGitBundle } from '../src/remote-git-bundle';
import {
  declareShallowBoundaries, describeShallowPushFailure, localGitRunner, pushThroughLocalGit,
  resolveShallowBoundaries, resolvePushTarget, validatePushUrl
} from '../src/local-git-push';

import { execGitFixture as exec } from './git-fixture-exec';

function shellRunner(cwd: string): GitRunner {
  return async command => {
    try { const result = await exec('/bin/sh', ['-c', command], { cwd }); return { ...result, exitCode: 0 }; }
    catch (error) { const result = error as any; return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr }; }
  };
}

async function identity(repository: string): Promise<void> {
  for (const [key, value] of [['user.name', 'Relay Test'], ['user.email', 'relay@example.test']]) {
    await exec('git', ['-C', repository, 'config', key, value]);
  }
}

async function fixture(t: any) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'safs-relay-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'remote');
  const destination = path.join(root, 'upstream.git');
  const storagePath = path.join(root, 'cache');
  await exec('git', ['init', '-b', 'topic', source]);
  await exec('git', ['init', '--bare', destination]);
  await identity(source);
  await writeFile(path.join(source, 'file.txt'), 'committed');
  await exec('git', ['-C', source, 'add', '.']);
  await exec('git', ['-C', source, 'commit', '-m', 'initial']);
  await exec('git', ['-C', source, 'remote', 'add', 'origin', 'https://example.test/project.git']);
  return { root, source, destination, storagePath, git: new RemoteGit(shellRunner(source)), local: localGitRunner() };
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
  // 报错要能看出读到的到底是什么：地址原样回显、控制字符转义、凭据脱敏。
  assert.throws(() => validatePushUrl('/srv/repo'), /读到：\/srv\/repo/);
  assert.throws(() => validatePushUrl('https://user:secret@host/repo\n'),
    /https:\/\/user:<hidden>@host\/repo\\x0a/);
});

test('complete repositories report no shallow boundaries', async t => {
  const { git } = await fixture(t);
  assert.deepEqual(await resolveShallowBoundaries(git, 'refs/heads/topic'), []);
  await assert.rejects(declareShallowBoundaries(path.join(os.tmpdir(), 'safs-unused-relay'), ['not-a-commit-id']),
    /Invalid Git commit ID/);
  // 边界说明只跟着浅克隆出现，别的失败原因（比如凭据）不该被安上这个尾巴。
  const boundary = '81ef4c4c566722a20d4c9586020fa8ab39f1049b';
  assert.match(describeShallowPushFailure([boundary], 'shallow update not allowed'), /git fetch --unshallow/);
  assert.equal(describeShallowPushFailure([boundary], 'Authentication failed'), 'Authentication failed');
  assert.equal(describeShallowPushFailure([], 'shallow update not allowed'), 'shallow update not allowed');
});

test('shallow remote pushes by declaring the same boundary in the relay', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'safs-shallow-push-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = path.join(root, 'upstream.git');
  const seed = path.join(root, 'seed');
  const source = path.join(root, 'remote');
  const storagePath = path.join(root, 'cache');
  await exec('git', ['init', '-q', '--bare', '-b', 'topic', upstream]);
  await exec('git', ['clone', '-q', upstream, seed]);
  await identity(seed);
  await writeFile(path.join(seed, 'file.txt'), 'upstream\n');
  await exec('git', ['-C', seed, 'add', '.']);
  await exec('git', ['-C', seed, 'commit', '-qm', 'upstream']);
  await writeFile(path.join(seed, 'file.txt'), 'upstream again\n');
  await exec('git', ['-C', seed, 'commit', '-qam', 'upstream again']);
  await exec('git', ['-C', seed, 'push', '-q', 'origin', 'topic']);
  // 远端是浅克隆：对象库里只有边界提交往上的历史，边界提交的父对象根本没有。
  await exec('git', ['clone', '-q', '--depth', '1', pathToFileURL(upstream).href, source]);
  await identity(source);
  await writeFile(path.join(source, 'local.txt'), 'local\n');
  await exec('git', ['-C', source, 'add', '.']);
  await exec('git', ['-C', source, 'commit', '-qm', 'local']);
  await exec('git', ['-C', source, 'remote', 'set-url', 'origin', 'https://example.test/project.git']);

  const git = new RemoteGit(shellRunner(source));
  const local = localGitRunner();
  const target = { ...await resolvePushTarget(git), url: upstream };
  const shallowBoundaries = await resolveShallowBoundaries(git, 'refs/heads/topic');
  assert.equal(shallowBoundaries.length, 1);
  assert.equal(shallowBoundaries[0], (await exec('git', ['-C', source, 'rev-parse', 'HEAD^'])).stdout.trim());
  const downloadBundle = async (file: string) => { await git.run(['bundle', 'create', file, 'refs/heads/topic']); };

  // 不声明边界，bundle 里缺的正是边界提交的父对象：导入以这条报错失败（用户看到的那条）。
  await assert.rejects(pushThroughLocalGit({ storagePath, local, target, downloadBundle }),
    /necessary objects|Could not read/);
  assert.deepEqual(await readdir(storagePath), []);

  await pushThroughLocalGit({ storagePath, local, target, downloadBundle, shallowBoundaries });
  assert.equal((await local(['-C', upstream, 'rev-parse', 'refs/heads/topic'])).trim(), target.oid);
  // 对端拿到的是完整历史：浅边界只存在于中转仓库，推送后上游照旧是完整仓库。
  assert.equal(await local(['-C', upstream, 'show', 'topic:local.txt']), 'local\n');
  assert.equal((await local(['-C', upstream, 'rev-list', '--count', 'refs/heads/topic'])).trim(), '3');
  assert.equal((await local(['-C', upstream, 'rev-parse', '--is-shallow-repository'])).trim(), 'false');
  await exec('git', ['-C', upstream, 'fsck', '--no-dangling']);
  assert.deepEqual(await readdir(storagePath), []);
});

test('shallow relay explains a target that lacks the truncated history', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'safs-shallow-reject-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = path.join(root, 'upstream.git');
  const fork = path.join(root, 'fork.git');
  const seed = path.join(root, 'seed');
  const source = path.join(root, 'remote');
  const storagePath = path.join(root, 'cache');
  await exec('git', ['init', '-q', '--bare', '-b', 'topic', fork]);
  await exec('git', ['clone', '-q', fork, seed]);
  await identity(seed);
  await writeFile(path.join(seed, 'file.txt'), 'one\n');
  await exec('git', ['-C', seed, 'add', '.']);
  await exec('git', ['-C', seed, 'commit', '-qm', 'one']);
  await exec('git', ['-C', seed, 'push', '-q', 'origin', 'topic']);
  await exec('git', ['clone', '-q', '--depth', '1', pathToFileURL(fork).href, source]);
  await identity(source);
  await writeFile(path.join(source, 'local.txt'), 'local\n');
  await exec('git', ['-C', source, 'add', '.']);
  await exec('git', ['-C', source, 'commit', '-qm', 'local']);
  await exec('git', ['-C', source, 'remote', 'set-url', 'origin', 'https://example.test/project.git']);
  // 目标仓库只有一条无关的历史：浅边界之前的对象谁都没有，推送只能被拒。
  await exec('git', ['init', '-q', '--bare', '-b', 'topic', upstream]);
  const other = path.join(root, 'other');
  await exec('git', ['init', '-q', '-b', 'topic', other]);
  await identity(other);
  await writeFile(path.join(other, 'other.txt'), 'other\n');
  await exec('git', ['-C', other, 'add', '.']);
  await exec('git', ['-C', other, 'commit', '-qm', 'other']);
  await exec('git', ['-C', other, 'push', '-q', upstream, 'topic']);
  const unchanged = (await exec('git', ['-C', upstream, 'rev-parse', 'refs/heads/topic'])).stdout.trim();

  const git = new RemoteGit(shellRunner(source));
  const local = localGitRunner();
  const target = { ...await resolvePushTarget(git), url: upstream };
  const shallowBoundaries = await resolveShallowBoundaries(git, 'refs/heads/topic');
  assert.equal(shallowBoundaries.length, 1);
  await assert.rejects(pushThroughLocalGit({ storagePath, local, target, shallowBoundaries,
    downloadBundle: async file => { await git.run(['bundle', 'create', file, 'refs/heads/topic']); }
  }), /git fetch --unshallow/);
  assert.equal((await local(['-C', upstream, 'rev-parse', 'refs/heads/topic'])).trim(), unchanged);
  assert.deepEqual(await readdir(storagePath), []);
});

test('cached pushes reuse objects, verify remote refs, and keep operation refs isolated', async t => {
  const { destination, storagePath, git, local } = await fixture(t);
  const target = { ...await resolvePushTarget(git), url: destination };
  let downloads = 0, verifications = 0;
  const options = {
    storagePath, target, local,
    verifyRemote: async () => {
      verifications++;
      assert.equal((await git.run(['rev-parse', 'HEAD'])).trim(), target.oid);
    },
    downloadBundle: async (file: string) => {
      downloads++;
      await git.run(['bundle', 'create', file, 'refs/heads/topic']);
    }
  };
  await pushThroughLocalGit(options);
  await Promise.all([pushThroughLocalGit(options), pushThroughLocalGit(options)]);
  assert.equal(downloads, 1);
  assert.equal(verifications, 2);
  assert.deepEqual(await readdir(storagePath), []);
  await assert.rejects(pushThroughLocalGit({ ...options,
    verifyRemote: async () => { throw new Error('remote changed'); }
  }), /remote changed/);
});


test('repeat push transfers an incremental bundle with validated shared prerequisites', async t => {
  const { destination, storagePath, git, local, source } = await fixture(t);
  const { randomBytes } = await import('node:crypto');
  const { stat } = await import('node:fs/promises');
  await writeFile(path.join(source, 'large.bin'), randomBytes(512 * 1024));
  await git.run(['add', '.']); await git.commit('large baseline');
  const sizes: number[] = [];
  let prerequisites: string[] = [];
  const push = async () => {
    const target = { ...await resolvePushTarget(git), url: destination };
    await pushThroughLocalGit({ storagePath, local, target,
      verifyRemote: async () => {
        assert.equal((await git.run(['rev-parse', 'HEAD'])).trim(), target.oid);
      },
      downloadBundle: async (file, exclusions = []) => {
        prerequisites = exclusions;
        await createRemoteGitBundle(git, file, 'refs/heads/topic', exclusions);
        sizes.push((await stat(file)).size);
      }
    });
    assert.equal((await local(['-C', destination, 'rev-parse', 'topic'])).trim(), target.oid);
  };
  await push();
  await writeFile(path.join(source, 'file.txt'), 'small change');
  await git.run(['add', '.']); await git.commit('incremental');
  await push();
  assert.ok(prerequisites.length > 0);
  assert.equal(sizes.length, 2);
  assert.ok(sizes[1] < sizes[0] / 10, `bundle sizes: ${sizes}`);
  // A valid but absent prerequisite must fall back to a full bundle.
  const fallback = path.join(source, 'fallback.bundle');
  await createRemoteGitBundle(git, fallback, 'refs/heads/topic', ['0'.repeat(40)]);
  assert.ok((await stat(fallback)).size > sizes[1]);
});
