import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  agentDiscoveryDirectory, agentWorkspaceRecordMaxAgeMs, discoverAgentWorkspaces,
  type DiscoveredAgentWorkspace
} from './agent-discovery';

export const remoteWorkspacesViewId = 'safs.remoteWorkspaces';

export class RemoteWorkspacesViewProvider implements vscode.TreeDataProvider<RemoteWorkspaceItem>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<RemoteWorkspaceItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private treeView: vscode.TreeView<RemoteWorkspaceItem> | undefined;
  private visibilityListener: vscode.Disposable | undefined;
  private selectionSync: Promise<void> = Promise.resolve();
  private watcher: FSWatcher | undefined;
  private expiryTimer: NodeJS.Timeout | undefined;
  private watchRetryTimer: NodeJS.Timeout | undefined;
  private changeCheck: Promise<void> = Promise.resolve();
  private workspaces = discoverAgentWorkspaces();
  private workspaceSignature = workspaceListSignature(this.workspaces);

  constructor() {
    void this.startWatching();
  }

  attachView(view: vscode.TreeView<RemoteWorkspaceItem>): void {
    this.visibilityListener?.dispose();
    this.treeView = view;
    this.visibilityListener = view.onDidChangeVisibility(({ visible }) => {
      if (visible) this.syncFocusedSelection();
    });
    this.syncFocusedSelection();
  }

  // TreeView.reveal requires getParent, even for a flat tree.
  getParent(): undefined { return undefined; }

  private syncFocusedSelection(): void {
    this.selectionSync = this.selectionSync.catch(() => undefined).then(async () => {
      const view = this.treeView;
      if (!view?.visible) return;
      const focusedId = this.workspaces.find(record => record.focused)?.instanceId;
      if (!focusedId || view.selection[0]?.id === focusedId) return;
      const item = this.getChildren().find(candidate => candidate.id === focusedId);
      if (item) await view.reveal(item, { select: true, focus: false });
    }).catch(() => undefined);
  }

  getTreeItem(item: RemoteWorkspaceItem): vscode.TreeItem { return item; }

  getChildren(): RemoteWorkspaceItem[] {
    const records = this.workspaces;
    const depths = records.map(() => 1);
    let labels = workspaceLabels(records, depths);
    for (let attempt = 0; attempt < records.length; attempt++) {
      const duplicates = duplicateLabelIndexes(labels);
      if (!duplicates.size) break;
      for (const index of duplicates) depths[index]++;
      labels = workspaceLabels(records, depths);
    }
    return records.map((record, index) => ({
      label: labels[index],
      item: new RemoteWorkspaceItem(record, labels[index])
    })).sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: 'base', numeric: true })
      || left.item.record.instanceId.localeCompare(right.item.record.instanceId))
      .map(entry => entry.item);
  }

  refresh(): void {
    this.emitter.fire(undefined);
    this.syncFocusedSelection();
  }

  private refreshIfWorkspacesChanged(): void {
    const workspaces = discoverAgentWorkspaces();
    const signature = workspaceListSignature(workspaces);
    if (signature === this.workspaceSignature) return;
    this.workspaces = workspaces;
    this.workspaceSignature = signature;
    this.refresh();
  }

  private async startWatching(): Promise<void> {
    if (this.watcher) return;
    try {
      const directory = agentDiscoveryDirectory();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      this.watcher = watch(directory, () => {
        this.changeCheck = this.changeCheck.then(async () => {
          await this.handleFocusRequests();
          this.refreshIfWorkspacesChanged();
          this.scheduleExpiryCheck();
        }).catch(() => undefined);
      });
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = undefined;
        this.scheduleWatchRetry();
      });
      await this.handleFocusRequests();
      this.refreshIfWorkspacesChanged();
      this.scheduleExpiryCheck();
    } catch {
      this.watcher?.close();
      this.watcher = undefined;
      this.scheduleWatchRetry();
    }
  }

  private scheduleWatchRetry(): void {
    if (this.watchRetryTimer) return;
    this.watchRetryTimer = setTimeout(() => {
      this.watchRetryTimer = undefined;
      void this.startWatching();
    }, 5_000);
  }

  private scheduleExpiryCheck(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    const nextExpiry = Math.min(...this.workspaces.map(
      record => record.updatedAtMs + agentWorkspaceRecordMaxAgeMs
    ));
    if (!Number.isFinite(nextExpiry)) return;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined;
      this.refreshIfWorkspacesChanged();
      this.scheduleExpiryCheck();
    }, Math.max(1, nextExpiry - Date.now() + 25));
  }

  async focus(instanceId: string): Promise<void> {
    const records = discoverAgentWorkspaces();
    if (!records.some(record => record.instanceId === instanceId)) {
      throw new Error('该远程工作区已关闭或登记已过期。');
    }
    const directory = agentDiscoveryDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const requestPath = path.join(directory, `focus-${randomUUID()}.json`);
    await writeFile(requestPath, JSON.stringify({ instanceId, createdAt: Date.now() }), { mode: 0o600, flag: 'wx' });
  }

  private async handleFocusRequests(): Promise<void> {
    const directory = agentDiscoveryDirectory();
    let names: string[];
    try { names = await readdir(directory); } catch { return; }
    for (const name of names) {
      if (!/^focus-[\w-]+\.json$/.test(name)) continue;
      const file = path.join(directory, name);
      let request: { instanceId?: unknown; createdAt?: unknown };
      try { request = JSON.parse(await readFile(file, 'utf8')); }
      catch { continue; }
      if (typeof request.instanceId !== 'string' || typeof request.createdAt !== 'number') continue;
      if (Date.now() - request.createdAt > 10_000 || request.createdAt > Date.now() + 5_000) {
        await rm(file, { force: true }).catch(() => undefined);
        continue;
      }
      const target = discoverAgentWorkspaces().find(record => record.instanceId === request.instanceId);
      if (!target || target.processId !== process.pid) continue;
      await rm(file, { force: true }).catch(() => undefined);
      // Run through VS Code's workbench so a WSL/Linux extension host focuses
      // its owning Windows VS Code window instead of trying a Linux WM API.
      await vscode.commands.executeCommand('workbench.action.focusWindow');
    }
  }

  dispose(): void {
    this.treeView = undefined;
    this.visibilityListener?.dispose();
    this.watcher?.close();
    this.watcher = undefined;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (this.watchRetryTimer) clearTimeout(this.watchRetryTimer);
    this.emitter.dispose();
  }
}

