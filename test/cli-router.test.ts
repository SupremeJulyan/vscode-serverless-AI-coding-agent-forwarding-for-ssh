import assert from 'node:assert/strict';
import test from 'node:test';
import { unwrapCliToolResult } from '../src/agent/agent-ipc-router';

test('CLI result adapter preserves structured success and tool errors', () => {
  assert.deepEqual(unwrapCliToolResult({
    ok: true, result: { path: '/remote', entries: [] }
  }), { ok: true, result: { path: '/remote', entries: [] } });
  assert.deepEqual(unwrapCliToolResult({
    ok: false, error: { code: 'REMOTE_WORKSPACE_NOT_FOUND' }
  }), { ok: false, result: { code: 'REMOTE_WORKSPACE_NOT_FOUND' } });
  assert.deepEqual(unwrapCliToolResult({
    ok: true, result: null
  }, true), { ok: true, result: null });
  assert.throws(() => unwrapCliToolResult({ content: [{ type: 'text', text: 'bad' }] }));
});
