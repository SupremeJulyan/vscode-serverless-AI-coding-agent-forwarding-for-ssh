import assert from 'node:assert/strict';
import test from 'node:test';
import { legacyAgentInterfaceMigrationTarget } from '../src/agent-interface';

test('migrates only the legacy explicit MCP setting once', () => {
  assert.equal(legacyAgentInterfaceMigrationTarget('mcp', false), 'hybrid');
  assert.equal(legacyAgentInterfaceMigrationTarget('mcp', true), undefined);
  assert.equal(legacyAgentInterfaceMigrationTarget('cli', false), undefined);
  assert.equal(legacyAgentInterfaceMigrationTarget('hybrid', false), undefined);
  assert.equal(legacyAgentInterfaceMigrationTarget(undefined, false), undefined);
});
