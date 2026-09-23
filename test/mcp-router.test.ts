import assert from 'node:assert/strict';
import * as http from 'node:http';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AgentHttpRouter, agentTaggedMcpUrl, workspaceIdFor } from '../src/agent-http-router';
import { AgentMcpServer } from '../src/agent-mcp';
import { DiscoveredAgentWorkspace } from '../src/agent-discovery';

function callbacks(label: string) {
  return {
    listFolders: async () => [],
    currentWorkspace: async () => ({
      name: 'A', workspaceUri: 'safs://a/srv/a', workspaceRoot: '/srv/a', host: 'dev'
    }),
    currentFile: async (input: unknown) => ({ label, input }),
    list: async (input: unknown) => {
      if ((input as { path?: string }).path === 'forbidden') throw new Error('路径越界');
      return { label, input };
    },
    read: async (input: unknown) => ({ label, input }),
    edit: async (input: unknown) => ({ label, input }),
    write: async (input: unknown) => ({ label, input }),
    create: async (input: unknown) => ({ label, input }),
    delete: async (input: unknown) => ({ label, input }),
    chmod: async (input: unknown) => ({ label, input }),
    move: async (input: unknown) => ({ label, input }),
    upload: async (input: unknown) => ({ label, input }),
    download: async (input: unknown) => ({ label, input }),
    search: async (input: unknown) => ({ label, input }),
    run: async (input: unknown) => ({ label, input })
  };
}

function record(
  instanceId: string, mcpUrl: string,
  workspace: {
    mountName?: string; workspaceRoot?: string; host?: string; focused?: boolean; terminalCommandOnly?: true;
  } = {}
): DiscoveredAgentWorkspace {
  const updatedAt = new Date().toISOString();
  return {
    version: 1,
    instanceId,
    processId: process.pid,
    focused: workspace.focused ?? true,
    execution: 'remote',
    workspaceUri: 'safs://a/srv/a',
    mountName: workspace.mountName ?? 'A',
    workspaceRoot: workspace.workspaceRoot ?? '/srv/a',
    terminalCommandOnly: workspace.terminalCommandOnly,
    host: workspace.host ?? 'dev',
    mcpUrl,
    updatedAt,
    updatedAtMs: Date.parse(updatedAt),
    discoveryFile: `${instanceId}.json`
  };
}

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close(
    (error) => error ? reject(error) : resolve()
  ));
  return address.port;
}

test('adds an encoded Agent source label without changing the router token', () => {
  const tagged = new URL(agentTaggedMcpUrl(
    'http://127.0.0.1:9848/mcp?token=secret', '  自定义 Agent  ', 'cli'
  ));
  assert.equal(tagged.searchParams.get('token'), 'secret');
  assert.equal(tagged.searchParams.get('agent'), '自定义 Agent');
  assert.equal(tagged.searchParams.get('platform'), null);
  assert.equal(tagged.searchParams.get('source'), 'cli');
});

