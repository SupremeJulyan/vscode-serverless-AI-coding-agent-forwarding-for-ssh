import assert from 'node:assert/strict';
import * as http from 'node:http';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AgentMcpServer, AgentToolError } from '../src/agent-mcp';

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

test('serves direct SFTP file and SSH command tools through MCP', async () => {
  const port = await freePort();
  const audited: Array<{ toolName: string; agentName?: string }> = [];
  const activity: Array<{
    phase: 'start' | 'success' | 'error'; toolName?: string;
    source?: string; agentName?: string;
  }> = [];
  const server = new AgentMcpServer(port, 'test-token', {
    listFolders: async () => [{
      name: 'project',
      workspaceUri: 'safs://project/srv/project',
      workspaceRoot: '/srv/project',
      host: 'dev'
    }],
    currentWorkspace: async () => ({
      name: 'project',
      workspaceUri: 'safs://project/srv/project',
      workspaceRoot: '/srv/project',
      host: 'dev'
    }),
    currentFile: async (input) => ({
      ...input, mountName: 'project', path: '/srv/project/README.md', relative: 'README.md',
      size: 12, modified: 123, dirty: false, exists: true
    }),
    list: async (input) => {
      if (input.path === 'forbidden') throw new Error('路径越界');
      return { ...input, entries: [] };
    },
    read: async (input) => ({ ...input, content: 'hello', truncated: false }),
    edit: async (input) => ({ ...input, replacements: input.edits.length }),
    write: async (input) => {
      if (input.path === '../outside.txt') {
        throw new AgentToolError(
          'WORKSPACE_BOUNDARY_VIOLATION', 'Path is outside the workspace.', {
            nonRetryable: true,
            mustStopNow: true,
            prohibitedFallback: 'safs exec'
          }
        );
      }
      return { ...input, bytes: input.content.length };
    },
    delete: async (input) => ({ ...input, deleted: true }),
    chmod: async (input) => ({ ...input, changed: true }),
    move: async (input) => ({ ...input, moved: true }),
    upload: async (input) => ({ ...input, completed: true }),
    download: async (input) => ({ ...input, completed: true }),
    search: async (input) => ({ ...input, stdout: 'src/index.ts:1:hello' }),
    run: async (input) => ({ ...input, exitCode: 0, stdout: input.command === 'large' ? 'x'.repeat(20000) : 'ok' }),
    audit: (entry) => audited.push(entry),
    activity: {
      start: (entry) => {
        const id = `activity-${activity.length}`;
        activity.push({
          phase: 'start', toolName: entry.toolName,
          source: entry.source, agentName: entry.agentName
        });
        return id;
      },
      succeed: () => activity.push({ phase: 'success' }),
      fail: () => activity.push({ phase: 'error' })
    }
  });
  await server.start();
  const client = new Client({ name: 'agent-mcp-test', version: '1.0.0' });
  try {
    const taggedUrl = new URL(server.url);
    taggedUrl.searchParams.set('agent', 'codex');
    await client.connect(new StreamableHTTPClientTransport(taggedUrl));
    assert.deepEqual(await client.listResources(), { resources: [] });
    assert.deepEqual(await client.listResourceTemplates(), { resourceTemplates: [] });
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'current_remote_file',
      'get_remote_workspace',
      'remote_chmod',
      'remote_delete',
      'remote_download',
      'remote_edit',
      'remote_list',
      'remote_move',
      'remote_output',
      'remote_read',
      'remote_read_many',
      'remote_search',
      'remote_upload',
      'remote_write',
      'run_remote_command'
    ]);
    const currentFile = await client.callTool({
      name: 'current_remote_file', arguments: {}
    });
    const currentFileText = (currentFile.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    assert.deepEqual(JSON.parse(currentFileText), {
      path: '/srv/project/README.md', relative: 'README.md', size: 12,
      modified: 123, dirty: false, exists: true
    });
    const route = await client.callTool({
      name: 'get_remote_workspace', arguments: {}
    });
    const routeText = (route.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    assert.deepEqual(JSON.parse(routeText), {
      workspace: {
        workspaceRoot: '/srv/project',
        host: 'dev'
      }
    });
    const listed = await client.callTool({
      name: 'remote_list', arguments: { path: '.', limit: 10 }
    });
    const listedText = (listed.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    assert.equal(JSON.parse(listedText).limit, 10);
    const read = await client.callTool({
      name: 'remote_read', arguments: { path: 'src/index.ts', offset: 10, length: 20 }
    });
    const readText = (read.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    assert.deepEqual(JSON.parse(readText), {
      path: 'src/index.ts', offset: 10, length: 20, content: 'hello', truncated: false
    });
    const edited = await client.callTool({
      name: 'remote_edit', arguments: {
        path: 'src/index.ts',
        edits: [{ oldText: 'hello', newText: 'world' }]
      }
    });
    assert.equal(JSON.parse((edited.content as any[])[0].text).replacements, 1);
    const downloaded = await client.callTool({
      name: 'remote_download', arguments: {
        remotePath: 'dist/app.bin', localPath: '/tmp/app.bin'
      }
    });
    const downloadedText = (downloaded.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    assert.deepEqual(JSON.parse(downloadedText), {
      remotePath: 'dist/app.bin', localPath: '/tmp/app.bin', completed: true
    });
    const uploaded = await client.callTool({
      name: 'remote_upload', arguments: {
        localPaths: ['/tmp/app.bin'], remoteDirectory: 'dist'
      }
    });
    const uploadedText = (uploaded.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    assert.deepEqual(JSON.parse(uploadedText), {
      localPaths: ['/tmp/app.bin'], remoteDirectory: 'dist', completed: true
    });
    const deleted = await client.callTool({
      name: 'remote_delete', arguments: { path: 'dist/old.bin', recursive: false }
    });
    assert.equal(JSON.parse((deleted.content as any[])[0].text).deleted, true);
    const chmod = await client.callTool({
      name: 'remote_chmod', arguments: { path: 'scripts/build.sh', mode: '755' }
    });
    assert.equal(JSON.parse((chmod.content as any[])[0].text).mode, '755');
    const moved = await client.callTool({
      name: 'remote_move', arguments: {
        sourcePath: 'old.txt', targetPath: 'new.txt', overwrite: false
      }
    });
    assert.equal(JSON.parse((moved.content as any[])[0].text).moved, true);
    const names = await client.callTool({
      name: 'remote_search', arguments: { query: '*.ts', mode: 'names', ignoreCase: true }
    });
    assert.deepEqual(JSON.parse((names.content as any[])[0].text), {
      query: '*.ts', mode: 'names', ignoreCase: true, agentName: 'codex',
      stdout: 'src/index.ts:1:hello'
    });
    const rejected = await client.callTool({
      name: 'remote_list', arguments: { path: 'forbidden' }
    });
    assert.equal(rejected.isError, true);
    const rejectedText = (rejected.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    assert.deepEqual(JSON.parse(rejectedText), {
      code: 'REMOTE_TOOL_ERROR', message: '路径越界'
    });
    const boundaryRejected = await client.callTool({
      name: 'remote_write', arguments: { path: '../outside.txt', content: 'blocked' }
    });
    assert.equal(boundaryRejected.isError, true);
    assert.deepEqual(JSON.parse((boundaryRejected.content as any[])[0].text), {
      nonRetryable: true,
      mustStopNow: true,
      prohibitedFallback: 'safs exec',
      code: 'WORKSPACE_BOUNDARY_VIOLATION',
      message: 'Path is outside the workspace.'
    });
    assert.deepEqual(audited.map((entry) => entry.toolName), [
      'current_remote_file', 'get_remote_workspace', 'remote_list',
      'remote_read', 'remote_edit', 'remote_download', 'remote_upload', 'remote_delete',
      'remote_chmod', 'remote_move', 'remote_search', 'remote_list', 'remote_write'
    ]);
    assert.ok(audited.every((entry) => entry.agentName === 'codex'));
    const large = await client.callTool({ name: 'run_remote_command', arguments: { command: 'large' } });
    const preview = JSON.parse((large.content as any)[0].text);
    assert.equal(preview.stdout.length, 8192);
    const remainder = await client.callTool({ name: 'remote_output', arguments: {
      outputId: preview.outputId, stream: 'stdout', offset: preview.stdoutNextOffset, length: 20000
    } });
    assert.equal(JSON.parse((remainder.content as any)[0].text).content.length, 11808);
    const starts = activity.filter((entry) => entry.phase === 'start');
    assert.ok(starts.length > 0);
    assert.ok(starts.every((entry) =>
      entry.source === 'mcp' && entry.agentName === 'codex'
    ));
    assert.ok(activity.some((entry) => entry.phase === 'error'));

  } finally {
    await client.close();
    await server.stop();
  }
});

test('allocates independent ports for concurrent window MCP servers', async () => {
  const callbacks = (name: string) => ({
    listFolders: async () => [],
    currentWorkspace: async () => ({
      name,
      workspaceUri: `safs://${name}/srv/${name}`,
      workspaceRoot: `/srv/${name}`,
      host: name
    }),
    currentFile: async () => null,
    list: async () => [],
    read: async () => ({}),
    edit: async () => ({}),
    write: async () => ({}),
    delete: async () => ({}),
    chmod: async () => ({}),
    move: async () => ({}),
    upload: async () => ({}),
    download: async () => ({}),
    search: async () => ({}),
    run: async () => ({})
  });
  const first = new AgentMcpServer(0, 'first-token', callbacks('dev1'));
  const second = new AgentMcpServer(0, 'second-token', callbacks('dev2'));
  try {
    await Promise.all([first.start(), second.start()]);
    const firstUrl = new URL(first.url);
    const secondUrl = new URL(second.url);
    assert.notEqual(firstUrl.port, '0');
    assert.notEqual(secondUrl.port, '0');
    assert.notEqual(firstUrl.port, secondUrl.port);
    assert.equal(first.running, true);
    assert.equal(second.running, true);
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});
