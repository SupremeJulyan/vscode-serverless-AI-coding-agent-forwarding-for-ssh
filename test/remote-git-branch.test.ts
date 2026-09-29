import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { GitRunner, RemoteGit } from '../src/remote-git';
import { createBranch, listBranches, parseBranches, switchBranch } from '../src/remote-git-branch';

test('parses, filters and sorts local and already-fetched remote branches', async () => {
  const output = [
    'refs/remotes/origin/feature\0origin/feature\0 \0',
    'refs/heads/main\0main\0*\0',
    'refs/remotes/origin/HEAD\0origin/HEAD\0 \0',
    'refs/heads/dev\0dev\0 \0'
  ].join('\n') + '\n';
  assert.deepEqual(parseBranches(output), [
    { ref: 'refs/remotes/origin/feature', name: 'origin/feature', current: false, kind: 'remote', localName: 'feature' },
    { ref: 'refs/heads/main', name: 'main', current: true, kind: 'local' },
    { ref: 'refs/heads/dev', name: 'dev', current: false, kind: 'local' }
  ]);
  const git = new RemoteGit(async () => ({ exitCode: 0, stdout: output, stderr: '' }));
  assert.deepEqual((await listBranches(git)).map(branch => branch.name), ['main', 'dev', 'origin/feature']);
  assert.throws(() => parseBranches('refs/tags/v1\0v1\0 \0\n'));
  assert.throws(() => parseBranches('refs/heads/main\0main\0*\0extra\n'));
});

test('switches local branches without force or networking', async () => {
  const commands: string[] = [];
  const runner: GitRunner = async command => { commands.push(command); return { exitCode: 0, stdout: '', stderr: '' }; };
  await switchBranch(new RemoteGit(runner), {
    ref: 'refs/heads/feature', name: "feature' safe", current: false, kind: 'local'
  });
  assert.equal(commands.length, 1);
  assert.match(commands[0], /'switch' 'feature'"'"' safe'/);
  assert.doesNotMatch(commands[0], /--force|-f|fetch|pull/);
});

test('creates a tracking branch only when its local name is still absent', async () => {
  const commands: string[] = [];
  const runner: GitRunner = async command => {
    commands.push(command);
    return { exitCode: command.includes("'show-ref'") ? 1 : 0, stdout: '', stderr: '' };
  };
  await switchBranch(new RemoteGit(runner), {
    ref: 'refs/remotes/origin/topic', name: 'origin/topic', localName: 'topic', current: false, kind: 'remote'
  });
  assert.ok(commands.some(command => command.includes("'check-ref-format' '--branch' 'topic'")));
  assert.ok(commands.some(command => command.includes("'switch' '--track' '-c' 'topic' 'origin/topic'")));
  assert.ok(commands.every(command => !/fetch|pull/.test(command)));

  const existing = new RemoteGit(async command => ({
    exitCode: 0, stdout: command.includes("'show-ref'") ? 'a'.repeat(40) : '', stderr: ''
  }));
  await assert.rejects(switchBranch(existing, {
    ref: 'refs/remotes/origin/topic', name: 'origin/topic', localName: 'topic', current: false, kind: 'remote'
  }), /已存在/);
});

test('creates and switches to a validated local branch without networking or force', async () => {
  const commands: string[] = [];
  const git = new RemoteGit(async command => {
    commands.push(command);
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  await createBranch(git, 'feature/login');
  assert.ok(commands[0].includes("'check-ref-format' '--branch' 'feature/login'"));
  assert.ok(commands[1].includes("'switch' '-c' 'feature/login'"));
  assert.ok(commands.every(command => !/fetch|pull|--force/.test(command)));
  await assert.rejects(createBranch(git, ' feature'), /首尾空格/);
});
