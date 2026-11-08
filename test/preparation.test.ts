import assert from 'node:assert/strict';
import test from 'node:test';
import { Preparation } from '../src/shared/preparation';

test('background and foreground callers share preparation and reuse its success', async () => {
  const preparation = new Preparation<number>();
  let calls = 0;
  let finish!: (value: number) => void;
  const factory = () => { calls++; return new Promise<number>(resolve => { finish = resolve; }); };
  const background = preparation.get(factory);
  const foreground = preparation.get(factory);
  const repairWhileRunning = preparation.get(factory, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  finish(42);
  assert.deepEqual(await Promise.all([background, foreground, repairWhileRunning]), [42, 42, 42]);
  assert.equal(await preparation.get(factory), 42);
  assert.equal(calls, 1);
  assert.equal(await preparation.get(async () => { calls++; return 43; }, true), 43);
  assert.equal(calls, 2);
});

test('failed background preparation permits a later explicit retry', async () => {
  const preparation = new Preparation<string>();
  await assert.rejects(preparation.get(async () => { throw new Error('runtime unavailable'); }));
  assert.equal(await preparation.get(async () => 'ready'), 'ready');
});

test('uninstall waits for preparation and clears the cached result', async () => {
  const preparation = new Preparation<string>();
  let finish!: (value: string) => void;
  const pending = preparation.get(() => new Promise<string>(resolve => { finish = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  let invalidated = false;
  const invalidation = preparation.invalidate().then(() => { invalidated = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(invalidated, false);
  finish('installed'); await pending; await invalidation;
  assert.equal(await preparation.get(async () => 'reinstalled'), 'reinstalled');
});
