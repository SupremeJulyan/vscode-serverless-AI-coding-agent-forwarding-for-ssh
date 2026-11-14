import assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile, utimes, rm } from 'node:fs/promises';
import * as os from 'node:os';
import {
  AgentWorkspacePublisher, agentDiscoveryDirectory, discoverAgentWorkspaces, cleanupAgentWorkspaceRecords
} from '../src/agent/agent-discovery';

test('discovery records use agent_discovery rather than remote workspace placeholders', () => {
  assert.equal(agentDiscoveryDirectory('/example'), path.join('/example', '.safs', 'agent_discovery'));
});

test('cleanup removes abandoned records and partial writes, preserving live and fresh files', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safs-discovery-cleanup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const now = Date.now();
  const old = new Date(now - 600_000);
  const record = (pid: number) => JSON.stringify({
    processId: pid, processPlatform: process.platform, updatedAt: old.toISOString()
  });
  const files = {
    'dead.json': record(2147483647),
    'live.json': record(process.pid),
    'partial.json.tmp': '{',
    'fresh.json': record(2147483647),
    'foreign.json': JSON.stringify({ processPlatform: process.platform === 'win32' ? 'linux' : 'win32' }),
    'recent-heartbeat.json': JSON.stringify({ updatedAt: new Date(now).toISOString() }),
    'unrelated.txt': 'keep'
  };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(directory, name);
    await writeFile(file, content);
    if (name !== 'fresh.json') await utimes(file, old, old);
  }
  cleanupAgentWorkspaceRecords(directory, now);
  for (const name of ['dead.json', 'partial.json.tmp']) {
    await assert.rejects(readFile(path.join(directory, name)), { code: 'ENOENT' });
  }
  for (const name of ['live.json', 'fresh.json', 'foreign.json', 'recent-heartbeat.json', 'unrelated.txt']) {
    assert.equal(await readFile(path.join(directory, name), 'utf8'), files[name as keyof typeof files]);
  }
  cleanupAgentWorkspaceRecords(directory, now);
});

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
    backendSocketPath: '/tmp/safs-backend.sock', backendToken: 'secret'
  });
  const filePath = path.join(directory, 'window-one.json');
  const value = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(value.version, 2);
  assert.equal(value.instanceId, 'window-one');
  assert.equal(value.processPlatform, process.platform);
  assert.equal(value.execution, 'remote');
  assert.equal(value.mountName, 'project');
  assert.equal(value.backendServerName, undefined);
  assert.equal(typeof value.updatedAt, 'string');
  await publisher.remove();
  await assert.rejects(readFile(filePath, 'utf8'), { code: 'ENOENT' });
});

test('discovers fresh windows first and ignores stale records', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'safs-discovery-'));
  const directory = agentDiscoveryDirectory(home);
  const now = Date.now();
  const record = (instanceId: string, focused: boolean, updatedAtMs: number) => ({
    version: 2,
    instanceId,
    processId: process.pid,
    processPlatform: process.platform,
    focused,
    execution: 'remote',
    workspaceUri: `safs://${instanceId}/srv/${instanceId}`,
    mountName: instanceId,
    workspaceRoot: `/srv/${instanceId}`,
    host: 'dev',
    backendSocketPath: '/tmp/safs-backend.sock', backendToken: 'secret',
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
    version: 2,
    instanceId,
    processId: process.pid,
    processPlatform: process.platform,
    focused: true,
    execution: 'remote',
    workspaceUri: `safs://${instanceId}/srv/${instanceId}`,
    mountName: instanceId,
    workspaceRoot: `/srv/${instanceId}`,
    host: 'dev',
    backendSocketPath: '/tmp/safs-backend.sock', backendToken: 'secret',
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
    workspaceRoot: '/srv/project', host: 'dev', backendSocketPath: '/tmp/safs-backend.sock', backendToken: 'secret'
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
    version: 2, instanceId: 'dead', processId: pid, processPlatform: process.platform,
    focused: true, execution: 'remote',
    workspaceUri: 'safs://project/srv/project', mountName: 'project', workspaceRoot: '/srv/project',
    host: 'dev', backendSocketPath: '/tmp/safs-backend.sock', backendToken: 'secret', updatedAt: new Date().toISOString()
  }));
  assert.deepEqual(discoverAgentWorkspaces([directory]), []);
});

test('foreign platform IPC records are excluded from local discovery', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'safs-discovery-foreign-'));
  const directory = agentDiscoveryDirectory(home);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'foreign.json'), JSON.stringify({
    version: 2, instanceId: 'foreign', processId: 2147483647,
    processPlatform: process.platform === 'win32' ? 'linux' : 'win32',
    focused: true, execution: 'remote', workspaceUri: 'safs://project/srv/project',
    mountName: 'project', workspaceRoot: '/srv/project', host: 'dev',
    backendSocketPath: '/tmp/safs-backend.sock', backendToken: 'secret', updatedAt: new Date().toISOString()
  }));
  assert.equal(discoverAgentWorkspaces([directory]).length, 0);
});
