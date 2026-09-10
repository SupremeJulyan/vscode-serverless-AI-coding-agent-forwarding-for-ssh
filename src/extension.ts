import { updateCliInstructions, writeCliConnectionFile } from './cli-integration';
import {
  ensureUnixCliPath, globalNativeCli, installNativeCli, nativeCliConnectionPath,
  nativeCliPlatform, nativeMcpBridgeInstallPrompt, parseNativeCliVersion,
  windowsUserPathUpdatePlan
} from './native-cli';
import { searchCommand, RemoteSearchOptions } from './remote-search';
import { readTextRange, RemoteReadOptions } from './remote-read';
import { pageDirectory, searchResult } from './remote-results';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import * as vscode from 'vscode';
import {
  BridgeConfig, deriveMounts, ensureConfigFile, expandHome, HostConfig, loadConfig, MountConfig,
  parseSshLogin, removeMountConfig, resolveMount, saveConfig
} from './config';
import { decryptPassword, encryptPassword, isEncryptedPassword } from './password';
import {
  AskpassCredentials, createAskpassCredentials, platformUsesAskpass
} from './askpass';
import {
  CommandPlan, createPlatformAdapter, platformExtensionStateKey
} from './platform';
import { executeCaptured, missingExecutableName, resolveExecutable } from './process';
import { closeSsh2ExecSessions, executeSsh2Command, Ssh2Terminal } from './ssh2-terminal';
import {
  passwordValueOffset
} from './authentication';
import { AgentMcpServer } from './agent-mcp';import {
  AgentHttpRouter, AgentPlatformLabel, agentTaggedMcpUrl
} from './agent-http-router';
import { AgentWorkspacePublisher, discoverAgentWorkspaces } from './agent-discovery';
import { resolveAgentPlatform, wslBashInvocation } from './agent-platform';
import {
  ensureAgentCwdPlaceholder, ensureAgentCwdSubdirectory,
  writeLastRemoteDirectory
} from './agent-cwd';
import { connectSftp } from './sftp/client';
import { SftpSession } from './sftp/session';
import { writeStreamToFile } from './stream-file';
import { downloadRemoteDirectoryTree } from './remote-download';
import { uploadRemoteTree } from './remote-upload';
import { defaultSshClientIdent, ensureSshCapabilities } from './ssh-algorithms';
import { SftpConnectionPool } from './sftp/connection-pool';
import { RemoteSyncManager, RemoteSyncTask } from './remote-sync';
import { SyncCoordinator } from './sync-coordination';
import {
  remotePathForUri, RemoteFolder, RemoteFolderRegistry, SftpFileSystemProvider,
  workspacePathForRemote
} from './sftp/filesystem-provider';
import {
  isRemotePathInsideRoot, parseRemoteUri, remoteFileSystemScheme, remoteUri
} from './sftp/uri';
import { ensureWslBridgeExecutable, setWslBundlePath } from './wsl-bridge';
import { setRemoteShellIntegrationBundlePath } from './remote-shell-integration';
import { hostVerifierFor, setKnownHostsFilePath } from './host-key';
import {
  isOpenSshHostKeyVerificationFailure, maxOpenSshHostKeyRetries,
  runWithOpenSshHostKeyRetry, verifySystemSshHostKey
} from './system-ssh-host-key';
import {
  hasRequiredWslDependencies, installWslDependencies
} from './dependency-installer';
import { appendMcpCommandLog, appendMcpToolLog } from './mcp-log';
import {
  localPathForAgent, localPathFromAgent,
  validateLocalDownloadTarget, validateLocalUploadSource
} from './local-transfer-path';
import { redactSensitiveText } from './redact';
import {
  applyRemoteTextEdits, maxRemoteEditFileBytes, RemoteTextEdit, textSha256
} from './remote-edit';
import { shellQuote } from './shell-quote';
import {
  evaluateMcpCommandPolicy, readMcpCommandPolicySettings
} from './mcp-command-policy';
import {
  cleanTerminalDiagnostic, decodeTerminalDiagnostic, nextAutoReconnectAttempt,
  shouldRecoverTerminalExit, terminalDiagnosticPlan
} from './terminal-diagnostics';
import { shouldUseBuiltinSshTerminal } from './terminal-routing';
import {
  findRemotePathCandidates, findRemoteTerminalPaths, resolveRemoteTerminalCwdReport,
  resolveRemoteTerminalPath
} from './terminal-links';

const commandPrefix = 'safs';
const platformAdapter = createPlatformAdapter();

const platformStateKey = (name: string): string =>
  platformExtensionStateKey(name, platformAdapter.kind);
const terminalIdentityEnv = 'SERVERLESS_REMOTE_TERMINAL_ID';
const masterPasswordSecret = 'safs.masterPassword';
const agentMcpTokenSecret = platformStateKey('agentMcpToken');
const aiForwardMountsKey = platformStateKey('aiForwardMounts');
const directoryHistoryKey = platformStateKey('directoryHistory');
/** 已安装用户级 SAFS CLI 的平台与安装路径；用于跳过平台未变且文件尚在时的重复刷新。 */
const cliInstallKey = platformStateKey('cliInstall');
const defaultConfigPath = '~/.safs/config.json';
const openConfigAction = 'Open Config';
const addSshConfigAction = 'Add SSH Config';
const reconnectRemoteTerminalAction = '重连终端';
const viewSafsLogAction = '查看 SAFS 日志';
const addTerminalLinkMountAction = '添加 SSH 配置';
const openTerminalLinkConfigAction = '打开配置';
const terminalCredentialTtlMs = 5 * 60 * 1000;
const logClearIntervalMs = 24 * 60 * 60 * 1000;
/** 稳定终端断开后只自动恢复一次；短时间内再次退出视为用户主动结束。 */
const maxTerminalAutoReconnectAttempts = 1;
/** 存活达到该时长的终端视为稳定连接，后续断开重新从第 1 次重连计数。 */
const terminalAutoReconnectStableMs = 60_000;

let output: vscode.OutputChannel;
let bridgeOutput: vscode.LogOutputChannel | undefined;
let mcp: AgentMcpServer | undefined;
let httpRouter: AgentHttpRouter | undefined;
let httpRouterCreation: Promise<AgentHttpRouter> | undefined;
let httpRouterStart: Promise<AgentHttpRouter> | undefined;
/** 每个目标 CLI 在本次 Extension Host 生命周期只做一次真实版本检查。 */
const cliVersionChecks = new Map<string, Promise<void>>();
let agentHttpRouterHeartbeat: NodeJS.Timeout | undefined;
let vscodeContext: vscode.ExtensionContext;
let pool: SftpConnectionPool;
let registry: RemoteFolderRegistry;
let provider: SftpFileSystemProvider;
const agentWorkspacePublisher = new AgentWorkspacePublisher(randomBytes(12).toString('hex'));
let agentWorkspaceHeartbeat: NodeJS.Timeout | undefined;
let lastAgentDiscoveryState = '';
let lastForwardingSignature = '';
let safsStatusBar: vscode.StatusBarItem | undefined;
let forwardingFocusStatusBar: vscode.StatusBarItem | undefined;
let syncStatusBar: vscode.StatusBarItem | undefined;
let focusedAgentSource: { name: string; platform: string } | undefined;
let refreshTree: () => void = () => undefined;
const openingTerminalIds = new Set<string>();
let lastReadConfig: BridgeConfig | undefined;
const managedRemoteTerminals = new Map<vscode.Terminal, {
  mount: MountConfig;
  remoteCwd: string;
  retryWithSystemSsh?: boolean;
  hostKeyRetries?: number;
  startedAt: number;
  /** 内置 ssh2 终端实例：live-sync 用它安全补发 cd（shell 就绪前入队）。 */
  pty?: import('./ssh2-terminal').Ssh2Terminal;
  diagnostic?: { file: string; command: string };
}>();
/** 自动重连计数（key：mount\0remoteCwd），防止异常退出时无限自动重连。 */
const autoReconnectFails = new Map<string, number>();

interface SafsTerminalLink extends vscode.TerminalLink {
  mountName: string;
  rawPath: string;
  remotePath: string;
  remoteRoot: string;
  searchRoot: string;
  line?: number;
  column?: number;
}

/** 当前窗口对应挂载的活动传输通道；非远程窗口或尚未连接时返回 undefined。 */
function currentSessionTransport(): 'sftp' | 'scp' | undefined {
  // 激活早期 pool/registry 可能还未创建（状态栏先于连接池初始化）。
  if (!pool || !registry) return undefined;
  const location = currentRemoteLocation();
  const folder = location ? registry.get(location.mountName) : undefined;
  return folder ? pool.transport(folder.hostName) : undefined;
}

/** 按当前会话传输通道刷新底栏入口文案（SFTP 或 SCP 回退），不影响焦点提示。 */
function refreshSafsEntryLabel(): void {
  if (!safsStatusBar) return;
  // 服务器未提供 SFTP 子系统而回退 SCP/exec 时，入口相应显示为 SAFS SCP。
  const scpFallback = currentSessionTransport() === 'scp';
  safsStatusBar.text = scpFallback ? '$(remote) SAFS SCP' : '$(remote) SAFS SFTP';
  safsStatusBar.name = scpFallback ? 'SAFS SCP' : 'SAFS SFTP';
  safsStatusBar.tooltip = scpFallback
    ? '打开远程目录（服务器未提供 SFTP 子系统，当前经 SCP/exec 回退）'
    : '打开 SFTP 远程目录';
}

/** 同步镜像窗口：工作区是本地目录，但语义上仍绑定远程挂载并双向同步。 */
function isSyncMirrorWindow(): boolean {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.some((folder) => folder.uri.scheme === remoteFileSystemScheme)) return false;
  return folders.some(
    (folder) => folder.uri.scheme === 'file' && syncedRemoteLocation(folder.uri.fsPath)
  );
}

function updateSafsStatusBar(
  agentFocus = false, agentName?: string, agentPlatform?: string, clearSource = false
): void {
  if (!safsStatusBar || !forwardingFocusStatusBar) return;
  if (clearSource) focusedAgentSource = undefined;
  // Agent 通常在 VS Code 失焦时发起请求（用户正在操作桌面版/终端）。
  // 当下可以不显示焦点提示，但必须记住来源，以便切回窗口时恢复。
  if (agentName && agentPlatform) {
    focusedAgentSource = { name: agentName, platform: agentPlatform };
  }
  const source = focusedAgentSource
    ? `${focusedAgentSource.name}（${focusedAgentSource.platform}）`
    : 'Agent';
  // SFTP 入口与 SAFS SYNC 一样常驻；转发焦点提示单独一项，不再顶替 SFTP 文案。
  refreshSafsEntryLabel();
  // 镜像窗口在悬停里注明双向同步，避免“本地改还是远程改”的困惑。
  const mirrorHint = isSyncMirrorWindow() ? '（本地镜像：改动与远程双向同步）' : '';
  forwardingFocusStatusBar.text = focusedAgentSource
    ? `$(sparkle) ${source}远程转发中💪`
    : '$(sparkle) Agent 已聚焦当前窗口😏';
  forwardingFocusStatusBar.tooltip = focusedAgentSource
    ? `${source} 正在通过本窗口的远程连接干活${mirrorHint}`
    : `本窗口是 Agent MCP 的默认路由目标${mirrorHint}`;
  if (agentFocus) forwardingFocusStatusBar.show();
  else forwardingFocusStatusBar.hide();
}

let syncManager: RemoteSyncManager | undefined;
let syncCoordinator: SyncCoordinator | undefined;
const syncTasksKey = 'safs.syncTasks';

function saveSyncTasks(persist = true): void {
  if (!syncManager) return;
  if (persist) {
    void vscodeContext.globalState.update(
      syncTasksKey,
      syncManager.list().map(({
        mountName, remotePath, localDir, isFile, fingerprintLines, resetLocalOnFirstSync
      }) => ({
        mountName, remotePath, localDir, isFile, fingerprintLines, resetLocalOnFirstSync
      }))
    );
  }
  refreshTree();
  void updateSyncStatusBar();
}

function historySyncTask(item: HistoryItem): RemoteSyncTask | undefined {
  return syncManager?.list().find(
    (task) => task.mountName === item.mountName && task.remotePath === item.path
  );
}

/** 找到包含指定本地路径的最具体同步任务。 */
function syncTaskForLocalPath(localPath: string): RemoteSyncTask | undefined {
  const resolvedPath = path.resolve(localPath);
  return [...(syncManager?.list() ?? [])]
    .sort((left, right) => path.resolve(right.localDir).length - path.resolve(left.localDir).length)
    .find((task) => {
      const localRoot = path.resolve(task.localDir);
      const relative = path.relative(localRoot, resolvedPath);
      if (relative === '..' || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)) return false;
      return !task.isFile || relative === '';
    });
}

/** 把同步镜像中的本地路径映射回远程路径。 */
function syncedRemoteLocation(localPath: string): {
  mountName: string;
  remotePath: string;
} | undefined {
  const task = syncTaskForLocalPath(localPath);
  if (!task) return undefined;
  const relative = path.relative(path.resolve(task.localDir), path.resolve(localPath));
  return {
    mountName: task.mountName,
    remotePath: relative
      ? path.posix.join(task.remotePath, relative.split(path.sep).join('/'))
      : task.remotePath
  };
}

async function updateSyncStatusBar(): Promise<void> {
  if (!syncStatusBar) return;
  const localFolders = (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === 'file')
    .map((folder) => path.resolve(folder.uri.fsPath));
  let task: RemoteSyncTask | undefined;
  for (const candidate of syncManager?.list() ?? []) {
    const target = path.resolve(candidate.localDir);
    if (localFolders.some((folder) => folder === target)
      && await syncCoordinator?.isReady(
        candidate.mountName, candidate.remotePath, candidate.localDir
      )) {
      task = candidate;
      break;
    }
  }
  if (!task) {
    syncStatusBar.hide();
    return;
  }
  syncStatusBar.text = '$(sync) SAFS SYNC';
  syncStatusBar.tooltip = `正在双向同步：${task.remotePath} ↔ ${task.localDir}`;
  syncStatusBar.show();
}

// 重开远程窗口后，首次远程文件激活时无条件把自动连接的终端移到该文件目录
// （配合标签页恢复，与 safs.terminalFollowsActiveFile 无关）；后续切换文件
// 是否同步才由该设置控制。
const restoredFileSyncPending = new Set<string>();

// Channel-level failures mean the server rejects the ssh2 client's pty/shell
// negotiation (common on NSG/gateway appliances). Fall back to the system ssh
// CLI in that case; auth failures must NOT fall back (same credentials).
const builtinSshFallbackPattern = /pseudo-terminal|open shell|start subsystem|channel open/i;

class ConfigActionRequiredError extends Error {
  constructor(
    message: string,
    readonly actions = [openConfigAction],
    readonly hostName?: string
  ) {
    super(message);
  }
}

function settings(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('safs');
}

function agentTrace(stage: string, message: string): void {
  bridgeOutput?.debug(`[${stage}] ${message}`);
}

function logAsyncFailure(label: string, error: unknown): void {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  bridgeOutput?.error(`[${label}] ${redactSensitiveText(detail)}`);
}

function logMcpMessage(component: string, message: string): void {
  const line = `[${component}] ${message}`;
  if (message.startsWith('收到 MCP 请求：tools/call')) {
    bridgeOutput?.info(line);
  } else if (message.startsWith('收到 MCP 请求：')) {
    bridgeOutput?.debug(line);
  } else {
    bridgeOutput?.info(line);
  }
}

function configPath(): string {
  return expandHome(defaultConfigPath);
}

/**
 * 扩展独立的 known_hosts 文件（与配置文件同目录）。
 * prompt 模式下系统 ssh 用它做 OpenSSH 原生校验兜底（见 system-ssh-host-key.ts）。
 */
function knownHostsFilePath(): string {
  return path.join(path.dirname(configPath()), 'known_hosts');
}

async function readConfig(): Promise<BridgeConfig> {
  try {
    const config = await loadConfig(configPath());
    lastReadConfig = config;
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigActionRequiredError(
        `No config file was found at ${configPath()}.`,
        [addSshConfigAction]
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigActionRequiredError(`Cannot read ${configPath()}: ${message}`);
  }
}

function planDisplayName(plan: CommandPlan): string {
  const args = plan.args.map((argument, index) => {
    const previous = plan.args[index - 1]?.toLowerCase();
    return previous === '-command' && argument.includes('\n') ? '<script>' : argument;
  });
  return [plan.command, ...args].join(' ');
}

function redactAgentMcpText(value: string): string {
  return redactSensitiveText(value);
}

async function executeAgentMcpCommand(
  plan: CommandPlan, signal?: AbortSignal, maxOutputBytes = 1024 * 1024
): Promise<Awaited<ReturnType<typeof executeCaptured>>> {
  const displayName = redactAgentMcpText(planDisplayName(plan));
  bridgeOutput?.debug(`[Agent MCP] $ ${displayName}`);
  try {
    const result = await executeCaptured(
      { ...plan, cwd: plan.cwd ?? os.homedir() }, signal, maxOutputBytes
    );
    bridgeOutput?.debug(
      `[Agent MCP] [${result.exitCode === 0 ? '完成' : `失败: exit ${result.exitCode}`}] ${displayName}`
    );
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    bridgeOutput?.appendLine(`[Agent MCP] [失败] ${displayName}: ${detail}`);
    throw error;
  }
}

function performanceLine(label: string, startedAt: number): void {
  bridgeOutput?.trace(`[性能] ${label}: ${(performance.now() - startedAt).toFixed(1)} ms`);
}

async function timedPhase<T>(label: string, action: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    return await action();
  } finally {
    performanceLine(label, startedAt);
  }
}

async function promptMasterPassword(
  context: vscode.ExtensionContext, confirm: boolean, force = false
): Promise<string> {
  const stored = await context.secrets.get(masterPasswordSecret);
  if (stored && !force) return stored;
  const password = await input({
    title: '配置密码加密',
    prompt: confirm ? '设置配置加密主口令' : '输入配置加密主口令',
    placeHolder: '此口令用于加密 SSH 密码，请妥善保存',
    password: true,
    validateInput: required('加密主口令')
  });
  if (password === undefined) throw new Error('已取消密码加密');
  if (confirm) {
    const repeated = await input({
      title: '配置密码加密', prompt: '再次输入配置加密主口令', password: true,
      validateInput: required('加密主口令')
    });
    if (repeated === undefined) throw new Error('已取消密码加密');
    if (repeated !== password) throw new Error('两次输入的加密主口令不一致');
  }
  await context.secrets.store(masterPasswordSecret, password);
  return password;
}

async function decryptHostPassword(context: vscode.ExtensionContext, encrypted: string): Promise<string> {
  const stored = await context.secrets.get(masterPasswordSecret);
  if (stored) {
    try {
      return await decryptPassword(encrypted, stored);
    } catch {
      // 单个主机的密文可能已损坏，也可能是主口令已更换。不要删除全局 secret：
      // 其它主机可能仍能用旧口令解密；这里仅对本次解密重新提示。
    }
  }
  const password = await promptMasterPassword(context, false, true);
  const decrypted = await decryptPassword(encrypted, password);
  // 新口令成功解密后才更新全局 secret；失败则保持旧 secret 不动。
  await context.secrets.store(masterPasswordSecret, password);
  return decrypted;
}

async function bridgeMasterPasswordEnv(
  context: vscode.ExtensionContext, host: HostConfig
): Promise<Record<string, string>> {
  if (platformAdapter.kind !== 'wsl' || !host.password) return {};
  const encrypted = isEncryptedPassword(host.password);
  if (encrypted) {
    // This validates a stored value and prompts again immediately if it is
    // stale, rather than failing inside the non-interactive bridge process.
    await decryptHostPassword(context, host.password);
    const masterPassword = await context.secrets.get(masterPasswordSecret);
    if (!masterPassword) throw new Error('无法读取配置加密主口令');
    return { WSL_VPN_MASTER_PASSWORD: masterPassword };
  }
  const masterPassword = await promptMasterPassword(context, true);
  return { WSL_VPN_MASTER_PASSWORD: masterPassword };
}

async function resolveStoredHostPassword(
  context: vscode.ExtensionContext, config: BridgeConfig, host: HostConfig
): Promise<HostConfig> {
  if (!host.password) return host;
  if (isEncryptedPassword(host.password)) {
    return { ...host, password: await decryptHostPassword(context, host.password) };
  }
  const plainPassword = host.password;
  const masterPassword = await promptMasterPassword(context, true);
  const encrypted = await encryptPassword(plainPassword, masterPassword);
  const index = config.hosts.findIndex((item) => item.name === host.name);
  if (index >= 0) config.hosts[index] = { ...host, password: encrypted };
  config.encrypt_passwords = true;
  await saveConfig(configPath(), config);
  return { ...host, password: plainPassword };
}

