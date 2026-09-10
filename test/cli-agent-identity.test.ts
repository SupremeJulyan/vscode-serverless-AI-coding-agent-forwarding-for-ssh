import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeCliAgentName, readCliAgentIdentity, updateCliAgentIdentity
} from '../src/cli-agent-identity';

test('CLI Agent identities are versioned and retained independently by platform', () => {
  const mac = updateCliAgentIdentity(undefined, 'mac', '  Codex  ');
  const both = updateCliAgentIdentity(mac, 'linux', 'Claude Code');
  assert.equal(readCliAgentIdentity(both, 'mac'), 'Codex');
  assert.equal(readCliAgentIdentity(both, 'linux'), 'Claude Code');
  assert.equal(readCliAgentIdentity(both, 'wsl'), undefined);
  assert.equal(readCliAgentIdentity({ version: 2, agents: { mac: 'old' } }, 'mac'), undefined);
});

test('CLI Agent identity validation rejects empty, control, and oversized names', () => {
  assert.equal(normalizeCliAgentName(''), undefined);
  assert.equal(normalizeCliAgentName('bad\nname'), undefined);
  assert.equal(normalizeCliAgentName('x'.repeat(101)), undefined);
  assert.equal(normalizeCliAgentName(' 自定义 Agent '), '自定义 Agent');
  assert.throws(() => updateCliAgentIdentity(undefined, 'mac', '\t'));
});