function workspaceListSignature(records: readonly DiscoveredAgentWorkspace[]): string {
  return JSON.stringify(records.map(record => [
    record.instanceId, record.mountName, record.workspaceUri, record.workspaceRoot,
    record.host, record.hostName ?? '', record.user ?? '', record.focused
  ]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
}

function remotePathParts(remotePath: string): string[] {
  const parts = remotePath.split('/').filter(Boolean);
  return parts.length ? parts : [remotePath || '/'];
}

function workspaceLabels(records: readonly DiscoveredAgentWorkspace[], depths: readonly number[]): string[] {
  return records.map((record, index) => {
    const host = record.hostName || record.host;
    const parts = remotePathParts(record.workspaceRoot);
    const depth = depths[index];
    const suffix = depth <= parts.length
      ? parts.slice(-depth).join('/')
      : `${parts.join('/')} (${record.mountName})${depth > parts.length + 1 ? ` #${record.processId}` : ''}`;
    return [host, record.user, suffix].filter((part): part is string => !!part?.trim()).join(' · ');
  });
}

function duplicateLabelIndexes(labels: readonly string[]): Set<number> {
  const indexesByLabel = new Map<string, number[]>();
  labels.forEach((label, index) => {
    const key = label.toLocaleLowerCase();
    indexesByLabel.set(key, [...(indexesByLabel.get(key) ?? []), index]);
  });
  return new Set([...indexesByLabel.values()].filter(indexes => indexes.length > 1).flat());
}

class RemoteWorkspaceItem extends vscode.TreeItem {
  constructor(readonly record: DiscoveredAgentWorkspace, label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.id = record.instanceId;
    this.tooltip = `${record.mountName}\n${record.workspaceRoot}\n${record.hostName ?? record.host}`;
    this.contextValue = 'safs.remoteWorkspace';
    this.iconPath = new vscode.ThemeIcon(record.focused ? 'eye' : 'folder');
    this.command = { command: 'safs.focusRemoteWorkspace', title: '置顶远程工作区', arguments: [record.instanceId] };
  }
}
