import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldCopyMcpUninstallPrompt } from '../src/mcp/agent-interface';
import { autoPrepareCli, uninstallPreparedCli } from '../src/cli/auto-prepare';

test('CLI startup honors explicit uninstall and only prompts on the first eligible run', async () => {
  const defaults = { enabled: true, disabled: false, checked: false, skippedNode: false };
  for (const [changes, expected] of [
    [{}, ['checked', true]],
    [{ checked: true }, ['checked', false]],
    [{ skippedNode: true }, ['checked', false]],
    [{ disabled: true }, []],
    [{ enabled: false }, []]
  ] as const) {
    const calls: Array<string | boolean> = [];
    await autoPrepareCli({ ...defaults, ...changes },
      async () => { calls.push('checked'); },
      interactive => { calls.push(interactive); });
    assert.deepEqual(calls, expected);
  }
});

test('CLI uninstall disables automatic preparation and drains pending setup before removal', async () => {
  const calls: string[] = [];
  const path = await uninstallPreparedCli(
    async () => { calls.push('disable'); },
    async () => { calls.push('invalidate'); },
    async () => { calls.push('remove'); return '/cli/safs'; }
  );
  assert.equal(path, '/cli/safs');
  assert.deepEqual(calls, ['disable', 'invalidate', 'remove']);
});

test('CLI cleanup does not race a preparation that could not be invalidated', async () => {
  await assert.rejects(uninstallPreparedCli(
    async () => {},
    async () => { throw new Error('invalidation failed'); },
    async () => assert.fail('removed before invalidation')
  ), /invalidation failed/);
});

test('only the focused window prompts to remove MCP when switching to CLI', () => {
  for (const previous of ['mcp', 'cli'] as const) {
    for (const next of ['mcp', 'cli'] as const) {
      for (const focused of [true, false]) {
        assert.equal(shouldCopyMcpUninstallPrompt(previous, next, focused),
          focused && previous === 'mcp' && next === 'cli');
      }
    }
  }
});
