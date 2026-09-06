import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAgentMcpTools, AgentToolProfile, routedAgentMcpInstructions } from '../src/agent-mcp-tools';
import { readTextRange } from '../src/remote-read';
import { RemoteOutputStore } from '../src/remote-output';
import { readTextBatch } from '../src/remote-read-batch';

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
async function schemas(profile: AgentToolProfile) {
  const server = new McpServer({ name: 'benchmark', version: '1' });
  registerAgentMcpTools(server, { routed: true, profile, invoke: async () => ({ content: [] }) });
  const client = new Client({ name: 'benchmark', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const { tools } = await client.listTools();
    return { profile, tools: tools.length, schemaBytes: bytes(tools), instructionsBytes: Buffer.byteLength(routedAgentMcpInstructions) };
  } finally { await client.close(); await server.close(); }
}

async function main() {
  const code = Buffer.from(Array.from({ length: 1500 }, (_, i) => `export const value${i} = ${i};\n`).join(''));
  const read = (offset: number, length: number) => Promise.resolve(code.subarray(offset, offset + length));
  const full = await readTextRange(code.length, read, { path: 'code.ts', length: 65536 });
  const selected = await readTextRange(code.length, read, { path: 'code.ts', startLine: 501, lineCount: 20 });
  assert.equal(selected.content, code.toString().split('\n').slice(500, 520).join('\n') + '\n');
  const output = { exitCode: 1, stdout: 'test case passed\n'.repeat(4000), stderr: 'one assertion failed\n', truncated: false };
  const store = new RemoteOutputStore();
  const preview = store.capture(output, 'benchmark') as any;
  let restored = preview.stdout;
  let offset = preview.stdoutNextOffset;
  while (offset < Buffer.byteLength(output.stdout)) {
    const page = store.read(preview.outputId, 'benchmark', 'stdout', offset);
    restored += page.content; offset = page.nextOffset;
  }
  assert.equal(restored, output.stdout);
  assert.equal(preview.stderr, output.stderr);
  const batch = await readTextBatch(Array.from({ length: 8 }, (_, i) => ({ path: `file${i}.ts` })), 16384,
    input => readTextRange(code.length, read, input));
  assert.ok(batch.contentBytes <= 16384);
  process.stdout.write(JSON.stringify({
    note: 'Synthetic interface benchmark: UTF-8 JSON bytes, not model tokens or task success rates.',
    schemas: await Promise.all([schemas('full'), schemas('core')]),
    workloads: [
      { task: 'locate 20 code lines', fullReadBytes: bytes(full), selectedReadBytes: bytes(selected), exactEvidence: true },
      { task: 'inspect test failure', completeOutputBytes: bytes(output), previewBytes: bytes(preview), exactContinuation: true },
      { task: 'inspect eight files', contentBudget: 16384, returnedContentBytes: batch.contentBytes,
        statuses: batch.results.map(result => result.status) }
    ]
  }, null, 2) + '\n');
}
main().catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
