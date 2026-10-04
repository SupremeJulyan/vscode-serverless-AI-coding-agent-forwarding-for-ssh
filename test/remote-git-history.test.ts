import { mockGitBatch } from './git-runner-helper';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { RemoteGit, GitRunner } from '../src/remote-git';

const vscode = require('vscode');

class TreeItem {
  id?: string;
  description?: string;
  tooltip?: string;
  contextValue?: string;
  iconPath?: unknown;
  command?: unknown;
  collapsibleState?: number;
  constructor(public label: string, state?: number) { this.collapsibleState = state; }
}
class ThemeIcon { constructor(readonly id: string) {} }
class EventEmitter<T> {
  private readonly listeners: ((value: T) => void)[] = [];
  readonly event = (listener: (value: T) => void) => {
    this.listeners.push(listener);
    return { dispose() {} };
  };
  fire(value: T) { for (const listener of [...this.listeners]) listener(value); }
  dispose() { this.listeners.length = 0; }
}
class Uri {
  constructor(readonly scheme: string, readonly path: string, readonly query = '', readonly authority = 'host') {}
  toString() { return `${this.scheme}://${this.authority}${this.path}?${this.query}`; }
  with(values: Partial<Uri>) {
    return new Uri(values.scheme ?? this.scheme, values.path ?? this.path, values.query ?? this.query, this.authority);
  }
}

const commands = new Map<string, (...args: any[]) => Promise<unknown>>();
const copied: string[] = [];
Object.assign(vscode, {
  TreeItem, ThemeIcon, EventEmitter, Uri,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  window: {
    createTreeView: () => ({ dispose() {} }),
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined
  },
  commands: {
    registerCommand: (name: string, callback: (...args: any[]) => Promise<unknown>) => {
      commands.set(name, callback); return { dispose() {} };
    }
  },
  env: { clipboard: { writeText: async (value: string) => { copied.push(value); } } },
  workspace: { getConfiguration: () => ({ get: (_name: string, fallback: unknown) => fallback }) }
});

const {
  RemoteGitHistory, parseGitLog, parseHistoryFiles, displayRefs, relativeTime
} = require('../src/remote-git-history') as typeof import('../src/remote-git-history');

const commitId = (seed: string) => seed.repeat(40).slice(0, 40);
const idFor = (index: number) => index.toString(16).padStart(40, '0');
const first = commitId('a');
const second = commitId('b');

function logRecord(id: string, parents: string, subject: string, decorations = '', body = '') {
  return [id, parents, 'Alice', 'alice@example.test', '1700000000', decorations, subject, body].join('\0') + '\x1e\n';
}

function repository(outputs: { log?: string | ((limit: number) => string); show?: string; fail?: string }) {
  const seen: string[] = [];
  const runner: GitRunner = async command => {
    seen.push(command);
    if (outputs.fail && command.includes(`'${outputs.fail}'`)) {
      return { exitCode: 128, stdout: '', stderr: `fatal: ${outputs.fail} failed` };
    }
    if (command.includes("'symbolic-ref'")) return { exitCode: 0, stdout: 'main\n', stderr: '' };
    if (command.includes("'rev-parse'")) return { exitCode: 0, stdout: first + '\n', stderr: '' };
    if (command.includes("'for-each-ref'")) return { exitCode: 0, stdout: '', stderr: '' };
    if (command.includes("'log'")) {
      // 假 git 也要认 --max-count，分页断言才有意义。
      const limit = Number(/--max-count=(\d+)/.exec(command)?.[1] ?? '0');
      const log = typeof outputs.log === 'function' ? outputs.log(limit) : outputs.log ?? '';
      return { exitCode: 0, stdout: log, stderr: '' };
    }
    if (command.includes("'show'")) return { exitCode: 0, stdout: outputs.show ?? '', stderr: '' };
    return { exitCode: 1, stdout: '', stderr: `unexpected: ${command}` };
  };
  return { git: new RemoteGit(mockGitBatch(runner)), seen, uri: new Uri('safs', '/repo'), name: 'repo' };
}

