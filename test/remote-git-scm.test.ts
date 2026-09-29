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

test('SCM isolates repositories, compares index vs worktree and disposes removed roots', async () => {
  const commands = new Map<string, (...args: any[]) => Promise<unknown>>();
  const sources: any[] = [];
  const errors: string[] = [];
  const executions: { root: string; command: string }[] = [];
  const opened: any[][] = [];
  const localPushes: string[] = [];
  const localPulls: string[] = [];
  const localFetches: string[] = [];
  let contentProvider: any;
  const rootA = new Uri('safs', '/placeholder/a');
  const rootB = new Uri('safs', '/placeholder/b');
  let status = 'MM file.txt\0A  added.txt\0D  deleted.txt\0R  renamed.txt\0original.txt\0UU conflict.txt\0';
  Object.assign(vscode, {
    Uri: { joinPath: (uri: Uri, file: string) => uri.with({ path: path.posix.join(uri.path, file) }) },
    EventEmitter,
    ProgressLocation: { SourceControl: 1 },
    commands: {
      registerCommand: (name: string, callback: (...args: any[]) => Promise<unknown>) => {
        commands.set(name, callback); return disposable();
      },
      executeCommand: async (...args: any[]) => { opened.push(args); }
    },
    scm: { createSourceControl: (_id: string, label: string, rootUri: Uri) => {
      const source = { label, rootUri, inputBox: { value: '' }, disposed: false,
        groups: [] as any[], dispose() { this.disposed = true; },
        createResourceGroup(id: string) {
          const group = { id, resourceStates: [], dispose() {} }; this.groups.push(group); return group;
        }
      };
      sources.push(source); return source;
    } }
  });
  Object.assign(vscode.workspace, {
    workspaceFolders: [{ uri: rootA, name: 'A' }, { uri: rootB, name: 'B' }],
    registerTextDocumentContentProvider: (_scheme: string, provider: any) => { contentProvider = provider; return disposable(); },
    onDidChangeWorkspaceFolders: disposable, onDidSaveTextDocument: disposable
  });
  Object.assign(vscode.window, {
    state: { focused: true }, onDidChangeWindowState: disposable,
    showErrorMessage: async (message: string) => { errors.push(message); },
    // 历史视图标题栏没有输入框：提交走 showInputBox，多仓库时走 showQuickPick。
    showInputBox: async (options?: { prompt?: string }) =>
      options?.prompt?.includes('创建并切换') ? 'feature/new' : 'view commit',
    showQuickPick: async (items: any[], options?: { placeHolder?: string }) =>
      options?.placeHolder?.includes('选择分支') ? items[1] : items[0],
    withProgress: async (_options: unknown, task: () => Promise<void>) => task()
  });
  const { RemoteGitScm } = require('../src/remote-git-scm') as typeof import('../src/remote-git-scm');
  let counts = '2\t3';
  const scm = new RemoteGitScm(async uri => async command => {
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
  }, message => errors.push(message), async uri => { localPushes.push(uri.path); counts = '0\t3'; },
  async uri => { localPulls.push(uri.path); }, async uri => { localFetches.push(uri.path); });
  try {
    for (let attempt = 0; attempt < 100 && sources.length < 2; attempt++) await new Promise(resolve => setImmediate(resolve));
    await scm.refresh();
    assert.equal(sources.length, 2);
    const a = sources[0];
    const b = sources[1];
    assert.match(a.statusBarCommands[1].title, /已提交待推送 ↑2.*待拉取 ↓3/);
    assert.equal(a.statusBarCommands[0].command, 'safs.git.branch');
    const index = a.groups.find((group: any) => group.id === 'index');
    const working = a.groups.find((group: any) => group.id === 'working');
    assert.equal(index.resourceStates.length, 4);
    assert.equal(working.resourceStates.length, 1);
    assert.equal(a.groups.find((group: any) => group.id === 'conflicts').resourceStates.length, 1);
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
    status = 'M  file.txt\0';
    b.inputBox.value = 'commit B';
    await commands.get('safs.git.commit')!(b);
    assert.equal(b.inputBox.value, '');
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
    assert.equal(b.statusBarCommands[1].title, '待拉取 ↓3');
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
    assert.deepEqual(errors, []);
  } finally { scm.dispose(); }
  assert.equal(sources[1].disposed, true);
});
