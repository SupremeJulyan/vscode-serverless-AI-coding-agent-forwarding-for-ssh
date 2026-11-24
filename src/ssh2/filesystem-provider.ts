import { notificationWindow } from '../ui/notification-window';
import { agentCwdMappings } from '../agent/agent-cwd';
import { saveConfirmation } from '../remote/save-confirmation';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SftpConnectionPool } from './connection-pool';
import { SftpFileStat, SftpSession } from './session';
import {
  isRemotePathInsideRoot, parseRemoteUri, remoteFileSystemScheme, remoteUri
} from './uri';

export interface RemoteFolder {
  /** Endpoint used to create this mount; configuration edits must rebuild it. */
  endpointKey?: string;
  mountName: string;
  hostName: string;
  remoteRoot: string;
  /** Initial directory, independent of the browsable mount root. */
  defaultRemotePath?: string;
  /** SAFS-only URI root whose basename is the host-account display name. */
  displayRoot?: string;
  displayRemoteRoot?: string;
  /** Previous storage namespace retained for restored editor tabs. */
  legacyMapping?: { workspaceRoot: string; remoteRoot: string };
  legacyMappings?: Array<{ workspaceRoot: string; remoteRoot: string }>;
  /** POSIX URI path backed by a real directory in extension global storage. */
  workspaceRoot: string;
}

function normalizeWorkspacePath(value: string): string {
  return path.posix.normalize(/^\/?[A-Za-z]:[\\/]/.test(value) ? value.replaceAll('\\', '/') : value);
}

function workspaceRelative(root: string, candidate: string): string {
  const normalize = (value: string) => normalizeWorkspacePath(value).replace(/^\/(?=[A-Za-z]:\/)/, '');
  const normalizedRoot = normalize(root);
  const normalizedCandidate = normalize(candidate);
  // VS Code lowercases drive letters in URI paths, while fs paths retain
  // their original casing. Use Windows semantics only for drive paths.
  return /^[A-Za-z]:\//.test(normalizedRoot) && /^[A-Za-z]:\//.test(normalizedCandidate)
    ? path.win32.relative(normalizedRoot, normalizedCandidate).replaceAll('\\', '/')
    : path.posix.relative(normalizedRoot, normalizedCandidate);
}

function isWorkspaceNamespacePath(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeWorkspacePath(root);
  const normalizedCandidate = normalizeWorkspacePath(candidate);
  const isAbsolute = (value: string): boolean =>
    value.startsWith('/') || /^[A-Za-z]:\//.test(value);
  if (!isAbsolute(normalizedRoot) || !isAbsolute(normalizedCandidate)) return false;
  const relative = workspaceRelative(normalizedRoot, normalizedCandidate);
  return relative === '' || (!relative.startsWith('../') && relative !== '..'
    && !path.posix.isAbsolute(relative) && !/^[A-Za-z]:/.test(relative));
}

function placeholderMappings(folder: RemoteFolder): Array<{ workspaceRoot: string; remoteRoot: string }> {
  return agentCwdMappings(folder.workspaceRoot).map(item => ({
    workspaceRoot: item.localPath.replaceAll('\\', '/').replace(/^(?=[A-Za-z]:\/)/, '/'), remoteRoot: item.remoteRoot
  }));
}

function additionalMappings(folder: RemoteFolder): Array<{ workspaceRoot: string; remoteRoot: string }> {
  return [...(folder.displayRoot && folder.displayRemoteRoot
    ? [{ workspaceRoot: folder.displayRoot, remoteRoot: folder.displayRemoteRoot }]
    : []), ...placeholderMappings(folder), ...(folder.legacyMappings ?? [])];
}

export function isWorkspaceUriPath(folder: RemoteFolder, uriPath: string): boolean {
  return additionalMappings(folder).some(item => isWorkspaceNamespacePath(item.workspaceRoot, uriPath))
    || isWorkspaceNamespacePath(folder.workspaceRoot, uriPath)
    || Boolean(folder.legacyMapping && isWorkspaceNamespacePath(
      folder.legacyMapping.workspaceRoot, uriPath
    ));
}