test('a terminal workspace permits only commands without changing other workspace routes', async () => {
  const backend = new AgentMcpServer(0, 'terminal-backend', {
    ...callbacks('terminal'),
    toolProfile: () => 'terminal',
    runTerminal: async (input) => ({
      workspaceRoot: '/home/switched-user/project',
      exitCode: 0,
      stdout: `terminal:${input.command}`,
      stderr: '',
      truncated: false,
      source: input.source
    })
  });
  let workspaces: DiscoveredAgentWorkspace[] = [];
  const router = new AgentHttpRouter(await freePort(), 'router-token', {
    discover: () => workspaces
  });
  const client = new Client({ name: 'terminal-agent', version: '1.0.0' });
  try {
    await backend.start();
    workspaces = [
      record('ordinary-window', backend.url, {
        workspaceRoot: '/home/ordinary/project',
        focused: true
      }),
      record('terminal-window', backend.url, {
        workspaceRoot: '/home/switched-user/project',
        focused: false,
        terminalCommandOnly: true
      })
    ];
    await router.start();
    await client.connect(new StreamableHTTPClientTransport(
      new URL(agentTaggedMcpUrl(router.url, 'Codex'))
    ));
    assert.match(client.getInstructions() ?? '', /workspace\.mode/);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'list_remote_workspaces'));
    assert.ok(tools.tools.some((tool) => tool.name === 'remote_read'));
    const selected = await client.callTool({ name: 'list_remote_workspaces', arguments: {} });
    const selectedValue = JSON.parse((selected.content as any[])[0].text)
      .workspaces.find((item: any) => item.mode === 'terminal');
    assert.ok(selectedValue);
    const mcpBindingId = selectedValue.workspaceId;
    const deniedMcp = await client.callTool({
      name: 'remote_read', arguments: { workspaceId: mcpBindingId, path: 'README.md' }
    });
    assert.equal(deniedMcp.isError, true);
    const deniedMcpValue = JSON.parse((deniedMcp.content as any[])[0].text);
    assert.equal(deniedMcpValue.code, 'TERMINAL_COMMAND_ONLY');
    assert.equal(deniedMcpValue.allowedTool, 'run_remote_command');
    assert.match(deniedMcpValue.message, /only available MCP remote-operation tool: run_remote_command/);
    const executed = await client.callTool({
      name: 'run_remote_command', arguments: { workspaceId: mcpBindingId, command: 'id -un' }
    });
    assert.deepEqual(JSON.parse((executed.content as any[])[0].text), {
      workspaceRoot: '/home/switched-user/project',
      exitCode: 0,
      stdout: 'terminal:id -un',
      stderr: '',
      truncated: false,
      source: 'mcp'
    });
    const cliUrl = new URL(router.url);
    cliUrl.pathname = '/cli';
    const invokeCli = async (name: string, args: Record<string, unknown>) => {
      const response = await fetch(cliUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, arguments: args })
      });
      assert.equal(response.status, 200);
      return response.json() as Promise<any>;
    };
    const listed = await invokeCli('list_remote_workspaces', {});
    assert.equal(listed.ok, true);
    const workspaceId = listed.result.workspaces.find((item: any) => item.mode === 'terminal').workspaceId;

    const denied = await invokeCli('remote_read', { workspaceId, path: 'README.md' });
    assert.equal(denied.ok, false);
    assert.equal(denied.result.code, 'TERMINAL_COMMAND_ONLY');
    assert.equal(denied.result.allowedCommand, `safs exec --workspace ${workspaceId} -- 'COMMAND'`);
    assert.match(denied.result.message, /only available CLI command: safs exec/);

    const deniedBatch = await invokeCli('safs_cli_batch', {
      operations: [{
        name: 'run_remote_command', arguments: { workspaceId, command: 'pwd' }
      }]
    });
    assert.equal(deniedBatch.ok, false);
    assert.equal(deniedBatch.result.code, 'TERMINAL_COMMAND_ONLY');
    assert.match(deniedBatch.result.message, /only available CLI command: safs exec/);

    const cliExecuted = await invokeCli('run_remote_command', {
      workspaceId, command: 'pwd'
    });
    assert.equal(cliExecuted.ok, true);
    assert.equal(cliExecuted.result.stdout, 'terminal:pwd');
    assert.equal(cliExecuted.result.source, 'cli');
  } finally {
    await client.close();
    await Promise.allSettled([router.stop(), backend.stop()]);
  }
});

