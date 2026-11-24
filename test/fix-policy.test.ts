import assert from 'node:assert/strict';
import test from 'node:test';
import { openTerminalDirectory, startTerminalForwarding } from '../src/terminal/open-terminal-directory';
import { openMountHome } from '../src/remote/open-mount-home';
import { openSelectedDirectory } from '../src/remote/open-selected-directory';
import { join } from 'node:path';
import { localWatchPatterns } from '../src/sync/local-watch-patterns';

test('terminal directory opens the resolved live directory in the current window', async () => {
  const calls: unknown[] = [];
  await openTerminalDirectory({
    probe: async () => '/live',
    publish: async cwd => { calls.push(['publish', cwd]); },
    resolve: async cwd => { calls.push(['resolve', cwd]); return '/canonical'; },
    remember: async target => { calls.push(['remember', target]); },
    open: async (target, options) => { calls.push(['open', target, options]); }
  });
  assert.deepEqual(calls, [
    ['publish', '/live'], ['resolve', '/live'], ['remember', '/canonical'],
    ['open', '/canonical', { forceReuseWindow: true }]
  ]);
});

test('a terminal directory resolution failure prevents recording and opening it', async () => {
  await assert.rejects(openTerminalDirectory({
    probe: async () => '/live',
    publish: async () => {},
    resolve: async () => { throw new Error('directory unavailable'); },
    remember: async () => assert.fail('remembered an unresolved directory'),
    open: async () => assert.fail('opened an unresolved directory')
  }), /directory unavailable/);
});

test('terminal forwarding waits for terminal preparation', async () => {
  let ready!: () => void;
  const preparation = new Promise<void>(resolve => { ready = resolve; });
  let enabled = false;
  const operation = startTerminalForwarding(() => preparation, async () => { enabled = true; });
  assert.equal(enabled, false);
  ready();
  await operation;
  assert.equal(enabled, true);
});

test('failed terminal preparation prevents enabling forwarding', async () => {
  await assert.rejects(startTerminalForwarding(
    async () => { throw new Error('terminal unavailable'); },
    async () => assert.fail('enabled forwarding after terminal preparation failed')
  ), /terminal unavailable/);
});

test('mount parent opens the login home, falling back to the mount root', async () => {
  for (const folder of [
    { remoteRoot: '/', defaultRemotePath: '/home/dev' },
    { remoteRoot: '/' }
  ]) {
    const calls: unknown[][] = [];
    await openMountHome(async () => folder, async (...args) => { calls.push(args); });
    assert.deepEqual(calls, [[folder, folder.defaultRemotePath ?? '/', true]]);
  }
  await openMountHome(async () => undefined, async () => assert.fail('opened a cancelled connection'));
});

test('remote navigation records the selected directory and chooses the requested window', async () => {
  for (const action of ['打开', '切换'] as const) {
    const calls: unknown[][] = [];
    await openSelectedDirectory(action,
      async (placeholder, mode) => {
        assert.equal(placeholder, `选择要${action}的远程连接`);
        assert.equal(mode, action);
        return '/project';
      },
      async target => { calls.push(['remember', target]); },
      async (...args) => { calls.push(['open', ...args]); });
    assert.deepEqual(calls, [['remember', '/project'], ['open', '/project', ...(action === '打开' ? [true] : [])]]);
  }
  await openSelectedDirectory('打开', async () => undefined,
    async () => assert.fail('remembered a cancelled selection'),
    async () => assert.fail('opened a cancelled selection'));
});

test('sync watcher plans cover the root entry and directory descendants', () => {
  const parent = join('local', 'mirrors');
  const root = join(parent, 'project');
  const rootEntry = { directory: parent, glob: '*' };
  assert.deepEqual(localWatchPatterns(root, true), [rootEntry]);
  for (const isFile of [false, undefined]) {
    assert.deepEqual(localWatchPatterns(root, isFile), [rootEntry, { directory: root, glob: '**/*' }]);
  }
});
