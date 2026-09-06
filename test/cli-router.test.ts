import assert from 'node:assert/strict';
import test from 'node:test';
import { unwrapCliToolResult } from '../src/agent-http-router';

test('CLI result adapter preserves structured success and tool errors', () => {
  assert.deepEqual(unwrapCliToolResult({
    content: [{ type: 'text', text: '{"path":"/remote","entries":[]}' }]
  }), { ok: true, result: { path: '/remote', entries: [] } });
  assert.deepEqual(unwrapCliToolResult({
    isError: true,
    content: [{ type: 'text', text: '{"code":"WORKSPACE_BINDING_INVALID"}' }]
  }), { ok: false, result: { code: 'WORKSPACE_BINDING_INVALID' } });
  assert.throws(() => unwrapCliToolResult({ content: [{ type: 'text', text: 'bad' }] }));
});
