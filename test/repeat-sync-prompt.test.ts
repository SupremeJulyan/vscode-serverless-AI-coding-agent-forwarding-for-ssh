import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleRepeatSync, showRepeatSyncPrompt } from '../src/sync/repeat-sync-prompt';

test('repeat sync offers actions based on the live task and local mirror', async (t) => {
  const mirror = await mkdtemp(join(tmpdir(), 'safs-repeat-sync-'));
  t.after(() => rm(mirror, { recursive: true, force: true }));

  for (const scenario of [
    { directory: mirror, running: true, buttons: ['打开副本', '重新同步', '停止同步'], choice: '停止同步', expected: 'stop' },
    { directory: mirror, running: false, buttons: ['打开副本', '重新同步', '取消'], choice: '打开副本', expected: 'open' },
    { directory: join(mirror, 'missing'), running: false, buttons: ['重新同步', '取消'], choice: '重新同步', expected: 'resync' },
    { directory: mirror, running: false, buttons: ['打开副本', '重新同步', '取消'], choice: undefined, expected: 'cancel' }
  ]) {
    let calls = 0;
    const result = await showRepeatSyncPrompt(scenario.directory, scenario.running, async (message, options, ...buttons) => {
      calls++;
      assert.ok(message.includes(scenario.directory));
      assert.deepEqual(options, { modal: true });
      assert.deepEqual(buttons, scenario.buttons);
      return scenario.choice;
    });
    assert.equal(calls, 1);
    assert.equal(result, scenario.expected);
  }
});

test('repeat sync dispatches only the selected action and stops before resyncing', async () => {
  for (const [choice, opened, expected] of [
    ['open', true, ['open']],
    ['open', false, ['open', 'missing']],
    ['stop', false, ['stop']],
    ['resync', false, ['stop', 'resync']],
    ['cancel', false, []]
  ] as const) {
    const calls: string[] = [];
    await handleRepeatSync(Promise.resolve(choice), {
      open: async () => { calls.push('open'); return opened; },
      missingMirror: () => { calls.push('missing'); },
      stop: async () => { calls.push('stop'); },
      resync: async () => { calls.push('resync'); }
    });
    assert.deepEqual(calls, expected);
  }
});