async function resolvedHost(
  context: vscode.ExtensionContext, hostName: string
): Promise<HostConfig> {
  const config = await readConfig();
  const host = config.hosts.find((candidate) => candidate.name === hostName);
  if (!host) throw new Error(`SSH 主机不存在：${hostName}`);
  if (!host.password) return { ...host };
  if (!isEncryptedPassword(host.password)) return { ...host };
  return {
    ...host,
    password: await decryptPassword(host.password, await promptMasterPassword(context, false))
  };
}

async function selectMount(placeHolder: string): Promise<MountConfig | undefined> {
  const config = await readConfig();
  if (config.mounts.length === 0) {
    throw new ConfigActionRequiredError(
      'No remote folders are configured yet.',
      [addSshConfigAction]
    );
  }
  const picked = await vscode.window.showQuickPick(config.mounts.map((mount) => ({
    label: mount.name,
    description: `${mount.host}: ${mount.remote_path}`,
    mount
  })), { placeHolder });
  return picked?.mount;
}

function cliMode(): boolean { return settings().get<string>('agentInterface', 'mcp') === 'cli'; }

function cliRouterUrl(url: string): string {
  const platform: AgentPlatformLabel = settings().get<string>('agentPlatform', 'auto') === 'wsl'
    || platformAdapter.kind === 'wsl' ? 'wsl' : platformAdapter.kind === 'windows' ? 'win'
      : platformAdapter.kind === 'macos' ? 'mac' : 'linux';
  return agentTaggedMcpUrl(url, 'safs-cli', platform);
}

async function removeLegacyCliInstructions(localRoot: string): Promise<void> {
  // workspaceRoot uses URI path syntax; normalize to the native filesystem view.
  const nativeRoot = platformAdapter.kind === 'windows' && /^\/[A-Za-z]:/.test(localRoot)
    ? vscode.Uri.from({ scheme: 'file', path: localRoot }).fsPath : localRoot;
  await updateCliInstructions(path.dirname(nativeRoot));
}

async function ensureFolder(mount: MountConfig): Promise<RemoteFolder> {
  const existing = registry.get(mount.name);
  if (existing) {
    bridgeOutput?.trace(`[SFTP] 复用挂载 ${mount.name}，remoteRoot=${existing.remoteRoot}`);
    await pool.get(existing.hostName);
    refreshSafsEntryLabel();
    await removeLegacyCliInstructions(existing.workspaceRoot);
    return existing;
  }
  agentTrace('SFTP', `开始连接挂载 ${mount.name}，host=${mount.host}`);
  const config = await readConfig();
  const resolved = resolveMount(config, mount);
  const session = await pool.get(resolved.hostConfig.name);
  refreshSafsEntryLabel();
  // realpath + stat 一步完成（SCP 回退下合并为单条 exec）。
  const { path: remoteRoot, stat } = await session.statResolved(mount.remote_path);
  if (stat.type !== 'directory') throw new Error(`远程路径不是目录：${remoteRoot}`);
  const placeholder = await ensureAgentCwdPlaceholder(
    remoteRoot, vscodeContext.globalStorageUri.fsPath, mount.name
  );
  await removeLegacyCliInstructions(placeholder.localPath);
  const workspaceRoot = vscode.Uri.file(placeholder.localPath).path;
  const folder = { mountName: mount.name, hostName: mount.host, remoteRoot, workspaceRoot };
  registry.set(folder);
  agentTrace(
    'SFTP',
    `挂载 ${mount.name} 验证完成，remoteRoot=${remoteRoot}，agentCwd=${placeholder.localPath}`
  );
  return folder;
}

function folderUri(folder: RemoteFolder, remotePath = folder.remoteRoot): string {
  return remoteUri(folder.mountName, workspacePathForRemote(folder, remotePath));
}

function reportedRemoteTerminalCwd(
  terminal: vscode.Terminal,
  info: NonNullable<ReturnType<typeof managedRemoteTerminals.get>>
): string {
  // VS Code explicitly allows this URI to refer to another machine. In
  // particular, a remote shell may report `file:///remote/path` without a
  // hostname, so rejecting empty/local-looking authorities leaves the cwd
  // permanently stuck at the SSH terminal's startup directory after `cd`.
  const cwd = resolveRemoteTerminalCwdReport(terminal.shellIntegration?.cwd, info.remoteCwd);
  info.remoteCwd = cwd;
  return cwd;
}

function provideSafsTerminalLinks(
  context: vscode.TerminalLinkContext
): SafsTerminalLink[] {
  const info = managedRemoteTerminals.get(context.terminal);
  if (!info) return [];
  const folder = registry.get(info.mount.name);
  if (!folder) return [];
  const remoteCwd = reportedRemoteTerminalCwd(context.terminal, info);
  const location = currentRemoteLocation();
  const searchRoot = location?.mountName === info.mount.name
    && isRemotePathInsideRoot(folder.remoteRoot, location.remotePath)
    ? location.remotePath
    : isRemotePathInsideRoot(folder.remoteRoot, remoteCwd)
      ? remoteCwd
      : folder.remoteRoot;
  return findRemoteTerminalPaths(context.line).map((match) => {
    const remotePath = resolveRemoteTerminalPath(match.path, remoteCwd);
    const insideRoot = isRemotePathInsideRoot(folder.remoteRoot, remotePath);
    return {
      startIndex: match.startIndex,
      length: match.length,
      tooltip: insideRoot
        ? `打开远程文件 ${remotePath}${match.line ? `:${match.line}${
          match.column ? `:${match.column}` : ''
      }` : ''}`
        : `路径超出挂载范围 ${folder.remoteRoot}，点击配置新的 SSH 挂载`,
      mountName: info.mount.name,
      rawPath: match.path,
      remotePath,
      remoteRoot: folder.remoteRoot,
      searchRoot,
      ...(match.line ? { line: match.line } : {}),
      ...(match.column ? { column: match.column } : {})
    };
  });
}

function isRemoteFileNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: string; name?: string };
  return value.code === 'FileNotFound' || value.code === 'ENOENT'
    || value.name === 'EntryNotFound';
}

async function openSafsTerminalRemotePath(
  folder: RemoteFolder, remotePath: string, line?: number, column?: number
): Promise<void> {
  const uri = vscode.Uri.parse(folderUri(folder, remotePath));
  const fileStat = await vscode.workspace.fs.stat(uri);
  if ((fileStat.type & vscode.FileType.Directory) !== 0) {
    await vscode.commands.executeCommand('revealInExplorer', uri);
    return;
  }
  const document = await vscode.workspace.openTextDocument(uri);
  let selection: vscode.Range | undefined;
  if (line) {
    const targetLine = Math.min(line - 1, Math.max(document.lineCount - 1, 0));
    const targetColumn = Math.min(
      Math.max((column ?? 1) - 1, 0), document.lineAt(targetLine).text.length
    );
    const position = new vscode.Position(targetLine, targetColumn);
    selection = new vscode.Range(position, position);
  }
  await vscode.window.showTextDocument(document, { preview: true, selection });
}

async function handleSafsTerminalLink(link: SafsTerminalLink): Promise<void> {
  const currentRoot = registry.get(link.mountName)?.remoteRoot ?? link.remoteRoot;
  if (!isRemotePathInsideRoot(currentRoot, link.remotePath)) {
    bridgeOutput?.warn(
      `[终端链接] 路径超出挂载范围；path=${link.remotePath}；mount=${link.mountName}；root=${currentRoot}`
    );
    const selected = await vscode.window.showWarningMessage(
      'SAFS：该远程路径超出当前挂载范围。',
      addTerminalLinkMountAction,
      openTerminalLinkConfigAction
    );
    if (selected === addTerminalLinkMountAction) {
      await vscode.commands.executeCommand(`${commandPrefix}.addSshConfig`);
    } else if (selected === openTerminalLinkConfigAction) {
      await vscode.commands.executeCommand(`${commandPrefix}.openConfig`);
    }
    return;
  }

  let folder = registry.get(link.mountName);
  if (!folder) {
    const config = await readConfig();
    const mount = config.mounts.find((candidate) => candidate.name === link.mountName);
    if (!mount) throw new Error(`远程挂载不存在：${link.mountName}`);
    folder = await ensureFolder(mount);
  }
  // Recheck against the live, server-resolved root in case the configuration
  // changed after the terminal printed this link.
  if (!isRemotePathInsideRoot(folder.remoteRoot, link.remotePath)) {
    throw new Error(`远程路径已超出挂载范围：${link.remotePath}`);
  }
  try {
    await openSafsTerminalRemotePath(folder, link.remotePath, link.line, link.column);
    return;
  } catch (error) {
    if (!isRemoteFileNotFound(error) || path.posix.isAbsolute(link.rawPath)) throw error;
  }

  const session = await pool.get(folder.hostName);
  bridgeOutput?.debug(`[终端链接] 查找 ${link.rawPath}；root=${link.searchRoot}`);
  const { search, cancelled } = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'SAFS：正在查找远程文件',
    cancellable: true
  }, async (_progress, token) => {
    const search = await findRemotePathCandidates(
      link.searchRoot,
      link.rawPath,
      async (directory) => {
        try {
          return await session.readDirectory(directory);
        } catch (error) {
          const code = (error as { code?: number | string }).code;
          if (code === 3 || code === 'EACCES' || code === 'EPERM') return [];
          throw error;
        }
      },
      { cancelled: () => token.isCancellationRequested }
    );
    return { search, cancelled: token.isCancellationRequested };
  });
  if (cancelled) return;
  if (search.matches.length === 0) {
    if (search.truncated) {
      bridgeOutput?.warn(
        `[终端链接] 前 5000 个远程条目中未找到 ${link.rawPath}；需要完整路径`
      );
      void vscode.window.showWarningMessage(
        'SAFS：未找到终端中的文件，请输出完整路径。'
      );
      return;
    }
    throw new Error(
      `远程文件不存在：${link.remotePath}；当前工作区内也没有同名路径。`
    );
  }
  const selected = search.matches.length === 1
    ? search.matches[0]
    : (await vscode.window.showQuickPick(
      search.matches.map((remotePath) => ({
        label: path.posix.relative(link.searchRoot, remotePath),
        description: remotePath,
        remotePath
      })),
      {
        title: `选择要打开的远程文件：${path.posix.basename(link.rawPath)}`,
        placeHolder: `找到 ${search.matches.length} 个匹配项`
      }
    ))?.remotePath;
  if (!selected) return;
  bridgeOutput?.appendLine(
    `[终端链接] ${link.remotePath} 不存在，已解析到工作区内的 ${selected}`
  );
  await openSafsTerminalRemotePath(folder, selected, link.line, link.column);
}

function localRootForFolder(folder: RemoteFolder): string {
  return vscode.Uri.from({ scheme: 'file', path: folder.workspaceRoot }).fsPath;
}

async function openDirectoryItem(requested: MountConfig): Promise<void> {
  const forwarding = vscodeContext.globalState
    .get<string[]>(aiForwardMountsKey, []).includes(requested.name);
  agentTrace('Open', `准备打开 ${requested.name}，Agent 转发=${forwarding ? '启用' : '关闭'}`);
  if (forwarding) {
    startAgentHttpRouterLeadership(vscodeContext);
    await ensureAgentHttpRouter(vscodeContext);
  }
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'SAFS：正在连接远程目录',
    cancellable: false
  }, async (progress) => {
    progress.report({ message: '正在验证远程目录…' });
    const folder = await ensureFolder(requested);
    const remoteDirectory = folder.remoteRoot;
    agentTrace('Open', `创建新窗口，workspace=${folderUri(folder, remoteDirectory)}`);
    progress.report({ message: '正在打开工作区…' });
    await vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.parse(folderUri(folder, remoteDirectory)),
      true
    );
  });
}

async function openRemoteDirectory(): Promise<void> {
  const location = currentRemoteLocation();
  if (!location) {
    throw new Error('当前窗口不是 SAFS 远程工作区');
  }
  const config = await readConfig();
  const mount = config.mounts.find((candidate) => candidate.name === location.mountName);
    if (!mount) throw new Error(`远程目录配置不存在：${location.mountName}`);
  const folder = await ensureFolder(mount);
  const session = await pool.get(folder.hostName);
  const requested = await promptRemoteDirectory(
    session, folder.remoteRoot, location.remotePath, mount.name
  );
  if (requested === undefined) return;
  const candidate = requested.trim().startsWith('/')
    ? path.posix.normalize(requested.trim())
    : path.posix.resolve(location.remotePath, requested.trim());
  if (!isRemotePathInsideRoot(folder.remoteRoot, candidate)) {
    throw new Error(`远程目录必须位于挂载根目录 ${folder.remoteRoot} 内`);
  }
  const resolved = await session.realpath(candidate);
  if (!isRemotePathInsideRoot(folder.remoteRoot, resolved)) {
    throw new Error(`远程目录必须位于挂载根目录 ${folder.remoteRoot} 内`);
  }
  if ((await session.stat(resolved)).type !== 'directory') {
    throw new Error(`远程路径不是目录：${resolved}`);
  }
  const forwarding = vscodeContext.globalState
    .get<string[]>(aiForwardMountsKey, []).includes(mount.name);
  agentTrace('Open', `准备在新窗口打开 ${mount.name}:${resolved}，Agent 转发=${forwarding ? '启用' : '关闭'}`);
  if (forwarding) {
    startAgentHttpRouterLeadership(vscodeContext);
    await ensureAgentHttpRouter(vscodeContext);
  }
  const localRoot = localRootForFolder(folder);
  await ensureAgentCwdSubdirectory(localRoot, folder.remoteRoot, resolved);
  await writeLastRemoteDirectory(localRoot, folder.remoteRoot, resolved);
  await recordDirectoryHistory(vscodeContext, mount.name, resolved);
  agentTrace('Open', `创建新窗口打开远程目录：${resolved}`);
  await vscode.commands.executeCommand(
    'vscode.openFolder', vscode.Uri.parse(folderUri(folder, resolved)), true
  );
}

async function switchRemoteDirectory(): Promise<void> {
  const location = currentRemoteLocation();
  if (!location) {
    throw new Error('当前窗口不是 SAFS 远程工作区');
  }
  const config = await readConfig();
  const mount = config.mounts.find((candidate) => candidate.name === location.mountName);
    if (!mount) throw new Error(`远程目录配置不存在：${location.mountName}`);
  const folder = await ensureFolder(mount);
  const session = await pool.get(folder.hostName);
  const requested = await promptRemoteDirectory(
    session, folder.remoteRoot, location.remotePath, mount.name
  );
  if (requested === undefined) return;
  const candidate = requested.trim().startsWith('/')
    ? path.posix.normalize(requested.trim())
    : path.posix.resolve(location.remotePath, requested.trim());
  if (!isRemotePathInsideRoot(folder.remoteRoot, candidate)) {
    throw new Error(`远程目录必须位于挂载根目录 ${folder.remoteRoot} 内`);
  }
  const resolved = await session.realpath(candidate);
  if (!isRemotePathInsideRoot(folder.remoteRoot, resolved)) {
    throw new Error(`远程目录必须位于挂载根目录 ${folder.remoteRoot} 内`);
  }
  if ((await session.stat(resolved)).type !== 'directory') {
    throw new Error(`远程路径不是目录：${resolved}`);
  }
  const localRoot = localRootForFolder(folder);
  await ensureAgentCwdSubdirectory(localRoot, folder.remoteRoot, resolved);
  await writeLastRemoteDirectory(localRoot, folder.remoteRoot, resolved);
  await recordDirectoryHistory(vscodeContext, mount.name, resolved);
  agentTrace('Open', `切换远程目录：${location.remotePath} -> ${resolved}`);
  await vscode.commands.executeCommand(
    'vscode.openFolder', vscode.Uri.parse(folderUri(folder, resolved))
  );
}

async function promptRemoteDirectory(
  session: import('./sftp/session').SftpSession,
  remoteRoot: string,
  currentPath: string,
  mountName: string
): Promise<string | undefined> {
  const picker = vscode.window.createQuickPick<vscode.QuickPickItem>();
  picker.title = `打开远程目录：${mountName}`;
  picker.placeholder = `输入路径，Tab 补全，回车进入`;
  picker.value = currentPath.endsWith('/') ? currentPath : `${currentPath}/`;
  // No items => no dropdown; completion is driven by the Tab keybinding.
  picker.items = [];
  const state: DirectoryPickerState = { picker, session, remoteRoot, currentPath };
  activeDirectoryPicker = state;
  void vscode.commands.executeCommand('setContext', directoryPickerContextKey, true);
  return new Promise<string | undefined>((resolve) => {
    let accepted = false;
    picker.onDidAccept(() => {
      accepted = true;
      clearActiveDirectoryPicker(state);
      picker.hide();
      resolve(picker.value);
    });
    picker.onDidHide(() => {
      clearActiveDirectoryPicker(state);
      picker.dispose();
      if (!accepted) resolve(undefined);
    });
    picker.show();
  });
}

// ---- Tab completion for the directory picker ----

const directoryPickerContextKey = 'safs.directoryPickerVisible';

interface DirectoryPickerState {
  picker: vscode.QuickPick<vscode.QuickPickItem>;
  session: import('./sftp/session').SftpSession;
  remoteRoot: string;
  currentPath: string;
}

let activeDirectoryPicker: DirectoryPickerState | undefined;

function clearActiveDirectoryPicker(state: DirectoryPickerState): void {
  if (activeDirectoryPicker === state) {
    activeDirectoryPicker = undefined;
    void vscode.commands.executeCommand('setContext', directoryPickerContextKey, false);
  }
}

function commonPrefix(names: string[]): string {
  let prefix = names[0] ?? '';
  for (const name of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

async function completeRemoteDirectory(): Promise<void> {
  const state = activeDirectoryPicker;
  if (!state) return;
  const { picker, session, remoteRoot, currentPath } = state;
  const typed = picker.value.trim();
  const absolute = typed.startsWith('/')
    ? path.posix.normalize(typed)
    : path.posix.resolve(currentPath, typed || '.');
  if (!isRemotePathInsideRoot(remoteRoot, absolute)) return;
  const [parent, base] = typed.endsWith('/') || absolute === remoteRoot
    ? [absolute, '']
    : [path.posix.dirname(absolute), path.posix.basename(absolute)];
  try {
    const entries = (await session.readDirectory(parent))
      .filter((entry) => entry.type === 'directory' || entry.type === 'symbolic-link')
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    if (base) {
      const matches = entries.filter((name) => name.startsWith(base));
      if (matches.length === 1) {
        picker.value = `${parent}/${matches[0]}/`;
      } else if (matches.length > 1) {
        const common = commonPrefix(matches);
        picker.value = common.length > base.length
          ? `${parent}/${common}`
          : `${parent}/${matches[0]}/`;
      }
    } else if (entries.length > 0) {
      picker.value = `${parent}/${entries[0]}/`;
    }
  } catch {
    // Completion is best-effort; ignore remote failures.
  }
}

/**
 * Returns the remote directory containing the currently open remote file of
 * the given mount, or undefined when none is active. No waiting: if the
 * terminal opens before the restored file tab is active, the live-sync
 * listener moves the terminal there once the editor becomes active.
 */
async function activeRemoteFileDirectory(mountName: string): Promise<string | undefined> {
  const editor = vscode.window.activeTextEditor
    ?? vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.scheme === remoteFileSystemScheme
        || candidate.document.uri.scheme === 'file'
    );
  const uri = editor?.document.uri;
  if (!uri) return undefined;
  const location = terminalRemoteLocationForUri(uri);
  return location?.mountName === mountName
    ? path.posix.dirname(location.remotePath)
    : undefined;
}

/** 把远程 URI 或同步镜像中的本地文件统一解析为远程位置。 */
function terminalRemoteLocationForUri(
  uri: vscode.Uri
): { mountName: string; remotePath: string } | undefined {
  if (uri.scheme === remoteFileSystemScheme) {
    try {
      const location = parseRemoteUri(uri.toString());
      const folder = registry.get(location.mountName);
      if (!folder) return undefined;
      return {
        mountName: location.mountName,
        remotePath: remotePathForUri(folder, location.remotePath)
      };
    } catch {
      return undefined;
    }
  }
  if (uri.scheme !== 'file') return undefined;
  return syncedRemoteLocation(uri.fsPath);
}

/**
 * Metadata for the remote file or synchronized local mirror file currently
 * open in the active editor (falling back to the first matching visible
 * editor), or null when none is active. Computed live on every call.
 * The remote stat is best-effort: a file deleted on the remote still resolves
 * with exists=false so callers can distinguish "file gone" from "no active
 * file". `mountName` optionally filters to one mount (the active file of any
 * other mount is never reported).
 */
async function activeRemoteFile(mountName?: string): Promise<{
  mountName: string;
  path: string;
  relative: string;
  size: number | null;
  modified: number | null;
  dirty: boolean;
  exists: boolean;
} | null> {
  const editor = vscode.window.activeTextEditor
    ?? vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.scheme === remoteFileSystemScheme
        || candidate.document.uri.scheme === 'file'
    );
  const uri = editor?.document.uri;
  if (!uri) return null;
  const location = terminalRemoteLocationForUri(uri);
  if (!location) return null;
  if (mountName && location.mountName !== mountName) return null;
  let folder = registry.get(location.mountName);
  if (!folder) {
    const config = await readConfig();
    const mount = config.mounts.find((candidate) => candidate.name === location.mountName);
    if (!mount) return null;
    folder = await ensureFolder(mount);
  }
  const filePath = location.remotePath;
  const relative = path.posix.relative(folder.remoteRoot, filePath);
  // 活动编辑器 URI 理论上必在挂载根内；防御性校验，避免越界路径泄漏。
  if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
    return null;
  }
  let stat: { size: number; mtime: number } | undefined;
  try {
    const value = await (await pool.get(folder.hostName)).stat(filePath);
    if (value.type === 'file') stat = { size: value.size, mtime: value.mtime };
  } catch {
    // The file may have been deleted remotely; report exists=false.
  }
  return {
    mountName: folder.mountName,
    path: filePath,
    relative,
    size: stat?.size ?? null,
    modified: stat?.mtime ?? null,
    dirty: editor?.document.isDirty ?? false,
    exists: stat !== undefined
  };
}

