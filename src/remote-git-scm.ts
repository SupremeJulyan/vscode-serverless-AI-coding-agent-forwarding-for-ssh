import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitChange, GitRunner, isGitConflict, RemoteGit } from './remote-git';

interface Repository {
  uri: vscode.Uri;
  git: RemoteGit;
  scm: vscode.SourceControl;
  index: vscode.SourceControlResourceGroup;
  working: vscode.SourceControlResourceGroup;
  conflicts: vscode.SourceControlResourceGroup;
  queue: Promise<unknown>;
  disposed: boolean;
  revision: number;
}
interface Resource extends vscode.SourceControlResourceState {
  repository: Repository;
  change: GitChange;
  staged: boolean;
}

/** Runs Git on the SSH host; never treats a SAFS placeholder as a local repository. */
export class RemoteGitScm implements vscode.Disposable {
  private readonly repositories = new Map<string, Repository>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private discovering = false;
  private readonly failures = new Map<string, { message: string; retryAt: number }>();
  private disposed = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly runner: (uri: vscode.Uri) => Promise<GitRunner>,
    private readonly log: (message: string) => void,
    private readonly localPush: (uri: vscode.Uri, git: RemoteGit) => Promise<void>
  ) {
    this.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('safs-git', {
      provideTextDocumentContent: async uri => {
        const data = JSON.parse(uri.query) as { repository: string; ref: string; file: string; empty: boolean };
        const repository = this.repositories.get(data.repository);
        if (!repository) throw new Error('远程 Git 仓库已关闭。');
        if (data.empty) return '';
        if (!['HEAD', ''].includes(data.ref)) throw new Error('Invalid Git revision');
        return repository.git.run(['show', `${data.ref}:${data.file}`]);
      }
    }));
    const command = (name: string, handler: (...args: any[]) => Promise<unknown>) => {
      this.subscriptions.push(vscode.commands.registerCommand(`safs.git.${name}`, async (...args) => {
        try { await handler(...args); }
        catch (error) { void vscode.window.showErrorMessage(`SAFS Git: ${error instanceof Error ? error.message : String(error)}`); }
      }));
    };
    command('refresh', async () => this.refresh(true));
    command('openChange', async (resource: Resource) => this.openChange(resource));
    for (const action of ['stage', 'unstage'] as const) {
      command(action, async (...resources: Resource[]) => {
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
            finally { await this.update(repository); }
          });
        }
      });
    }
    for (const action of ['fetch', 'pull', 'push'] as const) {
      command(action, async (source?: vscode.SourceControl) => {
        const repository = await this.select(source);
        if (!repository) return;
        await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl, title: `Git ${action}` },
          () => this.enqueue(repository, async () => {
            try {
              if (action === 'push') await this.localPush(repository.uri, repository.git);
              else await repository.git.run(action === 'pull' ? ['pull', '--ff-only'] : [action]);
            } finally {
              await this.update(repository).catch(error => this.log(String(error)));
            }
          }));
      });
    }
    command('commit', async (source?: vscode.SourceControl) => {
      const repository = await this.select(source);
      if (!repository) return;
      const message = repository.scm.inputBox.value;
      await this.enqueue(repository, async () => {
        await this.update(repository);
        if (repository.conflicts.resourceStates.length) throw new Error('请先解决并暂存冲突。');
        if (!repository.index.resourceStates.length) throw new Error('请先暂存需要提交的更改。');
        await repository.git.commit(message);
        if (repository.scm.inputBox.value === message) repository.scm.inputBox.value = '';
        await this.update(repository);
      });
    });
    this.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refresh()),
      vscode.workspace.onDidSaveTextDocument(document => {
        if (document.uri.scheme === 'safs') void this.refresh();
      }),
      vscode.window.onDidChangeWindowState(state => { if (state.focused) void this.refresh(); })
    );
    this.timer = setInterval(() => { if (vscode.window.state.focused) void this.refresh(); }, 15000);
    void this.refresh();
  }

  private async select(source?: vscode.SourceControl): Promise<Repository | undefined> {
    const repositories = [...this.repositories.values()];
    const selected = repositories.find(repository => repository.scm === source);
    if (selected) return selected;
    if (repositories.length === 1) return repositories[0];
    const item = await vscode.window.showQuickPick(repositories.map(repository => ({
      label: repository.scm.label, description: repository.uri.toString(), repository
    })), { placeHolder: '选择远程 Git 仓库' });
    return item?.repository;
  }

  private enqueue(repository: Repository, operation: () => Promise<void>): Promise<void> {
    const next = repository.queue.then(async () => { if (!repository.disposed) await operation(); });
    repository.queue = next.catch(() => {});
    return next;
  }

  async refresh(interactive = false): Promise<void> {
    if (this.discovering || this.disposed) return;
    this.discovering = true;
    try {
      const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'safs');
      const active = new Set(folders.map(folder => folder.uri.toString()));
      for (const [key, repository] of this.repositories) {
        if (!active.has(key)) { this.close(repository); this.repositories.delete(key); }
      }
      for (const folder of folders) {
        if (this.disposed) return;
        const key = folder.uri.toString();
        if (!interactive && (this.failures.get(key)?.retryAt ?? 0) > Date.now()) continue;
        try {
          let repository = this.repositories.get(key);
          if (!repository) {
            const git = new RemoteGit(await this.runner(folder.uri));
            // Opening the repository root keeps commits and path operations scoped consistently.
            const prefix = await git.run(['rev-parse', '--show-prefix']);
            if (prefix.trim()) throw new Error('请在 SAFS 中打开 Git 仓库根目录以启用源代码管理。');
            await git.status();
            if (this.disposed) return;
            const scm = vscode.scm.createSourceControl('safs-git', `Git (SAFS) · ${folder.name}`, folder.uri);
            repository = {
              uri: folder.uri, git, scm,
              index: scm.createResourceGroup('index', '已暂存的更改'),
              working: scm.createResourceGroup('working', '更改'),
              conflicts: scm.createResourceGroup('conflicts', '合并冲突'),
              queue: Promise.resolve(), disposed: false, revision: 0
            };
            repository.index.hideWhenEmpty = true;
            repository.conflicts.hideWhenEmpty = true;
            scm.inputBox.placeholder = '提交说明（Ctrl+Enter 提交已暂存更改）';
            scm.acceptInputCommand = { command: 'safs.git.commit', title: '提交', arguments: [scm] };
            this.repositories.set(key, repository);
          }
          await this.enqueue(repository, () => this.update(repository!));
          this.failures.delete(key);
        } catch (error) {
          const message = `${folder.name}: ${error instanceof Error ? error.message : String(error)}`;
          if (this.failures.get(key)?.message !== message) this.log(message);
          this.failures.set(key, { message, retryAt: Date.now() + 60000 });
          if (interactive) void vscode.window.showErrorMessage(`SAFS Git: ${message}`);
        }
      }
    } finally { this.discovering = false; }
  }

  private async update(repository: Repository): Promise<void> {
    const changes = await repository.git.status();
    const branch = (await repository.git.run(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => 'HEAD')).trim();
    if (repository.disposed) return;
    repository.revision++;
    repository.scm.count = changes.length;
    repository.scm.statusBarCommands = [{ command: 'safs.git.refresh', title: `$(git-branch) ${branch}`, tooltip: '刷新远程 Git' }];
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
  }

  private snapshot(repository: Repository, file: string, ref: string, empty = false): vscode.Uri {
    return repository.uri.with({ scheme: 'safs-git', path: path.posix.join(repository.uri.path, file), query: JSON.stringify({
      repository: repository.uri.toString(), ref, file, empty, revision: repository.revision
    }) });
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
    repository.index.dispose(); repository.working.dispose(); repository.conflicts.dispose(); repository.scm.dispose();
  }
  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    this.subscriptions.forEach(subscription => subscription.dispose());
    this.repositories.forEach(repository => this.close(repository));
    this.repositories.clear();
  }
}
