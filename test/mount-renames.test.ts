import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeHostNames } from '../src/config/normalize-host-names';
import { collectMountAliases, resolveMountAlias } from '../src/config/mount-aliases';
import { renameLiveMounts } from '../src/config/rename-live-mounts';
import { renameDirectoryHistory, renameEnabledMounts, renameMountEntries } from '../src/config/rename-mount-state';

test('normalizes legacy host names and assigns distinct names to matching display labels', () => {
  const config = {
    host_aliases: { '192.0.2.10': '开发', '192.0.2.11': '开发' },
    mounts: [],
    hosts: [
      { name: 'alice_dev', user: 'alice', ip: '192.0.2.10' },
      { name: 'alice_other', user: 'alice', ip: '192.0.2.11' },
      { name: 'old-empty', user: '', ip: '192.0.2.12' }
    ]
  };
  assert.deepEqual([...normalizeHostNames(config)], [
    ['alice_dev', '开发(alice)'], ['alice_other', '开发(alice)#2'], ['old-empty', '192.0.2.12']
  ]);
  assert.deepEqual(config.hosts.map(host => host.name), ['开发(alice)', '开发(alice)#2', '192.0.2.12']);
  assert.equal(normalizeHostNames(config).size, 0);
});

test('migration tolerates uninitialized services and renames live registry and pool entries when present', async () => {
  const names = new Map([['old', 'new']]);
  await renameLiveMounts(names, {});
  const events: string[][] = [];
  await renameLiveMounts(names, {
    registry: { rename: (from, to) => events.push(['registry', from, to]) },
    pool: { rename: (from, to) => events.push(['pool', from, to]) }
  });
  assert.deepEqual(events, [['registry', 'old', 'new'], ['pool', 'old', 'new']]);
});

test('mount renames merge bounded history and migrate forwarding and sync records', () => {
  const names = new Map([['old', 'new']]);
  const history = { old: ['/shared', '/previous', '/overflow'], new: ['/current', '/shared'], other: ['/keep'] };
  assert.deepEqual(renameDirectoryHistory(history, names, 3), {
    new: ['/current', '/shared', '/previous'], other: ['/keep']
  });
  assert.deepEqual(history.old, ['/shared', '/previous', '/overflow']);
  assert.equal(renameDirectoryHistory({ other: ['/keep'] }, names, 3), undefined);
  assert.deepEqual(renameEnabledMounts(['old', 'other', 'new'], names), ['new', 'other']);

  const task = { mountName: 'old', remotePath: '/work', localDir: '/mirror', fingerprintLines: ['a'] };
  const pair = { mountName: 'old', remotePath: '/work', localDir: '/mirror' };
  const unrelated = { ...pair, mountName: 'other' };
  assert.deepEqual(renameMountEntries([task], names), [{ ...task, mountName: 'new' }]);
  assert.deepEqual(renameMountEntries([pair, unrelated], names), [{ ...pair, mountName: 'new' }, unrelated]);
});

test('legacy mount aliases recover old names while existing hosts and mounts take priority', () => {
  const host = { name: 'dev(alice)', ip: '192.0.2.10', user: 'alice' };
  const config = { hosts: [host], mounts: [], host_aliases: { [host.ip]: 'dev' } };
  const aliases = collectMountAliases(config);
  assert.equal(resolveMountAlias('alice_dev', config, aliases), host.name);
  assert.equal(resolveMountAlias('unknown', config, aliases), 'unknown');
  const existing = { ...config, hosts: [...config.hosts, { ...host, name: 'alice_dev' }] };
  assert.equal(collectMountAliases(existing).has('alice_dev'), false);
  assert.equal(resolveMountAlias('alice_dev', existing, aliases), 'alice_dev');
  assert.equal(resolveMountAlias('alice_dev', {
    ...config, mounts: [{ name: 'alice_dev', host: host.name, remote_path: '/' }]
  }, aliases), 'alice_dev');
});