/**
 * Live-sync: when the active editor switches to a remote file, send `cd` to
 * every managed terminal of that mount so the terminal follows the file's
 * directory (only when the directory actually changed, to avoid noise).
 */
async function syncTerminalToActiveFile(uri: vscode.Uri): Promise<void> {
  try {
    const location = terminalRemoteLocationForUri(uri);
    if (!location) return;
    const fileDir = path.posix.dirname(location.remotePath);
    const restoreFollow = restoredFileSyncPending.has(location.mountName);
    const follows = settings().get<boolean>('terminalFollowsActiveFile', false)
      || restoreFollow;
    if (!follows) return;
    let synced = false;
    for (const [terminal, info] of managedRemoteTerminals) {
      if (info.mount.name !== location.mountName || info.remoteCwd === fileDir) continue;
      info.remoteCwd = fileDir;
      if (info.pty) {
        // 内置终端：shell 通道就绪前入队，就绪后补发，避免 cd 被丢弃。
        info.pty.sendInput(`cd -- ${shellQuote(fileDir)}\r`);
      } else {
        terminal.sendText(`cd -- ${shellQuote(fileDir)}`, true);
      }
      synced = true;
    }
    // 只有真正把终端移过去后才消费重开标志；否则（终端尚未创建等时序）
    // 保留标志，等待下一次文件激活或延迟补检。
    if (synced) restoredFileSyncPending.delete(location.mountName);
  } catch (error) {
    logAsyncFailure('终端目录跟随失败', error);
  }
}

/** 非阻塞延迟补检：覆盖“文件标签页先激活、终端后创建”的时序窗口。 */
function deferRestoreFollow(mountName: string): void {
  setTimeout(() => {
    void (async () => {
      if (!restoredFileSyncPending.has(mountName)) return;
      const uri = vscode.window.activeTextEditor?.document.uri;
      if (uri?.scheme === remoteFileSystemScheme || uri?.scheme === 'file') {
        await syncTerminalToActiveFile(uri);
      }
    })();
  }, 1500);
}

// ---- 远程同步到本地 ----

async function syncToLocal(uri?: vscode.Uri): Promise<void> {
  const resolvedUri = uri && uri.scheme === remoteFileSystemScheme
    ? uri
    : vscode.window.activeTextEditor?.document.uri;
  if (!resolvedUri || resolvedUri.scheme !== remoteFileSystemScheme) {
    throw new Error('请先在远程文件/目录上右键使用“同步到本地”');
  }
  const location = parseRemoteUri(resolvedUri.toString());
  const folder = registry.get(location.mountName);
  if (!folder) throw new Error(`远程挂载未连接：${location.mountName}`);
  const remotePath = remotePathForUri(folder, location.remotePath);
  const manager = syncManager;
  if (!manager) throw new Error('远程同步尚未就绪');
  if (manager.has(location.mountName, remotePath)) {
    const existingTask = manager.list().find(
      (task) => task.mountName === location.mountName && task.remotePath === remotePath
    );
    bridgeOutput?.info(`[同步] 已在运行；mount=${location.mountName}；path=${remotePath}`);
    const choice = await vscode.window.showInformationMessage('SAFS：该目录已在同步中。', '停止同步');
    if (choice === '停止同步') {
      await syncCoordinator?.requestStop(location.mountName, remotePath);
      if (existingTask) {
        await syncCoordinator?.clearReady(
          location.mountName, remotePath, existingTask.localDir
        );
      }
      manager.remove(location.mountName, remotePath);
      saveSyncTasks();
    }
    return;
  }
  const picked = await vscode.window.showOpenDialog({
    title: '选择同步目标目录',
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: '选择目录',
    // 固定打开用户家目录。
    defaultUri: vscode.Uri.file(os.homedir())
  });
  if (!picked || picked.length === 0) return;
  // 本地目标：远程目录 → 所选目录下的同名子目录；远程文件 → 同名文件。
  const baseName = path.posix.basename(remotePath);
  const localTarget = path.join(picked[0].fsPath, baseName);
  const resetLocalOnFirstSync = await confirmInitialSyncTarget(localTarget);
  if (resetLocalOnFirstSync === undefined) return;
  const task: RemoteSyncTask = {
    mountName: location.mountName,
    remotePath,
    localDir: localTarget,
    resetLocalOnFirstSync
  };
  await syncCoordinator?.clearReady(location.mountName, remotePath, localTarget);
  await syncCoordinator?.clearStop(location.mountName, remotePath);
  if (!await startRemoteSyncWithProgress(manager, task)) return;
}

async function confirmInitialSyncTarget(localDir: string): Promise<boolean | undefined> {
  const targetStat = await stat(localDir).catch(() => undefined);
  if (!targetStat) return false;
  const hasContent = !targetStat.isDirectory() || (await readdir(localDir)).length > 0;
  if (!hasContent) return false;
  const choice = await vscode.window.showWarningMessage(
    `本地目标 ${localDir} 已有内容。首次同步将以远程目录为准，删除本地独有内容并覆盖同名文件。是否继续？`,
    { modal: true },
    '继续同步'
  );
  return choice === '继续同步' ? true : undefined;
}

async function enableHistorySync(item: HistoryItem): Promise<void> {
  if (historySyncTask(item)) return;
  const confirmed = await vscode.window.showInformationMessage(
    `确认将远程目录 ${item.path}/ 同步到本地以提升 VS Code 插件兼容性？`,
    { modal: true },
    '开启同步'
  );
  if (confirmed !== '开启同步') return;
  const picked = await vscode.window.showOpenDialog({
    title: '选择同步目标目录',
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: '选择目录',
    defaultUri: vscode.Uri.file(os.homedir())
  });
  if (!picked?.length) return;
  const manager = syncManager;
  if (!manager) throw new Error('远程同步尚未就绪');
  const localDir = path.join(picked[0].fsPath, path.posix.basename(item.path));
  const resetLocalOnFirstSync = await confirmInitialSyncTarget(localDir);
  if (resetLocalOnFirstSync === undefined) return;
  await syncCoordinator?.clearReady(item.mountName, item.path, localDir);
  await syncCoordinator?.clearStop(item.mountName, item.path);
  if (!await startRemoteSyncWithProgress(manager, {
    mountName: item.mountName, remotePath: item.path, localDir, resetLocalOnFirstSync
  })) return;
}

async function disableHistorySync(item: HistoryItem): Promise<void> {
  await syncCoordinator?.requestStop(item.mountName, item.path);
  const task = historySyncTask(item);
  syncManager?.remove(item.mountName, item.path);
  if (task) await syncCoordinator?.clearReady(item.mountName, item.path, task.localDir);
}

// ---- SAFS：可视化下载（大文件流式 + 进度 + 可取消） ----

function formatDownloadBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** Keep the result visible after the transient progress notification closes. */
function showTransferCompleted(message: string): void {
  bridgeOutput?.appendLine(`[传输完成] ${message}`);
  const operation = message.split('：', 1)[0] || '传输完成';
  void vscode.window.showInformationMessage(`SAFS：${operation}。`);
}

async function startRemoteSyncWithProgress(
  manager: RemoteSyncManager, task: RemoteSyncTask
): Promise<boolean> {
  bridgeOutput?.info(
    `[同步] 开始；mount=${task.mountName}；remote=${task.remotePath}；local=${task.localDir}`
  );
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'SAFS：正在同步到本地',
    cancellable: true
  }, async (progress, token) => {
    const controller = new AbortController();
    const cancellation = token.onCancellationRequested(() => controller.abort());
    let reportedPercent = 0;
    progress.report({ message: '正在扫描远程目录…' });
    try {
      await manager.add(task, {
        signal: controller.signal,
        onProgress: (state) => {
          if (state.discovering) {
            progress.report({
              message: `已完成 ${state.completedFiles}/${state.totalFiles} 个 · ${
                formatDownloadBytes(state.transferredBytes)
              }`
            });
            return;
          }
          if (state.phase === 'scanning') {
            progress.report({ message: '正在统计文件数量和大小…' });
            return;
          }
          const percent = state.totalBytes > 0
            ? Math.min(100, state.transferredBytes / state.totalBytes * 100)
            : state.totalFiles > 0
              ? state.completedFiles / state.totalFiles * 100
              : 100;
          const increment = Math.max(0, percent - reportedPercent);
          reportedPercent = Math.max(reportedPercent, percent);
          progress.report({
            message: `${state.completedFiles}/${state.totalFiles} 个文件 · ${
              formatDownloadBytes(state.transferredBytes)
            }/${formatDownloadBytes(state.totalBytes)}（${Math.floor(percent)}%）`,
            increment
          });
        }
      });
      if (controller.signal.aborted) {
        bridgeOutput?.appendLine(`[同步取消] ${task.mountName}:${task.remotePath}`);
        void vscode.window.showInformationMessage('SAFS：同步已取消。');
        return false;
      }
      // add may schedule a retry after failure; that is not a completed sync.
      if (!manager.isReady(task.mountName, task.remotePath)) return false;
      const files = (task.fingerprintLines ?? []).filter((line) => line.startsWith('f:'));
      const bytes = files.reduce((sum, line) => {
        const fields = line.split(':');
        return sum + Number(fields.at(-2) ?? 0);
      }, 0);
      showTransferCompleted(
        `初始同步完成：${path.posix.basename(task.remotePath)} · 镜像 ${files.length} 个文件，${formatDownloadBytes(bytes)} → ${task.localDir}；双向自动同步已开启。`
      );
      return true;
    } finally {
      cancellation.dispose();
    }
  });
}

async function visualDownload(
  uri?: vscode.Uri, forcedLocalPath?: string, transferTimeoutMs?: number,
  secureLocalRoot?: string
): Promise<boolean> {
  const resolvedUri = uri && uri.scheme === remoteFileSystemScheme
    ? uri
    : vscode.window.activeTextEditor?.document.uri;
  if (!resolvedUri || resolvedUri.scheme !== remoteFileSystemScheme) {
    throw new Error('请先在远程文件/目录上右键使用"SAFS：可视化下载"');
  }
  const location = parseRemoteUri(resolvedUri.toString());
  const folder = registry.get(location.mountName);
  if (!folder) throw new Error(`远程挂载未连接：${location.mountName}`);
  const remotePath = remotePathForUri(folder, location.remotePath);
  bridgeOutput?.info(`[下载] 准备；remote=${remotePath}`);
  // 获取连接和远程类型都可能触发 SSH 握手。先显示可取消的准备通知，避免用户
  // 在连接较慢时点击后看不到任何反馈，误以为目录下载命令没有生效。
  const prepared = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'SAFS：正在准备下载',
    cancellable: true
  }, async (progress, token) => {
    const controller = new AbortController();
    const cancellation = token.onCancellationRequested(() => controller.abort());
    let timedOut = false;
    const timeout = transferTimeoutMs && transferTimeoutMs > 0
      ? setTimeout(() => { timedOut = true; controller.abort(); }, transferTimeoutMs)
      : undefined;
    progress.report({ message: '正在连接并读取远程文件信息…' });
    try {
      const session = await pool.get(folder.hostName, controller.signal);
      const stat = await session.stat(remotePath, controller.signal);
      return controller.signal.aborted ? undefined : { session, stat };
    } catch (error) {
      if (controller.signal.aborted) {
        if (timedOut) throw new Error(`文件传输超时（${transferTimeoutMs}ms）`);
        return undefined;
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      cancellation.dispose();
    }
  });
  if (!prepared) return false;
  const { session, stat } = prepared;
  if (stat.type === 'directory') {
    return downloadRemoteDirectory(
      session, remotePath, forcedLocalPath, transferTimeoutMs, secureLocalRoot
    );
  }
  return downloadRemoteFile(
    session, remotePath, stat.size, forcedLocalPath, transferTimeoutMs
  );
}

async function downloadRemoteFile(
  session: SftpSession, remotePath: string, totalBytes: number, forcedLocalPath?: string,
  transferTimeoutMs?: number
): Promise<boolean> {
  const baseName = path.posix.basename(remotePath);
  const target = forcedLocalPath ?? (await vscode.window.showSaveDialog({
    title: 'SAFS：下载到',
    defaultUri: vscode.Uri.file(path.join(os.homedir(), baseName)),
    saveLabel: '下载'
  }))?.fsPath;
  if (!target) return false;
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'SAFS：正在下载文件',
    cancellable: true
  }, async (progress, token) => {
    const controller = new AbortController();
    const onCancelled = token.onCancellationRequested(() => controller.abort());
    let timedOut = false;
    const timeout = transferTimeoutMs && transferTimeoutMs > 0
      ? setTimeout(() => { timedOut = true; controller.abort(); }, transferTimeoutMs)
      : undefined;
    let cumulative = 0;
    // 立即上报一次：通知一出现即带大小，而不是等跨过 1% 才显示。
    progress.report({
      message: `0 B / ${formatDownloadBytes(totalBytes)}（0%）`
    });
    try {
      const source = await session.readFileStream(remotePath, controller.signal);
      await writeStreamToFile(source, target, {
        onDelta: (delta) => {
          cumulative += delta;
          const percent = totalBytes > 0 ? cumulative / totalBytes * 100 : 0;
          progress.report({
            message: totalBytes > 0
              ? `${formatDownloadBytes(cumulative)} / ${formatDownloadBytes(totalBytes)}（${Math.floor(percent)}%）`
              : formatDownloadBytes(cumulative),
            increment: totalBytes > 0 ? delta / totalBytes * 100 : undefined
          });
        },
        signal: controller.signal
      });
      progress.report({
        message: `完成：${formatDownloadBytes(totalBytes)}`,
        increment: totalBytes > 0 ? 100 - cumulative / totalBytes * 100 : undefined
      });
      showTransferCompleted(`下载完成：${baseName} · 1 个文件，${formatDownloadBytes(cumulative)} → ${target}`);
      return true;
    } catch (error) {
      if (controller.signal.aborted) {
        if (timedOut) throw new Error(`文件传输超时（${transferTimeoutMs}ms）`);
        // writeStreamToFile 已删除半成品文件。
        bridgeOutput?.appendLine(`[下载取消] ${remotePath}`);
        void vscode.window.showInformationMessage('SAFS：下载已取消。');
        return false;
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      onCancelled.dispose();
    }
  });
}

async function downloadRemoteDirectory(
  session: SftpSession, remotePath: string, forcedLocalPath?: string,
  transferTimeoutMs?: number, secureLocalRoot?: string
): Promise<boolean> {
  const baseName = path.posix.basename(remotePath);
  let targetRoot = forcedLocalPath;
  if (!targetRoot) {
    const picked = await vscode.window.showOpenDialog({
      title: 'SAFS：选择下载目标目录',
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: '下载到这里',
      defaultUri: vscode.Uri.file(os.homedir())
    });
    if (!picked || picked.length === 0) return false;
    targetRoot = path.join(picked[0].fsPath, baseName);
  }
  const selectedTargetRoot = targetRoot;
  bridgeOutput?.info(`[目录下载] remote=${remotePath}；local=${selectedTargetRoot}`);
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'SAFS：正在下载目录',
    cancellable: true
  }, async (progress, token) => {
    const controller = new AbortController();
    const onCancelled = token.onCancellationRequested(() => controller.abort());
    let timedOut = false;
    const timeout = transferTimeoutMs && transferTimeoutMs > 0
      ? setTimeout(() => { timedOut = true; controller.abort(); }, transferTimeoutMs)
      : undefined;
    let lastReportAt = 0;
    progress.report({ message: '正在发现文件并开始下载…' });
    try {
      // SFTP 支持多个并行文件流；SCP 回退会整文件缓冲，且旧网关对并发 channel
      // 敏感，因此自动串行。有限队列会施加背压，不会为整棵树一次性创建 Promise。
      const result = await downloadRemoteDirectoryTree({
        session,
        remoteRoot: remotePath,
        localRoot: selectedTargetRoot,
        concurrency: session.transport === 'sftp' ? 4 : 1,
        signal: controller.signal,
        secureLocalRoot,
        onProgress: (state) => {
          const now = Date.now();
          if (lastReportAt > 0 && now - lastReportAt < 100) return;
          lastReportAt = now;
          progress.report({
            message: `${state.phase === 'scanning' ? '正在发现并下载' : '正在下载'}：${
              state.completedFiles
            }/${state.discoveredFiles} 个文件 · ${
              formatDownloadBytes(state.transferredBytes)
            }`
          });
        }
      });
      progress.report({
        message: `完成：${result.files} 个文件（${
          formatDownloadBytes(result.transferredBytes)
        }）`
      });
      showTransferCompleted(`目录下载完成：${baseName} · ${result.files} 个文件，${formatDownloadBytes(result.transferredBytes)} → ${selectedTargetRoot}`);
      return true;
    } catch (error) {
      if (controller.signal.aborted) {
        if (timedOut) throw new Error(`文件传输超时（${transferTimeoutMs}ms）`);
        bridgeOutput?.appendLine(`[目录下载取消] ${remotePath}；已完成文件保留`);
        void vscode.window.showInformationMessage('SAFS：目录下载已取消，已完成文件已保留。');
        return false;
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      onCancelled.dispose();
    }
  });
}

// ---- SAFS：可视化上传（本地 → 远程，流式 + 进度 + 可取消） ----

async function visualUpload(
  resources: vscode.Uri[], forcedMountName?: string, forcedTargetDir?: string,
  secureWorkspaceRoot?: string, transferTimeoutMs?: number
): Promise<boolean> {
  const sources = await collectUploadSources(resources);
  if (sources.length === 0) return false;
  // 第一步：选择远程挂载（来自 ~/.safs/config.json，无需打开远程目录）。
  const config = await readConfig();
  const mount = forcedMountName
    ? config.mounts.find((candidate) => candidate.name === forcedMountName)
    : await selectMount('选择要上传到的远程挂载');
  if (forcedMountName && !mount) throw new Error(`远程目录不存在：${forcedMountName}`);
  if (!mount) return false;
  const resolved = resolveMount(config, mount);
  const session = await pool.get(resolved.hostConfig.name);
  const remoteRoot = await session.realpath(mount.remote_path);
  // 第二步：选择/输入远程目标目录（Tab 补全、回车确认）。
  const picked = forcedTargetDir
    ?? await promptRemoteDirectory(session, remoteRoot, remoteRoot, mount.name);
  if (!picked) return false;
  const targetDir = picked.startsWith('/') ? picked : path.posix.join(remoteRoot, picked);
  bridgeOutput?.info(`[上传] mount=${mount.name}；target=${targetDir}`);
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'SAFS：正在上传文件',
    cancellable: true
  }, async (progress, token) => {
    const controller = new AbortController();
    const onCancelled = token.onCancellationRequested(() => controller.abort());
    let timedOut = false;
    const timeout = transferTimeoutMs && transferTimeoutMs > 0
      ? setTimeout(() => { timedOut = true; controller.abort(); }, transferTimeoutMs)
      : undefined;
    let lastReport = 0;
    progress.report({ message: '正在发现文件并上传…' });
    try {
      const result = await uploadRemoteTree({
        session, sources, targetDir, signal: controller.signal,
        verifyFile: secureWorkspaceRoot
          ? (remote) => verifyRemoteTransferFileDestination(session, secureWorkspaceRoot, remote)
          : undefined,
        log: (message) => bridgeOutput?.appendLine(message),
        onProgress: (state) => {
          const now = Date.now();
          if (now - lastReport < 100) return;
          lastReport = now;
          progress.report({
            message: `已完成 ${state.completed}/${state.discovered} 个 · ${
              formatDownloadBytes(state.bytes)
            }`
          });
        }
      });
      progress.report({
        message: `完成：${result.completed} 个文件（${formatDownloadBytes(result.bytes)}）`
      });
      showTransferCompleted(`上传完成：${result.completed} 个文件，${formatDownloadBytes(result.bytes)} → ${mount.name}:${targetDir}`);
      return true;
    } catch (error) {
      if (controller.signal.aborted) {
        if (timedOut) throw new Error(`文件传输超时（${transferTimeoutMs}ms）`);
        bridgeOutput?.appendLine(`[上传取消] ${mount.name}:${targetDir}；已完成文件保留`);
        void vscode.window.showInformationMessage('SAFS：上传已取消，已完成文件已保留。');
        return false;
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      onCancelled.dispose();
    }
  });
}