test('agents bound to separate windows retain their own modes across focus changes', async () => {
  let aProfile: 'terminal' | 'full' = 'terminal';
  const terminalBackend = new AgentMcpServer(0, 'terminal-backend', {
    ...callbacks('A'),
    toolProfile: () => aProfile,
    runTerminal: async (input) => ({ stdout: `A:${input.command}` })
  });
  const workspaceBackend = new AgentMcpServer(0, 'workspace-backend', callbacks('B'));
  let workspaces: DiscoveredAgentWorkspace[] = [];
  const router = new AgentHttpRouter(await freePort(), 'router-token', {
    discover: () => workspaces
  });
  const agentA = new Client({ name: 'agent-A', version: '1.0.0' });
  const agentB = new Client({ name: 'agent-B', version: '1.0.0' });
  try {
    await Promise.all([terminalBackend.start(), workspaceBackend.start()]);
    workspaces = [
      record('window-A', terminalBackend.url, {
        focused: true, terminalCommandOnly: true
      }),
      record('window-B', workspaceBackend.url, { focused: false })
    ];
    await router.start();
    await agentA.connect(new StreamableHTTPClientTransport(
      new URL(agentTaggedMcpUrl(router.url, 'Codex'))
    ));
    const aSelection = await agentA.callTool({
      name: 'list_remote_workspaces', arguments: {}
    });
    const aBinding = JSON.parse((aSelection.content as any[])[0].text)
      .workspaces.find((item: any) => item.mode === 'terminal');
    assert.equal(aBinding.mode, 'terminal');

    workspaces = workspaces.map((workspace) => ({
      ...workspace, focused: workspace.instanceId === 'window-B'
    }));
    await agentB.connect(new StreamableHTTPClientTransport(
      new URL(agentTaggedMcpUrl(router.url, 'Codex'))
    ));
    assert.deepEqual(
      (await agentA.listTools()).tools.map((tool) => tool.name),
      (await agentB.listTools()).tools.map((tool) => tool.name)
    );
    const bSelection = await agentB.callTool({
      name: 'list_remote_workspaces', arguments: {}
    });
    const bBinding = JSON.parse((bSelection.content as any[])[0].text)
      .workspaces.find((item: any) => item.mode === 'workspace');
    assert.equal(bBinding.mode, 'workspace');

    const bRead = await agentB.callTool({
      name: 'remote_read', arguments: { workspaceId: bBinding.workspaceId, path: 'README.md' }
    });
    assert.equal(JSON.parse((bRead.content as any[])[0].text).label, 'B');
    const aRead = await agentA.callTool({
      name: 'remote_read', arguments: { workspaceId: aBinding.workspaceId, path: 'README.md' }
    });
    assert.equal(JSON.parse((aRead.content as any[])[0].text).code, 'TERMINAL_COMMAND_ONLY');
    const aCommand = await agentA.callTool({
      name: 'run_remote_command',
      arguments: { workspaceId: aBinding.workspaceId, command: 'pwd' }
    });
    assert.equal(JSON.parse((aCommand.content as any[])[0].text).stdout, 'A:pwd');

    workspaces = workspaces.map((workspace) => ({
      ...workspace, focused: workspace.instanceId === 'window-A'
    }));
    const bReadAgain = await agentB.callTool({
      name: 'remote_read', arguments: { workspaceId: bBinding.workspaceId, path: 'README.md' }
    });
    assert.equal(JSON.parse((bReadAgain.content as any[])[0].text).label, 'B');

    const cliUrl = new URL(router.url);
    cliUrl.pathname = '/cli';
    const invokeCli = async (name: string, args: Record<string, unknown>) => {
      const response = await fetch(cliUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, arguments: args })
      });
      assert.equal(response.status, 200);
      return response.json() as Promise<any>;
    };
    const cliList = await invokeCli('list_remote_workspaces', {});
    const cliA = { result: { workspaceId: cliList.result.workspaces.find((item: any) => item.mode === 'terminal').workspaceId } };
    const cliB = { result: { workspaceId: cliList.result.workspaces.find((item: any) => item.mode === 'workspace').workspaceId } };
    const cliADenied = await invokeCli('remote_read', {
      workspaceId: cliA.result.workspaceId, path: 'README.md'
    });
    const cliBRead = await invokeCli('remote_read', {
      workspaceId: cliB.result.workspaceId, path: 'README.md'
    });
    assert.equal(cliADenied.result.code, 'TERMINAL_COMMAND_ONLY');
    assert.equal(cliBRead.result.label, 'B');

    aProfile = 'full';
    workspaces = workspaces.map((workspace) => workspace.instanceId === 'window-A'
      ? { ...workspace, terminalCommandOnly: undefined }
      : workspace);
    const aModeAfterSwitch = await agentA.callTool({
      name: 'list_remote_workspaces', arguments: {}
    });
    assert.equal(JSON.parse((aModeAfterSwitch.content as any[])[0].text)
      .workspaces.find((item: any) => item.mode === 'workspace').mode, 'workspace');
    const aReadAfterSwitch = await agentA.callTool({
      name: 'remote_read', arguments: { workspaceId: aBinding.workspaceId, path: 'README.md' }
    });
    assert.equal(JSON.parse((aReadAfterSwitch.content as any[])[0].text).label, 'A');
    workspaces = workspaces.map((workspace) => workspace.instanceId === 'window-A'
      ? { ...workspace, workspaceRoot: '/srv/a/terminal-cwd-refresh' }
      : workspace);
    const aReadAfterCwdRefresh = await agentA.callTool({
      name: 'remote_read', arguments: { workspaceId: aBinding.workspaceId, path: 'README.md' }
    });
    assert.equal(JSON.parse((aReadAfterCwdRefresh.content as any[])[0].text).label, 'A');
    workspaces = workspaces.map((workspace) => workspace.instanceId === 'window-A'
      ? { ...workspace, workspaceUri: 'safs://a/srv/another-project' }
      : workspace);
    const aAfterWorkspaceSwitch = await agentA.callTool({
      name: 'remote_read', arguments: { workspaceId: aBinding.workspaceId, path: 'README.md' }
    });
    assert.equal(JSON.parse((aAfterWorkspaceSwitch.content as any[])[0].text).code,
      'REMOTE_WORKSPACE_NOT_FOUND');
    const bReadAfterSwitch = await agentB.callTool({
      name: 'remote_read', arguments: { workspaceId: bBinding.workspaceId, path: 'README.md' }
    });
    assert.equal(JSON.parse((bReadAfterSwitch.content as any[])[0].text).label, 'B');
  } finally {
    await Promise.allSettled([
      agentA.close(), agentB.close(), router.stop(),
      terminalBackend.stop(), workspaceBackend.stop()
    ]);
  }
});

