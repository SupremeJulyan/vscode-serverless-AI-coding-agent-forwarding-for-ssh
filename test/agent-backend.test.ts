import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { AgentBackendServer, AgentBackendCallbacks } from '../src/agent/agent-backend';
import { AgentHttpRouter, workspaceIdFor } from '../src/agent/agent-http-router';
import { ipcFetch } from '../src/agent/agent-ipc';
import { DiscoveredAgentWorkspace } from '../src/agent/agent-discovery';

test('CLI routes authenticated operations to the window IPC backend', async () => {
  let terminal = false;
  const folder = { name: 'demo', workspaceUri: 'safs://demo/root', workspaceRoot: '/root', host: 'demo' };
  const callbacks = {
    toolProfile: () => terminal ? 'terminal' : 'full',
    currentWorkspace: async () => folder,
    read: async (input: { path: string }) => ({ path: input.path, content: 'from remote' }),
    run: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    runTerminal: async () => ({ stdout: 'terminal', exitCode: 0 })
  } as AgentBackendCallbacks;
  const backend = new AgentBackendServer(0, randomUUID(), callbacks);
  await backend.start();
  const record = {
    ...folder, version: 1, instanceId: randomUUID(), processId: process.pid,
    execution: 'remote', mountName: 'demo', focused: true,
    backendUrl: backend.url, updatedAt: new Date().toISOString(),
    updatedAtMs: Date.now(), discoveryFile: ''
  } as DiscoveredAgentWorkspace;
  const router = new AgentHttpRouter(40000 + Math.floor(Math.random() * 20000), randomUUID(), {
    discover: () => [record]
  });
  try {
    await router.start();
    const url = new URL(router.url); url.pathname = '/cli';
    const response = await ipcFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'remote_read', arguments: { workspaceId: workspaceIdFor(record), path: 'file' } }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, result: { path: 'file', content: 'from remote' } });
    const unauthorized = new URL(backend.url); unauthorized.searchParams.delete('token');
    assert.equal((await ipcFetch(unauthorized, { method: 'POST' })).status, 401);
    const invalid = await ipcFetch(backend.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(invalid.status, 400);
    terminal = true;
    const denied = await ipcFetch(backend.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'remote_read', input: { path: 'file' } }) });
    assert.equal(denied.status, 403);
  } finally { await router.stop(); await backend.stop(); }
});
