import assert from 'node:assert/strict';
import test from 'node:test';
import { orderedBatch } from '../src/ordered-batch';

test('reads overlap, mutations are barriers, and results preserve input order', async () => {
  const events: string[] = [];
  const result = await orderedBatch(['read-a', 'read-b', 'write', 'read-c'], item => item.startsWith('read'),
    async item => {
      events.push(`start:${item}`);
      await new Promise(resolve => setTimeout(resolve, item === 'read-a' ? 20 : 1));
      events.push(`end:${item}`);
      return item;
    });
  assert.deepEqual(result, ['read-a', 'read-b', 'write', 'read-c']);
  assert.ok(events.indexOf('start:read-b') < events.indexOf('end:read-a'));
  assert.ok(events.indexOf('start:write') > events.indexOf('end:read-a'));
  assert.ok(events.indexOf('start:read-c') > events.indexOf('end:write'));
});
