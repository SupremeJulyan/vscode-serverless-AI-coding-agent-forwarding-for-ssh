import assert from 'node:assert/strict';
import test from 'node:test';
import { historyOpenTarget } from '../src/sync/history-open-target';

const mirror = '/local/project';

test('disabled sync opens the remote directory without checking readiness', async () => {
  assert.deepEqual(await historyOpenTarget({
    activeLocalDirectory: () => undefined,
    isReady: () => assert.fail('readiness queried without an active mirror'),
    isStopped: () => assert.fail('stop state queried without an active mirror')
  }), { kind: 'remote' });
});

for (const [ready, expected] of [
  [true, { kind: 'local', directory: mirror }],
  [false, { kind: 'pending' }],
  [undefined, { kind: 'pending' }]
] as const) {
  test(`active sync resolves the target when readiness is ${ready}`, async () => {
    assert.deepEqual(await historyOpenTarget({
      activeLocalDirectory: () => mirror,
      isReady: async (directory) => {
        assert.equal(directory, mirror);
        return ready;
      },
      isStopped: async () => false
    }), expected);
  });
}

for (const current of [undefined, '/local/replacement']) {
  test(`mirror changing to ${current} while checking readiness opens remote`, async () => {
    let active: string | undefined = mirror;
    assert.deepEqual(await historyOpenTarget({
      activeLocalDirectory: () => active,
      isReady: async () => { active = current; return true; },
      isStopped: async () => false
    }), { kind: 'remote' });
  });
}

test('a stop request takes priority over a stale active mirror', async () => {
  assert.deepEqual(await historyOpenTarget({
    activeLocalDirectory: () => mirror,
    isReady: async () => true,
    isStopped: async () => true
  }), { kind: 'remote' });
});