/** 收集上传源：右键传入的本地 URI，或命令面板调用时弹文件选择器。 */
async function collectUploadSources(resources: vscode.Uri[]): Promise<string[]> {
  const paths = resources
    .filter((uri) => uri && uri.scheme === 'file')
    .map((uri) => uri.fsPath);
  if (paths.length > 0) return paths;
  const picked = await vscode.window.showOpenDialog({
    title: 'SAFS：选择要上传的文件/目录',
    canSelectFiles: true,
    canSelectFolders: true,
    canSelectMany: true,
    openLabel: '选择上传',
    defaultUri: vscode.Uri.file(os.homedir())
  });
  return picked?.map((uri) => uri.fsPath) ?? [];
}

function currentRemoteLocation(): { mountName: string; remotePath: string } | undefined {
  const resolveLocation = (location: { mountName: string; remotePath: string }) => {
    const folder = registry.get(location.mountName);
    if (!folder || !isRemotePathInsideRoot(folder.workspaceRoot, location.remotePath)) {
      return undefined;
    }
    return { ...location, remotePath: remotePathForUri(folder, location.remotePath) };
  };
  const workspace = vscode.workspace.workspaceFolders?.find(
    (folder) => folder.uri.scheme === remoteFileSystemScheme
  );
  if (workspace) return resolveLocation(parseRemoteUri(workspace.uri.toString()));
  // 同步镜像是 file:// 工作区，但语义上仍绑定到对应的远程目录。
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') continue;
    const location = syncedRemoteLocation(folder.uri.fsPath);
    if (location) return location;
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === remoteFileSystemScheme) {
    return resolveLocation(parseRemoteUri(active.toString()));
  }
  if (active?.scheme === 'file') return syncedRemoteLocation(active.fsPath);
  return undefined;
}

// ---- openTerminal (aligned with main) ----

