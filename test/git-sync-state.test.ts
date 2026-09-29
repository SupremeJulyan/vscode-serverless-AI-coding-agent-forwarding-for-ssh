import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { RemoteGit } from '../src/remote-git';
import { readGitSyncState, syncStateLabel, trackingRef } from '../src/git-sync-state';
import { recordSuccessfulPush, resolvePushTarget } from '../src/local-git-push';
import { resolveFetchTarget, resolvePullTarget } from '../src/local-git-pull';
const exec = promisify(execFile);
async function fixture(t: any) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'safs-sync-state-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await exec('git', ['init', '-b', 'feature', cwd]);
  const git = new RemoteGit(async command => {
    try { return { ...await exec('/bin/sh', ['-c', command], { cwd }), exitCode: 0 }; }
    catch (error) { const value = error as any; return { stdout: value.stdout, stderr: value.stderr, exitCode: value.code }; }
  });
  await git.run(['config', 'user.name', 'Test']); await git.run(['config', 'user.email', 'test@example.test']);
  const commit = async (content: string) => {
    await writeFile(path.join(cwd, 'file'), content); await git.run(['add', '.']); await git.commit(content);
    return (await git.run(['rev-parse', 'HEAD'])).trim();
  };
  return { git, commit };
}

test('states distinguish unborn, untracked, missing upstream, ahead, behind, divergence and detached HEAD', async t => {
  const { git, commit } = await fixture(t);
  assert.equal((await readGitSyncState(git)).kind, 'unborn');
  const base = await commit('base');
  assert.equal((await readGitSyncState(git)).kind, 'no-upstream');
  await git.run(['remote', 'add', 'origin', 'https://example.test/repo.git']);
  await git.run(['config', 'branch.feature.remote', 'origin']);
  await git.run(['config', 'branch.feature.merge', 'refs/heads/trunk']);
  assert.equal((await readGitSyncState(git)).kind, 'missing-upstream');
  await git.run(['update-ref', 'refs/remotes/origin/trunk', base]);
  let state = await readGitSyncState(git);
  assert.equal(syncStateLabel(state), '已推送 · 与上游同步');
  const local = await commit('local');
  state = await readGitSyncState(git);
  assert.equal(state.ahead, 1); assert.equal(state.behind, 0);
  assert.match(syncStateLabel(state), /已提交待推送 ↑1/);
  const incoming = (await git.run(['commit-tree', `${base}^{tree}`, '-p', base, '-m', 'incoming'])).trim();
  await git.run(['update-ref', 'refs/remotes/origin/trunk', incoming]);
  state = await readGitSyncState(git);
  assert.equal(state.ahead, 1); assert.equal(state.behind, 1);
  assert.match(syncStateLabel(state), /待拉取 ↓1/);
  await git.run(['reset', '--hard', base]);
  state = await readGitSyncState(git);
  assert.equal(state.ahead, 0); assert.equal(state.behind, 1);
  await git.run(['checkout', '--detach', local]);
  assert.equal((await readGitSyncState(git)).kind, 'detached');
});

test('fetch/pull and successful push use the actual upstream name, and push receipts reject races', async t => {
  const { git, commit } = await fixture(t);
  const base = await commit('base');
  await git.run(['remote', 'add', 'origin', 'https://example.test/repo.git']);
  await git.run(['config', 'branch.feature.remote', 'origin']);
  await git.run(['config', 'branch.feature.merge', 'refs/heads/trunk']);
  await git.run(['update-ref', 'refs/remotes/origin/trunk', base]);
  await commit('outgoing');
  assert.equal((await resolvePullTarget(git)).tracking, 'refs/remotes/origin/trunk');
  assert.equal((await resolveFetchTarget(git)).tracking, 'refs/remotes/origin/trunk');
  const target = await resolvePushTarget(git);
  assert.equal(target.tracking, 'refs/remotes/origin/trunk');
  assert.equal((await readGitSyncState(git)).ahead, 1);
  await recordSuccessfulPush(git, target);
  assert.equal((await readGitSyncState(git)).ahead, 0);
  await commit('another');
  const racing = await resolvePushTarget(git);
  await git.run(['update-ref', target.tracking!, base]);
  await assert.rejects(recordSuccessfulPush(git, racing), /cannot lock ref/);
  assert.equal((await git.run(['rev-parse', target.tracking!])).trim(), base);
  const override = await resolvePushTarget(git, 'https://example.test/fork.git');
  assert.equal(override.tracking, undefined);
  await recordSuccessfulPush(git, override);
  assert.equal((await git.run(['rev-parse', target.tracking!])).trim(), base);
  await git.run(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/custom/*']);
  assert.equal(await trackingRef(git, 'feature'), 'refs/remotes/custom/trunk');
});

test('state errors never become a synchronized result', async () => {
  const git = new RemoteGit(async () => ({ exitCode: 255, stdout: '', stderr: 'SSH failed' }));
  await assert.rejects(readGitSyncState(git), /SSH failed/);
});
