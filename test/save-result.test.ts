import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { adoptedRemoteSaveResult } from '../src/remote/save-result';

test('CLI receives authoritative remote content and hash without claiming a write', () => {
  const content = Buffer.from('remote contents');
  const result = adoptedRemoteSaveResult(content, 0o750);
  assert.equal(result.written, false);
  assert.equal(result.content, content.toString());
  assert.equal(result.hash, createHash('sha256').update(content).digest('hex'));
  assert.equal(result.permissions, 0o750);
  assert.equal(result.truncated, false);
});
test('large and binary remote results are bounded and explicitly encoded', () => {
  const content = Buffer.from('字'.repeat(30000));
  const result = adoptedRemoteSaveResult(content);
  assert.equal(result.truncated, true);
  assert.equal(result.nextOffset, Buffer.byteLength(result.content));
  assert.equal(content.subarray(0, result.nextOffset).toString(), result.content);
  const binary = adoptedRemoteSaveResult(Buffer.from([255, 0, 254]));
  assert.equal(binary.encoding, 'base64');
  assert.deepEqual(Buffer.from(binary.content, 'base64'), Buffer.from([255, 0, 254]));
});
