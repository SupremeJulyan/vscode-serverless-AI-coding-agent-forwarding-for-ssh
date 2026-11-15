import assert from 'node:assert/strict';
import test from 'node:test';
import { handleNotification } from '../src/ui/notification';
import { UiOperationGate } from '../src/ui/ui-operation';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('an unclosed error notification does not hold the command gate or block retry', async () => {
  const gate = new UiOperationGate();
  let select!: (value: string | undefined) => void;
  const notification = new Promise<string | undefined>(resolve => { select = resolve; });
  let openedLog = false;
  await gate.run('openDirectory', async () => {
    handleNotification(notification, () => { openedLog = true; }, error => { throw error; });
  });
  assert.equal(await gate.run('openDirectory', async () => 'retried'), 'retried');
  assert.equal(openedLog, false);
  select('查看日志'); await tick(); assert.equal(openedLog, true);
});

test('dismissing a notification never runs its optional action', async () => {
  let ran = false;
  handleNotification(Promise.resolve(undefined), () => { ran = true; }, () => {});
  await tick(); assert.equal(ran, false);
});

test('notification and optional-action failures are handled without an unhandled rejection', async () => {
  const errors: string[] = [];
  handleNotification(Promise.reject(new Error('notification failed')), () => {}, error => errors.push(String(error)));
  handleNotification(Promise.resolve('open'), async () => { throw new Error('action failed'); }, error => errors.push(String(error)));
  await tick(); assert.equal(errors.length, 2);
});
