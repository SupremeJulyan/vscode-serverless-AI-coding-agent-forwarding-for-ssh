import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Exercise the registered handler itself with VS Code and remote I/O replaced.
async function setup() {
  const source = await readFile(new URL('../src/extension.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
  let callback = '';
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'command'
      && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'openHistoryItem') callback = node.arguments[1].getText(tree);
    ts.forEachChild(node, visit);
  };
  visit(tree); assert.ok(callback);
  const output = ts.transpileModule(`exports.handler = ${callback};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const state = { active: false, ready: true, remembered: true, stopped: false, afterReady: () => {} };
  const opened: Array<{ scheme: string; path: string }> = [];
  const notices: string[] = [];
  const exported: { handler?: (item: unknown) => Promise<void> } = {};
  const item = { mountName: 'dev', path: '/project' };
  runInNewContext(output, {
    exports: exported,
    historySyncTask: () => state.active ? { localDir: '/local/project' } : undefined,
    syncedDirectoryFor: () => state.remembered ? { localDir: '/local/project' } : undefined,
    openLocalMirror: async (path: string) => { opened.push({ scheme: 'file', path }); return true; },
    syncCoordinator: { isStopRequested: async () => state.stopped, isReady: async () => { state.afterReady(); return state.ready; } },
    bridgeOutput: { info() {} },
    aiForwardMountsKey: 'forwarding',
    vscodeContext: { globalState: { get: () => [] } },
    vscode: { window: { showInformationMessage: async (message: string) => { notices.push(message); } },
      commands: { executeCommand: async (_name: string, uri: { scheme: string; path: string }) => { opened.push(uri); } },
      Uri: { file: (path: string) => ({ scheme: 'file', path }), parse: (path: string) => ({ scheme: 'safs', path }) } },
    readConfig: async () => ({ mounts: [{ name: 'dev' }] }),
    ensureFolder: async () => ({ remoteRoot: '/' }),
    isRemotePathInsideRoot: () => true,
    localRootForFolder: () => '/placeholder',
    ensureAgentCwdSubdirectory: async () => {}, writeLastRemoteDirectory: async () => {},
    setRemoteWorkspaceDisplayRoot() {}, recordDirectoryHistory: async () => {},
    folderUri: () => 'safs://dev/project'
  });
  return { state, opened, notices, open: () => exported.handler!(item) };
}

test('disabled sync opens the remote directory even when a local pairing is remembered', async () => {
  const s = await setup(); await s.open(); assert.equal(s.opened[0].scheme, 'safs');
});

test('active, ready sync opens its local mirror', async () => {
  const s = await setup(); s.state.active = true; await s.open();
  assert.equal(s.opened[0].scheme, 'file'); assert.equal(s.opened[0].path, '/local/project');
});

test('an active initial sync waits for readiness instead of opening incomplete files', async () => {
  const s = await setup(); s.state.active = true; s.state.ready = false; await s.open();
  assert.equal(s.opened.length, 0); assert.equal(s.notices.length, 1);
});

test('stopping sync during the readiness check opens the remote directory', async () => {
  const s = await setup(); s.state.active = true; s.state.afterReady = () => { s.state.active = false; };
  await s.open(); assert.equal(s.opened[0].scheme, 'safs');
});

test('a stop request from another window takes priority over a stale live task', async () => {
  const s = await setup(); s.state.active = true; s.state.stopped = true;
  await s.open(); assert.equal(s.opened[0].scheme, 'safs');
});
