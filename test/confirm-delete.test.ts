import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmDelete, deleteSyncHistory } from '../src/ui/confirm-delete';

test('connected configuration deletion requires explicit disconnect and delete', async () => {
  for (const selection of [undefined, '删除', '断开并删除']) {
    assert.equal(await confirmDelete(async (_message, options, button) => {
      assert.deepEqual(options, { modal: true });
      assert.equal(button, '断开并删除');
      return selection;
    }, '账号仍在使用中', '断开并删除'), selection === '断开并删除');
  }
});

test('history deletion stops active sync and forgets the pair only after confirmation', async () => {
  for (const syncing of [false, true]) {
    for (const confirmed of [false, true]) {
      const calls: string[] = [];
      await deleteSyncHistory('/project', syncing, async (message, options, button) => {
        assert.match(message, /\/project/);
        assert.deepEqual(options, { modal: true });
        calls.push('confirm');
        return confirmed ? button : undefined;
      }, {
        stop: async () => { calls.push('stop'); },
        removeHistory: async () => { calls.push('history'); },
        removePair: async () => { calls.push('pair'); },
        refresh: () => { calls.push('refresh'); }
      });
      assert.deepEqual(calls, confirmed
        ? ['confirm', ...(syncing ? ['stop'] : []), 'history', 'pair', 'refresh']
        : ['confirm']);
    }
  }
});