async function createTerminalDiagnostic(
  context: vscode.ExtensionContext, mountName: string, command: string
): Promise<{ file: string; command: string } | undefined> {
  try {
    const directory = path.join(context.globalStorageUri.fsPath, 'terminal-logs');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const safeMount = mountName.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 50) || 'remote';
    return {
      file: path.join(
        directory, `${safeMount}-${Date.now()}-${randomBytes(6).toString('hex')}.stderr.log`
      ),
      command
    };
  } catch (error) {
    bridgeOutput?.appendLine(
      `[终端诊断] 无法创建诊断目录，终端 stderr 将无法持久化：${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return undefined;
  }
}

async function recoverTerminalDiagnostics(context: vscode.ExtensionContext): Promise<void> {
  const directory = path.join(context.globalStorageUri.fsPath, 'terminal-logs');
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logAsyncFailure('终端诊断恢复失败', error);
    }
    return;
  }
  for (const name of names.filter((candidate) => candidate.endsWith('.stderr.log'))) {
    const file = path.join(directory, name);
    try {
      const cleaned = cleanTerminalDiagnostic(
        redactSensitiveText(decodeTerminalDiagnostic(await readFile(file)))
      );
      if (cleaned.text) {
        bridgeOutput?.appendLine(
          `[终端 stderr] 恢复上次未正常回收的诊断 ${name}${
            cleaned.truncated ? '（仅保留末尾 64 KiB）' : ''
          }\n${cleaned.text}`
        );
      }
      await unlink(file);
    } catch (error) {
      logAsyncFailure(`终端诊断恢复失败 ${name}`, error);
    }
  }
}

async function logManagedTerminalExit(
  terminal: vscode.Terminal,
  info: NonNullable<ReturnType<typeof managedRemoteTerminals.get>>
): Promise<string> {
  const status = terminal.exitStatus;
  const exitLine = `[终端] ${terminal.name} 已关闭；mount=${info.mount.name}；exit=${
    status?.code ?? 'unknown'
  }；reason=${status?.reason ?? 'unknown'}`;
  if (status?.reason === vscode.TerminalExitReason.Process
    && status.code !== 0 && !info.pty?.cleanExit) {
    bridgeOutput?.warn(exitLine);
  } else {
    bridgeOutput?.info(exitLine);
  }
  const diagnostic = info.diagnostic;
  if (!diagnostic) return '';
  let diagnosticText = '';
  try {
    const raw = decodeTerminalDiagnostic(await readFile(diagnostic.file));
    const cleaned = cleanTerminalDiagnostic(redactSensitiveText(raw));
    diagnosticText = cleaned.text;
    if (cleaned.text) {
      bridgeOutput?.appendLine(
        `[终端 stderr] $ ${diagnostic.command}${cleaned.truncated ? '（仅保留末尾 64 KiB）' : ''}\n${
          cleaned.text
        }`
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      bridgeOutput?.appendLine(
        `[终端诊断] 读取 ${diagnostic.file} 失败：${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  } finally {
    await unlink(diagnostic.file).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        bridgeOutput?.appendLine(
          `[终端诊断] 清理 ${diagnostic.file} 失败：${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    });
  }
  return diagnosticText;
}

async function suggestReopeningClosedTerminal(terminal: vscode.Terminal): Promise<void> {
  const reopen = managedRemoteTerminals.get(terminal);
  managedRemoteTerminals.delete(terminal);
  if (!reopen) return;
  const diagnosticText = await logManagedTerminalExit(terminal, reopen);
  const status = terminal.exitStatus;
  // 仅当远端连接被异常中断/崩溃时才处理（重连或提示）：
  // - 本地手动在 VS Code 关闭终端（reason=User/Shutdown）不触发；
  // - 启用自动重连后，所有 Process 结束都会恢复；部分 HPC 网关会把空闲超时报告为
  //   exit 0/cleanExit，无法与远端输入 exit 区分；
  // - 未启用自动重连时，exit 0 仅在诊断文本含断线特征时才提示用户。
  const autoReconnect = settings().get<boolean>('terminalAutoReconnect', true);
  if (!shouldRecoverTerminalExit({
    processExit: status?.reason === vscode.TerminalExitReason.Process,
    exitCode: status?.code,
    cleanExit: reopen.pty?.cleanExit ?? false,
    autoReconnect,
    diagnosticText
  })) return;
  // Reconnect into the remote directory currently open in this window
  // (kept in sync by SAFS: 切换远程目录), falling back to the cwd the
  // terminal was originally opened with.
  const location = currentRemoteLocation();
  const remoteCwd = location && location.mountName === reopen.mount.name
    ? location.remotePath
    : reopen.remoteCwd;
  if (isOpenSshHostKeyVerificationFailure(diagnosticText)) {
    const retry = reopen.hostKeyRetries ?? 0;
    if (retry < maxOpenSshHostKeyRetries) {
      bridgeOutput?.appendLine(
        `[主机密钥] 终端连接命中尚未记录的负载节点，重新探测并重连（${
          retry + 1
        }/${maxOpenSshHostKeyRetries}）`
      );
      await openTerminal(
        vscodeContext, reopen.mount, remoteCwd, undefined, true, true, retry + 1
      );
      return;
    }
    void vscode.window.showErrorMessage(
      'SAFS：远程终端遇到未确认的负载节点，已停止重连。'
    );
    return;
  }
  if (reopen.retryWithSystemSsh) {
    void vscode.window.showInformationMessage(
      'SAFS：已改用系统 SSH 重连远程终端。'
    );
    await openTerminal(vscodeContext, reopen.mount, remoteCwd, undefined, true, true);
    return;
  }
  if (autoReconnect) {
    const key = `${reopen.mount.name}\0${remoteCwd}`;
    const lifetimeMs = Math.max(0, Date.now() - reopen.startedAt);
    const fails = nextAutoReconnectAttempt(
      autoReconnectFails.get(key) ?? 0, lifetimeMs, terminalAutoReconnectStableMs
    );
    autoReconnectFails.set(key, fails);
    if (fails > maxTerminalAutoReconnectAttempts) {
      autoReconnectFails.delete(key);
      bridgeOutput?.error(
        `[终端] 已停止自动重连；mount=${reopen.mount.name}；cwd=${remoteCwd}；` +
        '重连后的终端在 60 秒内再次退出'
      );
      void vscode.window.showErrorMessage(
        'SAFS：远程终端再次退出，已停止自动重连。'
      );
      return;
    }
    bridgeOutput?.info(
      `[终端] 安排自动重连；mount=${reopen.mount.name}；cwd=${remoteCwd}；attempt=${
        fails
      }/${maxTerminalAutoReconnectAttempts}`
    );
    await openTerminal(
      vscodeContext, reopen.mount, remoteCwd, undefined, true, false, reopen.hostKeyRetries ?? 0
    );
    return;
  }
  const selected = await vscode.window.showInformationMessage(
    'SAFS：远程终端已退出。',
    reconnectRemoteTerminalAction,
    viewSafsLogAction
  );
  if (selected === reconnectRemoteTerminalAction) {
    await openTerminal(vscodeContext, reopen.mount, remoteCwd, undefined, true);
  } else if (selected === viewSafsLogAction) {
    bridgeOutput?.show(true);
  }
}

/**
 * Warm the OpenSSH capability cache used to build legacy algorithm flags.
 * WSL terminals go through the bundled bridge script, which does its own
 * version probing, so they do not need this.
 */
async function warmSshCliCapabilities(): Promise<void> {
  if (platformAdapter.kind === 'wsl') return;
  await ensureSshCapabilities(await resolveExecutable('ssh'));
}

async function openTerminal(
  context: vscode.ExtensionContext, requestedMount?: MountConfig, requestedRemoteCwd?: string,
  loadedConfig?: BridgeConfig, forceNew = false, forceSystemSsh = false,
  hostKeyRetries = 0
): Promise<{ terminal: vscode.Terminal; created: boolean } | undefined> {
  const config = loadedConfig ?? await readConfig();
  const location = requestedMount ? undefined : currentRemoteLocation();
  const mount = requestedMount
    ?? config.mounts.find((candidate) => candidate.name === location?.mountName)
    ?? await selectMount('Select a remote terminal');
  if (!mount) return undefined;
  const folder = await ensureFolder(mount);
  // Use the server-resolved root. Configured roots such as "." are relative
  // to the SSH login directory and cannot be compared directly with the
  // absolute paths stored in remote workspace URIs.
  const remoteRoot = folder.remoteRoot;
  let remoteCwd = requestedRemoteCwd
    ?? (location?.mountName === mount.name ? location.remotePath : folder.remoteRoot);
  // 打开终端始终跟随当前打开的远程文件所在目录（无条件，含重开窗口归位）；
  // 仅“切换/打开文件时实时 cd”才由 safs.terminalFollowsActiveFile 控制。
  const fileDirectory = await activeRemoteFileDirectory(mount.name);
  if (fileDirectory) {
    remoteCwd = fileDirectory;
    // openTerminal 已直接把终端放到文件目录，重开归位无需再补检。
    restoredFileSyncPending.delete(mount.name);
  }
  const remoteRelative = remoteCwd ? path.posix.relative(remoteRoot, remoteCwd) : '';
  const terminalName = remoteRelative
    ? `SSH: ${mount.name} — ${remoteRelative}`
    : `SSH: ${mount.name}`;
  const terminalId = `${mount.name}\0${remoteRelative}`;
  if (!forceNew) {
    const existingTerminal = vscode.window.terminals.find((terminal) => {
      const options = terminal.creationOptions;
      const identity = 'env' in options ? options.env?.[terminalIdentityEnv] : undefined;
      return identity === terminalId || terminal.name === terminalName;
    });
    if (existingTerminal) {
      existingTerminal.show();
      return { terminal: existingTerminal, created: false };
    }
  }
  if (openingTerminalIds.has(terminalId)) return undefined;
  openingTerminalIds.add(terminalId);
  try {
    const resolved = resolveMount(config, mount);
    let credentials: AskpassCredentials | undefined;
    if (resolved.hostConfig.password) {
      resolved.hostConfig = await timedPhase(
        `${mount.name} 终端凭据准备`,
        () => resolveStoredHostPassword(context, config, resolved.hostConfig)
      );
    }
    // Direct password terminals use ssh2 on all platforms. The actual terminal
    // connection performs the VS Code host-key confirmation, avoiding the race
    // where ssh-keyscan verifies one backend and system ssh reaches another.
    const useBuiltinSsh = shouldUseBuiltinSshTerminal(
      platformAdapter.kind, resolved.hostConfig, forceSystemSsh
    );
    if (!useBuiltinSsh && resolved.hostConfig.password
      && platformUsesAskpass(platformAdapter.kind)) {
      credentials = await createAskpassCredentials(resolved.hostConfig.password);
    }
    const bridgePasswordEnv = useBuiltinSsh
      ? {}
      : await bridgeMasterPasswordEnv(context, resolved.hostConfig);
    // Probe the installed OpenSSH first so the legacy algorithm flags in the
    // plan match what this client understands (macOS/Linux ship a wide range
    // of OpenSSH versions, and old or new clients reject the fixed flags).
    if (!useBuiltinSsh) await warmSshCliCapabilities();
    // 主机密钥校验：系统 ssh 路径无法弹 VS Code 对话框，由扩展在
    // 连接前 ssh-keyscan 探测当前后端密钥并与扩展 known_hosts 文件比对（仅 prompt 模式；
    // accept 走 known_hosts 空设备静默接受，reject 走系统 ssh 严格校验）。
    let hostKeyPolicy = settings().get<'accept' | 'prompt' | 'reject'>(
      'hostKeyChangedAction', 'prompt'
    );
    if (!useBuiltinSsh && hostKeyPolicy === 'prompt') {
      const verification = await verifySystemSshHostKey(
        hostKeyPolicy, resolved.hostConfig, platformAdapter.kind,
        (message) => bridgeOutput?.appendLine(`[主机密钥] ${message}`),
        undefined, undefined,
        { WSL_VPN_SSH_CONFIG: configPath() }
      );
      if (!verification.ok) {
        bridgeOutput?.error(`[主机密钥] ${verification.reason}`);
        void vscode.window.showErrorMessage(
          'SAFS：SSH 主机密钥验证失败。', viewSafsLogAction
        ).then((selected) => {
          if (selected === viewSafsLogAction) bridgeOutput?.show(true);
        });
        return undefined;
      }
    }
    const plan = platformAdapter.terminal(resolved.hostConfig, remoteCwd, {
      reuseSshConnection: settings().get<boolean>('reuseSshConnection', true),
      bridgeMasterPassword: bridgePasswordEnv.WSL_VPN_MASTER_PASSWORD,
      bridgeConfigPath: configPath(),
      hostKeyPolicy,
      ...(hostKeyPolicy === 'prompt' ? { userKnownHostsFile: knownHostsFilePath() } : {})
    });
    const resolvedTerminalCommand = await resolveExecutable(plan.command, plan.env);
    const diagnostic = useBuiltinSsh
      ? undefined
      : await createTerminalDiagnostic(
          context, mount.name,
          redactSensitiveText(planDisplayName({ ...plan, command: resolvedTerminalCommand }))
        );
    const terminalPlan = diagnostic
      ? terminalDiagnosticPlan(
          platformAdapter.kind, resolvedTerminalCommand, plan, diagnostic.file
        )
      : { ...plan, command: resolvedTerminalCommand };
    const terminalCommand = await resolveExecutable(terminalPlan.command, terminalPlan.env);
    bridgeOutput?.info(`[终端] 正在启动 ${mount.name}；cwd=${remoteCwd ?? remoteRoot}`);
    bridgeOutput?.debug(
      `[终端] 启动命令：$ ${
        redactSensitiveText(planDisplayName({ ...plan, command: resolvedTerminalCommand }))
      }`
    );
    const terminalStartedAt = performance.now();
    let builtinPty: import('./ssh2-terminal').Ssh2Terminal | undefined;
    const terminal = useBuiltinSsh
      ? (() => {
        let created!: vscode.Terminal;
        const pty = new Ssh2Terminal(
          resolved.hostConfig, resolved.hostConfig.password!, remoteCwd,
          (error) => {
            bridgeOutput?.error(
              `[终端] 内置 ssh2 终端 ${mount.name} 失败：${error.stack ?? error.message}`
            );
            // Server rejected the pty/shell negotiation (gateway appliance):
            // mark this terminal for a system-ssh retry instead of the
            // built-in ssh2 transport.
            if (builtinSshFallbackPattern.test(error.message)) {
              const entry = managedRemoteTerminals.get(created);
              if (entry) entry.retryWithSystemSsh = true;
            }
          },
          (message) => bridgeOutput?.appendLine(`[主机密钥] ${message}`),
          (reportedCwd) => {
            const entry = managedRemoteTerminals.get(created);
            if (entry) entry.remoteCwd = reportedCwd;
          }
        );
        created = vscode.window.createTerminal({
          name: terminalName,
          pty,
          isTransient: true
        });
        builtinPty = pty;
        return created;
      })()
      : vscode.window.createTerminal({
        name: terminalName,
        shellPath: terminalCommand,
        shellArgs: terminalPlan.args,
        env: {
          SSH_BRIDGE_MOUNT_NAME: mount.name,
          [terminalIdentityEnv]: terminalId,
          // 主口令已通过 plan.env（WslAdapter 按 bridgeMasterPassword 注入）交给
          // ssh-bridge；这里不再重复注入，避免交互式终端环境里可被读取。
          ...terminalPlan.env,
          ...credentials?.env
        },
        cwd: os.homedir(),
        isTransient: true
      });
    performanceLine(`${mount.name} SSH 终端创建（不含远端握手）`, terminalStartedAt);
    managedRemoteTerminals.set(terminal, {
      mount, remoteCwd, pty: builtinPty, diagnostic, hostKeyRetries, startedAt: Date.now()
    });
    if (credentials) {
      const disposable = vscode.window.onDidCloseTerminal((closed) => {
        if (closed === terminal) {
          disposable.dispose();
          void credentials?.cleanup();
        }
      });
      setTimeout(() => {
        disposable.dispose();
        void credentials?.cleanup();
      }, terminalCredentialTtlMs);
    }
    terminal.show();
    return { terminal, created: true };
  } finally {
    openingTerminalIds.delete(terminalId);
  }
}

// ---- disconnect / status ----

async function disconnect(requested?: MountConfig): Promise<void> {
  const mount = requested ?? await selectMount('选择要断开的 SFTP 连接');
  if (!mount) return;
  const current = currentRemoteLocation();
  if (current?.mountName === mount.name) {
    await vscode.commands.executeCommand('workbench.action.closeFolder');
  }
  registry.delete(mount.name);
  const config = await readConfig();
  const shared = registry.values().some((folder) => folder.hostName === mount.host);
  if (!shared) await pool.disconnect(resolveMount(config, mount).hostConfig.name);
  refreshSafsEntryLabel();

  // Keep the Agent-forwarding preference so reconnecting this mount can
  // restore Agent access through the stable MCP router.
  // Only the explicit toggle command clears the preference.
  await mcp?.stop();
  await agentWorkspacePublisher.remove();
}

// ---- Open Config ----

async function openConfig(hostName?: string): Promise<void> {
  const resolvedPath = await ensureConfigFile(configPath());
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolvedPath));
  const editor = await vscode.window.showTextDocument(document);
  if (!hostName) return;
  const offset = passwordValueOffset(document.getText(), hostName);
  if (offset === undefined) return;
  const position = document.positionAt(offset);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(
    new vscode.Range(position, position),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport
  );
}

// ---- Add SSH Config ----

interface InputOptions {
  title: string;
  prompt: string;
  value?: string;
  placeHolder?: string;
  password?: boolean;
  validateInput?: (value: string) => string | undefined;
}

async function input(options: InputOptions): Promise<string | undefined> {
  return vscode.window.showInputBox({
    ...options,
    ignoreFocusOut: true,
    valueSelection: options.value ? [0, options.value.length] : undefined
  });
}

const required = (label: string) => (value: string): string | undefined =>
  value.trim() ? undefined : `${label}不能为空`;

async function addSshConfig(context: vscode.ExtensionContext): Promise<void> {
  const title = 'Add SSH Config';
  const name = await input({
    title, prompt: '配置名称', value: 'dev', validateInput: required('配置名称')
  });
  if (name === undefined) return;
  const loginText = await input({
    title,
    prompt: 'SSH 登录地址',
    value: `${os.userInfo().username}@10.0.0.1`,
    placeHolder: 'user@10.0.0.1',
    validateInput: (value) => parseSshLogin(value) ? undefined : '请输入 user@IP 或 user@主机名'
  });
  if (loginText === undefined) return;
  const login = parseSshLogin(loginText);
  if (!login) throw new Error('SSH 登录地址格式无效');
  const password = await input({
    title,
    prompt: 'SSH 密码（留空则改用私钥）',
    placeHolder: '输入密码，或留空后按 Enter',
    password: true
  });
  if (password === undefined) return;
  const encryptedPassword = password
    ? await encryptPassword(password, await promptMasterPassword(context, true))
    : undefined;
  let privateKeyPath: string | undefined;
  if (!password) {
    privateKeyPath = await input({
      title,
      prompt: 'SSH 私钥路径',
      value: '~/.ssh/id_ed25519',
      placeHolder: '例如 ~/.ssh/id_ed25519',
      validateInput: required('私钥路径')
    });
    if (privateKeyPath === undefined) return;
  }
  let vpn = false;
  if (platformAdapter.kind === 'wsl') {
    const selectedVpn = await vscode.window.showQuickPick([
      {
        label: 'No',
        description: 'false（默认）：不使用外部 VPN 中继',
        value: false
      },
      {
        label: 'Yes',
        description: 'true：使用 aTrust 等外部 VPN 时启用中继',
        value: true
      }
    ], {
      title,
      placeHolder: '是否使用外部 VPN（如 aTrust）？',
      ignoreFocusOut: true
    });
    if (!selectedVpn) return;
    vpn = selectedVpn.value;
  }

  await ensureConfigFile(configPath());
  const config = await loadConfig(configPath());
  const normalizedName = name.trim();
  const existingIndex = config.hosts.findIndex((host) => host.name === normalizedName);
  if (existingIndex >= 0
    && await vscode.window.showWarningMessage(
      `配置"${normalizedName}"已存在，是否覆盖？`, { modal: true }, '覆盖'
    ) !== '覆盖') return;

  const host: HostConfig = {
    name: normalizedName,
    ip: login.host,
    user: login.user,
    port: 22
  };
  if (platformAdapter.kind === 'wsl') host.vpn = vpn;
  if (privateKeyPath) host.private_key_path = privateKeyPath.trim();
  if (encryptedPassword) host.password = encryptedPassword;
  if (existingIndex >= 0) config.hosts[existingIndex] = host;
  else config.hosts.push(host);

  config.mounts = deriveMounts(config.hosts);
  config.encrypt_passwords = true;
  await saveConfig(configPath(), config);
  bridgeOutput?.info(`[配置] 已保存 SFTP 配置 ${normalizedName}`);
  void vscode.window.showInformationMessage('SAFS：SFTP 配置已保存。');
}

// ---- MCP / Remote Ops ----

async function mountAndFolder(mountName: string): Promise<{
  mount: MountConfig;
  folder: RemoteFolder;
}> {
  const config = await readConfig();
  const mount = config.mounts.find((candidate) => candidate.name === mountName);
      if (!mount) throw new Error(`远程目录不存在：${mountName}`);
  return { mount, folder: await ensureFolder(mount) };
}

async function forwardedMountName(requested?: string): Promise<string> {
  const enabled = new Set(vscodeContext.globalState.get<string[]>(aiForwardMountsKey, []));
  if (requested) {
    if (!enabled.has(requested)) throw new Error(`Agent 转发未开启：${requested}`);
    return requested;
  }
  const current = currentRemoteLocation()?.mountName;
  if (current && enabled.has(current)) return current;
  if (enabled.size === 1) return [...enabled][0];
  if (enabled.size === 0) throw new Error('Agent 转发未开启');
  throw new Error('有多个 Agent 转发目标，请提供 mountName');
}

function windowBoundMountName(boundMountName: string, requested?: string): string {
  if (requested && requested !== boundMountName) {
    throw new Error(
      `MCP 服务已绑定远程窗口“${boundMountName}”，不能访问“${requested}”`
    );
  }
  return boundMountName;
}

function forwardedWindowMountName(
  context: vscode.ExtensionContext, boundMountName: string, requested?: string
): string {
  const enabled = new Set(context.globalState.get<string[]>(aiForwardMountsKey, []));
  if (!enabled.has(boundMountName)) throw new Error(`Agent 转发未开启：${boundMountName}`);
  return windowBoundMountName(boundMountName, requested);
}

function toolPath(folder: RemoteFolder, value = '.'): string {
  // Relative tool paths resolve against the current remote directory
  // (kept in sync by SAFS: 切换远程目录), while still being validated
  // against the mount root.
  const base = currentWorkspacePath(folder);
  const resolved = value.startsWith('/')
    ? path.posix.normalize(value)
    : path.posix.resolve(base, value);
  if (!isRemotePathInsideRoot(folder.remoteRoot, resolved)) {
    throw new Error(`路径超出远程工作区：${value}`);
  }
  return resolved;
}

/** Resolve an Agent file-transfer path without allowing it to leave this window's workspace. */
function transferRemotePath(folder: RemoteFolder, value: string): string {
  const workspaceRoot = currentWorkspacePath(folder);
  const resolved = value.startsWith('/')
    ? path.posix.normalize(value)
    : path.posix.resolve(workspaceRoot, value);
  if (!isRemotePathInsideRoot(workspaceRoot, resolved)) {
    throw new Error(`传输路径超出当前工作区：${value}`);
  }
  return resolved;
}

function isMissingRemoteError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === 2 || code === 'ENOENT';
}

async function ensureRemoteTransferDirectory(
  session: SftpSession, realWorkspaceRoot: string, remoteDir: string
): Promise<string> {
  if (!isRemotePathInsideRoot(realWorkspaceRoot, remoteDir)) {
    throw new Error(`上传目录超出当前工作区：${remoteDir}`);
  }
  const relative = path.posix.relative(realWorkspaceRoot, remoteDir);
  let current = realWorkspaceRoot;
  for (const part of relative.split('/').filter(Boolean)) {
    const candidate = path.posix.join(current, part);
    let stat;
    try {
      stat = await session.stat(candidate);
    } catch (error) {
      if (!isMissingRemoteError(error)) throw error;
      await session.createDirectory(candidate);
      stat = await session.stat(candidate);
    }
    if (stat.type === 'symbolic-link') {
      throw new Error(`上传目录包含符号链接，拒绝写入：${candidate}`);
    }
    if (stat.type !== 'directory') {
      throw new Error(`上传目录路径被非目录占用：${candidate}`);
    }
    current = await session.realpath(candidate);
    if (!isRemotePathInsideRoot(realWorkspaceRoot, current)) {
      throw new Error(`上传目录通过符号链接超出当前工作区：${candidate}`);
    }
  }
  return current;
}

async function verifyRemoteTransferFileDestination(
  session: SftpSession, realWorkspaceRoot: string, remotePath: string
): Promise<void> {
  const realParent = await session.realpath(path.posix.dirname(remotePath));
  if (!isRemotePathInsideRoot(realWorkspaceRoot, realParent)) {
    throw new Error(`上传文件父目录超出当前工作区：${remotePath}`);
  }
  try {
    const stat = await session.stat(remotePath);
    if (stat.type === 'symbolic-link') {
      throw new Error(`上传目标是符号链接，拒绝覆盖：${remotePath}`);
    }
    if (stat.type === 'directory') {
      throw new Error(`上传目标是目录，无法覆盖：${remotePath}`);
    }
    const realPath = await session.realpath(remotePath);
    if (!isRemotePathInsideRoot(realWorkspaceRoot, realPath)) {
      throw new Error(`上传目标超出当前工作区：${remotePath}`);
    }
  } catch (error) {
    if (!isMissingRemoteError(error)) throw error;
  }
}

async function localTransferRoot(folder: RemoteFolder): Promise<string> {
  return ensureAgentCwdSubdirectory(
    localRootForFolder(folder), folder.remoteRoot, currentWorkspacePath(folder)
  );
}

/** The remote directory currently open in this window, or the mount root. */
function currentWorkspacePath(folder: RemoteFolder): string {
  const location = currentRemoteLocation();
  if (location && location.mountName === folder.mountName) {
    return location.remotePath;
  }
  return folder.remoteRoot;
}

/**
 * 解析远程路径：相对路径基于当前 VS Code 工作区目录，而不是配置的挂载根。
 * 绝对路径仍可访问挂载外的位置，用于只读工具（list/search）查看
 * ~/.bashrc、/etc/hosts 等明确指定的路径。
 */
function resolveRemotePath(folder: RemoteFolder, value = '.'): string {
  return value.startsWith('/')
    ? path.posix.normalize(value)
    : path.posix.resolve(currentWorkspacePath(folder), value);
}

async function remoteList(input: {
  mountName: string; path?: string; limit?: number; cursor?: string;
}): Promise<unknown> {
  const { folder } = await mountAndFolder(input.mountName);
  const remotePath = resolveRemotePath(folder, input.path);
  const entries = await (await pool.get(folder.hostName)).readDirectory(remotePath);
  return { path: remotePath, ...pageDirectory(entries, remotePath, input) };
}

async function remoteRead(input: RemoteReadOptions & { mountName: string }): Promise<unknown> {
  const { folder } = await mountAndFolder(input.mountName);
  const requestedPath = resolveRemotePath(folder, input.path);
  const session = await pool.get(folder.hostName);
  const resolved = await session.statResolved(requestedPath);
  if (resolved.stat.type !== 'file') {
    throw new Error(`remote_read 只能读取普通文件：${input.path}`);
  }
  return { path: resolved.path, ...await readTextRange(resolved.stat.size,
    (offset, length) => session.readFileRange(resolved.path, offset, length), input) };

}

async function remoteWrite(input: {
  mountName: string; path: string; content: string;
}): Promise<unknown> {
  const { folder } = await mountAndFolder(input.mountName);
  const workspaceRoot = currentWorkspacePath(folder);
  const remotePath = input.path.startsWith('/')
    ? path.posix.normalize(input.path)
    : path.posix.resolve(workspaceRoot, input.path);
  if (!isRemotePathInsideRoot(workspaceRoot, remotePath)) {
    throw new Error(`写入路径超出当前工作区：${input.path}`);
  }
  const session = await pool.get(folder.hostName);
  let securedPath: string;
  try {
    securedPath = await session.realpath(remotePath);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== 2 && code !== 'ENOENT') throw error;
    const parent = await session.realpath(path.posix.dirname(remotePath));
    securedPath = path.posix.join(parent, path.posix.basename(remotePath));
  }
  if (!isRemotePathInsideRoot(workspaceRoot, securedPath)) {
    throw new Error(`写入路径通过符号链接超出当前工作区：${input.path}`);
  }
  const uri = vscode.Uri.parse(folderUri(folder, remotePath));
  const content = new TextEncoder().encode(input.content);
  await provider.writeFile(uri, content, { create: true, overwrite: true });
  return { path: remotePath, bytes: content.length };
}

async function remoteEdit(input: {
  mountName: string; path: string; edits: RemoteTextEdit[]; expectedHash?: string;
}): Promise<unknown> {
  const { folder } = await mountAndFolder(input.mountName);
  const session = await pool.get(folder.hostName);
  const entry = await verifiedRemoteEntry(folder, session, input.path);
  if (entry.stat.type !== 'file') {
    throw new Error(`remote_edit 只能修改普通文件：${input.path}`);
  }
  if (entry.stat.size > maxRemoteEditFileBytes) {
    throw new Error(`remote_edit 文件不能超过 ${maxRemoteEditFileBytes} 字节：${input.path}`);
  }
  const data = await session.readFile(entry.remotePath);
  if (data.length > maxRemoteEditFileBytes) {
    throw new Error(`remote_edit 文件不能超过 ${maxRemoteEditFileBytes} 字节：${input.path}`);
  }
  const beforeHash = textSha256(data);
  if (input.expectedHash && input.expectedHash.toLowerCase() !== beforeHash) {
    throw new Error(
      `remote_edit 文件已变化，expectedHash=${input.expectedHash.toLowerCase()}，` +
      `actualHash=${beforeHash}`
    );
  }
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new Error(`remote_edit 只支持有效的 UTF-8 文本：${input.path}`);
  }
  const edited = applyRemoteTextEdits(content, input.edits);
  const encoded = new TextEncoder().encode(edited.content);
  if (encoded.length > maxRemoteEditFileBytes) {
    throw new Error(`remote_edit 修改结果不能超过 ${maxRemoteEditFileBytes} 字节：${input.path}`);
  }
  const uri = vscode.Uri.parse(folderUri(folder, entry.remotePath));
  await provider.writeFile(uri, encoded, { create: false, overwrite: true });
  return {
    path: entry.remotePath,
    replacements: edited.replacements,
    bytes: encoded.length,
    beforeHash,
    hash: textSha256(encoded)
  };
}

async function verifiedRemoteEntry(
  folder: RemoteFolder, session: SftpSession, value: string,
  options: { allowWorkspaceRoot?: boolean; allowSymbolicLink?: boolean } = {}
) {
  const workspaceRoot = currentWorkspacePath(folder);
  const remotePath = transferRemotePath(folder, value);
  if (!options.allowWorkspaceRoot && remotePath === workspaceRoot) {
    throw new Error(`不能操作当前工作区根目录：${value}`);
  }
  const realParent = await session.realpath(path.posix.dirname(remotePath));
  if (!isRemotePathInsideRoot(workspaceRoot, realParent)) {
    throw new Error(`目标父目录通过符号链接超出当前工作区：${value}`);
  }
  const stat = await session.stat(remotePath);
  if (stat.type === 'symbolic-link') {
    if (!options.allowSymbolicLink) {
      throw new Error(`不允许对符号链接执行该操作：${value}`);
    }
  } else {
    const realPath = await session.realpath(remotePath);
    if (!isRemotePathInsideRoot(workspaceRoot, realPath)) {
      throw new Error(`目标通过符号链接超出当前工作区：${value}`);
    }
  }
  return { remotePath, stat };
}

async function verifiedRemoteDestination(
  folder: RemoteFolder, session: SftpSession, value: string
): Promise<string> {
  const workspaceRoot = currentWorkspacePath(folder);
  const remotePath = transferRemotePath(folder, value);
  if (remotePath === workspaceRoot) {
    throw new Error(`不能覆盖当前工作区根目录：${value}`);
  }
  const realParent = await session.realpath(path.posix.dirname(remotePath));
  if (!isRemotePathInsideRoot(workspaceRoot, realParent)) {
    throw new Error(`目标父目录通过符号链接超出当前工作区：${value}`);
  }
  try {
    const stat = await session.stat(remotePath);
    if (stat.type !== 'symbolic-link') {
      const realPath = await session.realpath(remotePath);
      if (!isRemotePathInsideRoot(workspaceRoot, realPath)) {
        throw new Error(`已有目标通过符号链接超出当前工作区：${value}`);
      }
    }
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== 2 && code !== 'ENOENT') throw error;
  }
  return remotePath;
}

async function remoteDelete(input: {
  mountName: string; path: string; recursive?: boolean;
}): Promise<unknown> {
  const { folder } = await mountAndFolder(input.mountName);
  const session = await pool.get(folder.hostName);
  const entry = await verifiedRemoteEntry(folder, session, input.path, {
    allowSymbolicLink: true
  });
  await provider.delete(vscode.Uri.parse(folderUri(folder, entry.remotePath)), {
    recursive: input.recursive === true
  });
  return { path: entry.remotePath, type: entry.stat.type, recursive: input.recursive === true };
}

async function remoteChmod(input: {
  mountName: string; path: string; mode: string;
}): Promise<unknown> {
  const { folder } = await mountAndFolder(input.mountName);
  const session = await pool.get(folder.hostName);
  const entry = await verifiedRemoteEntry(folder, session, input.path);
  const mode = Number.parseInt(input.mode, 8);
  await session.chmod(entry.remotePath, mode);
  return { path: entry.remotePath, mode: input.mode };
}

async function remoteMove(input: {
  mountName: string; sourcePath: string; targetPath: string; overwrite?: boolean;
}): Promise<unknown> {
  const { folder } = await mountAndFolder(input.mountName);
  const session = await pool.get(folder.hostName);
  const source = await verifiedRemoteEntry(folder, session, input.sourcePath, {
    allowSymbolicLink: true
  });
  const targetPath = await verifiedRemoteDestination(folder, session, input.targetPath);
  await provider.rename(
    vscode.Uri.parse(folderUri(folder, source.remotePath)),
    vscode.Uri.parse(folderUri(folder, targetPath)),
    { overwrite: input.overwrite === true }
  );
  return { sourcePath: source.remotePath, targetPath, overwrite: input.overwrite === true };
}

async function executeRemoteCommand(
  context: vscode.ExtensionContext,
  input: {
    command: string; mountName: string; remoteCwd?: string; source?: string; agentName?: string;
    agentPlatform?: string; captureForMcp?: boolean;
  },
  token?: vscode.CancellationToken
): Promise<Record<string, unknown>> {
  if (!input.command?.trim()) throw new Error('Remote command must not be empty.');
  const { mount, folder } = await mountAndFolder(input.mountName);
  const requestedCwd = toolPath(folder, input.remoteCwd);
  const remoteCwd = await (await pool.get(mount.host)).realpath(requestedCwd);
  if (!isRemotePathInsideRoot(folder.remoteRoot, remoteCwd)) {
    throw new Error(`远程工作目录通过符号链接超出工作区：${requestedCwd}`);
  }
  // 命令输出上限：Agent 上下文 token 保护。超限截断并标记 truncated: true，
  // 避免单次 head/cat/grep 把几十万 token 灌进会话。
  const responseBudget = Math.max(
    4096,
    Math.min(1024 * 1024, settings().get<number>('agentMcpMaxOutputBytes', 8192))
  );
  const source = input.source ?? 'mcp';
  const retainOutput = input.captureForMcp === true;
  const maxOutputBytes = retainOutput ? 16 * 1024 * 1024 : responseBudget;
  const logFailure = (error: unknown): void => {
    bridgeOutput?.appendLine(
      `[MCP 命令日志] 写入失败：${error instanceof Error ? error.message : String(error)}`
    );
  };
  const policy = evaluateMcpCommandPolicy(
    input.command, source, readMcpCommandPolicySettings(settings())
  );
  appendMcpCommandLog({
    source: policy.auditSource,
    agentName: input.agentName,
    agentPlatform: input.agentPlatform,
    mountName: mount.name,
    remoteCwd,
    command: input.command
  }).catch(logFailure);
  if (!policy.allowed) {
    bridgeOutput?.appendLine(
      `[高危指令拦截] 拒绝执行：${policy.redactedCommand}（规则：${policy.matched}）`
    );
    throw new Error(
      `高危指令已被 SAFS 拦截（规则：${policy.matched}）：${policy.redactedCommand}`
    );
  }
  if (policy.matched) {
    bridgeOutput?.appendLine(
      `[高危指令放行] 已按配置执行：${policy.redactedCommand}（规则：${policy.matched}）`
    );
  }
  const resolved = resolveMount(await readConfig(), mount);
  const outputMarker = `__SAFS_COMMAND_OUTPUT_${randomBytes(16).toString('hex')}__`;
  let credentials: AskpassCredentials | undefined;
  try {
    if (resolved.hostConfig.password) {
      const config = await readConfig();
      resolved.hostConfig = await resolveStoredHostPassword(context, config, resolved.hostConfig);
      if (platformAdapter.kind !== 'windows' && platformUsesAskpass(platformAdapter.kind)) {
        credentials = await createAskpassCredentials(resolved.hostConfig.password!);
      }
    }
    const controller = new AbortController();
    const cancellation = token?.onCancellationRequested(() => controller.abort());
    // 命令级超时：Agent 挂起时中止远端执行，避免命令在后台无限运行。
    // 与路由器的 forwardTimeoutMs 同源（safs.agentMcpTimeoutMs），保持一致。
    const commandTimeoutMs = settings().get<number>('agentMcpTimeoutMs', 120_000);
    let timedOut = false;
    const timeout = commandTimeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, commandTimeoutMs)
      : undefined;
    try {
      let result;
      if (platformAdapter.kind === 'windows') {
        bridgeOutput?.appendLine(
          `[Agent MCP] $ ${redactSensitiveText(input.command)} (cwd: ${remoteCwd})`
        );
        try {
          result = await executeSsh2Command(
            resolved.hostConfig, resolved.hostConfig.password,
            remoteCwd, input.command, controller.signal, maxOutputBytes, outputMarker
          );
          bridgeOutput?.appendLine(
            `[Agent MCP] [${result.exitCode === 0 ? '完成' : `失败: exit ${result.exitCode}`}] ${redactSensitiveText(input.command)}`
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          bridgeOutput?.appendLine(`[Agent MCP] [失败] ${redactSensitiveText(input.command)}: ${detail}`);
          throw error;
        }
      } else {
        await warmSshCliCapabilities();
        const hostKeyPolicy = settings().get<'accept' | 'prompt' | 'reject'>(
          'hostKeyChangedAction', 'prompt'
        );
        const verifyCurrentSystemSshHostKey = async (): Promise<void> => {
          const verification = await verifySystemSshHostKey(
            hostKeyPolicy, resolved.hostConfig, platformAdapter.kind,
            (message) => bridgeOutput?.appendLine(`[主机密钥] ${message}`),
            undefined, undefined,
            { WSL_VPN_SSH_CONFIG: configPath() }
          );
          if (!verification.ok) throw new Error(verification.reason);
        };
        if (hostKeyPolicy === 'prompt') {
          await verifyCurrentSystemSshHostKey();
        }
        const plan = platformAdapter.exec(resolved.hostConfig, remoteCwd, input.command, {
          reuseSshConnection: settings().get<boolean>('reuseSshConnection', true),
          bridgeConfigPath: configPath(),
          hostKeyPolicy,
          outputMarker,
          ...(hostKeyPolicy === 'prompt' ? { userKnownHostsFile: knownHostsFilePath() } : {})
        });
        plan.env = {
          ...plan.env,
          ...await bridgeMasterPasswordEnv(context, resolved.hostConfig),
          ...credentials?.env
        };
        const runSystemSsh = () => executeAgentMcpCommand(
          plan, controller.signal, maxOutputBytes
        );
        result = hostKeyPolicy === 'prompt'
          ? await runWithOpenSshHostKeyRetry(
              runSystemSsh, verifyCurrentSystemSshHostKey,
              (message) => bridgeOutput?.appendLine(`[主机密钥] ${message}`)
            )
          : await runSystemSsh();
      }
      if (timedOut) {
        throw new Error(`远程命令执行超时（${commandTimeoutMs}ms）`);
      }
      return {
        remoteCwd,
        ...(retainOutput ? { responseBudget } : {}),
        ...result
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      cancellation?.dispose();
    }
  } finally {
    await credentials?.cleanup();
  }
}

async function runRemote(input: {
  mountName: string; command: string; remoteCwd?: string; source?: string; agentName?: string;
  agentPlatform?: string;
}): Promise<unknown> {
  return executeRemoteCommand(vscodeContext, { ...input, source: input.source ?? 'mcp' });
}

async function remoteSearch(input: RemoteSearchOptions & {
  mountName: string; agentName?: string; agentPlatform?: string; captureForMcp?: boolean;
}): Promise<unknown> {
  const { folder } = await mountAndFolder(input.mountName);
  const requestedPath = resolveRemotePath(folder, input.path);
  const searchPath = await (await pool.get(folder.hostName)).realpath(requestedPath);
  const search = searchCommand(searchPath, input);
  const result = await executeRemoteCommand(vscodeContext, {
    mountName: input.mountName,
    remoteCwd: currentWorkspacePath(folder),
    source: 'remote_search',
    agentName: input.agentName,
    agentPlatform: input.agentPlatform,
    captureForMcp: input.captureForMcp,
    command: search.command
  });
  return { ...searchResult(result, search.mode), mode: search.mode, excludeDirs: search.excludeDirs };
}

// ---- Tree View ----

interface HistoryItem {
  type: 'history';
  mountName: string;
  path: string;
}

type TreeElement = MountConfig | HistoryItem;

const MAX_HISTORY_ENTRIES = 10;

async function getDirectoryHistory(
  context: vscode.ExtensionContext
): Promise<Record<string, string[]>> {
  return context.globalState.get<Record<string, string[]>>(
    directoryHistoryKey, {}
  );
}

async function recordDirectoryHistory(
  context: vscode.ExtensionContext,
  mountName: string,
  remotePath: string
): Promise<void> {
  const history = await getDirectoryHistory(context);
  const entries = history[mountName] ?? [];
  const idx = entries.indexOf(remotePath);
  if (idx >= 0) {
    entries.splice(idx, 1);
  }
  entries.unshift(remotePath);
  if (entries.length > MAX_HISTORY_ENTRIES) {
    entries.length = MAX_HISTORY_ENTRIES;
  }
  history[mountName] = entries;
  await context.globalState.update(directoryHistoryKey, history);
}

async function removeHistoryEntry(
  context: vscode.ExtensionContext,
  mountName: string,
  remotePath: string
): Promise<void> {
  const history = await getDirectoryHistory(context);
  const entries = history[mountName] ?? [];
  const idx = entries.indexOf(remotePath);
  if (idx >= 0) {
    entries.splice(idx, 1);
    history[mountName] = entries;
    await context.globalState.update(directoryHistoryKey, history);
  }
}

class RemoteFoldersProvider implements vscode.TreeDataProvider<TreeElement> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: TreeElement): vscode.TreeItem {
    if ('type' in element && element.type === 'history') {
      return this.getHistoryTreeItem(element);
    }
    return this.getMountTreeItem(element as MountConfig);
  }

  private getMountTreeItem(mount: MountConfig): vscode.TreeItem {
    const connectionState = pool.state(mount.host);
    const connected = registry.get(mount.name) !== undefined && connectionState === 'connected';
    const aiForwarded = this.context.globalState
      .get<string[]>(aiForwardMountsKey, []).includes(mount.name);
    const workspaces = discoverAgentWorkspaces();
    const forwarding = aiForwarded
      && workspaces.some((workspace) => workspace.mountName === mount.name);
    const focused = aiForwarded
      && workspaces.some((workspace) => workspace.mountName === mount.name && workspace.focused);
    const item = new vscode.TreeItem(mount.name);
    const connectionLabel = connected
      ? '已连接'
      : connectionState === 'connecting' || connectionState === 'reconnecting'
        ? '连接中'
        : connectionState === 'error' ? '连接错误' : '未连接';
    const symbol = focused ? '👁' : forwarding ? '⚡' : aiForwarded ? '○' : undefined;
    item.description = symbol ? `Agent State: ${symbol}` : undefined;
    item.contextValue = [
      'safs.connection',
      connected ? 'connected' : 'disconnected',
      aiForwarded ? 'aiEnabled' : 'aiDisabled'
    ].join('.');
    item.iconPath = new vscode.ThemeIcon(connected ? 'vm-active' : 'remote');
    item.tooltip = new vscode.MarkdownString([
      `**${mount.name}**`,
      '',
      `Host: \`${mount.host}\``,
      `Remote: \`${mount.remote_path}\``,
      '',
      `SFTP：${connectionLabel}`,
      forwarding
        ? 'Agent 转发：转发中'
        : aiForwarded
          ? 'Agent 转发：已启用（未转发）'
          : 'Agent 转发：已关闭',
      focused
        ? 'MCP 绑定：聚焦窗口（默认路由目标）'
        : forwarding
          ? 'MCP 绑定：其他窗口'
          : 'MCP 绑定：无',
      '',
      '展开可查看历史远程目录。'
    ].join('\n'));
    item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
    return item;
  }

  private getHistoryTreeItem(item: HistoryItem): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(item.path);
    const syncing = historySyncTask(item) !== undefined;
    treeItem.contextValue = `safs.history.${syncing ? 'syncEnabled' : 'syncDisabled'}`;
    treeItem.iconPath = new vscode.ThemeIcon('folder');
    treeItem.tooltip = `${item.path}`;
    treeItem.command = {
      command: 'safs.openHistoryItem',
      title: '打开历史目录',
      arguments: [item]
    };
    return treeItem;
  }

  async getChildren(element?: TreeElement): Promise<TreeElement[]> {
    if (element && 'type' in element && element.type === 'history') {
      return [];
    }
    if (element && !('type' in element)) {
      const history = await getDirectoryHistory(this.context);
      const entries = history[element.name] ?? [];
      return entries.map((path) => ({
        type: 'history' as const,
        mountName: element.name,
        path
      }));
    }
    try {
      const config = await readConfig();
      await vscode.commands.executeCommand(
        'setContext', 'safs.hasNoMounts', config.mounts.length === 0
      );
      return config.mounts;
    } catch {
      return [];
    }
  }

  getParent(element: TreeElement): TreeElement | undefined {
    if ('type' in element && element.type === 'history') {
      if (!lastReadConfig) return undefined;
      const mount = lastReadConfig.mounts.find((m) => m.name === element.mountName);
      return mount ?? undefined;
    }
    return undefined;
  }
}

