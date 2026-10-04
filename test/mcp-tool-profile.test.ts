import assert from 'node:assert/strict';
import test from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAgentMcpTools } from '../src/agent-mcp-tools';

test('core profile keeps typed editing and output continuation but omits extended tools', async () => {
  const server = new McpServer({ name: 'test', version: '1' });
  registerAgentMcpTools(server, { routed: true, profile: 'core', invoke: async () => ({ content: [] }) });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    assert.ok(names.includes('remote_edit'));
    assert.ok(names.includes('remote_output'));
    assert.ok(names.includes('list_remote_workspaces'));
    assert.ok(!names.includes('remote_upload'));
    assert.ok(!names.includes('remote_delete'));
    const result = await client.callTool({ name: 'remote_output', arguments: { workspaceId: 'x', outputId: 'invalid' } });
    assert.equal(result.isError, true);
  } finally { await client.close(); await server.close(); }
});

test('terminal profile exposes exactly one command tool without workspace selector or cwd inputs', async () => {
  const server = new McpServer({ name: 'test', version: '1' });
  registerAgentMcpTools(server, {
    routed: true,
    profile: 'terminal',
    invoke: async () => ({ content: [] })
  });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ['run_remote_command']);
    assert.deepEqual(Object.keys(tools[0].inputSchema.properties ?? {}), ['command']);
    assert.deepEqual(tools[0].inputSchema.required, ['command']);
  } finally {
    await client.close();
    await server.close();
  }
});

test('full MCP tool contracts document overloaded inputs and bounded transfers', async () => {
  const server = new McpServer({ name: 'test', version: '1' });
  registerAgentMcpTools(server, {
    routed: true,
    profile: 'full',
    invoke: async () => ({ content: [] })
  });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const { tools } = await client.listTools();
    const byName = (name: string) => tools.find((tool) => tool.name === name)!;
    assert.match(byName('remote_list').description ?? '', /never combine paths with path or cursor/);
    assert.match(byName('remote_write').description ?? '', /parent directory must already exist/);
    assert.match(byName('run_remote_command').description ?? '', /nonzero exitCode means/);
    assert.match(byName('current_remote_file').description ?? '', /modified, dirty, and exists/);
    assert.equal(
      ((byName('remote_upload').inputSchema.properties as any).localPaths.maxItems),
      100
    );
  } finally {
    await client.close();
    await server.close();
  }
});
