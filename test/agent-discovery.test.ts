import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import {
  AgentWorkspacePublisher, agentDiscoveryDirectory, discoverAgentWorkspaces
} from '../src/agent-discovery';

test('publishes a private, versioned remote workspace record and removes it', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'safs-discovery-'));
  const directory = agentDiscoveryDirectory(home);
  const publisher = new AgentWorkspacePublisher('window-one', directory);
  await publisher.publish({
    focused: true,
    execution: 'remote',
    workspaceUri: 'safs://project/srv/project',
    mountName: 'project',
    workspaceRoot: '/srv/project',
    host: 'dev',
    mcpUrl: 'http://127.0.0.1:9848/mcp?token=secret'
  });
  const filePath = path.join(directory, 'window-one.json');
  const value = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(value.version, 1);
  assert.equal(value.instanceId, 'window-one');
  assert.equal(value.execution, 'remote');
  assert.equal(value.mountName, 'project');
  assert.equal(value.mcpServerName, undefined);
  assert.equal(typeof value.updatedAt, 'string');
  await publisher.remove();
  await assert.rejects(readFile(filePath, 'utf8'), { code: 'ENOENT' });
});

test('discovers fresh windows first and ignores stale records', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'safs-discovery-'));
  const directory = agentDiscoveryDirectory(home);
  const now = Date.now();
  const record = (instanceId: string, focused: boolean, updatedAtMs: number) => ({
    version: 1,
    instanceId,
    processId: 1,
    focused,
    execution: 'remote',
    workspaceUri: `safs://${instanceId}/srv/${instanceId}`,
    mountName: instanceId,
    workspaceRoot: `/srv/${instanceId}`,
    host: 'dev',
    mcpUrl: 'http://127.0.0.1:3000/mcp?token=secret',
    updatedAt: new Date(updatedAtMs).toISOString()
  });
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'background.json'), JSON.stringify(
    record('background', false, now)
  ));
  await writeFile(path.join(directory, 'focused.json'), JSON.stringify(
    record('focused', true, now - 1_000)
  ));
  await writeFile(path.join(directory, 'stale.json'), JSON.stringify(
    record('stale', true, now - 36_000)
  ));
  assert.deepEqual(
    discoverAgentWorkspaces([directory], now).map((item) => item.mountName),
    ['background', 'focused']
  );
});

test('ignores records whose updatedAt is in the future', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'safs-discovery-'));
  const directory = agentDiscoveryDirectory(home);
  const now = Date.now();
  const record = (instanceId: string, updatedAtMs: number) => ({
    version: 1,
    instanceId,
    processId: 1,
    focused: true,
    execution: 'remote',
    workspaceUri: `safs://${instanceId}/srv/${instanceId}`,
    mountName: instanceId,
    workspaceRoot: `/srv/${instanceId}`,
    host: 'dev',
    mcpUrl: 'http://127.0.0.1:3000/mcp?token=secret',
    updatedAt: new Date(updatedAtMs).toISOString()
  });
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'future.json'), JSON.stringify(
    record('future', now + 60_000)
  ));
  await writeFile(path.join(directory, 'fresh.json'), JSON.stringify(
    record('fresh', now - 1_000)
  ));
  assert.deepEqual(
    discoverAgentWorkspaces([directory], now).map((item) => item.mountName),
    ['fresh']
  );
});

test('stopping publication drains pending writes and blocks future heartbeats', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'safs-discovery-stop-'));
  const directory = agentDiscoveryDirectory(home);
  const publisher = new AgentWorkspacePublisher('closing-window', directory);
  const record = {
    focused: true, execution: 'remote' as const,
    workspaceUri: 'safs://project/srv/project', mountName: 'project',
    workspaceRoot: '/srv/project', host: 'dev', mcpUrl: 'http://127.0.0.1:9848/mcp'
  };
  await Promise.all([publisher.publish(record), publisher.stop(), publisher.publish(record)]);
  assert.deepEqual(discoverAgentWorkspaces([directory]), []);
  await assert.rejects(readFile(path.join(directory, 'closing-window.json')), { code: 'ENOENT' });
});

test('ignores a fresh record owned by a terminated process', async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', '']);
  const pid = child.pid!;
  await new Promise<void>(resolve => child.once('close', () => resolve()));
  const home = await mkdtemp(path.join(os.tmpdir(), 'safs-discovery-dead-'));
  const directory = agentDiscoveryDirectory(home);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'dead.json'), JSON.stringify({
    version: 1, instanceId: 'dead', processId: pid, focused: true, execution: 'remote',
    workspaceUri: 'safs://project/srv/project', mountName: 'project', workspaceRoot: '/srv/project',
    host: 'dev', mcpUrl: 'http://127.0.0.1:9848/mcp', updatedAt: new Date().toISOString()
  }));
  assert.deepEqual(discoverAgentWorkspaces([directory]), []);
});