export function remotePathForUri(folder: RemoteFolder, uriPath: string): string {
  const mapped = additionalMappings(folder).sort((a, b) => b.workspaceRoot.length - a.workspaceRoot.length)
    .find(item => isWorkspaceNamespacePath(item.workspaceRoot, uriPath));
  if (mapped) return path.posix.join(mapped.remoteRoot, workspaceRelative(mapped.workspaceRoot, uriPath));
  if (folder.legacyMapping
    && folder.legacyMapping.workspaceRoot !== folder.workspaceRoot && isWorkspaceNamespacePath(
    folder.legacyMapping.workspaceRoot, uriPath
  )) {
    return path.posix.join(folder.legacyMapping.remoteRoot,
      workspaceRelative(folder.legacyMapping.workspaceRoot, uriPath));
  }
  if (isWorkspaceNamespacePath(folder.workspaceRoot, uriPath)) {
    return path.posix.join(
      folder.remoteRoot, workspaceRelative(folder.workspaceRoot, uriPath)
    );
  }
  return uriPath;
}

export function workspacePathForRemote(folder: RemoteFolder, remotePath: string): string {
  if (!isRemotePathInsideRoot(folder.remoteRoot, remotePath)) return remotePath;
  const mapped = additionalMappings(folder).filter(item => isRemotePathInsideRoot(item.remoteRoot, remotePath))
    .sort((a, b) => b.remoteRoot.length - a.remoteRoot.length)[0];
  if (mapped) return path.posix.join(mapped.workspaceRoot, path.posix.relative(mapped.remoteRoot, remotePath));
  return path.posix.join(
    folder.workspaceRoot, path.posix.relative(folder.remoteRoot, remotePath)
  );
}

/** Map a remote path to its real local proxy directory, excluding display-only URI aliases. */
export function placeholderPathForRemote(folder: RemoteFolder, remotePath: string): string {
  if (!isRemotePathInsideRoot(folder.remoteRoot, remotePath)) return remotePath;
  const mapped = placeholderMappings(folder)
    .filter(item => isRemotePathInsideRoot(item.remoteRoot, remotePath))
    .sort((a, b) => b.remoteRoot.length - a.remoteRoot.length)[0];
  return mapped
    ? path.posix.join(mapped.workspaceRoot, path.posix.relative(mapped.remoteRoot, remotePath))
    : path.posix.join(folder.workspaceRoot, path.posix.relative(folder.remoteRoot, remotePath));
}

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

interface WatchedResource {
  uri: vscode.Uri;
  snapshot?: string;
  references: number;
}

class RemoteFileChangedError extends Error {
  constructor() {
    super('Remote file changed since it was read');
    this.name = 'RemoteFileChangedError';
  }
}

const editorConflictDecisions = new Map<string, Promise<'overwrite' | 'revert' | undefined>>();

function fileType(type: SftpFileStat['type']): vscode.FileType {
  switch (type) {
    case 'file': return vscode.FileType.File;
    case 'directory': return vscode.FileType.Directory;
    case 'symbolic-link': return vscode.FileType.SymbolicLink;
    default: return vscode.FileType.Unknown;
  }
}

function fileStat(stat: SftpFileStat): vscode.FileStat {
  return {
    type: fileType(stat.type),
    ctime: stat.ctime,
    mtime: stat.mtime,
    size: stat.size,
    permissions: stat.permissions === undefined
      ? undefined
      : (stat.permissions & 0o222 ? undefined : vscode.FilePermission.Readonly)
  };
}

function errorCode(error: unknown): number | string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { code?: number | string };
  return value.code;
}