test('parses git log records with refs, bodies and separators', () => {
  const output = logRecord(first, '', 'first subject', 'HEAD -> main, tag: v1')
    + logRecord(second, first, 'second subject', '', 'body line 1\nbody line 2');
  const commits = parseGitLog(output);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].id, first);
  assert.deepEqual(commits[0].parents, []);
  assert.deepEqual(commits[0].refs, ['HEAD -> main', 'tag: v1']);
  assert.equal(displayRefs(commits[0].refs), 'main, v1');
  assert.equal(commits[1].parents[0], first);
  assert.equal(commits[1].body, 'body line 1\nbody line 2');
  assert.equal(commits[1].author, 'Alice');
  assert.equal(commits[1].timestamp, 1700000000);
  assert.throws(() => parseGitLog('nope\0\0\0\0\0\0\0\0\x1e'), /commit ID/);
  assert.throws(() => parseGitLog([first, '', 'a', 'a@b', 'not-a-time', '', 's', ''].join('\0') + '\x1e'), /timestamp/);
  assert.throws(() => parseGitLog(`${first}\0\0\x1e`), /log output/);
});

test('parses name-status records including renames and copies', () => {
  const output = ['M', 'src/a.ts', 'A', 'src/b.ts', 'D', 'src/c.ts', 'R100', 'src/old.ts', 'src/new.ts', 'C75', 'src/copy.ts', 'src/clone.ts', '']
    .join('\0');
  const files = parseHistoryFiles(output);
  assert.deepEqual(files, [
    { status: 'M', path: 'src/a.ts' },
    { status: 'A', path: 'src/b.ts' },
    { status: 'D', path: 'src/c.ts' },
    { status: 'R', path: 'src/new.ts', originalPath: 'src/old.ts' },
    { status: 'C', path: 'src/clone.ts', originalPath: 'src/copy.ts' }
  ]);
  assert.throws(() => parseHistoryFiles(['M', 'a.ts', '?', 'b.ts'].join('\0')), /name-status/);
  assert.throws(() => parseHistoryFiles('M\0'), /Incomplete/);
});

test('tree lists commits, expands files into diffs and pages further', async () => {
  const log = logRecord(first, '', 'first subject', 'HEAD -> main')
    + logRecord(second, first, 'second subject');
  const show = ['M', 'src/a.ts', 'A', 'src/b.ts', 'D', 'src/c.ts', 'R100', 'src/old.ts', 'src/new.ts', ''].join('\0');
  const remote = repository({ log, show });
  const history = new RemoteGitHistory(() => [remote], () => {});
  try {
    const roots = await history.getChildren();
    assert.equal(roots.length, 3);
    const root = roots[1] as any;
    assert.equal(root.label, 'first subject');
    assert.match(root.description, /main/);
    assert.match(root.description, /Alice/);
    assert.match(root.description, new RegExp(first.slice(0, 8)));
    assert.equal(root.contextValue, 'safsGitCommit');

    // roots[1] 的父提交是 roots[0]：改动两侧分别取父提交与本提交。
    const commit = roots[2] as any;
    const files = await history.getChildren(commit) as any[];
    assert.deepEqual(files.map(file => [file.file.status, file.file.path]), [
      ['M', 'src/a.ts'], ['A', 'src/b.ts'], ['D', 'src/c.ts'], ['R', 'src/new.ts']
    ]);
    const modified = files[0].command;
    assert.equal(modified.command, 'vscode.diff');
    assert.deepEqual(JSON.parse(modified.arguments[0].query), {
      repository: remote.uri.toString(), ref: first, file: 'src/a.ts', empty: false
    });
    assert.deepEqual(JSON.parse(modified.arguments[1].query), {
      repository: remote.uri.toString(), ref: second, file: 'src/a.ts', empty: false
    });
    const added = files[1].command;
    assert.equal(JSON.parse(added.arguments[0].query).empty, true);
    assert.equal(JSON.parse(added.arguments[1].query).ref, second);
    const removed = files[2].command;
    assert.equal(JSON.parse(removed.arguments[1].query).empty, true);
    assert.equal(JSON.parse(removed.arguments[0].query).ref, first);
    const renamed = files[3].command;
    assert.equal(JSON.parse(renamed.arguments[0].query).file, 'src/old.ts');
    assert.equal(JSON.parse(renamed.arguments[1].query).file, 'src/new.ts');

    // 提交文件按提交缓存，重复展开不再打远端。
    const before = remote.seen.length;
    await history.getChildren(commit);
    assert.equal(remote.seen.length, before);
  } finally { history.dispose(); }
});

