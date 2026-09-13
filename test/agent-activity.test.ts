import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentActivityStore, agentActivityLimit, summarizeAgentActivityInput
} from '../src/agent-activity';
import { activityViewHtml } from '../src/agent-activity-view';

class MemoryState {
  readonly values = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }
  async update(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
}

test('activity summaries retain metadata without file contents or command output', () => {
  const write = summarizeAgentActivityInput('remote_write', {
    path: 'secret.txt', content: 'TOP SECRET SOURCE'
  });
  assert.deepEqual(write, { path: 'secret.txt', contentBytes: 17 });
  assert.equal(JSON.stringify(write).includes('TOP SECRET'), false);

  const edit = summarizeAgentActivityInput('remote_edit', {
    path: 'src/app.ts', edits: [{ oldText: 'private source', newText: 'new source' }]
  });
  assert.deepEqual(edit, { path: 'src/app.ts', editCount: 1 });
  assert.equal(JSON.stringify(edit).includes('private source'), false);

  const command = summarizeAgentActivityInput('run_remote_command', {
    remoteCwd: '/srv/app', command: 'curl --token top-secret https://example.test'
  });
  assert.equal(command.remoteCwd, '/srv/app');
  assert.equal(command.command, 'curl --token <hidden> https://example.test');
});

test('activity lifecycle persists bounded events and redacts failures', async () => {
  const state = new MemoryState();
  let now = Date.parse('2026-09-11T01:00:00.000Z');
  const store = new AgentActivityStore(state, 'activity', () => new Date(now));
  await store.initialize();
  const first = store.start({
    source: 'cli', agentName: 'Codex', toolName: 'remote_write',
    input: { path: 'README.md', content: 'new source' }, mountName: 'dev',
    workspaceRoot: '/srv/project'
  });
  now += 250;
  store.fail(first, new Error('request token=secret failed'));
  const failed = store.snapshot()[0];
  assert.equal(failed.status, 'error');
  assert.equal(failed.durationMs, 250);
  assert.equal(failed.error, 'request token=<hidden> failed');

  for (let index = 0; index < agentActivityLimit + 5; index += 1) {
    const id = store.start({
      source: 'mcp', agentName: 'Claude', toolName: 'remote_read',
      input: { path: `src/${index}.ts` }, mountName: 'dev', workspaceRoot: '/srv/project'
    });
    store.succeed(id, { content: 'must not persist', truncated: false });
  }
  await store.flush();
  const stored = state.get<any[]>('activity', []);
  assert.equal(stored.length, agentActivityLimit);
  assert.equal(JSON.stringify(stored).includes('must not persist'), false);
  store.dispose();
});

test('reload marks unfinished activity as interrupted', async () => {
  const state = new MemoryState();
  state.values.set('activity', [{
    version: 1, id: 'running', source: 'mcp', agentName: 'Codex', toolName: 'remote_search',
    category: 'read', status: 'running', startedAt: '2026-09-11T01:00:00.000Z',
    mountName: 'dev', workspaceRoot: '/srv/project', summary: { query: 'TODO' }
  }]);
  const store = new AgentActivityStore(
    state, 'activity', () => new Date('2026-09-11T01:00:02.500Z')
  );
  await store.initialize();
  const restored = store.snapshot()[0];
  assert.equal(restored.status, 'interrupted');
  assert.equal(restored.durationMs, 2500);
  assert.match(restored.error ?? '', /关闭或重载/);
  store.dispose();
});

test('activity Webview uses a strict CSP and exposes timeline controls', () => {
  const html = activityViewHtml({ cspSource: 'vscode-webview://activity' } as any);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-/);
  assert.equal(html.includes('https://'), false);
  assert.equal(html.includes('暂停弹幕'), false);
  assert.equal(html.includes('恢复弹幕'), false);
  assert.equal(html.includes('关键操作会在这里显示'), false);
  assert.equal(html.includes('最近关键操作'), false);
  assert.match(html, /class="orb-frame"/);
  assert.match(html, /class="orb-wave"/);
  assert.equal(html.includes("orb.textContent = kind"), false);
  assert.match(html, /全部类型/);
  assert.match(html, /type: 'clear'/);
  assert.match(html, /prefers-reduced-motion/);
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});
