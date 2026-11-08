import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { AgentBackendServer, AgentBackendCallbacks } from '../src/agent/agent-backend';
import { AgentIpcRouter, workspaceIdFor } from '../src/agent/agent-ipc-router';
import { ipcPath, ipcRequest } from '../src/agent/agent-ipc';
import { DiscoveredAgentWorkspace } from '../src/agent/agent-discovery';

test('CLI routes authenticated operations to the window IPC backend', async () => {
  let terminal = false;
  const token = randomUUID();
  const folder = { name: 'demo', workspaceUri: 'safs://demo/root', workspaceRoot: '/root', host: 'demo' };
  const callbacks = {
    toolProfile: () => terminal ? 'terminal' : 'full',
    currentWorkspace: async () => folder,
    read: async (input: { path: string }) => ({ path: input.path, content: 'from remote' }),
    run: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    runTerminal: async () => ({ stdout: 'terminal', exitCode: 0 })
  } as AgentBackendCallbacks;
  const backend = new AgentBackendServer(token, callbacks);
  await backend.start();
  const record = {
    ...folder, version: 2, instanceId: randomUUID(), processId: process.pid,
    execution: 'remote', mountName: 'demo', focused: true,
    backendSocketPath: backend.socketPath, backendToken: token, updatedAt: new Date().toISOString(),
    updatedAtMs: Date.now(), discoveryFile: ''
  } as DiscoveredAgentWorkspace;
  const routerToken = randomUUID();
  const router = new AgentIpcRouter(ipcPath('router-test-' + randomUUID()), routerToken, { discover: () => [record] });
  try {
    await router.start();
    const response = await ipcRequest<any>(router.socketPath, routerToken, 'cli', {
      name: 'remote_read', arguments: { workspaceId: workspaceIdFor(record), path: 'file' }
    });
    assert.deepEqual(response, { ok: true, result: { path: 'file', content: 'from remote' } });
    await assert.rejects(ipcRequest(backend.socketPath, 'wrong-token', 'operation', {}));
    await assert.rejects(ipcRequest(backend.socketPath, token, 'operation', {}));
    terminal = true;
    await assert.rejects(ipcRequest(backend.socketPath, token, 'operation', {
      operation: 'remote_read', input: { path: 'file' }
    }));
  } finally { await router.stop(); await backend.stop(); }
});