test('tree pages commits and groups multiple repositories', async t => {
  const { historyPageSize } = require('../src/remote-git-history') as typeof import('../src/remote-git-history');
  const all = Array.from({ length: 150 }, (_, index) =>
    logRecord(idFor(index), index === 149 ? '' : idFor(index + 1), `subject ${index}`));
  const remote = repository({ log: limit => all.slice(0, limit).join(''), show: '' });
  const history = new RemoteGitHistory(() => [remote], () => {});
  try {
    const roots = await history.getChildren() as any[];
    assert.equal(roots.length, historyPageSize + 2);
    assert.equal(roots.at(-1).label, '加载更多…');
    assert.ok(remote.seen.at(-1)!.includes(`--max-count=${historyPageSize}`));
    await commands.get('safs.git.loadMoreCommits')!(remote.uri);
    const paged = await history.getChildren() as any[];
    assert.equal(paged.length, historyPageSize * 2 + 2);
    assert.ok(remote.seen.at(-1)!.includes(`--max-count=${historyPageSize * 2}`));
    assert.equal(paged.at(-1).label, '加载更多…');
  } finally { history.dispose(); }

  const firstRepository = repository({ log: logRecord(commitId('c'), '', 'one'), show: '' });
  const secondRepository = repository({ log: logRecord(commitId('d'), '', 'two'), show: '' });
  const grouped = new RemoteGitHistory(() => [firstRepository, secondRepository], () => {});
  try {
    const roots = await grouped.getChildren() as any[];
    assert.deepEqual(roots.map(node => node.label), ['repo', 'repo']);
    const children = await grouped.getChildren(roots[1]) as any[];
    assert.equal(children[1].label, 'two');
  } finally { grouped.dispose(); }
});

test('tree reports conflicts and copy command uses the commit id', async () => {
  const logs: string[] = [];
  const remote = repository({ fail: 'log' });
  const history = new RemoteGitHistory(() => [remote], message => logs.push(message));
  try {
    const roots = await history.getChildren() as any[];
    assert.equal(roots.length, 1);
    assert.match(roots[0].label, /log failed/);
    assert.equal(roots[0].contextValue, 'safsGitMessage');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /SAFS Git View/);
  } finally { history.dispose(); }

  const withLog = repository({ log: logRecord(first, '', 'subject'), show: '' });
  const copyHistory = new RemoteGitHistory(() => [withLog], () => {});
  try {
    const [, commit] = await copyHistory.getChildren() as any[];
    await commands.get('safs.git.copyCommitId')!(commit);
    assert.deepEqual(copied, [first]);
    await commands.get('safs.git.copyCommitId')!(undefined);
    assert.deepEqual(copied, [first]);
  } finally { copyHistory.dispose(); }

  assert.equal(relativeTime(Math.floor(Date.now() / 1000) - 5), '刚刚');
  assert.equal(relativeTime(Math.floor(Date.now() / 1000) - 3600 * 5), '5 小时前');
  assert.equal(relativeTime(1600000000), '2020-09-13');
  assert.equal(path.posix.basename('/repo/src/a.ts'), 'a.ts');
});

test('history labels outgoing, incoming and shared commits and invalidates after fetch', async () => {
  const outgoing = commitId('a'), incoming = commitId('b'), common = commitId('c');
  let counts = '1\t1';
  let differences = `<${outgoing}\n>${incoming}\n`;
  const git = new RemoteGit(mockGitBatch(async command => {
    let stdout = '';
    if (command.includes("'symbolic-ref'")) stdout = 'main';
    else if (command.includes("'for-each-ref'")) stdout = 'refs/remotes/origin/main';
    else if (command.includes("'rev-parse'")) stdout = command.includes('HEAD^{commit}') ? outgoing : incoming;
    else if (command.includes("'rev-list'")) stdout = command.includes("'--count'") ? counts : differences;
    else if (command.includes("'log'")) stdout = logRecord(outgoing, common, 'local') + logRecord(incoming, common, 'server') + logRecord(common, '', 'shared');
    return { exitCode: 0, stdout, stderr: '' };
  }));
  const changed = new EventEmitter<void>();
  const repo = { git, uri: new Uri('safs', '/status'), name: 'status' };
  const history = new RemoteGitHistory(() => [repo], () => {}, undefined, changed.event);
  try {
    let nodes = await history.getChildren() as any[];
    assert.match(nodes[0].label, /已提交待推送 ↑1.*待拉取 ↓1/);
    assert.match(nodes[1].description, /^已提交待推送/);
    assert.match(nodes[2].description, /^待拉取/);
    assert.match(nodes[3].description, /^已推送/);
    assert.match(nodes[0].tooltip, /最近一次/);
    counts = '0\t0'; differences = '';
    changed.fire();
    nodes = await history.getChildren() as any[];
    assert.match(nodes[0].label, /与上游同步/);
    assert.ok(nodes.slice(1).every(node => node.description.startsWith('已推送')));
  } finally { history.dispose(); }
});