test('a workspaceId never moves to another window with the same remote path', async () => {
  const terminalBackend = new AgentMcpServer(0, 'terminal-backend', {
    ...callbacks('A'), toolProfile: () => 'terminal',
    runTerminal: async (input) => ({ stdout: `A:${input.command}` })
  });
  const workspaceBackend = new AgentMcpServer(0, 'workspace-backend', callbacks('B'));
  let workspaces: DiscoveredAgentWorkspace[] = [];
  const router = new AgentHttpRouter(await freePort(), 'router-token', {
    discover: () => workspaces
  });
  const client = new Client({ name: 'window-agent', version: '1.0.0' });
  try {
    await Promise.all([terminalBackend.start(), workspaceBackend.start()]);
    workspaces = [
      record('window-A', terminalBackend.url, {
        host: 'host-a', mountName: 'A', workspaceRoot: '/srv/a',
        focused: true, terminalCommandOnly: true
      }),
      record('window-B', workspaceBackend.url, {
        host: 'host-a', mountName: 'A', workspaceRoot: '/srv/a', focused: false
      })
    ];
    await router.start();
    await client.connect(new StreamableHTTPClientTransport(new URL(router.url)));
    const selected = await client.callTool({ name: 'list_remote_workspaces', arguments: {} });
    const selectedValue = JSON.parse((selected.content as any[])[0].text)
      .workspaces.find((item: any) => item.mode === 'terminal');

    workspaces = workspaces.map((workspace) => ({
      ...workspace,
      focused: workspace.instanceId === 'window-B'
    }));
    const bSelected = await client.callTool({ name: 'list_remote_workspaces', arguments: {} });
    const bBinding = JSON.parse((bSelected.content as any[])[0].text)
      .workspaces.find((item: any) => item.mode === 'workspace');
    const aStillTerminal = await client.callTool({
      name: 'remote_read', arguments: { workspaceId: selectedValue.workspaceId, path: 'README.md' }
    });
    assert.equal(JSON.parse((aStillTerminal.content as any[])[0].text).code, 'TERMINAL_COMMAND_ONLY');

    workspaces = [{ ...workspaces[1], focused: false }];
    const expired = await client.callTool({
      name: 'run_remote_command',
      arguments: { workspaceId: selectedValue.workspaceId, command: 'pwd' }
    });
    assert.equal(expired.isError, true);
    assert.equal(
      JSON.parse((expired.content as any[])[0].text).code,
      'REMOTE_WORKSPACE_NOT_FOUND'
    );
    const bRead = await client.callTool({
      name: 'remote_read', arguments: { workspaceId: bBinding.workspaceId, path: 'README.md' }
    });
    assert.equal(JSON.parse((bRead.content as any[])[0].text).label, 'B');
    const listed = await client.callTool({ name: 'list_remote_workspaces', arguments: {} });
    assert.deepEqual(JSON.parse((listed.content as any[])[0].text).workspaces, [
      { workspaceId: bBinding.workspaceId, workspaceRoot: '/srv/a', host: 'host-a', mode: 'workspace' }
    ]);
  } finally {
    await client.close();
    await Promise.allSettled([router.stop(), terminalBackend.stop(), workspaceBackend.stop()]);
  }
});