// ---- Workspace restore ----

async function restoreRemoteWorkspaces(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders?.filter(
    (folder) => folder.uri.scheme === remoteFileSystemScheme
  ) ?? [];
  if (folders.length === 0) return;
  const config = await readConfig();
  for (const workspace of folders) {
    try {
      const location = parseRemoteUri(workspace.uri.toString());
      const mount = config.mounts.find((candidate) => candidate.name === location.mountName);
      if (!mount) continue;
      const folder = await ensureFolder(mount);
      if (!isRemotePathInsideRoot(folder.workspaceRoot, location.remotePath)) {
        output.appendLine(
          `工作区使用不受支持的旧 URI，请从 SAFS 面板重新打开：${mount.name}`
        );
        continue;
      }
      const openedRemotePath = remotePathForUri(folder, location.remotePath);
      await writeLastRemoteDirectory(
        localRootForFolder(folder), folder.remoteRoot, openedRemotePath
      );
      if (folder.remoteRoot !== openedRemotePath) {
        output.appendLine(
          `远程根目录已变化：${openedRemotePath} -> ${folder.remoteRoot}`
        );
      }
      if (mount.remote_terminal === 'open') {
        // 标记：本次自动连接后，首次远程文件激活时无条件跟随其目录（标签页恢复）。
        restoredFileSyncPending.add(mount.name);
        await openTerminal(vscodeContext, mount, openedRemotePath);
        // 非阻塞补检，覆盖“文件先激活、终端后创建/事件先于监听器注册”的时序。
        deferRestoreFollow(mount.name);
      }
    } catch (error) {
      // 单个挂载恢复失败（口令取消、连接异常）不阻断其余挂载的恢复。
      const detail = error instanceof Error ? error.message : String(error);
      bridgeOutput?.appendLine(`[工作区恢复] ${workspace.uri.toString()}: ${detail}`);
    }
  }
}

/**
 * 同步镜像以 file:// 工作区打开，不会进入 restoreRemoteWorkspaces。
 * 根据持久化同步任务把本地根映射回远程 cwd，恢复与远程工作区一致的自动终端。
 */
async function restoreSyncedLocalWorkspaceTerminal(): Promise<void> {
  const localRoots = (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === 'file')
    .map((folder) => path.resolve(folder.uri.fsPath));
  if (localRoots.length === 0 || !syncManager) return;
  const task = syncManager.list().find((candidate) =>
    localRoots.includes(path.resolve(candidate.localDir))
  );
  if (!task || !await syncCoordinator?.isReady(
    task.mountName, task.remotePath, task.localDir
  )) return;
  const config = await readConfig();
  const mount = config.mounts.find((candidate) => candidate.name === task.mountName);
  if (!mount || mount.remote_terminal !== 'open') return;
  await openTerminal(vscodeContext, mount, task.remotePath);
}

async function preloadRemoteWorkspaces(): Promise<void> {
  const workspaces = vscode.workspace.workspaceFolders?.filter(
    (folder) => folder.uri.scheme === remoteFileSystemScheme
  ) ?? [];
  if (workspaces.length === 0) return;
  const config = await readConfig();
  for (const workspace of workspaces) {
    try {
      const location = parseRemoteUri(workspace.uri.toString());
      const mount = config.mounts.find((candidate) => candidate.name === location.mountName);
      if (!mount) continue;
      await ensureFolder(mount);
    } catch (error) {
      // A broken/stale workspace folder must not block the rest of the
      // window or pop an error dialog on every startup.
      const detail = error instanceof Error ? error.message : String(error);
      bridgeOutput?.appendLine(`[工作区预载] ${workspace.uri.toString()}: ${detail}`);
    }
  }
}

// ---- Status ----

async function showStatus(): Promise<void> {
  const config = await readConfig();
  output.clear();
  for (const mount of config.mounts) {
    const folder = registry.get(mount.name);
    const state = pool.state(mount.host);
    output.appendLine(
      `${mount.name}: ${state}; host=${mount.host}; remote=${
        folder?.remoteRoot ?? mount.remote_path
      }${pool.error(mount.host) ? `; error=${pool.error(mount.host)?.message}` : ''}`
    );
  }
  output.show(true);
}

// ---- Delete Config ----

async function deleteConfig(mount: MountConfig): Promise<void> {
  const connected = registry.get(mount.name) !== undefined;
  const confirmMessage = connected
    ? `"${mount.name}" 的 SFTP 连接已连接，删除配置需先断开连接。是否断开并删除该配置？`
    : `确定删除"${mount.name}"配置吗？`;
  const confirmButton = connected ? '断开并删除' : '删除';
  if (await vscode.window.showWarningMessage(
    confirmMessage, { modal: true }, confirmButton
  ) !== confirmButton) return;
  if (connected) await disconnect(mount);
  const config = await readConfig();
  removeMountConfig(config, mount.name);
  await saveConfig(configPath(), config);
  const enabled = new Set(
    vscodeContext.globalState.get<string[]>(aiForwardMountsKey, [])
  );
  if (enabled.delete(mount.name)) {
    await vscodeContext.globalState.update(aiForwardMountsKey, [...enabled]);
  }
}

// ---- AI Agent Forwarding (aligned with main) ----

async function forwardedFolders(context: vscode.ExtensionContext): Promise<import('./agent-mcp').RemoteFolderInfo[]> {
  const config = await readConfig();
  const enabled = new Set(context.globalState.get<string[]>(aiForwardMountsKey, []));
  const current = currentRemoteLocation();
  return Promise.all(config.mounts
    .filter((mount) => enabled.has(mount.name))
    .map(async (mount) => {
      const folder = await ensureFolder(mount);
      const workspacePath = current?.mountName === mount.name
        ? currentWorkspacePath(folder)
        : folder.remoteRoot;
      return {
        name: mount.name,
        workspaceUri: folderUri(folder, workspacePath),
        workspaceRoot: workspacePath,
        host: mount.host
      };
    })
  );
}

async function agentMcpToken(context: vscode.ExtensionContext): Promise<string> {
  let token = await context.secrets.get(agentMcpTokenSecret);
  if (!token) {
    token = randomBytes(24).toString('hex');
    await context.secrets.store(agentMcpTokenSecret, token);
  }
  return token;
}

function auditMcpTool(entry: {
  toolName: string; input: Record<string, unknown>;
  agentName?: string; agentPlatform?: string;
}): void {
  void appendMcpToolLog(entry).catch((error) => {
    bridgeOutput?.appendLine(
      `[MCP 工具日志] 写入失败：${error instanceof Error ? error.message : String(error)}`
    );
  });
}

async function ensureAgentHttpRouter(
  context: vscode.ExtensionContext
): Promise<AgentHttpRouter> {
  let router = httpRouter;
  if (!router) {
    if (!httpRouterCreation) {
      httpRouterCreation = (async () => {
        const router = new AgentHttpRouter(
          settings().get<number>('agentHttpRouterPort', 9848),
          await agentMcpToken(context),
          {
            log: (message) => logMcpMessage('Agent HTTP Router', message),
            audit: auditMcpTool,
            forwardTimeoutMs: settings().get<number>('agentMcpTimeoutMs', 120_000),
            toolProfile: () => cliMode() ? 'full' : settings().get<'full' | 'core'>('agentMcpToolProfile', 'full')
          }
        );
        httpRouter = router;
        context.subscriptions.push({ dispose: () => void router.stop() });
        return router;
      })().finally(() => {
        httpRouterCreation = undefined;
      });
    }
    router = await httpRouterCreation;
  }
  if (!httpRouterStart) {
    httpRouterStart = router.start().then(() => router).finally(() => {
      httpRouterStart = undefined;
    });
  }
  return httpRouterStart;
}

function startAgentHttpRouterLeadership(context: vscode.ExtensionContext): void {
  if (agentHttpRouterHeartbeat) return;
  // 相同错误只记录一次，避免非 leader 窗口每 ~4.5s 刷屏（端口被无关程序占用时）。
  let lastLog = '';
  const logOnce = (message: string) => {
    if (lastLog === message) return;
    lastLog = message;
    bridgeOutput?.appendLine(`[Agent HTTP Router] ${message}`);
  };
  const retry = () => void ensureAgentHttpRouter(context).catch((error) => {
    logOnce(error instanceof Error ? error.message : String(error));
  });
  retry();
  agentHttpRouterHeartbeat = setInterval(retry, 4_000 + Math.floor(Math.random() * 1_000));
  context.subscriptions.push({
    dispose: () => {
      if (agentHttpRouterHeartbeat) clearInterval(agentHttpRouterHeartbeat);
      agentHttpRouterHeartbeat = undefined;
    }
  });
}

async function stopAgentHttpRouterLeadership(): Promise<void> {
  if (agentHttpRouterHeartbeat) clearInterval(agentHttpRouterHeartbeat);
  agentHttpRouterHeartbeat = undefined;
  await httpRouterStart?.catch(() => undefined);
  await httpRouter?.stop();
}

