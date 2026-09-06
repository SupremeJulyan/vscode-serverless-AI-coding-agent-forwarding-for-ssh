import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentMcpServer } from '../src/agent-mcp';
import { AgentHttpRouter } from '../src/agent-http-router';
import { cliConfigPath, writeCliConnection } from '../src/cli-integration';
import { bundledNativeCli, nativeCliPlatform } from '../src/native-cli';
import { executeCaptured } from '../src/process';

test('native CLI binds and executes through the existing SAFS router', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'safs-native-e2e-'));
  let runs = 0;
  const backend = new AgentMcpServer(0, 'native-test', {
    currentWorkspace: async () => ({
      name: 'dev', host: 'dev', workspaceRoot: '/project', workspaceUri: 'safs://dev/project'
    }),
    run: async () => {
      runs += 1;
      return { stdout: 'native-out', stderr: 'native-err', exitCode: 7 };
    }
  } as any);
  await backend.start();
  const router = new AgentHttpRouter(30000 + Math.floor(Math.random() * 10000), 'native-router', {
    discover: () => [{
      instanceId: 'native-window', workspaceRoot: '/project', host: 'dev',
      agentCwd: temporary, focused: true, mcpUrl: backend.url
    } as any]
  });
  await router.start();
  const config = cliConfigPath(temporary);
  const executable = bundledNativeCli(
    process.cwd(), nativeCliPlatform(process.platform, process.arch)
  );
  try {
    await writeCliConnection(temporary, router.url);
    const bind = await executeCaptured({ command: executable, args: [
      '--config', config, 'bind', '--cwd', temporary
    ] });
    assert.equal(bind.exitCode, 0, bind.stderr);
    const bindingId = JSON.parse(bind.stdout).bindingId;
    const run = await executeCaptured({ command: executable, args: [
      '--config', config, 'exec', '--binding', bindingId, '--', 'exit 7'
    ] });
    assert.equal(run.exitCode, 7);
    assert.equal(run.stdout, 'native-out');
    assert.equal(run.stderr, 'native-err');
    assert.equal(runs, 1);
  } finally {
    await router.stop();
    await backend.stop();
    await rm(temporary, { recursive: true, force: true });
  }
});
