import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliConfigPath, writeCliConnection } from '../src/cli-integration';
import assert from 'node:assert/strict';
import test from 'node:test';
import { callSafs, parseCliRequest } from '../src/safs-cli-client';
import { AgentMcpServer } from '../src/agent-mcp';
import { AgentHttpRouter } from '../src/agent-http-router';
import { executeCaptured } from '../src/process';

test('CLI requires a pinned binding and preserves remote command quoting', () => {
  const command = 'printf "%s" "$(pwd)"';
  assert.equal(parseCliRequest(['exec', '--binding', 'id', '--', command], '/local').arguments.command, command);
  assert.throws(() => parseCliRequest(['exec', '--', 'pwd'], '/local'));
  assert.throws(() => parseCliRequest(['output', '--binding', 'id', '--id', 'x', '--stream', 'stdout', '--offset', '-1'], '/local'));
});

test('CLI uses existing router binding, preserves exit code and refuses expired binding', async () => {
  let runs = 0;
  const configRoot = await mkdtemp(join(tmpdir(), 'safs-cli-e2e-'));
  const backend = new AgentMcpServer(0, 'cli-test', {
    currentWorkspace: async () => ({ host: 'dev', workspaceUri: 'safs://dev/project', workspaceRoot: '/project', name: 'dev' }),
    run: async () => { runs++; return { stdout: 'remote-out', stderr: 'remote-err', exitCode: 7 }; }
  } as any);
  await backend.start();
  const port = 30000 + Math.floor(Math.random() * 10000);
  let active = true;
  const router = new AgentHttpRouter(port, 'cli-router', { discover: () => active ? [{
    instanceId: 'test-cli-window', workspaceRoot: '/project', host: 'dev',
    agentCwd: '/local-cli', focused: true, mcpUrl: backend.url
  } as any] : [] });
  await router.start();
  try {
    await writeCliConnection(configRoot, router.url);
    const bound = await callSafs(router.url, parseCliRequest(['bind'], '/local-cli'));
    assert.equal(typeof bound.bindingId, 'string');
    const run = () => executeCaptured({ command: process.execPath,
      args: ['--import', 'tsx', 'src/safs-cli.ts', '--config', cliConfigPath(configRoot), 'exec', '--binding', String(bound.bindingId), '--', 'exit 7'],
      env: { SAFS_MCP_URL: '' } });
    const result = await run();
    assert.equal(result.exitCode, 7);
    assert.equal(result.stdout, 'remote-out');
    assert.equal(result.stderr, 'remote-err');
    active = false;
    const invalid = await run();
    assert.equal(invalid.exitCode, 1);
    assert.equal(runs, 1);
    assert.ok(!invalid.stderr.includes('cli-router'));
    await assert.rejects(callSafs('http://example.com/mcp?token=x', parseCliRequest(['bind'], '/local-cli')));
  } finally { await router.stop(); await backend.stop(); await rm(configRoot, { recursive: true, force: true }); }
});

test('structured CLI commands preserve edit payloads and prevent implicit target overrides', async () => {
  const { prepareCliRequest } = await import('../src/safs-cli-client');
  const edit = await prepareCliRequest(['edit', '--binding', 'id', '--path', 'a', '--input', 'edits.json'], '/',
    async () => JSON.stringify({ edits: [{ oldText: '$`old\n', newText: 'new\n' }] }));
  assert.equal(edit.name, 'remote_edit');
  assert.deepEqual(edit.arguments.edits, [{ oldText: '$`old\n', newText: 'new\n' }]);
  assert.equal(parseCliRequest(['read', '--binding', 'id', '--path', 'a', '--start-line', '20'], '/').arguments.startLine, 20);
  await assert.rejects(prepareCliRequest(['read', '--binding', 'id', '--input', 'x'], '/', async () => '{"bindingId":"other"}'));
  assert.throws(() => parseCliRequest(['switch', '--workspace', 'id'], '/'));
  assert.equal(parseCliRequest(['switch', '--workspace', 'id', '--confirmed', 'true'], '/').arguments.userConfirmed, true);
  const write = await prepareCliRequest(['write', '--binding', 'id', '--path', 'a', '--file', 'x'], '/', async () => '原样\n');
  assert.equal(write.arguments.content, '原样\n');
});
