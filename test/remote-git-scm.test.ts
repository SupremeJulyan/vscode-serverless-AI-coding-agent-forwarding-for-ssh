import { syncStateLabel } from '../src/git/git-sync-state';
import { listBranches } from '../src/git/remote-git-branch';
import { mockGitBatch } from './git-runner-helper';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';

const vscode = require('vscode');
class Uri {
  constructor(readonly scheme: string, readonly path: string, readonly query = '', readonly authority = 'host') {}
  toString() { return `${this.scheme}://${this.authority}${this.path}?${this.query}`; }
  with(values: Partial<Uri>) { return new Uri(values.scheme ?? this.scheme, values.path ?? this.path, values.query ?? this.query, this.authority); }
}
const disposable = () => ({ dispose() {} });
class EventEmitter {
  private readonly listeners: (() => void)[] = [];
  readonly event = (listener: () => void) => { this.listeners.push(listener); return disposable(); };
  fire() { for (const listener of [...this.listeners]) listener(); }
  dispose() { this.listeners.length = 0; }
}

test('SAFS sidebar isolates repositories, compares index vs worktree and disposes removed roots', async () => {
  const commands = new Map<string, (...args: any[]) => Promise<unknown>>();
  const sources: any[] = [];
  const errors: string[] = [];
  const metrics: string[] = [];
  const warnings: string[] = [];
  const executions: { root: string; command: string }[] = [];
  const opened: any[][] = [];
  const localPushes: string[] = [];
  const localPulls: string[] = [];
  const localFetches: string[] = [];
  let contentProvider: any;
  let saveDocument: (document: { uri: Uri }) => void;
  let changeWindowState: (state: { focused: boolean }) => void;
  const rootA = new Uri('safs', '/placeholder/a');
  const rootB = new Uri('safs', '/placeholder/b');
  let status = 'MM file.txt\0A  added.txt\0D  deleted.txt\0R  renamed.txt\0original.txt\0UU conflict.txt\0';
  Object.assign(vscode, {
    Uri: { joinPath: (uri: Uri, file: string) => uri.with({ path: path.posix.join(uri.path, file) }) },
    EventEmitter,
    TreeItem: class { constructor(public label: string, public collapsibleState?: number) {} },
    ThemeIcon: class { constructor(public id: string) {} },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ProgressLocation: { Notification: 1 },
    commands: {
      registerCommand: (name: string, callback: (...args: any[]) => Promise<unknown>) => {
        commands.set(name, callback); return disposable();
      },
      executeCommand: async (...args: any[]) => { opened.push(args); }
    },
    scm: { createSourceControl: () => { throw new Error('Must not register native SCM repositories'); } }

  });
  Object.assign(vscode.workspace, {
    workspaceFolders: [{ uri: rootA, name: 'A' }, { uri: rootB, name: 'B' }],
    registerTextDocumentContentProvider: (_scheme: string, provider: any) => { contentProvider = provider; return disposable(); },
    onDidChangeWorkspaceFolders: disposable,
    onDidSaveTextDocument: (listener: typeof saveDocument) => { saveDocument = listener; return disposable(); }
  });
  Object.assign(vscode.window, {
    createTreeView: (_id: string, _options: unknown) => disposable(),
    state: { focused: true },
    onDidChangeWindowState: (listener: typeof changeWindowState) => { changeWindowState = listener; return disposable(); },
    showErrorMessage: async (message: string) => { errors.push(message); },
    showWarningMessage: async (message: string) => { warnings.push(message); return '还原更改'; },
    // 历史视图标题栏没有输入框：提交走 showInputBox，多仓库时走 showQuickPick。
    showInputBox: async (options?: { prompt?: string; value?: string }) =>
      options?.prompt?.includes('创建并切换') ? 'feature/new' : options?.value || 'view commit',
    showQuickPick: async (items: any[], options?: { placeHolder?: string }) =>
      options?.placeHolder?.includes('选择分支') ? items[1] : items[0],
    withProgress: async (_options: unknown, task: (progress: unknown, token: unknown) => Promise<void>) => task({}, { onCancellationRequested: disposable })
  });
  const { RemoteGitScm } = require('../src/git/remote-git-scm') as typeof import('../src/git/remote-git-scm');
  let counts = '2\t3';
  const scm = new RemoteGitScm(async uri => mockGitBatch(async command => {
    executions.push({ root: uri.path, command });
    let stdout = '';
    if (command.includes("'status'")) stdout = status;
    if (command.includes("'symbolic-ref'")) stdout = 'main\n';
    if (command.includes("'show'")) stdout = 'snapshot\n';
    if (command.includes("'rev-parse'") && !command.includes("'--show-prefix'")) stdout = 'a'.repeat(40);
    if (command.includes("'for-each-ref'") && command.includes('%00')) {
      stdout = 'refs/heads/main\0main\0*\0\nrefs/heads/topic\0topic\0 \0\n';
    } else if (command.includes("'for-each-ref'")) stdout = 'refs/remotes/origin/main';
    if (command.includes("'rev-list'")) stdout = counts;
    return { exitCode: 0, stdout, stderr: '' };
  }), message => (message.startsWith('[Performance]') ? metrics : errors).push(message), async uri => { localPushes.push(uri.path); counts = '0\t3'; },
  async uri => { localPulls.push(uri.path); }, async uri => { localFetches.push(uri.path); });
  try {
    for (let attempt = 0; attempt < 100 && scm.repositoriesForView().length < 2; attempt++) await new Promise(resolve => setImmediate(resolve));
    await scm.refresh();
    sources.push(...scm.repositoriesForView());
    assert.equal(sources.length, 2);
    const a = sources[0];
    const b = sources[1];
    assert.match(syncStateLabel(a.syncState), /已提交待推送 ↑2.*待拉取 ↓3/);
    const branches = await listBranches(a.git);
    assert.equal(branches.length, 2);
    assert.equal(branches[0].current, true);
    assert.equal(branches[1].current, false);
    await commands.get('safs.git.checkoutBranch')!({kind:'branch',repository:a,branch:branches[1]});
    assert.ok(executions.some(value => value.root === rootA.path && value.command.includes("'switch' 'topic'")));
    const index = a.index;
    const working = a.working;
    assert.equal(index.resourceStates.length, 4);
    assert.equal(working.resourceStates.length, 1);
    assert.equal(a.conflicts.resourceStates.length, 1);
    const automaticRefreshStart = executions.length;
    await scm.refresh();
    assert.ok(executions.slice(automaticRefreshStart).some(command => command.command.includes("'status'")));
    assert.ok(executions.slice(automaticRefreshStart).every(command =>
      !command.command.includes("'symbolic-ref'") && !command.command.includes("'rev-list'")));
    const manualRefreshStart = executions.length;
    await commands.get('safs.git.refresh')!();
    assert.ok(executions.slice(manualRefreshStart).some(command => command.command.includes("'symbolic-ref'")));
    await commands.get('safs.git.openChange')!(working.resourceStates[0]);
    const diff = opened.at(-1)!;
    assert.equal(diff[0], 'vscode.diff');
    assert.equal(JSON.parse(diff[1].query).ref, '');
    assert.equal(diff[2].scheme, 'safs');
    await commands.get('safs.git.openChange')!(index.resourceStates[3]);
    assert.equal(JSON.parse(opened.at(-1)![1].query).file, 'original.txt');
    await commands.get('safs.git.openChange')!(index.resourceStates[1]);
    assert.equal(await contentProvider.provideTextDocumentContent(opened.at(-1)![1]), '');
    const before = executions.length;
    await commands.get('safs.git.stage')!(working.resourceStates[0]);
    assert.ok(executions.slice(before).every(command => command.root === rootA.path));
    assert.ok(executions.slice(before).some(command => command.command.includes("'add' '--' 'file.txt'")));
    assert.ok(executions.slice(before).some(command => command.command.includes("'status'")));
    assert.ok(executions.slice(before).every(command =>
      !command.command.includes("'symbolic-ref'") && !command.command.includes("'rev-list'")));
    const discardStart = executions.length;
    await commands.get('safs.git.discard')!(working.resourceStates[0]);
    assert.ok(executions.slice(discardStart).some(command =>
      command.root === rootA.path && command.command.includes("'restore' '--worktree' '--' 'file.txt'")));
    assert.match(warnings[0], /file\.txt/);
    status = 'M  file.txt\0';
    b.message = 'commit B';
    await commands.get('safs.git.commit')!(b);
    assert.equal(b.message, '');
    assert.ok(executions.some(command => command.root === rootB.path && command.command.includes("'commit' '-m' 'commit B'")));
    // 历史视图标题栏触发：没有 SourceControl 上下文，先选仓库（单选走 QuickPick）再问提交说明。
    await commands.get('safs.git.commit')!();
    assert.ok(executions.some(command => command.root === rootA.path && command.command.includes("'commit' '-m' 'view commit'")));
    await commands.get('safs.git.branch')!(a);
    assert.equal(opened.at(-1)?.[0], 'safs.git.switchBranch');
    assert.equal(opened.at(-1)?.[1], a);
    const switchStart = executions.length;
    await commands.get('safs.git.switchBranch')!(a);
    assert.ok(executions.slice(switchStart).some(command =>
      command.root === rootA.path && command.command.includes("'switch' 'topic'")));
    assert.ok(executions.slice(switchStart).every(command => !/fetch|pull/.test(command.command)));
    const createStart = executions.length;
    await commands.get('safs.git.createBranch')!(a);
    assert.ok(executions.slice(createStart).some(command =>
      command.root === rootA.path && command.command.includes("'switch' '-c' 'feature/new'")));
    assert.ok(executions.slice(createStart).every(command => !/fetch|pull|--force/.test(command.command)));
    await commands.get('safs.git.push')!(b);
    assert.deepEqual(localPushes, [rootB.path]);
    assert.match(syncStateLabel(b.syncState), /待拉取 ↓3/);
    assert.ok(!executions.some(command => command.command.includes("'push'")));
    await commands.get('safs.git.pull')!(a);
    assert.deepEqual(localPulls, [rootA.path]);
    assert.ok(!executions.some(command => command.command.includes("'pull'")));
    let historyEvents = 0;
    const listener = scm.onDidChangeHistory(() => { historyEvents++; });
    await commands.get('safs.git.fetch')!(a);
    assert.ok(historyEvents > 0);
    listener.dispose();
    assert.deepEqual(localFetches, [rootA.path]);
    assert.ok(!executions.some(command => command.command.includes("'fetch'")));
    vscode.workspace.workspaceFolders = [{ uri: rootB, name: 'B' }];
    await scm.refresh();
    assert.equal(a.disposed, true);
    assert.equal(b.disposed, false);
    const waitForStatus = async (expected: string) => {
      for (let attempt = 0; attempt < 300 && b.working.resourceStates[0]?.change.path !== expected; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(b.working.resourceStates[0]?.change.path, expected);
    };
    const backgroundStart = executions.length;
    status = ' M saved.txt\0';
    saveDocument!({ uri: rootB.with({ path: `${rootB.path}/saved.txt` }) });
    saveDocument!({ uri: rootB.with({ path: `${rootB.path}/saved.txt` }) });
    await waitForStatus('saved.txt');
    assert.equal(executions.slice(backgroundStart).filter(command => command.command.includes("'status'")).length, 1);
    status = '?? external.txt\0';
    await waitForStatus('external.txt');
    vscode.window.state.focused = false;
    status = ' M focused.txt\0';
    const pausedStart = executions.length;
    await new Promise(resolve => setTimeout(resolve, 2100));
    assert.equal(executions.length, pausedStart);
    vscode.window.state.focused = true;
    changeWindowState!({ focused: true });
    await waitForStatus('focused.txt');
    assert.ok(executions.slice(backgroundStart).every(command =>
      !command.command.includes("'symbolic-ref'") && !command.command.includes("'rev-list'")));
    assert.deepEqual(errors, []);
    assert.ok(metrics.length > 0);
  } finally { scm.dispose(); }
  assert.equal(sources[1].disposed, true);
});

test('sidebar discovery caches scans and refreshes nested repositories without native SCM registration', async () => {
  const commands = new Map<string, (...args: any[]) => Promise<unknown>>();
  const root = new Uri('safs', '/parent');
  let names = ['one', 'two'];
  let scans = 0;
  Object.assign(vscode.workspace, { workspaceFolders: [{ uri: root, name: 'parent' }] });
  Object.assign(vscode.commands, {
    registerCommand: (name: string, callback: (...args: any[]) => Promise<unknown>) => {
      commands.set(name, callback); return disposable();
    }
  });
  const { RemoteGitScm } = require('../src/git/remote-git-scm') as typeof import('../src/git/remote-git-scm');
  const controller = new RemoteGitScm(async () => mockGitBatch(async command => ({
    exitCode: 0, stderr: '', stdout: command.includes("'symbolic-ref'") ? 'main\n'
      : command.includes("'HEAD^{commit}'") ? 'a'.repeat(40) : ''
  })), () => {}, async () => {}, async () => {}, async () => {}, undefined, async (_uri, signal) => {
    signal.throwIfAborted(); scans++;
    return names.map(name => ({ name, uri: root.with({ path: `/parent/${name}` }) })) as any;
  });
  try {
    for (let i = 0; i < 100 && controller.repositoriesInUse().length < 2; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(controller.repositoriesInUse().length, 2);
    await controller.refresh();
    assert.equal(scans, 1);
    names = ['two', 'three'];
    await commands.get('safs.git.refresh')!();
    assert.equal(scans, 2);
    assert.deepEqual(controller.repositoriesInUse().map(repo => repo.name), names);
  } finally { controller.dispose(); }
});
