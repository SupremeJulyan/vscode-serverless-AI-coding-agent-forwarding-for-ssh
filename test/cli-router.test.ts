import assert from 'node:assert/strict';
import test from 'node:test';
import { unwrapCliToolResult } from '../src/agent-http-router';

test('CLI result adapter preserves structured success and tool errors', () => {
  assert.deepEqual(unwrapCliToolResult({
    content: [{ type: 'text', text: '{"path":"/remote","entries":[]}' }]
  }), { ok: true, result: { path: '/remote', entries: [] } });
  assert.deepEqual(unwrapCliToolResult({
    isError: true,
    content: [{ type: 'text', text: '{"code":"REMOTE_WORKSPACE_NOT_FOUND"}' }]
  }), { ok: false, result: { code: 'REMOTE_WORKSPACE_NOT_FOUND' } });
  assert.deepEqual(unwrapCliToolResult({
    content: [{ type: 'text', text: 'null' }]
  }, true), { ok: true, result: null });
  assert.throws(() => unwrapCliToolResult({ content: [{ type: 'text', text: 'bad' }] }));
});
