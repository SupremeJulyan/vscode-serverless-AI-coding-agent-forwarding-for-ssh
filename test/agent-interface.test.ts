import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAgentInterface } from '../src/agent-interface';

test('supports only mutually exclusive MCP and CLI interfaces', () => {
  assert.equal(normalizeAgentInterface('mcp'), 'mcp');
  assert.equal(normalizeAgentInterface('cli'), 'cli');
  assert.equal(normalizeAgentInterface('removed-mode'), 'mcp');
  assert.equal(normalizeAgentInterface(undefined), 'mcp');
});