test('workspace listing returns stable IDs and expired IDs stay invalid', async () => {
  const first = new AgentMcpServer(0, 'first', callbacks('first'));
  const second = new AgentMcpServer(0, 'second', callbacks('second'));
  let workspaces: DiscoveredAgentWorkspace[] = [];
  const router = new AgentHttpRouter(await freePort(), 'router-token', {
    discover: () => workspaces
  });
  const client = new Client({ name: 'window-agent', version: '1.0.0' });
  try {
    await Promise.all([first.start(), second.start()]);
    workspaces = [
      record('window-a', first.url, {
        host: 'host-a', workspaceRoot: '/srv/a',
        focused: false
      }),
      record('window-b', second.url, {
        host: 'host-b', workspaceRoot: '/srv/b',
        focused: true
      })
    ];
    await router.start();
    await client.connect(new StreamableHTTPClientTransport(new URL(router.url)));
    const selected = await client.callTool({ name: 'list_remote_workspaces', arguments: {} });
    const listedValue = JSON.parse((selected.content as any[])[0].text);
    assert.equal(listedValue.workspaces.length, 2);
    const value = listedValue.workspaces.find((item: any) => item.host === 'host-a');
    assert.deepEqual(value, {
      workspaceId: workspaceIdFor(workspaces[0]), workspaceRoot: '/srv/a', host: 'host-a', mode: 'workspace'
    });

    workspaces = [workspaces[1]];
    const expired = await client.callTool({
      name: 'remote_list', arguments: { workspaceId: value.workspaceId, path: '.' }
    });
    assert.equal(expired.isError, true);
    assert.equal(JSON.parse((expired.content as any[])[0].text).code, 'REMOTE_WORKSPACE_NOT_FOUND');
    const rebound = await client.callTool({ name: 'list_remote_workspaces', arguments: {} });
    const reboundValue = JSON.parse((rebound.content as any[])[0].text).workspaces[0];
    assert.deepEqual(reboundValue, {
      workspaceId: workspaceIdFor(workspaces[0]), workspaceRoot: '/srv/b', host: 'host-b', mode: 'workspace'
    });
    assert.notEqual(reboundValue.workspaceId, value.workspaceId);
  } finally {
    await client.close();
    await Promise.allSettled([router.stop(), first.stop(), second.stop()]);
  }
});

