import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rename, rm, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { gitCommand, isGitConflict, parseGitStatus, RemoteGit, GitRunner } from '../src/remote-git';

const exec = promisify(execFile);
async function fixture(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'safs-git-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await exec('git', ['init', '-q', cwd]);
  await exec('git', ['config', 'user.name', 'SAFS Test'], { cwd });
  await exec('git', ['config', 'user.email', 'safs@example.test'], { cwd });
  const runner: GitRunner = async command => {
    try {
      const result = await exec('/bin/sh', ['-c', command], { cwd });
      return { ...result, exitCode: 0 };
    } catch (error) {
      const result = error as { code: number; stdout: string; stderr: string };
      return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
    }
  };
  return { cwd, git: new RemoteGit(runner) };
}

test('porcelain parser preserves unusual paths, rename ordering and conflicts', () => {
  const changes = parseGitStatus('R  新名字\n.txt\0old name.txt\0 M :[abc]\0?? file\tname\0UU conflict\0');
  assert.deepEqual(changes[0], { index: 'R', working: ' ', path: '新名字\n.txt', originalPath: 'old name.txt' });
  assert.equal(changes[1].path, ':[abc]');
  assert.ok(isGitConflict(changes[3]));
  assert.throws(() => parseGitStatus('R  new\0'));
});

test('initial stage, unstage and commit preserve literal filenames and message', async t => {
  const { cwd, git } = await fixture(t);
  const filename = ":(glob)* ' $(touch INJECTED)\n中文.txt";
  await writeFile(path.join(cwd, filename), 'first\n');
  await writeFile(path.join(cwd, 'other.txt'), 'untouched');
  await git.stage((await git.status()).filter(c => c.path === filename));
  assert.equal((await git.status()).find(c => c.path === filename)?.index, 'A');
  await git.unstage((await git.status()).filter(c => c.index === 'A'));
  assert.equal(await readFile(path.join(cwd, filename), 'utf8'), 'first\n');
  assert.equal((await git.status()).find(c => c.path === filename)?.index, '?');
  await git.stage((await git.status()).filter(c => c.path === filename));
  const message = "first ' commit\n\n$(touch INJECTED)";
  await git.commit(message);
  assert.equal((await git.run(['log', '-1', '--format=%B'])).trim(), message);
  assert.deepEqual((await git.status()).map(c => c.path), ['other.txt']);
});

test('partial staging, rename, deletion and unstaging against HEAD', async t => {
  const { cwd, git } = await fixture(t);
  await writeFile(path.join(cwd, 'old.txt'), 'original\n');
  await git.stage(await git.status());
  await git.commit('initial');
  await writeFile(path.join(cwd, 'old.txt'), 'staged\n');
  await git.stage(await git.status());
  await writeFile(path.join(cwd, 'old.txt'), 'working\n');
  assert.deepEqual(await git.status(), [{ index: 'M', working: 'M', path: 'old.txt' }]);
  assert.equal(await git.run(['show', ':old.txt']), 'staged\n');
  await git.unstage(await git.status());
  assert.equal((await git.status())[0].index, ' ');
  await writeFile(path.join(cwd, 'old.txt'), 'original\n');
  await rename(path.join(cwd, 'old.txt'), path.join(cwd, 'new.txt'));
  await git.stage(await git.status());
  const renamed = await git.status();
  assert.equal(renamed[0].originalPath, 'old.txt');
  await git.unstage(renamed);
  assert.equal(await readFile(path.join(cwd, 'new.txt'), 'utf8'), 'original\n');
  await git.stage(await git.status());
  await git.commit('rename');
  await rm(path.join(cwd, 'new.txt'));
  await git.stage(await git.status());
  assert.equal((await git.status())[0].index, 'D');
  await git.unstage(await git.status());
  assert.equal((await git.status())[0].working, 'D');
});

test('discard restores tracked content from the index and removes selected untracked files', async t => {
  const { cwd, git } = await fixture(t);
  await writeFile(path.join(cwd, 'tracked.txt'), 'committed\n');
  await git.stage(await git.status());
  await git.commit('initial');
  await writeFile(path.join(cwd, 'tracked.txt'), 'staged\n');
  await git.stage(await git.status());
  await writeFile(path.join(cwd, 'tracked.txt'), 'working\n');
  await writeFile(path.join(cwd, 'untracked.txt'), 'remove me\n');
  const changes = await git.status();
  await git.discard(changes.filter(change => change.working !== ' '));
  assert.equal(await readFile(path.join(cwd, 'tracked.txt'), 'utf8'), 'staged\n');
  assert.deepEqual(await git.status(), [{ index: 'M', working: ' ', path: 'tracked.txt' }]);
});

test('failures and truncated output are rejected', async () => {
  await assert.rejects(new RemoteGit(async () => ({ exitCode: 0, stdout: ' M a\0', stderr: '', truncated: true })).status(), /capture limit/);
  await assert.rejects(new RemoteGit(async () => ({ exitCode: 128, stdout: '', stderr: 'SSH failed' })).status(), /SSH failed/);
  assert.match(gitCommand(['add', '--', "a'b"]), /--literal-pathspecs/);
});

test('unstage avoids a separate HEAD probe in an ordinary repository', async t => {
  const { cwd } = await fixture(t);
  await writeFile(path.join(cwd, 'tracked.txt'), 'initial\n');
  await exec('git', ['add', 'tracked.txt'], { cwd });
  await exec('git', ['commit', '-m', 'initial'], { cwd });
  await writeFile(path.join(cwd, 'tracked.txt'), 'changed\n');
  await exec('git', ['add', 'tracked.txt'], { cwd });
  const commands: string[] = [];
  const runner: GitRunner = async command => {
    commands.push(command);
    try {
      const result = await exec('/bin/sh', ['-c', command], { cwd });
      return { ...result, exitCode: 0 };
    } catch (error) {
      const result = error as { code: number; stdout: string; stderr: string };
      return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
    }
  };
  await new RemoteGit(runner).unstage([{ index: 'M', working: ' ', path: 'tracked.txt' }]);
  assert.equal(commands.length, 1);
  assert.match(commands[0], /'reset' 'HEAD'/);
});

test('batched metadata preserves NUL output and distinguishes missing configuration', async t => {
  const { cwd, git } = await fixture(t);
  await writeFile(path.join(cwd, 'untracked.txt'), 'test');
  const results = await git.batch([
    ['status', '--porcelain=v1', '-z'], ['config', '--get', 'safs.missing'], ['rev-parse', '--is-inside-work-tree']
  ]);
  assert.equal(results[0].stdout, '?? untracked.txt\0');
  assert.equal(results[1].exitCode, 1);
  assert.equal(results[2].stdout.trim(), 'true');
  await git.run(['config', 'safs.present', 'a value']);
  assert.deepEqual(await git.configMany(['safs.present', 'safs.missing']), ['a value', undefined]);
});
