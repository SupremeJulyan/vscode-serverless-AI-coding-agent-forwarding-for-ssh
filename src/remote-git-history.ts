import {
  GitSyncState, readGitSyncState, syncStateLabel, syncStateTooltip
} from './git-sync-state';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { RemoteGit } from './remote-git';
import { gitSnapshotUri } from './remote-git-scm';

export const historyPageSize = 50;
/** NUL 分隔字段、RS 分隔提交：提交说明里的换行和特殊字符都不会破坏解析。 */
export const gitLogFormat = '%H%x00%P%x00%an%x00%ae%x00%at%x00%D%x00%s%x00%b%x1e';

export interface HistoryRepository {
  uri: vscode.Uri;
  name: string;
  git: RemoteGit;
  syncState?: GitSyncState;
}

export interface HistoryCommit {
  id: string;
  parents: string[];
  author: string;
  authorEmail: string;
  /** Unix 秒。 */
  timestamp: number;
  refs: string[];
  subject: string;
  body: string;
}

export interface HistoryFile { status: string; path: string; originalPath?: string }

export function parseGitLog(output: string): HistoryCommit[] {
  const commits: HistoryCommit[] = [];
  for (const record of output.split('\x1e')) {
    const value = record.replace(/^\n+/, '');
    if (!value.trim()) continue;
    const fields = value.split('\0');
    if (fields.length < 8) throw new Error('Invalid Git log output');
    const [id, parents, author, authorEmail, timestamp, decorations, subject, ...body] = fields;
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id)) throw new Error('Invalid Git commit ID');
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds)) throw new Error('Invalid Git commit timestamp');
    commits.push({
      id, parents: parents.split(' ').filter(Boolean), author, authorEmail,
      timestamp: seconds, refs: decorations.split(',').map(ref => ref.trim()).filter(Boolean),
      subject, body: body.join('\0').replace(/\n+$/, '')
    });
  }
  return commits;
}

/** `git show --name-status --format= -z` 的记录：状态与路径各占一个 NUL 字段，重命名多一个旧路径。 */
export function parseHistoryFiles(output: string): HistoryFile[] {
  const fields = output.split('\0');
  const files: HistoryFile[] = [];
  for (let i = 0; i < fields.length; i++) {
    const status = fields[i];
    if (!status) continue;
    if (!/^[A-Z][0-9]*$/.test(status)) throw new Error('Invalid Git name-status output');
    const first = fields[++i];
    if (!first) throw new Error('Incomplete Git name-status output');
    if (status.startsWith('R') || status.startsWith('C')) {
      const second = fields[++i];
      if (!second) throw new Error('Incomplete Git rename status');
      files.push({ status: status[0], path: second, originalPath: first });
    } else {
      files.push({ status: status[0], path: first });
    }
  }
  return files;
}

/** 引用装饰去掉前缀，保留可读性（`HEAD -> main` → `main`，`tag: v1` → `v1`）。 */
export function displayRefs(refs: string[]): string {
  return refs.map(ref => ref.replace(/^HEAD -> /, '').replace(/^tag: /, '')).join(', ');
}

