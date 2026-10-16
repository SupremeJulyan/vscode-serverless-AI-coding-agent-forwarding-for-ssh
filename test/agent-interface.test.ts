import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addRecordedMcpAgentName, normalizeAgentInterface, recordedMcpAgentNames,
  shouldCopyMcpUninstallPrompt
} from '../src/agent-interface';

test('supports only mutually exclusive MCP and CLI interfaces', () => {
  assert.equal(normalizeAgentInterface('mcp'), 'mcp');
  assert.equal(normalizeAgentInterface('cli'), 'cli');
  assert.equal(normalizeAgentInterface('removed-mode'), 'cli');
  assert.equal(normalizeAgentInterface(undefined), 'cli');
});

test('only an MCP to CLI transition copies the MCP uninstall prompt', () => {
  assert.equal(shouldCopyMcpUninstallPrompt('mcp', 'cli'), true);
  assert.equal(shouldCopyMcpUninstallPrompt('cli', 'cli'), false);
  assert.equal(shouldCopyMcpUninstallPrompt('mcp', 'mcp'), false);
  assert.equal(shouldCopyMcpUninstallPrompt('cli', 'mcp'), false);
});

test('records unique valid MCP Agent names for later uninstall guidance', () => {
  assert.deepEqual(recordedMcpAgentNames(['Codex', ' codex ', '', 3, 'Claude']), [
    'Codex', 'Claude'
  ]);
  assert.deepEqual(addRecordedMcpAgentName(['Codex'], 'Claude'), ['Codex', 'Claude']);
  assert.deepEqual(addRecordedMcpAgentName(['Codex'], 'codex'), ['Codex']);
});
