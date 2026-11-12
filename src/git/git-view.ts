import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { RemoteGitScm, Repository } from './remote-git-scm';
import { CommitNode, FileNode, RemoteGitHistory, RepositoryNode } from './remote-git-history';
import { GitBranch, listBranches } from './remote-git-branch';
import { syncStateLabel, syncStateTooltip } from './git-sync-state';
import { describeGitOperationError } from './git-error';

export interface GitSetupInput {
  mode: 'init' | 'clone'; target: string; name: string; email: string; url: string; directory: string;
}
interface Inspector {
  generation: number; loaded: boolean; pending?: Promise<void>; commits: CommitNode[];
  branches: GitBranch[]; files: Map<string, FileNode[]>; error?: string;
  pushed: Set<string>; pulled: Set<string>;
}

/** The Tabby Git interface, hosted as one VS Code Source Control webview. */
export class RemoteGitView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly inspectors = new Map<string, Inspector>();
  private readonly operations = new Map<string, AbortController>();
  private readonly errors = new Map<string, string>();
  private scheduled?: ReturnType<typeof setTimeout>;
  private revision = 0;
  private lastState = '';
  private disposed = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: RemoteGitScm,
    private readonly history: RemoteGitHistory,
    private readonly actions: {
      root(uri: vscode.Uri): string;
      setup(input: GitSetupInput, signal: AbortSignal, report: (message: string) => void): Promise<void>;
    }
  ) {
    this.subscriptions.push(controller.onDidChangeStatus(() => this.schedule()),
      controller.onDidChangeRepositories(() => this.schedule()),
      controller.onDidChangeHistory(() => {
        for (const inspector of this.inspectors.values()) { inspector.generation++; inspector.loaded = false; }
        this.schedule();
      }), history.onDidChangeTreeData(() => {
        for (const inspector of this.inspectors.values()) { inspector.generation++; inspector.loaded = false; }
        this.schedule();
      }));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.lastState = '';
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = gitViewHtml(view.webview, this.extensionUri);
    this.subscriptions.push(view.onDidDispose(() => { if (this.view === view) this.view = undefined; }),
      view.webview.onDidReceiveMessage(message => {
        void this.receive(message).catch(error => this.post({ type: 'error', message: describeGitOperationError(error) }));
      }));
  }

  private post(message: unknown): void { void this.view?.webview.postMessage(message); }
  private schedule(): void {
    if (this.disposed || !this.view || this.scheduled) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined;
      void this.publish().catch(error => this.post({ type: 'error', message: describeGitOperationError(error) }));
    }, 30);
  }

  private inspector(key: string): Inspector {
    let value = this.inspectors.get(key);
    if (!value) {
      value = { generation: 0, loaded: false, commits: [], branches: [], files: new Map(), pushed: new Set(), pulled: new Set() };
      this.inspectors.set(key, value);
    }
    return value;
  }

  private async load(repository: Repository): Promise<void> {
    const inspector = this.inspector(repository.uri.toString());
    if (inspector.loaded) return;
    if (inspector.pending) {
      await inspector.pending;
      if (!inspector.loaded && !this.disposed && !repository.disposed) await this.load(repository);
      return;
    }
    const generation = inspector.generation;
    inspector.pending = (async () => {
      try {
        await repository.queue;
        const [nodes, branches] = await Promise.all([
          this.history.getChildren(new RepositoryNode(repository)), listBranches(repository.git)
        ]);
        if (generation !== inspector.generation || repository.disposed) return;
        inspector.commits = nodes.filter((node): node is CommitNode => node instanceof CommitNode);
        inspector.branches = branches.filter(branch => branch.kind === 'local');
        inspector.error = nodes.find(node => node.contextValue === 'safsGitMessage' && node.iconPath instanceof vscode.ThemeIcon && node.iconPath.id === 'warning')?.label as string | undefined;
        inspector.loaded = true;
      } catch (error) {
        inspector.error = describeGitOperationError(error); inspector.loaded = true;
      } finally { inspector.pending = undefined; }
    })();
    await inspector.pending;
    if (!inspector.loaded && !this.disposed && !repository.disposed) await this.load(repository);
  }

  async publish(): Promise<void> {
    if (!this.view || this.disposed) return;
    const revision = ++this.revision;
    const repositories = this.controller.repositoriesForView();
    const keys = new Set(repositories.map(repository => repository.uri.toString()));
    for (const key of this.inspectors.keys()) if (!keys.has(key)) this.inspectors.delete(key);
    await Promise.all(repositories.map(repository => this.load(repository)));
    if (revision !== this.revision || !this.view || this.disposed) return;
    const state = {
      type: 'state', scanning: this.controller.scanning || this.operations.has('scan'),
      setupBusy: this.operations.has('setup'),
      targets: (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'safs')
        .map(folder => ({ id: folder.uri.toString(), name: folder.name, root: this.actions.root(folder.uri) })),
      repositories: repositories.map(repository => {
        const id = repository.uri.toString(), inspector = this.inspector(id);
        return {
          id, name: repository.name, root: this.actions.root(repository.uri),
          branch: repository.syncState?.branch ?? 'HEAD', count: repository.count,
          sync: repository.syncState ? syncStateLabel(repository.syncState) : '正在读取同步状态…',
          syncTooltip: repository.syncState ? syncStateTooltip(repository.syncState) : '',
          busy: this.operations.has(id), error: this.errors.get(id), inspectorError: inspector.error,
          groups: [repository.index, repository.working, repository.conflicts].map((group, index) => ({
            id: String(index), title: group.label, staged: group.staged, conflict: index === 2,
            changes: group.resourceStates.map(resource => ({ ...resource.change }))
          })),
          commits: inspector.commits.map(node => ({
            id: node.commit.id, subject: node.commit.subject, author: node.commit.author,
            timestamp: node.commit.timestamp, ...commitSyncStatus(node, inspector),
            files: inspector.files.get(node.commit.id)?.map(file => ({ ...file.file }))
          })),
          branches: inspector.branches.map(branch => ({ name: branch.name, current: branch.current }))
        };
      })
    };
    const encoded = JSON.stringify(state);
    if (encoded !== this.lastState) { this.lastState = encoded; this.post(state); }
  }

  private async receive(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object' || Array.isArray(message) || this.disposed) return;
    const input = message as Record<string, unknown>;
    if (input.type === 'ready') { this.lastState = ''; await this.publish(); return; }
    if (input.type === 'cancel' && typeof input.repository === 'string') {
      if (input.repository === 'scan') this.controller.cancelScan();
      this.operations.get(input.repository)?.abort(); return;
    }
    if (input.type === 'dismiss' && typeof input.repository === 'string') {
      this.errors.delete(input.repository);
      const inspector = this.inspectors.get(input.repository);
      if (inspector) inspector.error = undefined;
      this.schedule(); return;
    }
    if (input.type !== 'action' || typeof input.action !== 'string') return;
    const key = input.action === 'refresh' ? 'scan' : input.action === 'setup' ? 'setup' : String(input.repository ?? '');
    if (this.operations.has(key)) return;
    const operation = new AbortController();
    this.operations.set(key, operation); this.errors.delete(key);
    this.post({ type: 'busy', repository: key, busy: true, action: input.action });
    try {
      await this.act(input, operation.signal);
      this.post({ type: 'completed', repository: key, action: input.action, success: true });
    } catch (error) {
      const text = operation.signal.aborted ? '操作已取消，请刷新确认仓库状态。' : describeGitOperationError(error);
      this.errors.set(key, text); this.post({ type: 'error', repository: key, message: text });
    } finally {
      this.operations.delete(key); this.post({ type: 'busy', repository: key, busy: false }); this.schedule();
    }
  }

  private async act(input: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    const action = input.action;
    if (action === 'refresh') {
      for (const inspector of this.inspectors.values()) { inspector.generation++; inspector.loaded = false; }
      await this.controller.execute('refresh'); return;
    }
    if (action === 'setup') {
      if (input.mode !== 'init' && input.mode !== 'clone') throw new Error('Invalid setup mode');
      for (const field of ['target', 'name', 'email', 'url', 'directory']) {
        if (typeof input[field] !== 'string' || (input[field] as string).length > 8192) throw new Error('Invalid setup input');
      }
      if (!vscode.workspace.workspaceFolders?.some(folder => folder.uri.scheme === 'safs' && folder.uri.toString() === input.target)) {
        throw new Error('远程工作区已关闭，请重新打开。');
      }
      await this.actions.setup(input as unknown as GitSetupInput, signal,
        message => this.post({ type: 'progress', repository: 'setup', message }));
      await this.controller.refresh(true); return;
    }
    if (typeof input.repository !== 'string') throw new Error('Invalid repository');
    const repository = this.controller.repository(input.repository);
    if (!repository || repository.disposed) throw new Error('远程 Git 仓库已关闭。');
    const inspector = this.inspector(input.repository);
    if (['fetch', 'pull', 'push'].includes(String(action))) {
      const before = action === 'fetch' ? undefined : (await repository.git.probe(['rev-parse', '--verify', '--quiet', 'HEAD']))?.trim();
      const sync = repository.syncState;
      const outgoing = action === 'push' && sync?.kind === 'tracked' && sync.head && sync.upstreamOid
        ? (await repository.git.run(['rev-list', sync.head, '--not', sync.upstreamOid, '--'])).trim().split('\n').filter(Boolean) : [];
      await this.controller.execute(String(action), repository, signal,
        (message: string) => this.post({ type: 'progress', repository: input.repository, message }));
      if (action === 'push' && before && repository.syncState?.kind === 'tracked' && repository.syncState.ahead === 0
          && (await repository.git.probe(['rev-parse', '--verify', '--quiet', 'HEAD']))?.trim() === before) {
        outgoing.forEach(id => inspector.pushed.add(id));
      } else if (action === 'pull' && before) {
        const incoming = (await repository.git.run(['rev-list', 'HEAD', '--not', before, '--'])).trim().split('\n').filter(Boolean);
        incoming.forEach(id => inspector.pulled.add(id));
      }
    } else if (action === 'commit') {
      if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 65536) throw new Error('请输入有效提交说明。');
      await this.controller.execute('commit', repository, input.message);
    } else if (action === 'branch') {
      const branch = inspector.branches.find(branch => branch.name === input.branch);
      if (!branch) throw new Error('分支已不存在，请刷新。');
      await this.controller.execute('checkoutBranch', { kind: 'branch', repository, branch });
    } else if (action === 'files' || action === 'copyCommit' || action === 'openCommitFile') {
      const commit = inspector.commits.find(node => node.commit.id === input.commit);
      if (!commit) throw new Error('提交已不在当前历史中，请刷新。');
      if (action === 'copyCommit') { await vscode.env.clipboard.writeText(commit.commit.id); return; }
      let files = inspector.files.get(commit.commit.id);
      if (!files) {
        files = (await this.history.getChildren(commit)).filter((node): node is FileNode => node instanceof FileNode);
        inspector.files.set(commit.commit.id, files);
      }
      if (action === 'openCommitFile') {
        const file = files.find(node => node.file.path === input.path);
        if (!file?.command) throw new Error('提交文件已不存在。');
        await vscode.commands.executeCommand(file.command.command, ...(file.command.arguments ?? []));
      }
    } else if (['stage', 'unstage', 'discard', 'openChange'].includes(String(action))) {
      const group = [repository.index, repository.working, repository.conflicts][Number(input.group)];
      if (!group) throw new Error('Invalid change group');
      const resource = typeof input.path === 'string' ? group.resourceStates.find(resource => resource.change.path === input.path) : undefined;
      if (typeof input.path === 'string' && !resource) throw new Error('文件状态已变化，请刷新。');
      if (action === 'openChange' && !resource) throw new Error('Invalid change');
      await this.controller.execute(String(action), resource ?? group);
    } else throw new Error('Unsupported Git action');
  }

  dispose(): void {
    this.disposed = true;
    if (this.scheduled) clearTimeout(this.scheduled);
    for (const operation of this.operations.values()) operation.abort();
    this.subscriptions.forEach(subscription => subscription.dispose());
    this.view = undefined;
  }
}

function commitSyncStatus(node: CommitNode, inspector: Inspector): { status: string; sync: string } {
  if (inspector.pushed.has(node.commit.id)) return {status:'已推送',sync:'pushed'};
  if (inspector.pulled.has(node.commit.id)) return {status:'已拉取',sync:'pulled'};
  const label = String(node.description ?? '').split(' · ')[0];
  if (label === '已推送') return {status:'已在上游',sync:'synced'};
  if (label === '已提交待推送') return {status:'待推送',sync:'unpushed'};
  if (label === '待拉取') return {status:'待拉取',sync:'incoming'};
  return {status:'同步状态未知',sync:'unknown'};
}

export function gitViewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(18).toString('hex');
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'git-view.css'));
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'git-view.js'));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;"><link rel="stylesheet" href="${css}"></head><body><div id="git-view"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
}