export function relativeTime(timestamp: number): string {
  const seconds = Math.floor(Date.now() / 1000 - timestamp);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

export class RepositoryNode extends vscode.TreeItem {
  constructor(readonly repository: HistoryRepository) {
    super(repository.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `repo:${repository.uri.toString()}`;
    this.contextValue = 'safsGitRepository';
    this.iconPath = new vscode.ThemeIcon('repo');
    this.tooltip = repository.uri.toString();
  }
}

export class CommitNode extends vscode.TreeItem {
  constructor(readonly repository: HistoryRepository, readonly commit: HistoryCommit, status = '已提交 · 推送状态未知') {
    super(commit.subject || commit.id.slice(0, 8), vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `commit:${repository.uri.toString()}:${commit.id}`;
    this.contextValue = 'safsGitCommit';
    this.iconPath = new vscode.ThemeIcon(status === '待拉取' ? 'cloud-download' : status === '已推送' ? 'check' : 'git-commit');
    const refs = displayRefs(commit.refs);
    this.description = [status, refs, commit.id.slice(0, 8), relativeTime(commit.timestamp), commit.author]
      .filter(Boolean).join(' · ');
    this.tooltip = [status, commit.subject, '', commit.id, `${commit.author} <${commit.authorEmail}>`,
      new Date(commit.timestamp * 1000).toISOString(), refs, commit.body].filter(Boolean).join('\n');
  }
}

export class FileNode extends vscode.TreeItem {
  constructor(readonly repository: HistoryRepository, readonly commit: HistoryCommit, readonly file: HistoryFile) {
    super(file.path, vscode.TreeItemCollapsibleState.None);
    this.id = `file:${repository.uri.toString()}:${commit.id}:${file.path}`;
    this.contextValue = 'safsGitCommitFile';
    this.description = file.originalPath ? `${file.status} ← ${file.originalPath}` : file.status;
    this.iconPath = new vscode.ThemeIcon(
      file.status === 'A' ? 'diff-added' : file.status === 'D' ? 'diff-removed'
        : file.status === 'R' ? 'diff-renamed' : 'diff-modified');
    const parent = commit.parents[0];
    const original = file.originalPath ?? file.path;
    const left = file.status === 'A' || !parent
      ? gitSnapshotUri(repository.uri, original, '', true)
      : gitSnapshotUri(repository.uri, original, parent);
    const right = file.status === 'D'
      ? gitSnapshotUri(repository.uri, file.path, '', true)
      : gitSnapshotUri(repository.uri, file.path, commit.id);
    this.command = {
      command: 'vscode.diff', title: '查看提交改动',
      arguments: [left, right, `${path.posix.basename(file.path)} (${commit.id.slice(0, 8)})`]
    };
  }
}

class MessageNode extends vscode.TreeItem {
  constructor(message: string, icon = 'info') {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'safsGitMessage';
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

class LoadMoreNode extends vscode.TreeItem {
  constructor(repository: HistoryRepository) {
    super('加载更多…', vscode.TreeItemCollapsibleState.None);
    this.id = `more:${repository.uri.toString()}`;
    this.iconPath = new vscode.ThemeIcon('ellipsis');
    this.command = { command: 'safs.git.loadMoreCommits', title: '加载更多', arguments: [repository.uri] };
  }
}

export type HistoryNode = RepositoryNode | CommitNode | FileNode | MessageNode | LoadMoreNode;

/** 远端 `git log` 的树视图；只在展开时取数据，分页与提交文件都做缓存。 */
export class RemoteGitHistory implements vscode.TreeDataProvider<HistoryNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<HistoryNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly cache = new Map<string, {
    limit: number; commits: HistoryCommit[]; labels?: Map<string, string>; summary?: MessageNode; files: Map<string, HistoryFile[]>;
  }>();

  constructor(
    private readonly repositories: () => HistoryRepository[],
    private readonly log: (message: string) => void,
    onRepositoriesChanged?: vscode.Event<void>,
    onHistoryChanged?: vscode.Event<void>
  ) {
    this.subscriptions.push(this.emitter);
    this.subscriptions.push(vscode.window.createTreeView('safs.gitHistory', {
      treeDataProvider: this, showCollapseAll: true
    }));
    this.subscriptions.push(vscode.commands.registerCommand('safs.git.refreshHistory', () => this.refresh()));
    this.subscriptions.push(vscode.commands.registerCommand('safs.git.loadMoreCommits', (uri: vscode.Uri) => {
      const state = this.state(uri);
      state.limit += historyPageSize;
      state.commits = [];
      this.emitter.fire(undefined);
    }));
    this.subscriptions.push(vscode.commands.registerCommand('safs.git.copyCommitId', async (node?: HistoryNode) => {
      if (!(node instanceof CommitNode)) return;
      await vscode.env.clipboard.writeText(node.commit.id);
      void vscode.window.showInformationMessage(`SAFS Git: 已复制提交 ID ${node.commit.id.slice(0, 8)}。`);
    }));
    if (onRepositoriesChanged) {
      this.subscriptions.push(onRepositoriesChanged(() => {
        this.cache.clear();
        this.emitter.fire(undefined);
      }));
    }
    if (onHistoryChanged) {
      this.subscriptions.push(onHistoryChanged(() => {
        this.cache.clear();
        this.emitter.fire(undefined);
      }));
    }
  }

  refresh(): void {
    this.cache.clear();
    this.emitter.fire(undefined);
  }

  getTreeItem(node: HistoryNode): vscode.TreeItem { return node; }

  async getChildren(node?: HistoryNode): Promise<HistoryNode[]> {
    try {
      return await this.children(node);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`SAFS Git View：${message}`);
      return [new MessageNode(message, 'warning')];
    }
  }

  private async children(node?: HistoryNode): Promise<HistoryNode[]> {
    const repositories = this.repositories();
    if (!node) {
      // 没有仓库时返回空，让 VS Code 显示视图欢迎页（viewsWelcome）。
      if (!repositories.length) return [];
      // 单个仓库直接列提交；多仓库先分组，避免把不同仓库的历史混在一起。
      return repositories.length === 1 ? this.commitNodes(repositories[0]) : repositories.map(
        repository => new RepositoryNode(repository));
    }
    if (node instanceof RepositoryNode) return this.commitNodes(node.repository);
    if (node instanceof CommitNode) return this.fileNodes(node.repository, node.commit);
    return [];
  }

  private async commitNodes(repository: HistoryRepository): Promise<HistoryNode[]> {
    const state = this.state(repository.uri);
    if (!state.commits.length) {
      const sync = repository.syncState ?? await readGitSyncState(repository.git);
      state.summary = new MessageNode(syncStateLabel(sync), sync.behind ? 'cloud-download' : 'info');
      state.summary.tooltip = syncStateTooltip(sync);
      state.summary.command = { command: 'safs.git.fetch', title: '提取上游更新', arguments: [repository.uri] };
      state.labels = new Map();
      if (sync.kind === 'unborn') return [state.summary];
      const revisions = sync.head && sync.upstreamOid && !sync.observedUpstream
        ? [sync.head, sync.upstreamOid] : sync.head ? [sync.head] : ['--all'];
      const commits = parseGitLog(await repository.git.run([
        'log', ...revisions, '--date-order', `--max-count=${state.limit}`, `--pretty=format:${gitLogFormat}`
      ]));
      if (sync.head && sync.upstreamOid && !sync.observedUpstream) {
        const differences = await repository.git.run(['rev-list', '--left-right', `${sync.head}...${sync.upstreamOid}`]);
        const outgoing = new Set<string>();
        const incoming = new Set<string>();
        for (const line of differences.trim().split('\n').filter(Boolean)) {
          if (!/^[<>][a-f0-9]{40,64}$/.test(line)) throw new Error('Invalid Git revision comparison');
          (line[0] === '<' ? outgoing : incoming).add(line.slice(1));
        }
        for (const commit of commits) state.labels.set(commit.id,
          outgoing.has(commit.id) ? '已提交待推送' : incoming.has(commit.id) ? '待拉取' : '已推送');
      } else if (sync.observedUpstream) {
        for (const commit of commits) state.labels.set(commit.id, '已推送');
      } else {
        for (const commit of commits) state.labels.set(commit.id, '已提交 · 推送状态未知');
      }
      state.commits = commits;
    }
    if (this.state(repository.uri) !== state) return this.commitNodes(repository);
    const nodes: HistoryNode[] = state.summary ? [state.summary] : [];
    nodes.push(...state.commits.map(commit => new CommitNode(repository, commit, state.labels?.get(commit.id))));
    if (state.commits.length >= state.limit) nodes.push(new LoadMoreNode(repository));
    return nodes;
  }

  private async fileNodes(repository: HistoryRepository, commit: HistoryCommit): Promise<HistoryNode[]> {
    const state = this.state(repository.uri);
    let files = state.files.get(commit.id);
    if (!files) {
      const root = commit.parents.length ? [] : ['--root'];
      files = parseHistoryFiles(await repository.git.run([
        'show', '--name-status', '--format=', '-z', '-M', ...root, commit.id
      ]));
      state.files.set(commit.id, files);
    }
    return files.map(file => new FileNode(repository, commit, file));
  }

  private state(uri: vscode.Uri) {
    const key = uri.toString();
    let state = this.cache.get(key);
    if (!state) {
      state = { limit: historyPageSize, commits: [], files: new Map() };
      this.cache.set(key, state);
    }
    return state;
  }

  dispose(): void {
    this.subscriptions.forEach(subscription => subscription.dispose());
    this.subscriptions.length = 0;
    this.cache.clear();
  }
}