test('fixed HTTP router follows a reconnected mount without changing the Agent URL', async () => {
  const first = new AgentMcpServer(0, 'first', callbacks('first'));
  const second = new AgentMcpServer(0, 'second', callbacks('second'));
  let workspaces: DiscoveredAgentWorkspace[] = [];
  const routerAudits: string[] = [];
  const router = new AgentHttpRouter(await freePort(), 'router-token', {
    discover: () => workspaces,
    audit: (entry) => routerAudits.push(entry.toolName)
  });
  const client = new Client({ name: 'http-router-test', version: '1.0.0' });
  try {
    await Promise.all([first.start(), second.start()]);
    await router.start();
    assert.equal(router.leader, true);
    await client.connect(new StreamableHTTPClientTransport(
      new URL(agentTaggedMcpUrl(router.url, 'Codex'))
    ));
    const instructions = client.getInstructions() ?? '';
    assert.match(instructions, /use the MCP tools only/i);
    assert.equal(instructions.includes('SAFS CLI transport'), false);
    assert.deepEqual(await client.listResources(), { resources: [] });
    assert.deepEqual(await client.listResourceTemplates(), { resourceTemplates: [] });

    workspaces = [record('old-a', first.url)];
    const route = await client.callTool({ name: 'list_remote_workspaces', arguments: {} });
    const routeValue = JSON.parse((route.content as any[])[0].text).workspaces[0];
    const workspaceId = routeValue.workspaceId as string;
    assert.match(workspaceId, /^[a-f0-9]{16}$/);
    assert.deepEqual(routeValue, {
      workspaceId, workspaceRoot: '/srv/a', host: 'dev', mode: 'workspace'
    });
    assert.deepEqual(routerAudits, []);

    const connected = await client.callTool({
      name: 'remote_list', arguments: { workspaceId, path: 'README.md' }
    });
    assert.equal(JSON.parse((connected.content as any[])[0].text).label, 'first');

    const ran = await client.callTool({
      name: 'run_remote_command', arguments: { workspaceId, command: 'pwd' }
    });
    assert.equal(JSON.parse((ran.content as any[])[0].text).input.agentName, 'Codex');
    assert.equal('agentPlatform' in JSON.parse((ran.content as any[])[0].text).input, false);

    const rejected = await client.callTool({
      name: 'remote_list', arguments: { workspaceId, path: 'forbidden' }
    });
    assert.equal(rejected.isError, true);
    assert.deepEqual(JSON.parse((rejected.content as any[])[0].text), {
      code: 'REMOTE_TOOL_ERROR', message: '路径越界'
    });

    // current_remote_file is window-specific: the router forwards it to the
    // focused window's MCP server.
    const currentFile = await client.callTool({
      name: 'current_remote_file', arguments: { workspaceId }
    });
    const currentFileValue = JSON.parse((currentFile.content as any[])[0].text);
    assert.equal(currentFileValue.label, 'first');
    assert.deepEqual(currentFileValue.input, {});

    workspaces = [];
    const disconnected = await client.callTool({
      name: 'remote_list', arguments: { workspaceId, path: 'README.md' }
    });
    assert.equal(disconnected.isError, true);
    assert.equal(
      JSON.parse((disconnected.content as any[])[0].text).code,
      'REMOTE_WORKSPACE_NOT_FOUND'
    );
    const disconnectedFile = await client.callTool({
      name: 'current_remote_file', arguments: { workspaceId }
    });
    assert.equal(disconnectedFile.isError, true);
    assert.equal(
      JSON.parse((disconnectedFile.content as any[])[0].text).code,
      'REMOTE_WORKSPACE_NOT_FOUND'
    );

    workspaces = [record('new-a', second.url)];
    const rebound = await client.callTool({ name: 'list_remote_workspaces', arguments: {} });
    const reboundId = JSON.parse((rebound.content as any[])[0].text).workspaces[0].workspaceId;
    const reconnected = await client.callTool({
      name: 'remote_list', arguments: { workspaceId: reboundId, path: 'README.md' }
    });
    assert.equal(JSON.parse((reconnected.content as any[])[0].text).label, 'second');
  } finally {
    await client.close();
    await Promise.allSettled([router.stop(), first.stop(), second.stop()]);
  }
});

