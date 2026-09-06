import assert from 'node:assert/strict';
import test from 'node:test';
import { readTextBatch } from '../src/remote-read-batch';

test('batch budget bounds content and preserves partial failures and unattempted items', async () => {
  const calls: string[] = [];
  const result = await readTextBatch(['bad', 'a', 'b', 'c'].map(path => ({ path })), 8, async input => {
    calls.push(input.path);
    if (input.path === 'bad') throw new Error('missing');
    return { content: 'abcd'.slice(0, input.length), truncated: false };
  });
  assert.deepEqual(calls, ['bad', 'a', 'b']);
  assert.deepEqual(result.results.map(r => r.status), ['error', 'ok', 'ok', 'not_read']);
  assert.equal(result.contentBytes, 8);
});
