import assert from 'node:assert/strict';
import test from 'node:test';
import { saveForwardingPreference } from '../src/agent/forwarding-preference';

test('enabling forwarding waits for interface preparation before saving', async () => {
  const current = new Set(['other']);
  let complete!: (value: string) => void;
  const preparation = new Promise<string>(resolve => { complete = resolve; });
  const saved: string[][] = [];
  const operation = saveForwardingPreference(current, 'dev', true, () => preparation,
    async mounts => { saved.push(mounts); });

  assert.deepEqual(saved, []);
  complete('/cli/safs');
  assert.equal(await operation, '/cli/safs');
  assert.deepEqual(saved, [['other', 'dev']]);
  assert.deepEqual([...current], ['other']);
});

test('failed preparation leaves the forwarding preference available for retry', async () => {
  const failure = new Error('Skill setup failed');
  await assert.rejects(saveForwardingPreference(new Set(), 'dev', true,
    async () => { throw failure; },
    async () => assert.fail('saved before preparation succeeded')), failure);
});

test('disabling forwarding removes just the selected mount without preparing an interface', async () => {
  await saveForwardingPreference(new Set(['dev', 'other']), 'dev', false,
    async () => assert.fail('prepared while disabling'),
    async mounts => assert.deepEqual(mounts, ['other']));
});