test('workspace listing exposes the focused and unfocused SAFS windows', async () => {
  const backend = new AgentMcpServer(0, 'focused', callbacks('focused'));
  let workspaces: DiscoveredAgentWorkspace[] = [];
  const router = new AgentHttpRouter(await freePort(), 'router-token', {
    discover: () => workspaces
  });
  const client = new Client({ name: 'focused-workspace-test', version: '1.0.0' });
  try {
    await backend.start();
    workspaces = [
      record('focused', backend.url, {
        host: 'host-a', workspaceRoot: '/srv/a', focused: true
      }),
      record('other', backend.url, {
        host: 'host-b', workspaceRoot: '/srv/b', focused: false
      })
    ];
    await router.start();
    await client.connect(new StreamableHTTPClientTransport(new URL(router.url)));
    const selected = await client.callTool({ name: 'list_remote_workspaces', arguments: {} });
    const value = JSON.parse((selected.content as any[])[0].text);
    assert.equal(selected.isError, undefined);
    assert.deepEqual(value.workspaces, [
      { workspaceId: workspaceIdFor(workspaces[0]), workspaceRoot: '/srv/a', host: 'host-a', mode: 'workspace' },
      { workspaceId: workspaceIdFor(workspaces[1]), workspaceRoot: '/srv/b', host: 'host-b', mode: 'workspace' }
    ]);
  } finally {
    await client.close();
    await Promise.allSettled([router.stop(), backend.stop()]);
  }
});

test('workspace selection accepts workspaceId and preserves existing routes', async () => {
  const first = new AgentMcpServer(0, 'first', callbacks('first'));
  const second = new AgentMcpServer(0, 'second', callbacks('second'));
  let workspaces: DiscoveredAgentWorkspace[] = [];
  const router = new AgentHttpRouter(await freePort(), 'router-token', {
    discover: () => workspaces
  });
  const client = new Client({ name: 'workspace-selection-test', version: '1.0.0' });
  try {
    await Promise.all([first.start(), second.start()]);
    workspaces = [
      record('focused', first.url, {
        mountName: 'A', host: 'host-a', workspaceRoot: '/srv/a', focused: false
      }),
      record('other', second.url, {
        mountName: 'B', host: 'host-b', workspaceRoot: '/srv/b', focused: false
      })
    ];
    await router.start();
    await client.connect(new StreamableHTTPClientTransport(
      new URL(agentTaggedMcpUrl(router.url, 'Codex'))
    ));

    const tools = await client.listTools();
    for (const tool of tools.tools) {
      assert.equal(JSON.stringify(tool.inputSchema).includes('mountName'), false);
      if (['current_remote_file', 'remote_list', 'remote_edit', 'remote_write', 'remote_search',
        'run_remote_command'].includes(tool.name)) {
        assert.ok((tool.inputSchema.required as string[] | undefined)?.includes('workspaceId'));
      }
    }

    const listed = await client.callTool({ name: 'list_remote_workspaces', arguments: {} });
    const listedValue = JSON.parse((listed.content as any[])[0].text);
    assert.deepEqual(listedValue.workspaces, [
      { workspaceId: workspaceIdFor(workspaces[0]), workspaceRoot: '/srv/a', host: 'host-a', mode: 'workspace' },
      { workspaceId: workspaceIdFor(workspaces[1]), workspaceRoot: '/srv/b', host: 'host-b', mode: 'workspace' }
    ]);
    const workspaceId = workspaceIdFor(workspaces[1]);
    const bound = await client.callTool({
      name: 'remote_list', arguments: { workspaceId, path: '.' }
    });
    assert.equal(JSON.parse((bound.content as any[])[0].text).label, 'second');

    const stale = await client.callTool({ name: 'remote_list', arguments: {
      workspaceId: 'missing', path: '.'
    } });
    assert.equal(stale.isError, true);
    assert.equal(
      JSON.parse((stale.content as any[])[0].text).code,
      'REMOTE_WORKSPACE_NOT_FOUND'
    );
    const stillBound = await client.callTool({
      name: 'remote_list', arguments: { workspaceId, path: '.' }
    });
    assert.equal(JSON.parse((stillBound.content as any[])[0].text).label, 'second');

    const switchedId = workspaceIdFor(workspaces[0]);
    const switched = await client.callTool({
      name: 'remote_list', arguments: { workspaceId: switchedId, path: '.' }
    });
    assert.equal(JSON.parse((switched.content as any[])[0].text).label, 'first');
    const originalRoute = await client.callTool({
      name: 'remote_list', arguments: { workspaceId, path: '.' }
    });
    assert.equal(JSON.parse((originalRoute.content as any[])[0].text).label, 'second');
  } finally {
    await client.close();
    await Promise.allSettled([router.stop(), first.stop(), second.stop()]);
  }
});