function providerError(error: unknown, uri: vscode.Uri): never {
  if (error instanceof vscode.FileSystemError) throw error;
  const code = errorCode(error);
  if (code === 2 || code === 'ENOENT') throw vscode.FileSystemError.FileNotFound(uri);
  if (code === 3 || code === 'EACCES' || code === 'EPERM') {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
  if (code === 4 || code === 'EEXIST') throw vscode.FileSystemError.FileExists(uri);
  const message = error instanceof Error ? error.message : String(error);
  throw vscode.FileSystemError.Unavailable(`${uri.toString()}: ${message}`);
}

export class RemoteFolderRegistry {
  private readonly folders = new Map<string, RemoteFolder>();

  set(folder: RemoteFolder): void {
    this.folders.set(folder.mountName, folder);
  }

  get(mountName: string): RemoteFolder | undefined {
    return this.folders.get(mountName);
  }

  delete(mountName: string): void {
    this.folders.delete(mountName);
  }

  /** 配置改名：连同文件夹记录挂到新名字下（hostName 也是连接键，一起换）。 */
  rename(oldName: string, newName: string): void {
    const folder = this.folders.get(oldName);
    if (!folder || oldName === newName) return;
    this.folders.delete(oldName);
    this.folders.set(newName, { ...folder, mountName: newName, hostName: newName });
  }

  values(): RemoteFolder[] {
    return [...this.folders.values()];
  }

  uri(folder: RemoteFolder): vscode.Uri {
    return vscode.Uri.parse(remoteUri(folder.mountName, folder.workspaceRoot));
  }
}

export class SftpFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly remoteAccepted = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidAcceptRemoteSave = this.remoteAccepted.event;
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  private readonly statCache = new Map<string, CacheEntry<vscode.FileStat>>();
  private readonly directoryCache = new Map<string, CacheEntry<[string, vscode.FileType][]>>();
  private readonly statRequests = new Map<string, Promise<vscode.FileStat>>();
  private readonly directoryRequests = new Map<string, Promise<[string, vscode.FileType][]>>();
  private cacheGeneration = 0;
  private polling = false;
  private readonly watched = new Map<string, WatchedResource>();
  private readonly readVersions = new Map<string, { size: number; mtime: number }>();
  private readonly watchTimer: NodeJS.Timeout;
  readonly onDidChangeFile = this.changes.event;
  constructor(
    private readonly pool: SftpConnectionPool,
    private readonly registry: RemoteFolderRegistry,
    private readonly cacheTtlMs: number,
    watchIntervalMs: number,
    private readonly onMutation?: (
      uri: vscode.Uri, kind: 'write' | 'delete' | 'rename' | 'mkdir', targetUri?: vscode.Uri
    ) => void,
    private readonly recoverFolder?: (mountName: string) => Promise<RemoteFolder | undefined>
  ) {
    this.watchTimer = setInterval(() => void this.pollWatches(), watchIntervalMs);
    this.watchTimer.unref();
  }

  refresh(uri: vscode.Uri): void {
    this.cacheGeneration++;
    this.statRequests.clear();
    this.directoryRequests.clear();
    this.statCache.clear();
    this.directoryCache.clear();
    this.changes.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  private async resolveBase(uri: vscode.Uri): Promise<{
    folder: RemoteFolder;
    translatedPath: string;
    session: SftpSession;
  }> {
    if (uri.scheme !== remoteFileSystemScheme) {
      throw vscode.FileSystemError.Unavailable(`Unsupported URI scheme: ${uri.scheme}`);
    }
    const location = parseRemoteUri(uri.toString());
    const folder = this.registry.get(location.mountName)
      ?? await this.recoverFolder?.(location.mountName);
    if (!folder) throw vscode.FileSystemError.Unavailable(`Unknown remote folder: ${location.mountName}`);
    if (!isWorkspaceUriPath(folder, location.remotePath)) {
      throw vscode.FileSystemError.NoPermissions(
        'The URI is outside the storage-backed workspace namespace'
      );
    }
    const translatedPath = remotePathForUri(folder, location.remotePath);
    if (!isRemotePathInsideRoot(folder.remoteRoot, translatedPath)) {
      throw vscode.FileSystemError.NoPermissions('The path is outside the remote workspace root');
    }
    const session = await this.pool.get(folder.hostName);
    return { folder, translatedPath, session };
  }

  private async resolve(uri: vscode.Uri, allowMissing = false): Promise<{
    folder: RemoteFolder;
    remotePath: string;
    session: SftpSession;
  }> {
    const { folder, translatedPath, session } = await this.resolveBase(uri);
    let securedPath: string;
    try {
      securedPath = await session.realpath(translatedPath);
    } catch (error) {
      if (!allowMissing || (errorCode(error) !== 2 && errorCode(error) !== 'ENOENT')) throw error;
      const parent = await session.realpath(path.posix.dirname(translatedPath));
      securedPath = path.posix.join(parent, path.posix.basename(translatedPath));
    }
    if (!isRemotePathInsideRoot(folder.remoteRoot, securedPath)) {
      throw vscode.FileSystemError.NoPermissions(
        'A symbolic link resolves outside the remote workspace root'
      );
    }
    return {
      folder,
      remotePath: securedPath,
      session
    };
  }

  private valid<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
    const entry = cache.get(key);
    if (!entry || entry.expiresAt <= Date.now()) {
      cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  private store<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): T {
    cache.set(key, { value, expiresAt: Date.now() + this.cacheTtlMs });
    return value;
  }

  private invalidate(uri: vscode.Uri): void {
    this.cacheGeneration++;
    const key = uri.toString();
    this.statCache.delete(key);
    this.directoryCache.delete(key);
    this.statRequests.delete(key);
    this.directoryRequests.delete(key);
    const parent = uri.with({ path: path.posix.dirname(uri.path) }).toString();
    this.directoryCache.delete(parent);
    this.statCache.delete(parent);
    this.statRequests.delete(parent);
    this.directoryRequests.delete(parent);
  }

  private coalesce<T>(requests: Map<string, Promise<T>>, key: string, action: () => Promise<T>): Promise<T> {
    const existing = requests.get(key);
    if (existing) return existing;
    const pending = Promise.resolve().then(action).finally(() => {
      if (requests.get(key) === pending) requests.delete(key);
    });
    requests.set(key, pending);
    return pending;
  }

  stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const generation = this.cacheGeneration;
    return this.coalesce(this.statRequests, uri.toString(), () => this.loadStat(uri, generation));
  }

  private async loadStat(uri: vscode.Uri, generation: number): Promise<vscode.FileStat> {
    const key = uri.toString();
    const cached = this.valid(this.statCache, key);
    if (cached) return cached;
    try {
      const { session, remotePath } = await this.resolve(uri);
      const value = fileStat(await session.stat(remotePath));
      return generation === this.cacheGeneration ? this.store(this.statCache, key, value) : value;
    } catch (error) {
      providerError(error, uri);
    }
  }

  readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const generation = this.cacheGeneration;
    return this.coalesce(this.directoryRequests, uri.toString(), () => this.loadDirectory(uri, generation));
  }

  private async loadDirectory(uri: vscode.Uri, generation: number): Promise<[string, vscode.FileType][]> {
    const key = uri.toString();
    const cached = this.valid(this.directoryCache, key);
    if (cached) return cached;
    try {
      // 合并 realpath + 列举（SCP 回退下一条 exec，SFTP 下等价原两步），
      // 由返回的规范路径做符号链接越界校验。
      const { folder, translatedPath, session } = await this.resolveBase(uri);
      const { path: securedPath, entries } = await session.readDirectoryResolved(translatedPath);
      if (!isRemotePathInsideRoot(folder.remoteRoot, securedPath)) {
        throw vscode.FileSystemError.NoPermissions(
          'A symbolic link resolves outside the remote workspace root'
        );
      }
      const result: [string, vscode.FileType][] = [];
      for (const entry of entries) {
        if (entry.name === '.' || entry.name === '..') continue;
        result.push([entry.name, fileType(entry.type)]);
        // 预填子项 stat 缓存：列举已带完整元数据（size/mtime/mode），随后编辑器/
        // 资源管理器对子项的 stat 直接命中，不再产生网络请求（打开文件少一次往返）。
        // 符号链接除外：其真实类型需按需 stat（与 realpath 缓存同策略，防不一致）。
        if (entry.type !== 'symbolic-link' && generation === this.cacheGeneration) {
          this.store(
            this.statCache,
            vscode.Uri.joinPath(uri, entry.name).toString(),
            fileStat(entry)
          );
        }
      }
      return generation === this.cacheGeneration ? this.store(this.directoryCache, key, result) : result;
    } catch (error) {
      providerError(error, uri);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    try {
      const { session, remotePath } = await this.resolve(uri);
      const value = await session.readFile(remotePath);
      const info = await session.stat(remotePath);
      if (info.size === value.byteLength) {
        this.readVersions.set(uri.toString(), { size: info.size, mtime: info.mtime });
      } else {
        this.readVersions.delete(uri.toString());
      }
      if (!saveConfirmation.attempts.get(uri.toString())?.busy) saveConfirmation.discard(uri.toString());
      return value;
    } catch (error) {
      providerError(error, uri);
    }
  }

  async writeFile(
    uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }, confirmedRetry = false
  ): Promise<void> {
    try {
      await this.saveFile(uri, content, options, confirmedRetry);
    } catch (error) {
      if (!(error instanceof RemoteFileChangedError)) throw error;
      const key = uri.toString();
      const pending = editorConflictDecisions.get(key) ?? Promise.resolve(notificationWindow.showWarningMessage(
        `远程文件“${path.posix.basename(uri.path)}”已发生变化。`,
        { modal: true }, '覆盖远程', '撤销修改'
      )).then(value => value === '覆盖远程' ? 'overwrite' as const
        : value === '撤销修改' ? 'revert' as const : undefined)
      const decision = pending.finally(() => {
        if (editorConflictDecisions.get(key) === decision) editorConflictDecisions.delete(key);
      });
      editorConflictDecisions.set(key, decision);
      const selected = await decision;
      if (selected === 'overwrite') {
        await this.saveFile(uri, content, options, false, undefined, undefined, 'overwrite');
        return;
      }
      if (selected === 'revert') {
        const remoteContent = await this.reloadRemoteFile(uri);
        const document = await vscode.workspace.openTextDocument(uri);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
          new TextDecoder('utf-8', { fatal: true }).decode(remoteContent));
        if (!await vscode.workspace.applyEdit(edit)) {
          throw new Error('无法用远程最新内容替换本地修改');
        }
        const { session, remotePath } = await this.resolve(uri);
        const info = await session.stat(remotePath);
        this.readVersions.set(uri.toString(), { size: info.size, mtime: info.mtime });
        return;
      }
      throw vscode.FileSystemError.Unavailable('保存已取消；本地修改仍保留。');
    }
  }

  async saveFile(
    uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }, confirmedRetry = false,
    requiredRoot?: string, expectedVersion?: { size: number; mtime: number },
    conflictPolicy: 'reject' | 'overwrite' = 'reject'
  ): Promise<{ remotePreferred: boolean; bytes: number; remoteContent?: Uint8Array; permissions?: number }> {
    try {
      if (!confirmedRetry && saveConfirmation.attempts.has(uri.toString())) {
        if (await this.verifyPendingSave(uri, requiredRoot) === 'remote') {
          const { session, remotePath } = await this.resolve(uri);
          if (requiredRoot && !isRemotePathInsideRoot(requiredRoot, remotePath)) {
            throw vscode.FileSystemError.NoPermissions('Write path escapes workspaceRoot through a symbolic link');
          }
          const remoteContent = await session.readFile(remotePath);
          const info = await session.stat(remotePath);
          this.invalidate(uri);
          this.changes.fire([{ type: vscode.FileChangeType.Changed, uri }]);
          this.remoteAccepted.fire(uri);
          return { remotePreferred: true, bytes: remoteContent.byteLength, remoteContent, permissions: info.permissions };
        }
      }
      const { session, remotePath } = await this.resolve(uri, true);
      if (requiredRoot && !isRemotePathInsideRoot(requiredRoot, remotePath)) {
        throw vscode.FileSystemError.NoPermissions('Write path escapes workspaceRoot through a symbolic link');
      }
      let existing: SftpFileStat | undefined;
      try { existing = await session.stat(remotePath); }
      catch (error) {
        if (errorCode(error) !== 2 && errorCode(error) !== 'ENOENT') throw error;
      }
      if (existing && !options.overwrite) throw vscode.FileSystemError.FileExists(uri);
      if (!existing && !options.create) throw vscode.FileSystemError.FileNotFound(uri);
      if (existing && existing.type !== 'file') throw vscode.FileSystemError.NoPermissions('Only regular files can be saved');
      const readVersion = expectedVersion ?? this.readVersions.get(uri.toString());
      if (existing && readVersion
        && (existing.size !== readVersion.size || existing.mtime !== readVersion.mtime)) {
        if (conflictPolicy === 'overwrite') {
          this.readVersions.set(uri.toString(), { size: existing.size, mtime: existing.mtime });
        } else {
          this.readVersions.delete(uri.toString());
          this.invalidate(uri);
          this.changes.fire([{ type: vscode.FileChangeType.Changed, uri }]);
          throw new RemoteFileChangedError();
        }
      }
      if (expectedVersion && (!existing || existing.size !== expectedVersion.size
        || existing.mtime !== expectedVersion.mtime)) {
        throw new RemoteFileChangedError();
      }
      // Preserve the existing inode, owner, group and ACLs by writing in place.
      // New files are created exclusively with private permissions.
      await saveConfirmation.run(uri.toString(), content,
        existing?.permissions === undefined ? (existing ? undefined : 0o600) : existing.permissions & 0o7777, async signal => {
      await session.writeFile(remotePath, content, existing
        ? { create: false, overwrite: true }
        : { create: true, overwrite: false, mode: 0o600 }, signal);
      const saved = await session.stat(remotePath);
      if (saved.size !== content.byteLength) throw new Error('Remote file size changed during save');
      if (existing?.permissions !== undefined && saved.permissions !== undefined
        && (saved.permissions & 0o7777) !== (existing.permissions & 0o7777)) {
        throw new Error('Remote file permissions changed during save');
      }
      }, () => session.isAlive(), confirmedRetry);
      this.invalidate(uri);
      const saved = await session.stat(remotePath);
      this.readVersions.set(uri.toString(), { size: saved.size, mtime: saved.mtime });
      this.changes.fire([
        { type: vscode.FileChangeType.Changed, uri },
        { type: vscode.FileChangeType.Changed, uri: vscode.Uri.joinPath(uri, '..') }
      ]);
      this.onMutation?.(uri, 'write');
      return { remotePreferred: false, bytes: content.byteLength };
    } catch (error) {
      providerError(error, uri);
    }
  }

  async reloadRemoteFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { session, remotePath } = await this.resolve(uri);
    const content = await session.readFile(remotePath);
    const info = await session.stat(remotePath);
    if (content.byteLength !== info.size) throw new Error('Remote file changed while reloading');
    this.readVersions.set(uri.toString(), { size: info.size, mtime: info.mtime });
    this.invalidate(uri);
    this.changes.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    return content;
  }

  async verifySavedVersion(uri: vscode.Uri): Promise<void> {
    const readVersion = this.readVersions.get(uri.toString());
    if (!readVersion) return;
    const { session, remotePath } = await this.resolve(uri);
    const current = await session.stat(remotePath);
    if (current.size !== readVersion.size || current.mtime !== readVersion.mtime) {
      this.readVersions.delete(uri.toString());
      this.invalidate(uri);
      const error = new Error('Remote file changed since it was opened');
      error.name = 'RemoteFileChangedError';
      throw error;
    }
  }

  async verifyPendingSave(uri: vscode.Uri, requiredRoot?: string): Promise<'matched' | 'remote' | undefined> {
    const { session, remotePath } = await this.resolve(uri);
    if (requiredRoot && !isRemotePathInsideRoot(requiredRoot, remotePath)) {
      throw vscode.FileSystemError.NoPermissions('Write path escapes workspaceRoot through a symbolic link');
    }
    const result = await saveConfirmation.verify(uri.toString(), async () => {
      const content = await session.readFile(remotePath);
      const info = await session.stat(remotePath);
      return { content, permissions: info.permissions === undefined ? undefined : info.permissions & 0o7777 };
    });
    this.invalidate(uri);
    return result;
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    try {
      const { session, remotePath } = await this.resolve(uri, true);
      await session.createDirectory(remotePath);
      this.invalidate(uri);
      this.changes.fire([{ type: vscode.FileChangeType.Created, uri }]);
      this.onMutation?.(uri, 'mkdir');
    } catch (error) {
      providerError(error, uri);
    }
  }

  private async deleteRecursive(session: SftpSession, remotePath: string): Promise<void> {
    const stat = await session.stat(remotePath);
    if (stat.type !== 'directory') {
      await session.deleteFile(remotePath);
      return;
    }
    const children = await session.readDirectory(remotePath);
    for (const child of children) {
      if (child.name === '.' || child.name === '..') continue;
      await this.deleteRecursive(session, path.posix.join(remotePath, child.name));
    }
    await session.deleteDirectory(remotePath);
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    try {
      const { folder, session, remotePath } = await this.resolve(uri);
      if (remotePath === folder.remoteRoot) {
        throw vscode.FileSystemError.NoPermissions('The remote workspace root cannot be deleted');
      }
      const stat = await session.stat(remotePath);
      if (stat.type === 'directory' && options.recursive) {
        await this.deleteRecursive(session, remotePath);
      } else if (stat.type === 'directory') {
        await session.deleteDirectory(remotePath);
      } else {
        await session.deleteFile(remotePath);
      }
      this.invalidate(uri);
      this.changes.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
      this.onMutation?.(uri, 'delete');
    } catch (error) {
      providerError(error, uri);
    }
  }

  async rename(
    oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }
  ): Promise<void> {
    try {
      const source = await this.resolve(oldUri);
      const target = await this.resolve(newUri, true);
      if (source.folder.hostName !== target.folder.hostName) {
        throw vscode.FileSystemError.Unavailable('Cannot rename across SFTP connections');
      }
      if (options.overwrite) {
        await target.session.stat(target.remotePath).then(async (stat) => {
          if (stat.type === 'directory') await target.session.deleteDirectory(target.remotePath);
          else await target.session.deleteFile(target.remotePath);
        }).catch((error) => {
          if (errorCode(error) !== 2 && errorCode(error) !== 'ENOENT') throw error;
        });
      }
      await source.session.rename(source.remotePath, target.remotePath, options.overwrite);
      this.invalidate(oldUri);
      this.invalidate(newUri);
      this.changes.fire([
        { type: vscode.FileChangeType.Deleted, uri: oldUri },
        { type: vscode.FileChangeType.Created, uri: newUri }
      ]);
      this.onMutation?.(oldUri, 'rename', newUri);
    } catch (error) {
      providerError(error, oldUri);
    }
  }

  watch(uri: vscode.Uri): vscode.Disposable {
    const key = uri.toString();
    const existing = this.watched.get(key);
    if (existing) existing.references += 1;
    else this.watched.set(key, { uri, references: 1 });
    return new vscode.Disposable(() => {
      const watched = this.watched.get(key);
      if (!watched) return;
      watched.references -= 1;
      if (watched.references <= 0) this.watched.delete(key);
    });
  }

  private async pollWatches(): Promise<void> {
    // A slow native SFTP request must not spawn another polling wave every
    // timer tick. Explorer reads also share pending stat/list operations.
    if (this.polling) return;
    this.polling = true;
    try {
    const targets = [...this.watched.values()];
    await Promise.allSettled(targets.map(async (watched) => {
      try {
        const stat = await this.stat(watched.uri);
        const snapshot = `${stat.type}:${stat.mtime}:${stat.size}`;
        if (watched.snapshot !== snapshot) {
          if (watched.snapshot !== undefined) this.invalidate(watched.uri);
          this.changes.fire([{ type: vscode.FileChangeType.Changed, uri: watched.uri }]);
        }
        watched.snapshot = snapshot;
      } catch (error) {
        const missing = ['FileNotFound', 'EntryNotFound', 'ENOENT'].includes(String(errorCode(error)))
          || errorCode(error) === 2;
        if (watched.snapshot !== undefined) {
          watched.snapshot = undefined;
          this.invalidate(watched.uri);
          if (missing) {
            this.changes.fire([{ type: vscode.FileChangeType.Deleted, uri: watched.uri }]);
          }
        }
      }
    }));
    } finally { this.polling = false; }
  }

  dispose(): void {
    this.cacheGeneration++;
    this.statRequests.clear();
    this.directoryRequests.clear();
    this.readVersions.clear();
    clearInterval(this.watchTimer);
    this.changes.dispose();
    this.remoteAccepted.dispose();
    this.statCache.clear();
    this.directoryCache.clear();
    this.watched.clear();
  }
}
