import assert from 'node:assert/strict';
import test from 'node:test';
import { startAndRecordSyncMirror, startDownloadMirror, startUploadedMirror } from '../src/sync/start-sync-mirror';

for (const started of [true, false]) {
  test(`publishes history and the pair only after successful sync (started=${started})`, async () => {
    const calls: string[] = [];
    const result = await startAndRecordSyncMirror({
      clearReady: async () => { calls.push('clear readiness'); },
      clearStop: async () => { calls.push('clear stop request'); },
      start: async () => { calls.push('start'); return started; },
      recordHistory: async () => { calls.push('history'); },
      recordPair: async () => { calls.push('pair'); },
      refresh: () => { calls.push('refresh'); }
    });
    assert.equal(result, started);
    assert.deepEqual(calls, [
      'clear readiness', 'clear stop request', 'start',
      ...(started ? ['history', 'pair', 'refresh'] : [])
    ]);
  });
}

test('upload sync scans the uploaded tree before starting the mirror', async () => {
  const calls: string[] = [];
  const baseline = ['f:a:3:1'];
  assert.equal(await startUploadedMirror(
    async () => { calls.push('upload'); return true; },
    async () => { calls.push('scan'); return baseline; },
    async lines => {
      calls.push('start');
      assert.equal(lines, baseline);
      return true;
    }
  ), true);
  assert.deepEqual(calls, ['upload', 'scan', 'start']);
  assert.equal(await startUploadedMirror(async () => false,
    async () => assert.fail('scanned without an upload'),
    async () => assert.fail('started without an upload')), false);
});

test('download sync respects cancellation and passes the selected reset mode', async () => {
  for (const choice of [undefined, false, true]) {
    const started: boolean[] = [];
    assert.equal(await startDownloadMirror(async () => choice,
      async reset => { started.push(reset); return true; }), choice !== undefined);
    assert.deepEqual(started, choice === undefined ? [] : [choice]);
  }
});