test('another VS Code window takes over the fixed HTTP port after its leader exits', async () => {
  const port = await freePort();
  const first = new AgentHttpRouter(port, 'shared-token', { discover: () => [] });
  const second = new AgentHttpRouter(port, 'shared-token', { discover: () => [] });
  try {
    await first.start();
    await second.start();
    assert.equal(first.leader, true);
    assert.equal(second.leader, false);
    assert.equal(second.available, true);

    await first.stop();
    await second.start();
    assert.equal(second.leader, true);
    assert.equal(second.available, true);
  } finally {
    await Promise.allSettled([first.stop(), second.stop()]);
  }
});

test('fixed HTTP router rejects a port owned by an unrelated process', async () => {
  const port = await freePort();
  const unrelated = http.createServer((_request, response) => response.end('not a router'));
  await new Promise<void>((resolve) => unrelated.listen(port, '127.0.0.1', resolve));
  const router = new AgentHttpRouter(port, 'router-token');
  try {
    await assert.rejects(router.start(), /已被其他程序占用/);
  } finally {
    await new Promise<void>((resolve, reject) => unrelated.close(
      (error) => error ? reject(error) : resolve()
    ));
  }
});

test('router refuses to forward to its own port (loop protection)', async () => {
  const port = await freePort();
  const self = record('self', `http://127.0.0.1:${port}/mcp?token=router-token`);
  const router = new AgentHttpRouter(port, 'router-token', {
    discover: () => [self]
  });
  const client = new Client({ name: 'http-router-test', version: '1.0.0' });
  try {
    await router.start();
    await client.connect(new StreamableHTTPClientTransport(new URL(router.url)));
    const workspaceId = workspaceIdFor(self);
    const result = await client.callTool({
      name: 'remote_list', arguments: { workspaceId, path: 'x' }
    });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse((result.content as any[])[0].text).code, 'REMOTE_UNAVAILABLE');
  } finally {
    await client.close();
    await router.stop();
  }
});

test('router rejects requests marked as forwarded by another router', async () => {
  const port = await freePort();
  const router = new AgentHttpRouter(port, 'router-token', { discover: () => [] });
  await router.start();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/mcp?token=router-token`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'x-safs-forwarded': '1'
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'list_remote_workspaces', arguments: {} }
      })
    });
    assert.equal(response.status, 403);
  } finally {
    await router.stop();
  }
});
