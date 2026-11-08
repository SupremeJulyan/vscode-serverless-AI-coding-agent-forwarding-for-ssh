import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateBackendCommandPolicy, readBackendCommandPolicySettings
} from '../src/security/command-policy';

test('reads command policy with deny as the fail-safe action', () => {
  const values: Record<string, unknown> = {
    highRiskCommandAction: 'confirm',
    highRiskCommandPatterns: ['danger']
  };
  const policy = readBackendCommandPolicySettings({
    get: <T>(section: string, fallback: T) => (values[section] as T | undefined) ?? fallback
  });
  assert.deepEqual(policy, { patterns: ['danger'], action: 'deny' });
});

test('marks each CLI command with one audit outcome', () => {
  const denied = evaluateBackendCommandPolicy('sudo token=secret', 'cli', {
    patterns: ['sudo'], action: 'deny'
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.auditSource, 'high_risk_denied');
  assert.equal(denied.matched, 'sudo');
  assert.ok(!denied.redactedCommand.includes('secret'));

  const allowed = evaluateBackendCommandPolicy('sudo true', 'cli', {
    patterns: ['sudo'], action: 'allow'
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.auditSource, 'high_risk_allowed');

  const search = evaluateBackendCommandPolicy('sudo true', 'remote_search', {
    patterns: ['sudo'], action: 'deny'
  });
  assert.deepEqual(search, {
    allowed: true,
    auditSource: 'remote_search',
    redactedCommand: 'sudo true'
  });
});
