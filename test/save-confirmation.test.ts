import assert from 'node:assert/strict';
import test from 'node:test';
import { SaveConfirmation } from '../src/remote/save-confirmation';
const data = Buffer.from('new content');

test('confirmed save clears memory without any local recovery file', async () => {
  const saves = new SaveConfirmation();
  await saves.run('file', data, 0o750, async () => {}, () => true);
  assert.equal(saves.attempts.size, 0);
});

test('failed save blocks replay until content and permissions match', async () => {
  const saves = new SaveConfirmation();
  await assert.rejects(saves.run('file', data, 0o750, async () => { throw new Error('connection reset'); }, () => true));
  await assert.rejects(saves.run('file', data, 0o750, async () => {}, () => true), /尚未确认/);
  assert.equal(await saves.verify('file', async () => ({ content: data, permissions: 0o644 })), 'remote');
  assert.equal(saves.attempts.size, 0);
  await assert.rejects(saves.run('file', data, 0o750, async () => { throw new Error('lost response'); }, () => true));
  assert.equal(await saves.verify('file', async () => ({ content: Buffer.from('remote version'), permissions: 0o750 })), 'remote');
  assert.equal(saves.attempts.size, 0);
  await assert.rejects(saves.run('file', data, 0o750, async () => { throw new Error('lost response'); }, () => true));
  assert.equal(await saves.verify('file', async () => ({ content: data, permissions: 0o750 })), 'matched');
  assert.equal(saves.attempts.size, 0);
});

test('explicit retry succeeds after failed save and timeout does not clear a late write', async () => {
  const saves = new SaveConfirmation(10);
  let release!: () => void;
  await assert.rejects(saves.run('file', data, 0o600, async () => new Promise<void>(resolve => { release = resolve; }), () => true), /超时/);
  await assert.rejects(saves.run('file', data, 0o600, async () => {}, () => true, true), /尚未确认/);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(saves.attempts.size, 1);
  await saves.run('file', data, 0o600, async () => {}, () => true, true);
  assert.equal(saves.attempts.size, 0);
});

test('disconnect aborts the write, preserves content and permits inspection after it settles', async () => {
  const saves = new SaveConfirmation(2000);
  let connected = true;
  const operation = saves.run('file', data, 0o600, signal => new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), () => connected);
  connected = false;
  await assert.rejects(operation, /断开/);
  assert.deepEqual(saves.attempts.get('file')?.content, data);
  await new Promise(resolve => setImmediate(resolve));
  saves.discard('file');
  assert.equal(saves.attempts.size, 0);
});