async function ensureAgentMcpServer(context: vscode.ExtensionContext): Promise<AgentMcpServer> {
  if (!mcp) {
    const token = await agentMcpToken(context);
    const location = currentRemoteLocation();
    if (!location) throw new Error('当前窗口不是 Serverless Remote 工作区');
    const boundMountName = location.mountName;
    agentTrace('MCP', `创建窗口级 MCP，绑定挂载 ${boundMountName}`);
    mcp = new AgentMcpServer(
      settings().get<number>('agentMcpPort', 0),
      token,
      {
        toolProfile: () => cliMode() ? 'full' : settings().get<'full' | 'core'>('agentMcpToolProfile', 'full'),
        listFolders: async () => (await forwardedFolders(context)).filter(
          (folder) => folder.name === boundMountName
        ),
        currentWorkspace: async () => {
          const location = currentRemoteLocation();
          if (!location) return null;
          const enabled = new Set(context.globalState.get<string[]>(aiForwardMountsKey, []));
          if (!enabled.has(location.mountName)) return null;
          const config = await readConfig();
          const mount = config.mounts.find((candidate) => candidate.name === location.mountName);
          if (!mount) return null;
          const folder = await ensureFolder(mount);
          const workspacePath = currentWorkspacePath(folder);
          return {
            name: mount.name,
            workspaceUri: folderUri(folder, workspacePath),
            workspaceRoot: workspacePath,
            host: mount.host
          };
        },
        currentFile: (input) => activeRemoteFile(input.mountName),
        list: async (input) => remoteList({
          ...input, mountName: forwardedWindowMountName(context, boundMountName, input.mountName)
        }),
        read: async (input) => remoteRead({
          ...input, mountName: forwardedWindowMountName(context, boundMountName, input.mountName)
        }),
        edit: async (input) => remoteEdit({
          ...input, mountName: forwardedWindowMountName(context, boundMountName, input.mountName)
        }),
        write: async (input) => remoteWrite({
          ...input, mountName: forwardedWindowMountName(context, boundMountName, input.mountName)
        }),
        delete: async (input) => remoteDelete({
          ...input, mountName: forwardedWindowMountName(context, boundMountName, input.mountName)
        }),
        chmod: async (input) => remoteChmod({
          ...input, mountName: forwardedWindowMountName(context, boundMountName, input.mountName)
        }),
        move: async (input) => remoteMove({
          ...input, mountName: forwardedWindowMountName(context, boundMountName, input.mountName)
        }),
        upload: async (input) => {
          const mountName = forwardedWindowMountName(
            context, boundMountName, input.mountName
          );
          const { folder } = await mountAndFolder(mountName);
          const stagingRoot = await localTransferRoot(folder);
          const localPaths = await Promise.all(input.localPaths.map(
            (localPath) => validateLocalUploadSource(
              stagingRoot, localPathFromAgent(localPath, input.agentPlatform)
            )
          ));
          const session = await pool.get(folder.hostName);
          const lexicalWorkspaceRoot = currentWorkspacePath(folder);
          const realWorkspaceRoot = await session.realpath(lexicalWorkspaceRoot);
          const lexicalTarget = transferRemotePath(folder, input.remoteDirectory);
          const relativeTarget = path.posix.relative(lexicalWorkspaceRoot, lexicalTarget);
          const requestedTarget = path.posix.resolve(realWorkspaceRoot, relativeTarget);
          const remoteDirectory = await ensureRemoteTransferDirectory(
            session, realWorkspaceRoot, requestedTarget
          );
          const sources = localPaths.map((localPath) => vscode.Uri.file(localPath));
          const timeoutMs = settings().get<number>('agentMcpTimeoutMs', 120_000);
          return {
            completed: await visualUpload(
              sources, mountName, remoteDirectory, realWorkspaceRoot, timeoutMs
            ),
            remoteDirectory,
            localRoot: localPathForAgent(stagingRoot, input.agentPlatform)
          };
        },
        download: async (input) => {
          const mountName = forwardedWindowMountName(
            context, boundMountName, input.mountName
          );
          const { folder } = await mountAndFolder(mountName);
          const stagingRoot = await localTransferRoot(folder);
          const localPath = await validateLocalDownloadTarget(
            stagingRoot, localPathFromAgent(input.localPath, input.agentPlatform)
          );
          const workspaceRoot = currentWorkspacePath(folder);
          const session = await pool.get(folder.hostName);
          const realWorkspaceRoot = await session.realpath(workspaceRoot);
          const requestedPath = transferRemotePath(folder, input.remotePath);
          const resolved = await session.statResolved(requestedPath);
          if (!isRemotePathInsideRoot(realWorkspaceRoot, resolved.path)) {
            throw new Error(`下载路径通过符号链接超出当前工作区：${input.remotePath}`);
          }
          const uri = vscode.Uri.parse(remoteUri(mountName, resolved.path));
          const timeoutMs = settings().get<number>('agentMcpTimeoutMs', 120_000);
          return {
            completed: await visualDownload(uri, localPath, timeoutMs, stagingRoot),
            remotePath: resolved.path,
            localPath: localPathForAgent(localPath, input.agentPlatform),
            localRoot: localPathForAgent(stagingRoot, input.agentPlatform)
          };
        },
        search: async (input) => remoteSearch({
          ...input, captureForMcp: true, mountName: forwardedWindowMountName(context, boundMountName, input.mountName)
        }),
        run: async (input) => executeRemoteCommand(context, {
          ...input, captureForMcp: true, mountName: forwardedWindowMountName(context, boundMountName, input.mountName)
        }),
        request: (agentName, agentPlatform) => {
          updateSafsStatusBar(vscode.window.state.focused, agentName, agentPlatform);
        },
        audit: auditMcpTool,
        log: (message) => logMcpMessage('Agent MCP', message)
      }
    );
    context.subscriptions.push({ dispose: () => void mcp?.stop() });
  }
  agentTrace('MCP', `启动窗口级 MCP，configuredPort=${settings().get<number>('agentMcpPort', 0)}`);
  await mcp.start();
  agentTrace('MCP', mcp.portUnavailable
    ? 'MCP 启动失败：端口不可用'
    : `MCP 已运行，port=${new URL(mcp.url).port}`);
  return mcp;
}

async function publishAgentWorkspace(context: vscode.ExtensionContext): Promise<void> {
  const location = currentRemoteLocation();
  const enabled = new Set(context.globalState.get<string[]>(aiForwardMountsKey, []));
  if (!location || !enabled.has(location.mountName) || !mcp?.running || mcp.portUnavailable) {
    updateSafsStatusBar(false, undefined, undefined, true);
    if (location && !enabled.has(location.mountName)) await mcp?.stop();
    await agentWorkspacePublisher.remove();
    const reason = !location ? '非远程工作区'
      : !enabled.has(location.mountName) ? `挂载 ${location.mountName} 未启用 Agent 转发`
        : !mcp?.running ? 'MCP 未运行' : 'MCP 端口不可用';
    if (lastAgentDiscoveryState !== `removed:${reason}`) {
      lastAgentDiscoveryState = `removed:${reason}`;
      agentTrace('Discovery', `未发布工作区记录：${reason}`);
    }
    return;
  }
  const config = await readConfig();
  const mount = config.mounts.find((candidate) => candidate.name === location.mountName);
  if (!mount) {
    updateSafsStatusBar(false, undefined, undefined, true);
    await agentWorkspacePublisher.remove();
    return;
  }
  const folder = await ensureFolder(mount);
  const workspacePath = currentWorkspacePath(folder);
  await agentWorkspacePublisher.publish({
    focused: vscode.window.state.focused,
    execution: 'remote',
    workspaceUri: folderUri(folder, workspacePath),
    mountName: mount.name,
    workspaceRoot: workspacePath,
    agentCwd: vscode.Uri.parse(folderUri(folder, workspacePath)).fsPath,
    host: mount.host,
    mcpUrl: mcp.url
  });
  updateSafsStatusBar(vscode.window.state.focused);
  const state = `published:${mount.name}:${workspacePath}:${mcp.url}:${vscode.window.state.focused}`;
  if (lastAgentDiscoveryState !== state) {
    lastAgentDiscoveryState = state;
    agentTrace(
      'Discovery',
      `已发布挂载 ${mount.name}，focused=${vscode.window.state.focused}，port=${new URL(mcp.url).port}`
    );
  }
}

function startAgentWorkspacePublishing(context: vscode.ExtensionContext): void {
  if (agentWorkspaceHeartbeat) clearInterval(agentWorkspaceHeartbeat);
  const refresh = () => void publishAgentWorkspace(context).catch((error) => {
    bridgeOutput?.appendLine(`[Agent discovery] ${error instanceof Error ? error.message : String(error)}`);
  });
  refresh();
  agentWorkspaceHeartbeat = setInterval(refresh, 10_000);
  // 转发状态与聚焦窗口变化（本窗口或其他窗口启用/关闭/发布/聚焦切换）时刷新
  // 树视图，让“转发中/已启用”状态与“👁 聚焦窗口”指示符保持最新。
  const forwardingRefresh = () => {
    const workspaces = discoverAgentWorkspaces();
    const active = new Set(workspaces.map((workspace) => workspace.mountName));
    const focusedMount = workspaces.find((workspace) => workspace.focused)?.mountName ?? '';
    const signature = `${focusedMount}|${[...active].sort().join(',')}`;
    if (signature !== lastForwardingSignature) {
      lastForwardingSignature = signature;
      refreshTree();
    }
  };
  forwardingRefresh();
  const forwardingTimer = setInterval(forwardingRefresh, 10_000);
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) updateSafsStatusBar(false);
      refresh();
      if (state.focused) forwardingRefresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    {
      dispose: () => {
        if (agentWorkspaceHeartbeat) clearInterval(agentWorkspaceHeartbeat);
        agentWorkspaceHeartbeat = undefined;
        clearInterval(forwardingTimer);
      }
    },
    {
      dispose: () => {
        if (agentWorkspaceHeartbeat) clearInterval(agentWorkspaceHeartbeat);
        agentWorkspaceHeartbeat = undefined;
        void agentWorkspacePublisher.remove().catch((error) =>
          logAsyncFailure('Agent discovery 清理失败', error)
        );
      }
    }
  );
}

async function probeInstalledCliVersion(
  executable: string, agentInWsl: boolean
): Promise<string | undefined> {
  try {
    const plan = agentInWsl
      ? wslBashInvocation('"$1" --version', [localPathForAgent(executable, 'wsl')])
      : { command: executable, args: ['--version'] };
    const result = await executeCaptured(plan, AbortSignal.timeout(5_000), 4096);
    if (result.exitCode !== 0) return undefined;
    return parseNativeCliVersion(`${result.stdout}\n${result.stderr}`);
  } catch {
    return undefined;
  }
}

async function ensureGlobalCliVersion(
  context: vscode.ExtensionContext, executable: string,
  nativePlatform: ReturnType<typeof nativeCliPlatform>, agentHome: string, agentInWsl: boolean
): Promise<void> {
  const extensionVersion = String(context.extension.packageJSON?.version ?? '');
  if (!extensionVersion) throw new Error('无法读取当前 SAFS 插件版本');
  const checkKey = `${nativePlatform}\0${executable}\0${extensionVersion}`;
  const existing = cliVersionChecks.get(checkKey);
  if (existing) return existing;
  const check = (async () => {
    const fileExists = await access(executable).then(() => true, () => false);
    const installedVersion = fileExists
      ? await probeInstalledCliVersion(executable, agentInWsl)
      : undefined;
    if (installedVersion !== extensionVersion) {
      bridgeOutput?.warn(
        `[Agent CLI] 版本不一致，正在更新；installed=${installedVersion ?? '<unknown>'}；` +
        `extension=${extensionVersion}；platform=${nativePlatform}`
      );
      await installNativeCli(context.extensionUri.fsPath, agentHome, nativePlatform);
      if (agentInWsl) {
        const permission = await executeCaptured(wslBashInvocation(
          'chmod 755 "$1"', [localPathForAgent(executable, 'wsl')]
        ));
        if (permission.exitCode !== 0) {
          throw new Error('无法设置 WSL SAFS CLI 权限：' + permission.stderr.trim());
        }
      }
      const refreshedVersion = await probeInstalledCliVersion(executable, agentInWsl);
      if (refreshedVersion !== extensionVersion) {
        throw new Error(
          `SAFS CLI 更新后版本仍不一致：期望 ${extensionVersion}，实际 ${
            refreshedVersion ?? '无法识别'
          }`
        );
      }
      bridgeOutput?.info(`[Agent CLI] 已更新到插件版本 ${extensionVersion}：${executable}`);
    } else {
      bridgeOutput?.debug(`[Agent CLI] 版本检查通过：${installedVersion}；${executable}`);
    }
    await context.globalState.update(cliInstallKey, {
      platform: nativePlatform, installPath: executable, version: extensionVersion,
      home: agentHome
    });
  })().catch((error) => {
    cliVersionChecks.delete(checkKey);
    throw error;
  });
  cliVersionChecks.set(checkKey, check);
  return check;
}

async function installGlobalCli(
  context: vscode.ExtensionContext, routerUrl: string
): Promise<string> {
  const agentPlatform = await resolveAgentPlatform(
    settings().get<string>('agentPlatform', 'auto')
  );
  const nativePlatform = nativeCliPlatform(process.platform, process.arch, agentPlatform.wsl);
  const executable = globalNativeCli(agentPlatform.home, nativePlatform);
  // globalState 只能说明插件曾尝试安装过，不能证明磁盘上的二进制没有被旧版本
  // 覆盖。首次使用时执行 `safs --version`，不一致（或旧版不支持探测）就从
  // 当前扩展包内刷新对应平台的二进制。
  await ensureGlobalCliVersion(
    context, executable, nativePlatform, agentPlatform.home, agentPlatform.wsl
  );
  const forwardingTimeoutMs = settings().get<number>('agentMcpTimeoutMs', 120_000);
  const cliTimeoutMs = forwardingTimeoutMs > 0 ? forwardingTimeoutMs + 5_000 : 0;
  await writeCliConnectionFile(
    nativeCliConnectionPath(executable), routerUrl, cliTimeoutMs
  );
  const binDirectory = path.dirname(executable);
  if (nativePlatform.startsWith('win32-')) {
    const result = await executeCaptured(windowsUserPathUpdatePlan(binDirectory));
    if (result.exitCode !== 0) throw new Error('无法更新用户级 PATH：' + result.stderr.trim());
  } else {
    await ensureUnixCliPath(agentPlatform.home);
    if (agentPlatform.wsl) {
      const result = await executeCaptured(wslBashInvocation(
        'chmod 755 "$1" && chmod 600 "$2"',
        [
          localPathForAgent(executable, 'wsl'),
          localPathForAgent(nativeCliConnectionPath(executable), 'wsl')
        ]
      ));
      if (result.exitCode !== 0) throw new Error('无法设置 WSL SAFS CLI 权限：' + result.stderr.trim());
    }
  }
  if (!agentPlatform.wsl) {
    const current = process.env.PATH?.split(path.delimiter) ?? [];
    if (!current.includes(binDirectory)) {
      process.env.PATH = `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}`;
    }
    context.environmentVariableCollection.prepend('PATH', `${binDirectory}${path.delimiter}`);
  }
  return executable;
}

async function configureAgentInterface(
  context: vscode.ExtensionContext
): Promise<{ cliExecutable?: string; mcpBridgeExecutable?: string }> {
  const router = await ensureAgentHttpRouter(context);
  if (!cliMode()) {
    const executable = await installGlobalCli(context, router.url);
    bridgeOutput?.appendLine(
      `[Agent MCP] 无代理 stdio 桥已就绪：${executable}；SAFS 不探测或修改 Agent 配置。`
    );
    return { mcpBridgeExecutable: executable };
  }
  const executable = await installGlobalCli(context, cliRouterUrl(router.url));
  bridgeOutput?.appendLine(
    '[Agent CLI] 已安装用户级 safs 命令；SAFS 不探测或修改 Agent 配置。'
  );
  return { cliExecutable: executable };
}

async function setAiForwardEnabled(mount: MountConfig, enabledValue: boolean): Promise<void> {
  let cliExecutable: string | undefined;
  bridgeOutput?.info(
    `[Agent 转发] ${enabledValue ? '启用' : '关闭'} ${mount.name}`
  );
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: enabledValue
      ? 'SAFS：正在启用 Agent 转发'
      : 'SAFS：正在关闭 Agent 转发'
  }, async () => {
    const enabled = new Set(vscodeContext.globalState.get<string[]>(aiForwardMountsKey, []));
    if (enabledValue) enabled.add(mount.name);
    else enabled.delete(mount.name);
    await vscodeContext.globalState.update(aiForwardMountsKey, [...enabled]);
    agentTrace(
      'Preference',
      `挂载 ${mount.name} Agent 转发标记已设为${enabledValue ? '启用' : '关闭'}`
    );
    const current = currentRemoteLocation();
    if (!enabledValue && current?.mountName === mount.name) {
      agentTrace('Preference', `当前窗口绑定 ${mount.name}，正在停止 MCP 并移除发现记录`);
      await mcp?.stop();
      await agentWorkspacePublisher.remove();
    }
    if (enabledValue) {
      await prepareAgentCwd(mount);
      agentTrace('Preference', '先启动固定 HTTP 路由，再启动当前窗口服务');
      startAgentHttpRouterLeadership(vscodeContext);
      cliExecutable = (await configureAgentInterface(vscodeContext)).cliExecutable;
      if (current?.mountName === mount.name) {
        const server = await ensureAgentMcpServer(vscodeContext);
        if (!server.portUnavailable) await publishAgentWorkspace(vscodeContext);
      }
    } else if (enabled.size === 0) {
      agentTrace('Preference', '已无启用挂载，停止固定路由；Agent 配置由用户手动管理');
      await stopAgentHttpRouterLeadership();
    }
  });
  if (enabledValue) {
    if (cliExecutable) {
      bridgeOutput?.info(`[Agent CLI] 安装完成：${cliExecutable}`);
      void vscode.window.showInformationMessage(
        'SAFS：CLI 已安装，请重启后使用。'
      );
      return;
    }
    await vscode.commands.executeCommand(`${commandPrefix}.installAgentForwarding`);
    return;
  }
  const enabled = new Set(vscodeContext.globalState.get<string[]>(aiForwardMountsKey, []));
  bridgeOutput?.info(
    `[Agent 转发] 已关闭 ${mount.name}；剩余=${[...enabled].join(',') || '<empty>'}`
  );
  void vscode.window.showInformationMessage(
    enabled.size === 0
      ? 'SAFS：所有 Agent 转发已关闭。'
      : 'SAFS：Agent 转发已关闭，其他挂载不受影响。'
  );
}

