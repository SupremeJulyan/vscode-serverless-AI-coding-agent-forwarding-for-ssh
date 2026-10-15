import assert from 'node:assert/strict';
import test from 'node:test';
import { untilCancelled, UiOperationGate } from '../src/ui-operation';

function cancellation() {
  const listeners = new Set<() => void>();
  const token = {
    isCancellationRequested: false,
    onCancellationRequested(listener: () => void) {
      listeners.add(listener);
      return { dispose() { listeners.delete(listener); } };
    }
  };
  return { token, listeners, cancel() {
    token.isCancellationRequested = true;
    for (const listener of listeners) listener();
  } };
}

test('cancelling an open flow releases the UI and ignores late connection failures', async () => {
  const cancellationState = cancellation();
  let fail!: (error: Error) => void;
  const connection = new Promise<string>((_resolve, reject) => { fail = reject; });
  const flow = untilCancelled(cancellationState.token, () => connection);
  await Promise.resolve();
  cancellationState.cancel();
  assert.equal(await flow, undefined);
  assert.equal(cancellationState.listeners.size, 0);
  fail(new Error('late connection failure'));
  await new Promise((resolve) => setImmediate(resolve));
});

test('cancelled flows never start and successful flows release their cancellation listener', async () => {
  const state = cancellation();
  assert.equal(await untilCancelled(state.token, async () => 'folder'), 'folder');
  assert.equal(state.listeners.size, 0);
  state.cancel();
  assert.equal(await untilCancelled(state.token, async () => { throw new Error('must not run'); }), undefined);
});

test('duplicate UI requests share one result and failures allow a direct retry', async () => {
  const gate = new UiOperationGate();
  let finish!: () => void;
  let calls = 0;
  const first = gate.run('directory', () => {
    calls++;
    return new Promise<void>((resolve) => { finish = resolve; });
  });
  const second = gate.run('directory', async () => { calls++; });
  assert.equal(first, second);
  await Promise.resolve();
  finish();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  await assert.rejects(gate.run('directory', async () => { throw new Error('failed'); }), /failed/);
  assert.equal(await gate.run('directory', async () => 'retried'), 'retried');
});
