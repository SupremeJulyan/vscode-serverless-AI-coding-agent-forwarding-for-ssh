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
    assert.ok(names.includes('switch_remote_workspace'));
    assert.ok(!names.includes('remote_upload'));
    assert.ok(!names.includes('remote_delete'));
    const result = await client.callTool({ name: 'remote_output', arguments: { bindingId: 'x', outputId: 'invalid' } });
    assert.equal(result.isError, true);
  } finally { await client.close(); await server.close(); }
});

test('hybrid profile exposes only workspace binding and switching', async () => {
  const server = new McpServer({ name: 'test', version: '1' });
  registerAgentMcpTools(server, {
    routed: true,
    profile: 'hybrid',
    invoke: async () => ({ content: [] })
  });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'get_remote_workspace', 'switch_remote_workspace'
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});
