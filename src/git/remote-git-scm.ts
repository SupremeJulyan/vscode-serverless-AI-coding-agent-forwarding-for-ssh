import {
  applyObservedPushState, GitSyncState, ObservedPushState, readGitSyncState
} from './git-sync-state';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitChange, GitRunner, isGitConflict, RemoteGit } from './remote-git';
import { describeGitOperationError } from './git-error';
import { validatePushUrl } from './local-git-push';
import { createBranch, GitBranch, listBranches, switchBranch } from './remote-git-branch';

export interface Repository {
  kind: 'repository';
  message: string;
  count: number;
  uri: vscode.Uri;
  name: string;
  git: RemoteGit;
  index: ChangeGroup;
  working: ChangeGroup;
  conflicts: ChangeGroup;
  queue: Promise<unknown>;
  pendingOperations?: number;
  disposed: boolean;
  revision: number;
  syncState?: GitSyncState;
}
interface ChangeGroup { kind: 'group'; label: string; staged: boolean; resourceStates: Resource[] }
interface BranchNode { kind: 'branch'; repository: Repository; branch: GitBranch }
type GitSource = vscode.Uri | Repository | { repository: { uri: vscode.Uri } };
interface Resource extends vscode.SourceControlResourceState {
  repository: Repository;
  change: GitChange;
  staged: boolean;
}

function selectedResources(values: unknown[]): Resource[] {
  const flattened = values.flatMap(value => {
    if (Array.isArray(value)) return selectedResources(value);
    if (value && typeof value === 'object' && 'resourceStates' in value) {
      return selectedResources((value as ChangeGroup).resourceStates);
    }
    return value && typeof value === 'object' && 'change' in value ? [value as Resource] : [];
  });
  return [...new Set(flattened)];
}

/** 提交内容不可变，历史视图可以不带 revision 直接引用某个提交里的文件。 */
export function gitSnapshotUri(repository: vscode.Uri, file: string, ref: string, empty = false): vscode.Uri {
  return repository.with({
    scheme: 'safs-git', path: path.posix.join(repository.path, file),
    query: JSON.stringify({ repository: repository.toString(), ref, file, empty })
  });
}

/** Runs Git on the SSH host; never treats a SAFS placeholder as a local repository. */
export class RemoteGitScm implements vscode.Disposable {
  private readonly repositories = new Map<string, Repository>();
  private readonly handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly repositoryEmitter = new vscode.EventEmitter<void>();
  private readonly historyEmitter = new vscode.EventEmitter<void>();
  private readonly statusEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeStatus = this.statusEmitter.event;
  /** 已发现的仓库集合发生变化（新增/关闭）。 */
  readonly onDidChangeRepositories = this.repositoryEmitter.event;
  /** 提交、拉取、推送之后：历史内容可能变了。 */
  readonly onDidChangeHistory = this.historyEmitter.event;
  private discovering = false;
  private readonly failures = new Map<string, { message: string; retryAt: number }>();
  private disposed = false;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private readonly discoveredFolders = new Map<string, Array<{ uri: vscode.Uri; name: string }>>();
  private discoveryController?: AbortController;

  /** 供历史视图复用同一批仓库实例（同一个 RemoteGit，避免重复发现）。 */
  repositoriesInUse(): { uri: vscode.Uri; name: string; git: RemoteGit; syncState?: GitSyncState; pendingChanges: number }[] {
    return [...this.repositories.values()].map(repository => ({
      uri: repository.uri, name: repository.name, git: repository.git,
      syncState: repository.syncState, pendingChanges: repository.count
    }));
  }

