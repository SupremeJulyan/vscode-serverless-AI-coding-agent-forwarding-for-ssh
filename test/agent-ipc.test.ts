import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createIpcServer, ipcPath, ipcRequest, listenIpc } from '../src/agent/agent-ipc';

import { writeWorkspaceId, resolveWorkspaceId } from '../src/agent/workspace-id';

const exec = promisify(execFile);
test('CLI uses native IPC and resolves placeholder cwd and explicit IDs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safs-cli-ipc-'));
  const socket = ipcPath(root);
  const seen: any[] = [];
  let workspaces = [{ workspaceId: 'auto', localRoot: root }];
  const server = createIpcServer(({ action, payload }) => {
    assert.equal(action, 'cli');
    const input = (payload as { value: any }).value;
    seen.push(input);
    return { result: input.name === 'list_remote_workspaces' ? { workspaces }
      : { workspaceId: input.arguments?.workspaceId, outputId: input.arguments?.outputId } };
  });
  try {
    await listenIpc(server, socket);
    const config = join(root, 'connection.json');
    await writeFile(config, JSON.stringify({ version: 2, socketPath: socket, token: 'test' }));
    const cli = resolve('dist/safs-cli.js');
    const child = join(root, 'sub'); await mkdir(child);
    const run = (args: string[], cwd = child) => exec(process.execPath, [cli, '--config', config, ...args], { cwd });
    await assert.rejects(run(['list']), /No \.awm\/workspace\.json/);
    await writeWorkspaceId(root, 'auto');
    const requestsBeforeMissingMarker = seen.length;
    await assert.rejects(run(['list']), /No \.awm\/workspace\.json/);
    assert.equal(seen.length, requestsBeforeMissingMarker);
    const marker = join(child, '.awm/workspace.json');
    await writeWorkspaceId(child, 'auto');
    assert.equal(JSON.parse((await run(['list'])).stdout).workspaceId, 'auto');
    await writeWorkspaceId(child, 'expired');
    assert.equal(JSON.parse((await run(['list'])).stdout).workspaceId, 'auto');
    assert.equal(JSON.parse(await readFile(marker, 'utf8')).workspaceId, 'auto');
    await writeWorkspaceId(child, 'expired');
    workspaces = [{ workspaceId: 'auto', localRoot: root }, { workspaceId: 'second', localRoot: root }];
    await assert.rejects(run(['list']), /multiple placeholder workspaces match/);
    await writeWorkspaceId(child, 'second');
    assert.equal(JSON.parse((await run(['list'])).stdout).workspaceId, 'second');
    await writeWorkspaceId(child, 'expired');
    assert.equal(JSON.parse(await readFile(marker, 'utf8')).workspaceId, 'expired');
    workspaces = [];
    await assert.rejects(run(['list']), /no active placeholder workspace matches/);
    assert.equal(JSON.parse((await run(['list', '--id', 'explicit'])).stdout).workspaceId, 'explicit');
    assert.equal(JSON.parse(await readFile(marker, 'utf8')).workspaceId, 'expired');
    await rm(marker);
    assert.equal(JSON.parse((await run(['list', '--id', 'second'])).stdout).workspaceId, 'second');
    workspaces = [{ workspaceId: 'auto', localRoot: root }];
    assert.equal(JSON.parse((await run(['workspaces'])).stdout).workspaces[0].workspaceId, 'auto');
    assert.equal(JSON.parse((await run(['output', 'stream-id', 'stdout', '--id', 'explicit'])).stdout).outputId, 'stream-id');
    await assert.rejects(run(['list', '--workspace', 'old']));
    await assert.rejects(run(['list'], tmpdir()));
    assert.ok(seen.some(v => v.name === 'remote_list'));
    assert.equal((await ipcRequest<any>(socket, 'test', 'cli', { name: 'list_remote_workspaces', arguments: {} })).result.workspaces.length, 1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('IPC requests require the matching local capability token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safs-ipc-auth-'));
  const socket = ipcPath(root);
  const server = createIpcServer(({ action, payload }) => {
    if ((payload as { token: string }).token !== 'secret') throw new Error('Unauthorized');
    return { action };
  });
  try {
    await listenIpc(server, socket);
    assert.equal((await ipcRequest<any>(socket, 'secret', 'probe')).action, 'probe');
    await assert.rejects(ipcRequest(socket, 'wrong', 'probe'));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});


test('expired workspace binding matches canonical directories through a local alias', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safs-canonical-binding-'));
  try {
    const actual = join(root, 'actual');
    const alias = join(root, 'alias');
    await mkdir(actual);
    await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await writeWorkspaceId(actual, 'expired');
    const id = await resolveWorkspaceId(actual, async () => [{ workspaceId: 'active', localRoot: alias }]);
    assert.equal(id, 'active');
    assert.equal(JSON.parse(await readFile(join(actual, '.awm', 'workspace.json'), 'utf8')).workspaceId, 'active');
  } finally { await rm(root, { recursive: true, force: true }); }
});
