import assert from 'node:assert/strict';
import test from 'node:test';
import * as http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ipcPath, ipcUrl, listenIpc, ipcFetch } from '../src/agent/agent-ipc';

const exec = promisify(execFile);
test('CLI uses IPC and resolves placeholder cwd, explicit IDs and retained output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safs-cli-ipc-'));
  const socket = ipcPath(root);
  const seen: any[] = [];
  let workspaces = [{ workspaceId: 'auto', localRoot: root }];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body || '{}');
    seen.push(input);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ result: input.name === 'list_remote_workspaces'
      ? { workspaces }
      : { workspaceId: input.arguments?.workspaceId, outputId: input.arguments?.outputId } }));
  });
  try {
    await listenIpc(server, socket);
    assert.equal(typeof server.address(), 'string');
    const config = join(root, 'connection.json');
    await writeFile(config, JSON.stringify({ version: 1, url: ipcUrl(socket) + '&token=test' }));
    const cli = resolve('dist/safs-cli.js');
    const child = join(root, 'sub');
    await mkdir(child);
    const run = (args: string[], cwd = child) => exec(process.execPath, [cli, '--config', config, ...args], { cwd });
    await assert.rejects(run(['list']), /No .safs-workspace-id/);
    const parentMarker = join(root, '.safs-workspace-id');
    await writeFile(parentMarker, 'auto\n');
    const requestsBeforeMissingMarker = seen.length;
    await assert.rejects(run(['list']), /No .safs-workspace-id/);
    assert.equal(seen.length, requestsBeforeMissingMarker);
    const marker = join(child, '.safs-workspace-id');
    await writeFile(marker, 'auto\n');
    assert.equal(JSON.parse((await run(['list'])).stdout).workspaceId, 'auto');
    await writeFile(marker, 'expired\n');
    assert.equal(JSON.parse((await run(['list'])).stdout).workspaceId, 'auto');
    assert.equal(await readFile(marker, 'utf8'), 'auto\n');
    await writeFile(marker, 'expired\n');
    workspaces = [{ workspaceId: 'auto', localRoot: root }, { workspaceId: 'second', localRoot: root }];
    await assert.rejects(run(['list']), /multiple placeholder workspaces match/);
    await writeFile(marker, 'second\n');
    assert.equal(JSON.parse((await run(['list'])).stdout).workspaceId, 'second');
    await writeFile(marker, 'expired\n');
    assert.equal(await readFile(marker, 'utf8'), 'expired\n');
    workspaces = [];
    await assert.rejects(run(['list']), /no active placeholder workspace matches/);

    assert.equal(JSON.parse((await run(['list', '--id', 'explicit'])).stdout).workspaceId, 'explicit');
    assert.equal(await readFile(marker, 'utf8'), 'expired\n');
    await rm(marker);
    assert.equal(JSON.parse((await run(['list', '--id', 'second'])).stdout).workspaceId, 'second');
    workspaces = [{ workspaceId: 'auto', localRoot: root }];
    const listed = JSON.parse((await run(['workspaces'])).stdout);
    assert.equal(listed.workspaces[0].workspaceId, 'auto');

    const output = JSON.parse((await run(['output', 'stream-id', 'stdout', '--id', 'explicit'])).stdout);
    assert.equal(output.outputId, 'stream-id');
    await assert.rejects(run(['list', '--workspace', 'old']));
    await assert.rejects(run(['list'], tmpdir()));
    assert.ok(seen.some(v => v.name === 'remote_list'));
    const response = await ipcFetch(ipcUrl(socket));
    assert.equal(response.status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('IPC fetch preserves JSON response headers and payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safs-ipc-sse-'));
  const socket = ipcPath(root);
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'x-safs-diagnostic': 'present' });
    response.end('{"ok":true,"result":{"entries":[]}}');
  });
  try {
    await listenIpc(server, socket);
    const response = await ipcFetch(ipcUrl(socket));
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal(response.headers.get('x-safs-diagnostic'), 'present');
    assert.deepEqual(await response.json(), { ok: true, result: { entries: [] } });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