async function prepareAgentCwd(mount: MountConfig): Promise<void> {
  try {
    const folder = await ensureFolder(mount);
    agentTrace('CWD', `Agent cwd 已可用：${vscode.Uri.parse(folderUri(folder)).fsPath}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    bridgeOutput?.appendLine(`[Agent CWD] 无法为 ${mount.name} 创建本机占位目录：${detail}`);
    void vscode.window.showWarningMessage(
      'SAFS：Agent 工作目录准备失败。', viewSafsLogAction
    ).then((selected) => {
      if (selected === viewSafsLogAction) bridgeOutput?.show(true);
    });
  }
}

// ---- Guard / Error Handling (aligned with main) ----

async function guard(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logAsyncFailure('命令失败', error);
    if (error instanceof ConfigActionRequiredError) {
      const selected = await vscode.window.showErrorMessage(
        error.actions.includes(addSshConfigAction)
          ? 'SAFS：尚未配置远程目录。'
          : 'SAFS：配置无法读取，请打开配置检查。',
        ...error.actions
      );
      if (selected === openConfigAction) {
        await vscode.commands.executeCommand(`${commandPrefix}.openConfig`, error.hostName);
      } else if (selected === addSshConfigAction) {
        await vscode.commands.executeCommand(`${commandPrefix}.addSshConfig`);
      }
      return;
    }
    const missingCommand = missingExecutableName(error);
    if (missingCommand) {
      bridgeOutput?.appendLine(`[缺少依赖] ${message}`);
      const selected = await vscode.window.showErrorMessage(
        'SAFS：缺少必要的 SSH 客户端命令。', viewSafsLogAction
      );
      if (selected === viewSafsLogAction) bridgeOutput?.show(true);
      return;
    }
    output.appendLine(`[错误] ${message}`);
    const summary = /All configured authentication methods failed/i.test(message)
      ? 'SAFS：SSH 认证失败，请检查登录凭据。'
      : /Unable to start subsystem/i.test(message)
        ? 'SAFS：服务器未提供 SFTP 子系统。'
        : /packet length|exchange encryption keys|wrong packet|bad packet/i.test(message)
          ? 'SAFS：SSH 握手失败，自动重试仍未恢复。'
          : 'SAFS：操作失败，完整原因已写入日志。';
    const selected = await vscode.window.showErrorMessage(summary, viewSafsLogAction);
    if (selected === viewSafsLogAction) bridgeOutput?.show(true);
  }
}

async function ensureSystemDependencies(): Promise<void> {
  const platform = platformAdapter.kind;
  if (platform !== 'wsl' || await hasRequiredWslDependencies()) return;
  const platformName = 'WSL';
  bridgeOutput?.appendLine(
    `检测到 ${platformName} 系统依赖缺失，开始自动安装`
  );
  try {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'SAFS：正在安装系统依赖',
      cancellable: false
    }, async (progress) => {
      const reporter = {
        log: (message: string) => {
          if (!message) return;
          bridgeOutput?.appendLine(message);
          progress.report({ message: '正在安装所需组件…' });
        },
        progress: (message: string, increment?: number) =>
          progress.report({ message, increment })
      };
      await installWslDependencies(reporter);
    });
    bridgeOutput?.appendLine(`${platformName} 系统依赖自动安装完成`);
    void vscode.window.showInformationMessage(
      `SAFS：${platformName} 依赖安装完成。`
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    bridgeOutput?.appendLine(`[依赖安装失败] ${detail}`);
    const selected = await vscode.window.showErrorMessage(
      `SAFS：${platformName} 依赖安装失败。`,
      '查看输出'
    );
    if (selected === '查看输出') bridgeOutput?.show(true);
  }
}

// ---- Activate / Deactivate ----

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  vscodeContext = context;
  output = vscode.window.createOutputChannel('SAFS');
  bridgeOutput = vscode.window.createOutputChannel('SAFS Log', { log: true });
  context.subscriptions.push(output, bridgeOutput);
  await recoverTerminalDiagnostics(context);
  // 独立、高优先级 ID：避免长焦点文案被底栏布局整项挤掉，也不复用
  // 旧匿名 SAFS 状态项可能已被用户隐藏的可见性偏好。
  forwardingFocusStatusBar = vscode.window.createStatusBarItem(
    'safs.agentForwardingFocus', vscode.StatusBarAlignment.Left, 10_000
  );
  forwardingFocusStatusBar.name = 'SAFS Agent 转发焦点';
  forwardingFocusStatusBar.command = `${commandPrefix}.openFolder`;
  // SFTP 入口与 SAFS SYNC 一致：独立常驻一项，转发焦点提示不再顶替它。
  safsStatusBar = vscode.window.createStatusBarItem(
    'safs.sftpEntry', vscode.StatusBarAlignment.Left, 9_999
  );
  safsStatusBar.name = 'SAFS SFTP';
  safsStatusBar.command = `${commandPrefix}.openFolder`;
  updateSafsStatusBar(false);
  safsStatusBar.show();
  context.subscriptions.push(safsStatusBar, forwardingFocusStatusBar);
  syncStatusBar = vscode.window.createStatusBarItem(
    'safs.syncStatus', vscode.StatusBarAlignment.Left, 99
  );
  syncStatusBar.name = 'SAFS 本地同步';
  context.subscriptions.push(syncStatusBar);
  syncCoordinator = new SyncCoordinator(
    vscode.Uri.joinPath(context.globalStorageUri, 'sync-coordination').fsPath
  );
  context.subscriptions.push({ dispose: () => void syncCoordinator?.dispose() });
  const logCleanup = setInterval(() => {
    output.clear();
    bridgeOutput?.clear();
  }, logClearIntervalMs);
  context.subscriptions.push({ dispose: () => clearInterval(logCleanup) });
  agentTrace('Activate', `扩展激活，workspace=${
    vscode.workspace.workspaceFolders?.map((folder) => folder.uri.toString()).join(', ') || '<none>'
  }`);

  // WSL: point the bundled scripts at resources/wsl/. VSIX packaging can
  // strip the executable bit from ssh-bridge (Windows builds store 0666), so
  // re-assert it before any terminal spawns the bridge.
  setWslBundlePath(vscode.Uri.joinPath(context.extensionUri, 'resources', 'wsl').fsPath);
  setRemoteShellIntegrationBundlePath(
    vscode.Uri.joinPath(context.extensionUri, 'resources', 'shell-integration').fsPath
  );
  setKnownHostsFilePath(knownHostsFilePath());
  await ensureWslBridgeExecutable();
  // 依赖安装后台执行，不阻塞窗口激活（apt install 可能耗时数分钟）；
  // 终端路径另有 hasRequiredWslDependencies 守卫。
  void ensureSystemDependencies();

  registry = new RemoteFolderRegistry();
  refreshTree = () => undefined;
  pool = new SftpConnectionPool(
    async (hostName, signal) => {
      const host = await resolvedHost(context, hostName);
      const session = await connectSftp(
        host,
        platformAdapter.kind === 'wsl',
        signal,
        settings().get<string>('sshClientIdent', defaultSshClientIdent),
        hostVerifierFor(host, (message) => bridgeOutput?.appendLine(`[主机密钥] ${message}`)),
        (reason) => bridgeOutput?.appendLine(
          `[SFTP] ${host.name} SFTP 子系统不可用，回退到 SCP/exec：${reason}`
        )
      );
      agentTrace('SFTP', `${host.name} 传输通道：${session.transport}`);
      return session;
    },
    // 连接/重连/断开即时刷新底栏入口（SFTP↔SCP）与树视图；心跳仅作兜底。
    () => {
      refreshTree();
      refreshSafsEntryLabel();
    }
  );
  // 回收空闲 SFTP 连接（safs.sftp.idleConnectionTtl 秒，0 关闭），避免多主机
  // 长期挂载时连接无限累积。
  const idleTtlSec = settings().get<number>('sftp.idleConnectionTtl', 600);
  if (idleTtlSec > 0) {
    const idleTtlMs = idleTtlSec * 1000;
    const idleTimer = setInterval(() => {
      void pool.closeIdle(idleTtlMs).catch((error) =>
        logAsyncFailure('SFTP 空闲连接回收失败', error)
      );
    }, Math.min(idleTtlMs, 60_000));
    idleTimer.unref?.();
    context.subscriptions.push({ dispose: () => clearInterval(idleTimer) });
  }
  // 远程文件/目录 ↔ 本地双向同步管理器：provider 事件即时同步，低频扫描
  // 补获终端、Agent 与其他 SSH 客户端直接产生的远程变更。
  syncManager = new RemoteSyncManager(
    async (mountName) => {
      const existing = registry.get(mountName);
      if (existing) return pool.get(existing.hostName);
      // 非远程窗口（如只打开了本地目录的窗口）：按配置解析挂载并连接，
      // 这样本地变更的状态与同步也能在该窗口生效。
      const config = await readConfig();
      const mount = config.mounts.find((candidate) => candidate.name === mountName);
      if (!mount) throw new Error(`远程挂载不存在：${mountName}`);
      const folder = await ensureFolder(mount);
      return pool.get(folder.hostName);
    },
    (uri) => {
      try {
        const location = parseRemoteUri(uri.toString());
        const folder = registry.get(location.mountName);
        if (!folder) return undefined;
        return { mountName: location.mountName, remotePath: remotePathForUri(folder, location.remotePath) };
      } catch {
        return undefined;
      }
    },
    (message) => bridgeOutput?.appendLine(`[远程同步] ${message}`),
    (persist) => saveSyncTasks(persist),
    // 同步进度显示在 VS Code 底部中间（短暂消息，如“正在下载…”）。
    (message) => void vscode.window.setStatusBarMessage(message, 3000),
    (task) => syncCoordinator?.acquire(task.mountName, task.remotePath) ?? Promise.resolve(true),
    (task) => syncCoordinator?.release(task.mountName, task.remotePath) ?? Promise.resolve(),
    async (task) => {
      await syncCoordinator?.markReady(task.mountName, task.remotePath, task.localDir);
      await updateSyncStatusBar();
    },
    (task) => syncCoordinator?.isStopRequested(task.mountName, task.remotePath)
      ?? Promise.resolve(false),
    settings().get<number>('sftp.watchInterval', 5) * 1000
  );
  // 恢复上次的同步任务（指纹行随任务持久化，重载后继续增量同步）。
  for (const task of context.globalState.get<RemoteSyncTask[]>(syncTasksKey, [])) {
    void syncManager.add(task).catch((error) =>
      logAsyncFailure(`恢复同步任务失败 ${task.mountName}:${task.remotePath}`, error)
    );
  }
  void updateSyncStatusBar().catch((error) => logAsyncFailure('同步状态栏刷新失败', error));
  await guard(preloadRemoteWorkspaces);
  provider = new SftpFileSystemProvider(
    pool,
    registry,
    settings().get<number>('sftp.cacheTtl', 30) * 1000,
    settings().get<number>('sftp.watchInterval', 5) * 1000,
    (uri, kind, targetUri) => void syncManager?.notifyRemoteChange(uri, kind, targetUri)
  );

  const tree = new RemoteFoldersProvider(context);
  refreshTree = () => tree.refresh();
  context.subscriptions.push(
    provider,
    vscode.workspace.registerFileSystemProvider(remoteFileSystemScheme, provider, {
      isCaseSensitive: true,
      isReadonly: false
    }),
    vscode.window.registerTerminalLinkProvider({
      provideTerminalLinks: (linkContext) => provideSafsTerminalLinks(linkContext),
      handleTerminalLink: (link) => guard(
        () => handleSafsTerminalLink(link as SafsTerminalLink)
      )
    }),
    vscode.window.registerTreeDataProvider(`${commandPrefix}.mounts`, tree),
    { dispose: () => { void pool.close(); syncManager?.dispose(); } }
  );

  const command = (name: string, callback: (...args: never[]) => Promise<unknown>) => {
    context.subscriptions.push(vscode.commands.registerCommand(
      `${commandPrefix}.${name}`,
      (...args: never[]) => guard(() => callback(...args))
    ));
  };
  command('openFolder', async () => {
    await openRemoteDirectory();
    tree.refresh();
  });
  command('openFolderItem', async (mount) => {
    await openDirectoryItem(mount);
    tree.refresh();
  });
  command('switchRemoteDirectory', switchRemoteDirectory);
  command('completeRemoteDirectory', completeRemoteDirectory);
  command('syncToLocal', (uri) => syncToLocal(uri as vscode.Uri | undefined));
  command('visualDownload', (uri) => visualDownload(uri as vscode.Uri | undefined));
  command('visualUpload', (...args) => visualUpload(args as vscode.Uri[]));
  command('openTerminal', () => openTerminal(context, undefined, undefined, undefined, true));
  command('openTerminalItem', (mount) =>
    openTerminal(context, mount, undefined, undefined, true));
  command('close', async () => {
    await disconnect();
    tree.refresh();
  });
  command('closeItem', async (mount) => {
    await disconnect(mount);
    tree.refresh();
  });
  command('status', showStatus);
  command('openConfig', () => openConfig());
  command('addSshConfig', async () => {
    await addSshConfig(context);
    tree.refresh();
  });
  const askAgentNameAndPlatform = async (
    title: string
  ): Promise<{ agentName: string; platform: AgentPlatformLabel } | undefined> => {
    const agentName = await vscode.window.showInputBox({
      title,
      prompt: '请输入使用该 URL 的 Agent 名（仅用于日志和诊断）',
      placeHolder: '例如：Codex、Claude、MyAgent',
      ignoreFocusOut: true,
      validateInput: (value) => !value.trim()
        ? '请输入 Agent 名'
        : value.trim().length > 100
          ? 'Agent 名最多 100 个字符'
          : /[\u0000-\u001f\u007f]/.test(value)
            ? 'Agent 名不能包含控制字符'
            : undefined
    });
    if (agentName === undefined) return undefined;
    const platform = await vscode.window.showQuickPick<{
      label: string; description: string; value: AgentPlatformLabel;
    }>([
      { label: 'WSL', description: 'Agent 运行在 Windows Subsystem for Linux', value: 'wsl' },
      { label: 'mac', description: 'Agent 运行在 macOS', value: 'mac' },
      { label: 'linux', description: 'Agent 运行在 Linux', value: 'linux' },
      { label: 'win', description: 'Agent 运行在 Windows', value: 'win' }
    ], {
      title: 'SAFS：选择 Agent 所在平台',
      placeHolder: '选择 wsl、mac、linux 或 win',
      ignoreFocusOut: true
    });
    if (!platform) return undefined;
    return { agentName: agentName.trim(), platform: platform.value };
  };
  command('copyStreamableHttpUrl', async () => {
    const answer = await askAgentNameAndPlatform('SAFS：复制 Streamable HTTP URL');
    if (!answer) return;
    startAgentHttpRouterLeadership(context);
    const router = await ensureAgentHttpRouter(context);
    const url = agentTaggedMcpUrl(router.url, answer.agentName, answer.platform);
    await vscode.env.clipboard.writeText(url);
    void vscode.window.showInformationMessage(
      'SAFS：MCP URL 已复制；请确认 NO_PROXY。'
    );
  });
  command('installAgentForwarding', async () => {
    if (cliMode()) {
      const router = await ensureAgentHttpRouter(context);
      const executable = await installGlobalCli(context, cliRouterUrl(router.url));
      bridgeOutput?.info(`[Agent CLI] 安装完成：${executable}`);
      void vscode.window.showInformationMessage(
        'SAFS：CLI 已安装，请重启后运行 safs bind。'
      );
      return;
    }
    const answer =
      await askAgentNameAndPlatform('SAFS：为我的Agent安装转发功能');
    if (!answer) return;
    startAgentHttpRouterLeadership(context);
    const router = await ensureAgentHttpRouter(context);
    const executable = await installGlobalCli(context, router.url);
    // 默认通过原生 stdio 桥直连 loopback，避免 Agent 的 HTTP 代理把
    // 127.0.0.1 请求转发到代理并产生 502；MCP 配置仍由用户粘贴提示词安装。
    const promptText = nativeMcpBridgeInstallPrompt(
      executable, answer.agentName, answer.platform
    );
    await vscode.env.clipboard.writeText(promptText);
    void vscode.window.showInformationMessage(
      'SAFS：安装提示词已复制，请粘贴到 Agent。'
    );
  });
  command('uninstallAgentForwarding', async () => {
    const answer = await askAgentNameAndPlatform('SAFS：为我的Agent卸载转发功能');
    if (!answer) return;
    // 与安装对称：复制一段提示词让 Agent 自己删除名为 safs 的用户级 MCP。
    const promptText = [
      '请卸载你之前安装的名为 safs 的用户级 MCP 服务器，只删除该条目，不要改动其他配置或其他 Agent。',
      '完成后告诉我已删除，然后重启并新建对话确认不再加载 SAFS 工具。'
    ].join('\n');
    await vscode.env.clipboard.writeText(promptText);
    void vscode.window.showInformationMessage(
      'SAFS：卸载提示词已复制，请粘贴到 Agent。'
    );
  });
  command('refreshExplorer', async () => tree.refresh());
  command('deleteConfigItem', async (mount) => {
    await deleteConfig(mount);
    tree.refresh();
  });
  command('openHistoryItem', async (item: HistoryItem) => {
    const syncTask = historySyncTask(item);
    if (syncTask) {
      if (!await syncCoordinator?.isReady(item.mountName, item.path, syncTask.localDir)) {
        bridgeOutput?.info(
          `[同步] 本地目录尚未准备完成；mount=${item.mountName}；path=${item.path}`
        );
        void vscode.window.showInformationMessage(
          'SAFS：目录仍在同步，请稍后再打开。'
        );
        return;
      }
      await vscode.commands.executeCommand(
        'vscode.openFolder', vscode.Uri.file(syncTask.localDir), true
      );
      return;
    }
    const config = await readConfig();
    const mount = config.mounts.find((m) => m.name === item.mountName);
    if (!mount) throw new Error(`远程目录配置不存在：${item.mountName}`);
    const folder = await ensureFolder(mount);
    const remoteRoot = folder.remoteRoot;
    if (!isRemotePathInsideRoot(remoteRoot, item.path)) {
      throw new Error(`远程目录路径无效：${item.path}`);
    }
    const forwarding = vscodeContext.globalState
      .get<string[]>(aiForwardMountsKey, []).includes(mount.name);
    if (forwarding) {
      startAgentHttpRouterLeadership(vscodeContext);
      await ensureAgentHttpRouter(vscodeContext);
    }
    const localRoot = localRootForFolder(folder);
    await ensureAgentCwdSubdirectory(localRoot, folder.remoteRoot, item.path);
    await writeLastRemoteDirectory(localRoot, folder.remoteRoot, item.path);
    await recordDirectoryHistory(vscodeContext, item.mountName, item.path);
    await vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.parse(folderUri(folder, item.path)),
      true
    );
  });
  command('enableHistorySync', async (item: HistoryItem) => {
    await enableHistorySync(item);
    tree.refresh();
  });
  command('disableHistorySync', async (item: HistoryItem) => {
    await disableHistorySync(item);
    tree.refresh();
  });
  command('openTerminalFromHistory', async (item: HistoryItem) => {
    const config = await readConfig();
    const mount = config.mounts.find((m) => m.name === item.mountName);
    if (!mount) throw new Error(`远程目录配置不存在：${item.mountName}`);
    await recordDirectoryHistory(vscodeContext, item.mountName, item.path);
    await openTerminal(vscodeContext, mount, item.path, undefined, true);
  });
  command('deleteHistoryItem', async (item: HistoryItem) => {
    await removeHistoryEntry(vscodeContext, item.mountName, item.path);
    tree.refresh();
  });
  command('enableAiForwardItem', async (mount) => {
    await setAiForwardEnabled(mount, true);
    tree.refresh();
  });
  command('disableAiForwardItem', async (mount) => {
    await setAiForwardEnabled(mount, false);
    tree.refresh();
  });

  // VS Code Language Model tools
  const tool = <T>(
    name: string,
    callback: (input: T) => Promise<unknown>,
    confirmation = false
  ) => context.subscriptions.push(vscode.lm.registerTool<T>(name, {
    ...(confirmation ? {
      prepareInvocation: async () => ({
        invocationMessage: '正在修改远程 SFTP 文件',
        confirmationMessages: {
          title: '修改远程文件',
          message: new vscode.MarkdownString('是否允许修改远程 SFTP 工作区？')
        }
      })
    } : {}),
    invoke: async (options) => new vscode.LanguageModelToolResult([
      // 紧凑 JSON：缩进空白只会白白消耗模型 token。
      new vscode.LanguageModelTextPart(JSON.stringify(
        await callback((options.input ?? {}) as T)
      ))
    ])
  }));
  tool<{ mountName?: string; path?: string }>('safs_listRemoteFiles', async (input) =>
    remoteList({ ...input, mountName: await forwardedMountName(input.mountName) }));
  tool<{ mountName?: string }>('safs_currentRemoteFile', async (input) =>
    activeRemoteFile(await forwardedMountName(input.mountName)));
  tool<{ mountName?: string; path: string; content: string }>(
    'safs_writeRemoteFile', async (input) =>
      remoteWrite({ ...input, mountName: await forwardedMountName(input.mountName) }), true
  );
  tool<RemoteSearchOptions & { mountName?: string }>(
    'safs_searchRemoteFiles', async (input) =>
      remoteSearch({ ...input, mountName: await forwardedMountName(input.mountName) })
  );
  tool<{ mountName?: string; command: string; remoteCwd?: string }>(
    'safs_runRemoteCommand', async (input) =>
      runRemote({
        ...input,
        mountName: await forwardedMountName(input.mountName),
        source: 'command_palette'
      }), true
  );

  // Terminal lifecycle
  context.subscriptions.push(vscode.window.onDidCloseTerminal((terminal) => {
    void suggestReopeningClosedTerminal(terminal).catch((error) =>
      logAsyncFailure('终端退出处理失败', error)
    );
  }));

  // Restore workspaces on startup
  await guard(restoreRemoteWorkspaces);
  await guard(restoreSyncedLocalWorkspaceTerminal);
  tree.refresh();

  // 每次切换到远程文件或同步镜像文件时：若设置开启则同步远程终端；
  // 重开远程窗口后首次文件激活也无条件跟随（配合标签页恢复）。
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
    const uri = editor?.document.uri;
    if (!uri || (uri.scheme !== remoteFileSystemScheme && uri.scheme !== 'file')) return;
    void syncTerminalToActiveFile(uri).catch((error) =>
      logAsyncFailure('终端目录跟随调度失败', error)
    );
  }));
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void updateSyncStatusBar().catch((error) =>
        logAsyncFailure('同步状态栏刷新失败', error)
      );
    })
  );

  // Keep MCP and CLI mutually exclusive without inspecting Agent installations.
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration('safs.agentInterface')) return;
    void guard(async () => {
      startAgentHttpRouterLeadership(context);
      if (cliMode()) {
        const result = await configureAgentInterface(context);
        bridgeOutput?.info(`[Agent CLI] 接口切换完成：${result.cliExecutable}`);
        void vscode.window.showInformationMessage(
          'SAFS：CLI 已就绪；请重启 Agent。'
        );
      } else {
        await configureAgentInterface(context);
        await vscode.commands.executeCommand(`${commandPrefix}.installAgentForwarding`);
      }
    });
  }));
  // Agent MCP: keep one in-extension fixed HTTP router alive, then start the
  // dynamic backend only in an enabled remote window.
  await guard(async () => {
    const enabled = new Set(context.globalState.get<string[]>(aiForwardMountsKey, []));
    const current = currentRemoteLocation();
    agentTrace(
      'Activate',
      `当前远程挂载=${current?.mountName ?? '<none>'}，启用列表=${[...enabled].join(',') || '<empty>'}`
    );
    // CLI mode is a user-level interface and must be installed even before a
    // mount enables forwarding. This also repairs missing installs on reload.
    if (cliMode()) {
      agentTrace('Activate', 'CLI 模式已启用，安装或更新用户级全局 safs 命令');
      startAgentHttpRouterLeadership(context);
      await configureAgentInterface(context);
    }
    if (enabled.size > 0) {
      agentTrace('Activate', '启动或连接固定 HTTP MCP 路由器');
      startAgentHttpRouterLeadership(context);
      await configureAgentInterface(context);
      if (current && enabled.has(current.mountName)) {
        agentTrace('Activate', `挂载 ${current.mountName} 已启用，启动窗口动态 MCP 后端`);
        const config = await readConfig();
        const mount = config.mounts.find((candidate) => candidate.name === current.mountName);
        if (mount) await prepareAgentCwd(mount);
        const server = await ensureAgentMcpServer(context);
        if (!server.portUnavailable) {
          await publishAgentWorkspace(context);
        }
      } else {
        agentTrace('Activate', '当前不是已启用的远程窗口，仅提供固定 HTTP 路由');
      }
    } else {
      agentTrace('Activate', 'CLI 路由已就绪；当前没有启用 Agent 转发的远程挂载');
    }
  });
  startAgentWorkspacePublishing(context);

}

export async function deactivate(): Promise<void> {
  agentTrace('Deactivate', '扩展停用，清理发现记录、MCP 和连接池');
  if (agentWorkspaceHeartbeat) clearInterval(agentWorkspaceHeartbeat);
  if (agentHttpRouterHeartbeat) clearInterval(agentHttpRouterHeartbeat);
  await agentWorkspacePublisher.remove();
  await mcp?.stop();
  await httpRouterStart?.catch(() => undefined);
  await httpRouter?.stop();
  await pool?.close();
  closeSsh2ExecSessions();
}
