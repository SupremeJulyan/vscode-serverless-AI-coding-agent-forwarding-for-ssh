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
    withProgress: async (_options: unknown, task: () => Promise<void>) => task()
  });
  const { RemoteGitScm } = require('../src/remote-git-scm') as typeof import('../src/remote-git-scm');
  const scm = new RemoteGitScm(async uri => async command => {
    executions.push({ root: uri.path, command });
    let stdout = '';
    if (command.includes("'status'")) stdout = status;
    if (command.includes("'symbolic-ref'")) stdout = 'main\n';
    if (command.includes("'show'")) stdout = 'snapshot\n';
    return { exitCode: 0, stdout, stderr: '' };
  }, message => errors.push(message), async uri => { localPushes.push(uri.path); },
  async uri => { localPulls.push(uri.path); });
  try {
    for (let attempt = 0; attempt < 100 && sources.length < 2; attempt++) await new Promise(resolve => setImmediate(resolve));
    await scm.refresh();
    assert.equal(sources.length, 2);
    const a = sources[0];
    const b = sources[1];
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
    await commands.get('safs.git.push')!(b);
    assert.deepEqual(localPushes, [rootB.path]);
    assert.ok(!executions.some(command => command.command.includes("'push'")));
    await commands.get('safs.git.pull')!(a);
    assert.deepEqual(localPulls, [rootA.path]);
    assert.ok(!executions.some(command => command.command.includes("'pull'")));
    vscode.workspace.workspaceFolders = [{ uri: rootB, name: 'B' }];
    await scm.refresh();
    assert.equal(a.disposed, true);
    assert.equal(b.disposed, false);
    assert.deepEqual(errors, []);
  } finally { scm.dispose(); }
  assert.equal(sources[1].disposed, true);
});
