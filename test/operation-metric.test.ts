import assert from 'node:assert/strict';
import test from 'node:test';
import { operationMetric } from '../src/operation-metric';

test('performance diagnostics expose only numeric measurements and never fail operations', () => {
  let output = '';
  operationMetric(line => { output = line; }, 'git.bundle.download', performance.now(), 1024);
  const value = JSON.parse(output.replace('[Performance] ', ''));
  assert.equal(value.phase, 'git.bundle.download');
  assert.equal(value.bytes, 1024);
  assert.ok(value.elapsedMs >= 0);
  assert.deepEqual(Object.keys(value), ['phase', 'elapsedMs', 'bytes']);
  assert.doesNotThrow(() => operationMetric(() => { throw new Error('log unavailable'); }, 'test', performance.now()));
});