  constructor(
    private readonly runner: (uri: vscode.Uri) => Promise<GitRunner>,
    private readonly log: (message: string) => void,
    private readonly localPush: (uri: vscode.Uri, git: RemoteGit, signal?: AbortSignal, report?: (message: string) => void) => Promise<void>,
    private readonly localPull: (uri: vscode.Uri, git: RemoteGit, signal?: AbortSignal, report?: (message: string) => void) => Promise<void>,
    private readonly localFetch: (uri: vscode.Uri, git: RemoteGit, signal?: AbortSignal, report?: (message: string) => void) => Promise<void>,
    private readonly prepareSyncState?: (
      uri: vscode.Uri, git: RemoteGit
    ) => Promise<ObservedPushState | undefined>,
    private readonly discoverRepositories?: (uri: vscode.Uri, signal: AbortSignal) => Promise<Array<{ uri: vscode.Uri; name: string }>>
  ) {
    this.subscriptions.push(this.repositoryEmitter, this.historyEmitter, this.statusEmitter);
    this.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('safs-git', {
      provideTextDocumentContent: async uri => {
        const data = JSON.parse(uri.query) as { repository: string; ref: string; file: string; empty: boolean };
        const repository = this.repositories.get(data.repository);
        if (!repository) throw new Error('远程 Git 仓库已关闭。');
        if (data.empty) return '';
        if (!/^(?:HEAD|[a-f0-9]{7,64})?$/.test(data.ref)) throw new Error('Invalid Git revision');
        return repository.git.run(['show', `${data.ref}:${data.file}`]);
      }
    }));
    const command = (name: string, handler: (...args: any[]) => Promise<unknown>) => {
      this.handlers.set(name, handler);
      this.subscriptions.push(vscode.commands.registerCommand(`safs.git.${name}`, async (...args) => {
        try { await handler(...args); }
        catch (error) { void vscode.window.showErrorMessage(`SAFS Git: ${describeGitOperationError(error)}`); }
      }));
    };
    command('refresh', async () => vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification, title: 'SAFS：扫描远程 Git 仓库', cancellable: true
    }, async (_progress, token) => {
      const listener = token.onCancellationRequested(() => this.discoveryController?.abort());
      try { await this.refresh(true); } finally { listener.dispose(); }
    }));
    command('init', async () => {
      const folders = (vscode.workspace.workspaceFolders ?? [])
        .filter(folder => folder.uri.scheme === 'safs');
      const folder = folders.length === 1 ? folders[0] : await vscode.window.showQuickPick(
        folders.map(folder => ({ label: folder.name, description: folder.uri.path, folder })),
        { placeHolder: '选择要初始化 Git 仓库的远程工作区' }
      ).then(selected => selected?.folder);
      if (!folder) return;
      const git = new RemoteGit(await this.runner(folder.uri), this.log);
      let existing: string | undefined;
      try { existing = await git.run(['rev-parse', '--show-toplevel']); }
      catch (error) { if (!/not a git repository|不是.*git.*仓库/i.test(String(error))) throw error; }
      if (existing) throw new Error('当前目录已属于 Git 仓库，请刷新 Git。');
      const name = await vscode.window.showInputBox({
        title: '初始化远程仓库（1/3）', prompt: 'Git 用户名，仅保存到当前远程仓库',
        value: await git.config('user.name') ?? '',
        validateInput: value => value.trim() && !/[<>\x00-\x1f\x7f]/.test(value) ? undefined : '请输入有效 Git 用户名'
      });
      if (name === undefined) return;
      const email = await vscode.window.showInputBox({
        title: '初始化远程仓库（2/3）', prompt: 'Git 邮箱，仅保存到当前远程仓库',
        value: await git.config('user.email') ?? '',
        validateInput: value => /^[^\s@<>]+@[^\s@<>]+$/.test(value.trim()) ? undefined : '请输入有效邮箱'
      });
      if (email === undefined) return;
      const url = await vscode.window.showInputBox({
        title: '初始化远程仓库（3/3）', prompt: '远程仓库 HTTPS/SSH 地址，留空可稍后配置',
        validateInput: value => {
          if (!value.trim()) return undefined;
          try { validatePushUrl(value.trim()); return undefined; }
          catch (error) { return String(error); }
        }
      });
      if (url === undefined) return;
      await git.run(['init', '--initial-branch=main']);
      await git.run(['config', '--local', 'user.name', name.trim()]);
      await git.run(['config', '--local', 'user.email', email.trim()]);
      if (url.trim()) {
        await git.run(['remote', 'add', 'origin', url.trim()]);
        await git.run(['config', '--local', 'branch.main.remote', 'origin']);
        await git.run(['config', '--local', 'branch.main.merge', 'refs/heads/main']);
      }
      await this.refresh(true);
      void vscode.window.showInformationMessage(`SAFS：已在远程工作区 ${folder.name} 初始化 Git 仓库。`);
    });
    command('openChange', async (resource: Resource) => this.openChange(resource));
    command('branch', async (source?: GitSource) => {
      const selected = await vscode.window.showQuickPick([
        {
          label: '$(git-branch) 切换分支',
          description: '切换到已有的本地或远程跟踪分支',
          command: 'safs.git.switchBranch'
        },
        {
          label: '$(git-branch-create) 创建分支',
          description: '基于当前提交创建并切换到新分支',
          command: 'safs.git.createBranch'
        }
      ], { placeHolder: '选择要执行的分支操作' });
      if (selected) await vscode.commands.executeCommand(selected.command, source);
    });
    command('switchBranch', async (source?: GitSource) => {
      const repository = await this.select(source);
      if (!repository) return;
      await this.enqueue(repository, async () => {
        const branches = await listBranches(repository.git);
        if (!branches.length) throw new Error('仓库中没有可切换的分支。');
        const selected = await vscode.window.showQuickPick(branches.map(branch => ({
          label: `${branch.current ? '$(check) ' : ''}${branch.name}`,
          description: branch.kind === 'local'
            ? (branch.current ? '当前本地分支' : '本地分支')
            : `远程跟踪分支 · 创建 ${branch.localName}`,
          branch
        })), { placeHolder: `${repository.name}：选择分支（仅使用远端已有引用，不联网）` });
        if (!selected || selected.branch.current) return;
        await switchBranch(repository.git, selected.branch as GitBranch);
        await this.update(repository);
        this.historyEmitter.fire();
      });
    });
    command('createBranch', async (source?: GitSource) => {
      const repository = await this.select(source);
      if (!repository) return;
      const name = await vscode.window.showInputBox({
        prompt: `${repository.name}：创建并切换到新分支`,
        placeHolder: '例如 feature/login',
        ignoreFocusOut: true,
        validateInput: value => value.trim() ? undefined : '请输入分支名。'
      });
      if (name === undefined) return;
      await this.enqueue(repository, async () => {
        await createBranch(repository.git, name);
        await this.update(repository);
        this.historyEmitter.fire();
      });
    });
    command('checkoutBranch', async (node: BranchNode) => {
      if (node?.kind !== 'branch' || node.branch.current) return;
      await this.enqueue(node.repository, async () => {
        await switchBranch(node.repository.git, node.branch);
        await this.update(node.repository);
        this.historyEmitter.fire();
      });
    });
    for (const action of ['stage', 'unstage'] as const) {
      command(action, async (...resources: Resource[]) => {
        resources = selectedResources(resources);
        const groups = new Map<Repository, GitChange[]>();
        for (const resource of resources) {
          if (!resource?.repository || !resource.change) continue;
          const changes = groups.get(resource.repository) ?? [];
          changes.push(resource.change);
          groups.set(resource.repository, changes);
        }
        for (const [repository, changes] of groups) {
          await this.enqueue(repository, async () => {
            try { await repository.git[action](changes); }
            // Index/worktree operations cannot change HEAD or its upstream. Reuse the
            // current sync state instead of paying for many extra SSH Git queries.
            finally { await this.update(repository, false); }
          });
        }
      });
    }
    command('discard', async (...resources: Resource[]) => {
      const selected = selectedResources(resources).filter(resource =>
        resource?.repository && resource.change && !resource.staged && !isGitConflict(resource.change));
      if (!selected.length) return;
      const confirmation = await vscode.window.showWarningMessage(
        selected.length === 1
          ? `确定还原“${selected[0].change.path}”的更改吗？此操作无法撤销。`
          : `确定还原选中的 ${selected.length} 项更改吗？此操作无法撤销。`,
        { modal: true }, '还原更改');
      if (confirmation !== '还原更改') return;
      const groups = new Map<Repository, GitChange[]>();
      for (const resource of selected) {
        const changes = groups.get(resource.repository) ?? [];
        changes.push(resource.change);
        groups.set(resource.repository, changes);
      }
      for (const [repository, changes] of groups) {
        await this.enqueue(repository, async () => {
          try { await repository.git.discard(changes); }
          finally { await this.update(repository, false); }
        });
      }
    });
    for (const action of ['fetch', 'pull', 'push'] as const) {
      command(action, async (source?: GitSource, signal?: AbortSignal, report?: (message: string) => void) => {
        const repository = await this.select(source);
        if (!repository) return;
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
          title: action === 'fetch' ? 'Git 提取' : action === 'pull' ? 'Git 拉取' : 'Git 推送' },
          () => this.enqueue(repository, async () => {
            try {
              // 推送、拉取、提取全部经本地 Git 中转（远端不需要出网或凭据）。
              if (action === 'push') await this.localPush(repository.uri, repository.git, signal, report);
              else if (action === 'pull') await this.localPull(repository.uri, repository.git, signal, report);
              else await this.localFetch(repository.uri, repository.git, signal, report);
              this.historyEmitter.fire();
            } finally {
              await this.update(repository).catch(error => this.log(String(error)));
            }
          }));
      });
    }
    command('commit', async (source?: GitSource, submittedMessage?: string) => {
      const repository = await this.select(source);
      if (!repository) return;
      let message = repository.message;
      if (submittedMessage === undefined) {
        // 从 SAFS Git View 标题栏触发时没有输入框上下文，直接问一句提交说明。
        message = await vscode.window.showInputBox({
          prompt: `${repository.name}：提交说明（只提交已暂存更改）`,
          value: message, ignoreFocusOut: true,
          validateInput: value => value.trim() ? undefined : '请输入提交说明。'
        }) ?? '';
        if (!message.trim()) return;
        repository.message = message;
      } else { message = submittedMessage; repository.message = message; }
      await this.enqueue(repository, async () => {
        await this.update(repository, false);
        if (repository.conflicts.resourceStates.length) throw new Error('请先解决并暂存冲突。');
        if (!repository.index.resourceStates.length) throw new Error('请先暂存需要提交的更改。');
        await repository.git.commit(message);
        if (repository.message === message) repository.message = '';
        await this.update(repository);
        this.historyEmitter.fire();
      });
    });
    this.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refresh()),
      vscode.workspace.onDidSaveTextDocument(document => {
        if (document.uri.scheme === 'safs') this.scheduleRefresh(200);
      }),
      vscode.window.onDidChangeWindowState(state => {
        if (state.focused) this.scheduleRefresh(0);
      })
    );
    void this.refresh().finally(() => this.scheduleRefresh());
  }

  private scheduleRefresh(delay = 2000): void {
    if (this.disposed) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      const refresh = vscode.window.state.focused ? this.refresh() : Promise.resolve();
      void refresh.finally(() => this.scheduleRefresh());
    }, delay);
  }

  execute(action: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(action);
    if (!handler) throw new Error('Unsupported Git action');
    return handler(...args);
  }

  repository(key: string): Repository | undefined { return this.repositories.get(key); }
  repositoriesForView(): Repository[] { return [...this.repositories.values()]; }
  cancelScan(): void { this.discoveryController?.abort(); }
  get scanning(): boolean { return this.discovering; }

  private async select(source?: GitSource): Promise<Repository | undefined> {
    const repositories = [...this.repositories.values()];
    const uri = source && ('repository' in source ? source.repository.uri : 'uri' in source ? source.uri : source);
    const selected = repositories.find(repository => repository === source || repository.uri.toString() === uri?.toString());
    if (selected) return selected;
    if (repositories.length === 1) return repositories[0];
    const item = await vscode.window.showQuickPick(repositories.map(repository => ({
      label: repository.name, description: repository.uri.toString(), repository
    })), { placeHolder: '选择远程 Git 仓库' });
    return item?.repository;
  }

  private enqueue(repository: Repository, operation: () => Promise<void>): Promise<void> {
    repository.pendingOperations = (repository.pendingOperations ?? 0) + 1;
    const next = repository.queue.then(async () => {
      try { if (!repository.disposed) await operation(); }
      finally { repository.pendingOperations!--; }
    });
    repository.queue = next.catch(() => {});
    return next;
  }

  async refresh(interactive = false): Promise<void> {
    if (this.discovering || this.disposed) return;
    this.discovering = true;
    const controller = new AbortController();
    this.discoveryController = controller;
    try {
      const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'safs');
      const current = new Set(workspaceFolders.map(folder => folder.uri.toString()));
      for (const key of this.discoveredFolders.keys()) if (!current.has(key)) this.discoveredFolders.delete(key);
      const folders: Array<{ uri: vscode.Uri; name: string }> = [];
      for (const folder of workspaceFolders) {
        const key = folder.uri.toString();
        if (this.discoverRepositories && (interactive || !this.discoveredFolders.has(key))) {
          try { this.discoveredFolders.set(key, await this.discoverRepositories(folder.uri, controller.signal)); }
          catch (error) {
            controller.signal.throwIfAborted();
            this.log(`Git 仓库扫描：${String(error)}`);
            if (interactive) void vscode.window.showErrorMessage(`SAFS Git: ${String(error)}`);
          }
        }
        folders.push(...(this.discoveredFolders.get(key) ?? [folder]));
      }
      const active = new Set(folders.map(folder => folder.uri.toString()));
      let changed = false;
      for (const [key, repository] of this.repositories) {
        if (!active.has(key)) { this.close(repository); this.repositories.delete(key); changed = true; }
      }
      for (const folder of folders) {
        if (this.disposed) return;
        const key = folder.uri.toString();
        if (!interactive && (this.failures.get(key)?.retryAt ?? 0) > Date.now()) continue;
        try {
          let repository = this.repositories.get(key);
          if (!repository) {
            const git = new RemoteGit(await this.runner(folder.uri), this.log);
            // Opening the repository root keeps commits and path operations scoped consistently.
            const prefix = await git.run(['rev-parse', '--show-prefix']);
            if (prefix.trim()) throw new Error('请在 SAFS 中打开 Git 仓库根目录以启用源代码管理。');
            await git.status();
            if (this.disposed) return;
            repository = {
              kind: 'repository', message: '', count: 0,
              uri: folder.uri, name: folder.name, git,
              index: { kind: 'group', label: '已暂存的更改', staged: true, resourceStates: [] },
              working: { kind: 'group', label: '更改', staged: false, resourceStates: [] },
              conflicts: { kind: 'group', label: '合并冲突', staged: false, resourceStates: [] },
              queue: Promise.resolve(), disposed: false, revision: 0
            };
            this.repositories.set(key, repository);
            changed = true;
          }
          // Existing repositories refresh their sync state only for an explicit
          // user refresh. A newly discovered repository still performs a full
          // update because it has no sync state yet.
          if (interactive || !repository.pendingOperations) {
            await this.enqueue(repository, () => this.update(repository!, interactive));
          }
          this.failures.delete(key);
        } catch (error) {
          const message = `${folder.name}: ${error instanceof Error ? error.message : String(error)}`;
          if (this.failures.get(key)?.message !== message) this.log(message);
          this.failures.set(key, { message, retryAt: Date.now() + 60000 });
          if (interactive) void vscode.window.showErrorMessage(`SAFS Git: ${message}`);
        }
      }
      if (changed && !this.disposed) { this.repositoryEmitter.fire(); }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      this.discovering = false; this.discoveryController = undefined;
      if (!this.disposed) this.statusEmitter.fire();
    }
  }

  private async update(repository: Repository, refreshSyncState = true): Promise<void> {
    const changes = await repository.git.status();
    let syncState = repository.syncState;
    if (refreshSyncState || !syncState) {
      try {
        const observed = await this.prepareSyncState?.(repository.uri, repository.git);
        syncState = applyObservedPushState(await readGitSyncState(repository.git), observed);
      }
      catch (error) {
        this.log(`Git 同步状态：${String(error)}`);
        syncState = { branch: repository.syncState?.branch ?? 'HEAD', kind: 'unknown' };
      }
    }
    const changed = JSON.stringify(repository.syncState) !== JSON.stringify(syncState);
    repository.syncState = syncState;
    if (repository.disposed) return;
    repository.revision++;
    repository.count = changes.length;
    if (changed) this.historyEmitter.fire();
    const resource = (change: GitChange, staged: boolean): Resource => {
      const uri = vscode.Uri.joinPath(repository.uri, change.path);
      const state: Resource = {
        resourceUri: uri, repository, change, staged,
        decorations: { tooltip: `${change.index}${change.working}`, strikeThrough: (staged ? change.index : change.working) === 'D' }
      };
      return { ...state, command: { command: 'safs.git.openChange', title: '查看更改', arguments: [state] } };
    };
    repository.index.resourceStates = changes.filter(c => !isGitConflict(c) && ![' ', '?', '!'].includes(c.index)).map(c => resource(c, true));
    repository.working.resourceStates = changes.filter(c => !isGitConflict(c) && ![' ', '!'].includes(c.working)).map(c => resource(c, false));
    repository.conflicts.resourceStates = changes.filter(isGitConflict).map(c => resource(c, false));
    this.statusEmitter.fire();

  }

  private snapshot(repository: Repository, file: string, ref: string, empty = false): vscode.Uri {
    // revision 让每次刷新后的暂存区对比 URI 变化，避免 VS Code 复用旧内容。
    const uri = gitSnapshotUri(repository.uri, file, ref, empty);
    const query = JSON.parse(uri.query) as Record<string, unknown>;
    query.revision = repository.revision;
    return uri.with({ query: JSON.stringify(query) });
  }

  private async openChange(resource: Resource): Promise<void> {
    const { repository, change, staged } = resource;
    if (repository.disposed) return;
    if (isGitConflict(change) || change.index === '?') {
      await vscode.commands.executeCommand('vscode.open', resource.resourceUri);
      return;
    }
    const status = staged ? change.index : change.working;
    const original = staged ? change.originalPath ?? change.path : change.path;
    const left = this.snapshot(repository, original, staged ? 'HEAD' : '', status === 'A');
    const right = status === 'D' ? this.snapshot(repository, change.path, '', true)
      : staged ? this.snapshot(repository, change.path, '') : resource.resourceUri;
    await vscode.commands.executeCommand('vscode.diff', left, right,
      `${path.posix.basename(change.path)} (${staged ? '已暂存' : '工作区'})`);
  }

  private close(repository: Repository): void {
    repository.disposed = true;
  }
  dispose(): void {
    this.disposed = true;
    this.discoveryController?.abort();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.subscriptions.forEach(subscription => subscription.dispose());
    this.repositories.forEach(repository => this.close(repository));
    this.repositories.clear();
  }
}
