import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigLiveReload, configChanges } from '../src/config/config-live-reload';
import { parseConfig } from '../src/config/config';

const config = (label = 'dev', port = 22) => parseConfig({ hosts: [{ name: label, ip: 'example.com', accounts: [{ user: 'alice', auth: 'password', port }] }] });

test('a saved host rename applies immediately and preserves the endpoint identity', async () => {
  const first = config(); const next = config('renamed'); let applied = false;
  const loader = new ConfigLiveReload(first, async () => next, async (previous, current) => {
    const delta = configChanges(previous, current);
    assert.equal(delta.renamed.get('dev(alice)'), 'renamed(alice)');
    assert.equal(delta.invalidated.length, 0); applied = true;
  });
  await loader.refresh(); assert.equal(applied, true);
});

test('port, authentication and key changes invalidate the old connection, while labels alone do not', () => {
  const first = config();
  assert.equal(configChanges(first, config('dev', 2200)).invalidated.length, 1);
  const changed = config(); changed.hosts[0].auth = 'publickey'; changed.hosts[0].private_key_path = '/old/key';
  assert.equal(configChanges(first, changed).invalidated.length, 1);
  const key = structuredClone(changed); key.hosts[0].private_key_path = '/new/key';
  assert.equal(configChanges(changed, key).invalidated.length, 1);
  assert.equal(configChanges(first, config('renamed')).invalidated.length, 0);
});

test('deleted accounts are invalidated and newly added accounts appear in the next snapshot', () => {
  const first = config(); const empty = parseConfig({ hosts: [] });
  assert.equal(configChanges(first, empty).invalidated.length, 1);
  assert.equal(configChanges(empty, first).invalidated.length, 0);
});

test('invalid saved config preserves the last successful snapshot and the next save recovers', async () => {
  let next = config('next'); let fail = true; const previousNames: string[] = [];
  const loader = new ConfigLiveReload(config(), async () => { if (fail) throw new Error('invalid JSON'); return next; }, async previous => { previousNames.push(previous!.hosts[0].name); });
  await assert.rejects(loader.refresh(), /invalid JSON/);
  fail = false; await loader.refresh(); assert.deepEqual(previousNames, ['dev(alice)']);
  next = config('last'); await loader.refresh(); assert.deepEqual(previousNames, ['dev(alice)', 'next(alice)']);
});

test('duplicate filesystem and save events do not repeat connection cleanup', async () => {
  let calls = 0; const next = config('next');
  const loader = new ConfigLiveReload(config(), async () => next, async () => { calls++; });
  await Promise.all([loader.refresh(), loader.refresh(), loader.refresh()]);
  await loader.refresh(); assert.equal(calls, 1);
});

test('a newer save supersedes an older read still in flight', async () => {
  let complete!: (value: ReturnType<typeof config>) => void; let reads = 0; const applied: string[] = [];
  const loader = new ConfigLiveReload(config(), async () => {
    if (++reads === 1) return new Promise(resolve => { complete = resolve; });
    return config('latest');
  }, async (_previous, next) => { applied.push(next.hosts[0].name); });
  const old = loader.refresh(); await Promise.resolve(); await Promise.resolve();
  const latest = loader.refresh(); complete(config('stale'));
  await Promise.all([old, latest]); assert.deepEqual(applied, ['latest(alice)']);
});

test('saving a key selected by the first login does not revoke that same handshake', () => {
  const before = config(); before.hosts[0].auth = 'publickey';
  const after = structuredClone(before); after.hosts[0].private_key_path = '/selected/key';
  assert.equal(configChanges(before, after).invalidated.length, 0);
  after.hosts[0].port = 2222;
  assert.equal(configChanges(before, after).invalidated.length, 1);
});
