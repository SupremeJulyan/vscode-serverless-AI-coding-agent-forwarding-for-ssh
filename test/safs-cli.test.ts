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
    const bound = await callSafs(router.url, parseCliRequest(['bind'], '/local-cli'));
    assert.equal(typeof bound.bindingId, 'string');
    const run = () => executeCaptured({ command: process.execPath,
      args: ['--import', 'tsx', 'src/safs-cli.ts', 'exec', '--binding', String(bound.bindingId), '--', 'exit 7'],
      env: { SAFS_MCP_URL: router.url } });
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
  } finally { await router.stop(); await backend.stop(); }
});
