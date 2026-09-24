import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';
import { defaultHighRiskCommandPatterns } from '../src/high-risk-commands';

interface ExtensionManifest {
  version: string;
  activationEvents?: string[];
  extensionKind?: string[];
  contributes?: {
    commands?: Array<{ command: string; title: string }>;
    menus?: Record<string, Array<{ command: string; when?: string; group?: string }>>;
    configuration?: {
      properties?: Record<string, {
        default?: unknown; enum?: unknown[]; description?: string; markdownDescription?: string;
      }>
    };
    jsonValidation?: Array<{ fileMatch?: string[] }>;
    keybindings?: Array<{
      command: string;
      key: string;
      win?: string;
      linux?: string;
      mac?: string;
    }>;
    views?: Record<string, Array<{ id: string; name: string; type?: string; icon?: string }>>;
  };
}

test('extension declares the SFTP filesystem activation event', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;

  assert.equal(manifest.version, '1.9.5');
  assert.ok(manifest.activationEvents?.includes('onFileSystem:safs'));
  assert.ok(manifest.activationEvents?.includes('onCommand:safs.switchRemoteDirectory'));
  assert.equal(manifest.activationEvents?.includes('*'), false);
  assert.deepEqual(manifest.extensionKind, ['workspace']);
  assert.equal(
    manifest.contributes?.configuration?.properties?.['safs.terminalAutoReconnect']?.default,
    true
  );
  assert.equal(
    manifest.contributes?.configuration?.properties?.['safs.agentInterface']?.default,
    'mcp'
  );
  assert.deepEqual(
    manifest.contributes?.configuration?.properties?.['safs.agentInterface']?.enum,
    ['mcp', 'cli']
  );
});

test('every SAFS menu item references a contributed command', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest & {
    contributes?: { menus?: Record<string, Array<{ command?: string }>> }
  };
  const commands = new Set(
    (manifest.contributes?.commands ?? []).map((item) => item.command)
  );
  const menuCommands = Object.values(manifest.contributes?.menus ?? {})
    .flat().map((item) => item.command)
    .filter((command): command is string => command?.startsWith('safs.') === true);
  assert.deepEqual(
    menuCommands.filter((command) => !commands.has(command)),
    []
  );
});

test('contributes a remote-directory switch command instead of relying on the local picker', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  const commands = manifest.contributes?.commands ?? [];
  assert.ok(commands.some((item) => item.command === 'safs.switchRemoteDirectory'));
});

test('remote directory commands can select a connection from a local or empty window', async () => {
  const extensionSource = await readFile(new URL('../src/extension.ts', import.meta.url), 'utf8');
  assert.ok(extensionSource.includes('mount = await selectMount(mountPlaceHolder)'));
  assert.ok(extensionSource.includes(
    "selectRemoteDirectory('选择要打开的远程连接')"
  ));
  assert.ok(extensionSource.includes(
    "selectRemoteDirectory('选择要切换的远程连接')"
  ));
});

test('declares every command referenced by a menu contribution', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  const declared = new Set(
    (manifest.contributes?.commands ?? []).map((item) => item.command)
  );
  const referenced = Object.values(manifest.contributes?.menus ?? {})
    .flatMap((items) => items.map((item) => item.command));
  assert.deepEqual(referenced.filter((command) => !declared.has(command)), []);
});

test('uses distinct conflict-resistant shortcuts on each desktop platform', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  const keybindings = manifest.contributes?.keybindings ?? [];
  const openFolder = keybindings.find((item) => item.command === 'safs.openFolder');
  const openTerminal = keybindings.find((item) => item.command === 'safs.openTerminal');

  assert.deepEqual(openFolder, {
    key: 'ctrl+alt+r',
    win: 'ctrl+alt+r',
    linux: 'ctrl+alt+o',
    mac: 'cmd+ctrl+r',
    command: 'safs.openFolder'
  });
  assert.deepEqual(openTerminal, {
    key: 'ctrl+alt+t',
    win: 'ctrl+alt+t',
    linux: 'ctrl+alt+x',
    mac: 'cmd+ctrl+t',
    command: 'safs.openTerminal'
  });
  const extensionSource = await readFile(new URL('../src/extension.ts', import.meta.url), 'utf8');
  assert.ok(extensionSource.includes('showRemoteShortcutHintOnce(vscodeContext)'));
  assert.ok(extensionSource.includes("platformStateKey('remoteShortcutHintV1')"));
});

test('shows separate Agent forwarding actions for enabled and disabled mounts', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  const commands = manifest.contributes?.commands ?? [];
  assert.ok(commands.some((item) => item.command === 'safs.enableAiForwardItem'));
  assert.ok(commands.some((item) => item.command === 'safs.disableAiForwardItem'));
  assert.ok(commands.some(
    (item) => item.command === 'safs.copyStreamableHttpUrl'
  ));
  assert.equal(commands.some((item) => item.command === 'safs.toggleAiForwardItem'), false);
  const menu = manifest.contributes?.menus?.['view/item/context'] ?? [];
  assert.ok(menu.some((item) => item.command === 'safs.enableAiForwardItem'
    && item.when?.includes('aiDisabled')));
  assert.ok(menu.some((item) => item.command === 'safs.disableAiForwardItem'
    && item.when?.includes('aiEnabled')));
});

test('packages Agent integration without the legacy JS stdio router or Codex plugin', async () => {
  await access(new URL('../src/agent-http-router.ts', import.meta.url));
  const extensionSource = await readFile(new URL('../src/extension.ts', import.meta.url), 'utf8');
  const nativeCliSource = await readFile(
    new URL('../native-cli/src/main.rs', import.meta.url), 'utf8'
  );
  const vscodeIgnore = await readFile(new URL('../.vscodeignore', import.meta.url), 'utf8');
  assert.equal(extensionSource.includes('mcp-router.cjs'), false);
  assert.equal(extensionSource.includes("'--', 'node'"), false);
  assert.equal(nativeCliSource.includes('mcp-bridge'), false);
  assert.equal(/^bin\/\*\*$/m.test(vscodeIgnore), false);
  for (const executable of [
    'linux-x64/safs', 'linux-arm64/safs', 'darwin-x64/safs', 'darwin-arm64/safs',
    'win32-x64/safs.exe', 'win32-arm64/safs.exe'
  ]) {
    await access(new URL(`../bin/${executable}`, import.meta.url));
  }
  await access(new URL('../skills/safs-cli/SKILL.md', import.meta.url));
  await access(new URL('../skills/safs-cli/references/commands.md', import.meta.url));
  await assert.rejects(access(new URL(
    '../plugins/safs/.codex-plugin/plugin.json', import.meta.url
  )));
});

test('Agent integration installs the bundled CLI Skill without probing Agent installations', async () => {
  const extensionSource = await readFile(new URL('../src/extension.ts', import.meta.url), 'utf8');
  const nativeCliSource = await readFile(new URL('../src/native-cli.ts', import.meta.url), 'utf8');
  assert.ok(nativeCliSource.includes('globalNativeCliSkill'));
  assert.ok(extensionSource.includes("args: ['install', '--skills', '-g']"));
  assert.equal(extensionSource.includes('nativeCliUsagePrompt'), false);
  assert.equal(extensionSource.includes('cliInstructions('), false);
  assert.ok(extensionSource.includes('installGlobalCli(context'));
  assert.ok(extensionSource.includes("tagged.searchParams.delete('agent')"));
  assert.ok(extensionSource.includes("command('installCli'"));
  assert.ok(extensionSource.includes("if (!cliEnabled())"));
  assert.equal(extensionSource.includes('cliAgentIdentity'), false);
  assert.ok(extensionSource.includes("args: ['--version']"));
  assert.ok(extensionSource.includes('installedVersion !== extensionVersion'));
  assert.equal(extensionSource.includes('configureDetectedAgents'), false);
  assert.equal(extensionSource.includes('recordObservedAgentSource'), false);
  assert.equal(extensionSource.includes('runAgentMcpOperation'), false);
  await assert.rejects(access(new URL('../src/agent-mcp-registry.ts', import.meta.url)));
});

test('contributes the Agent activity Webview in the SAFS sidebar', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  assert.ok(manifest.activationEvents?.includes('onView:safs.agentActivity'));
  assert.deepEqual(
    manifest.contributes?.views?.safs?.find((view) => view.id === 'safs.agentActivity'),
    {
      id: 'safs.agentActivity', name: 'Agent 活动', type: 'webview',
      icon: 'resources/agent-activity.svg'
    }
  );
  const mounts = manifest.contributes?.views?.safs?.find((view) => view.id === 'safs.mounts');
  assert.equal(mounts?.icon, 'resources/remote-ssh.svg');
  assert.notEqual(mounts?.icon, 'resources/agent-activity.svg');
  const activityIcon = await readFile(
    new URL('../resources/agent-activity.svg', import.meta.url), 'utf8'
  );
  assert.ok(activityIcon.includes('M3 13h4l2-5 4 10'));
  assert.equal(activityIcon.includes('M8 2.75 L16 2.75'), false);
  const extensionSource = await readFile(new URL('../src/extension.ts', import.meta.url), 'utf8');
  assert.ok(extensionSource.includes('registerWebviewViewProvider(agentActivityViewId'));
  assert.ok(extensionSource.includes('onDidChangeTerminalShellIntegration'));
  assert.ok(extensionSource.includes('onDidEndTerminalShellExecution'));
  assert.ok(extensionSource.includes('queueAgentCommandTerminalRefresh'));
  assert.ok(extensionSource.includes('工作区已切换，停止使用不匹配的终端'));
});

test('packages session-only remote shell integration scripts', async () => {
  for (const file of [
    'bash.sh', 'fish.fish', 'zsh-env.zsh', 'zsh-profile.zsh', 'zsh-rc.zsh'
  ]) {
    await access(new URL(`../resources/shell-integration/${file}`, import.meta.url));
  }
});

test('SAFS MCP is opt-in for remote context instead of mandatory in every workspace', async () => {
  const direct = await readFile(new URL('../src/agent-mcp.ts', import.meta.url), 'utf8');
  const router = await readFile(new URL('../src/agent-http-router.ts', import.meta.url), 'utf8');
  const tools = await readFile(new URL('../src/agent-mcp-tools.ts', import.meta.url), 'utf8');
  assert.equal(tools.includes('anthropic/alwaysLoad'), false);
  assert.equal(tools.includes('At the start of every conversation'), false);
  assert.equal(tools.includes('Before reading files, editing, searching'), false);
  assert.ok(tools.includes('Do not call SAFS tools for ordinary local workspaces'));
  assert.ok(tools.includes('Use only for explicit SAFS tasks or known safs:// context'));
  assert.ok(tools.includes("'list_remote_workspaces'"));
  assert.ok(direct.includes('registerAgentMcpTools'));
  assert.ok(router.includes('registerAgentMcpTools'));
  assert.equal(direct.includes('safs_list_remote_workspaces'), false);
  assert.equal(router.includes('safs_list_remote_workspaces'), false);
  assert.equal(direct.includes('safs_select_remote_workspace'), false);
  assert.equal(router.includes('safs_select_remote_workspace'), false);
  assert.ok(tools.includes('workspaceId'));
  assert.ok(router.includes('instanceId'));
  assert.equal(router.includes('mustWaitForNewUserRequest: true'), false);
  assert.ok(tools.includes('This tool does not select, switch, or store a current workspace'));
  const extension = await readFile(new URL('../src/extension.ts', import.meta.url), 'utf8');
  assert.equal(extension.includes('vscode.lm.registerTool'), false);
  assert.equal(extension.includes("'safs_listRemoteFiles'"), false);
  assert.equal(extension.includes("'safs_runRemoteCommand'"), false);
  assert.match(extension, /prepareOpenedTerminalForAgent\(/);
  assert.match(extension, /const mountName = location\?\.mountName \?\? terminalInfo\?\.mount\.name/);
  assert.ok(direct.includes('currentFile(input)'));
  assert.equal(direct.includes('resolve_workspace_execution'), false);
  assert.equal(router.includes('resolve_workspace_execution'), false);
});

test('shows when this window is the Agent forwarding focus', async () => {
  const extensionSource = await readFile(new URL('../src/extension.ts', import.meta.url), 'utf8');
  assert.ok(extensionSource.includes(
    '$(sparkle) Agent 已聚焦当前窗口😏'
  ));
  assert.ok(extensionSource.includes(
    '$(sparkle) ${source}远程转发中💪'
  ));
  // 悬停说明路由关系；同步镜像窗口注明改动与远程双向同步。
  assert.ok(extensionSource.includes('本窗口的远程连接干活'));
  assert.ok(extensionSource.includes('改动与远程双向同步'));
  assert.ok(extensionSource.includes('isSyncMirrorWindow()'));
  assert.equal(extensionSource.includes('选择 Agent 所在平台'), false);
  assert.equal(extensionSource.includes('askAgentNameAndPlatform'), false);
  assert.ok(extensionSource.includes('updateSafsStatusBar(vscode.window.state.focused)'));
  assert.ok(extensionSource.includes('if (agentName) focusedAgentSource'));
  assert.ok(extensionSource.includes(
    'updateSafsStatusBar(vscode.window.state.focused, agentName)'
  ));
  assert.ok(extensionSource.includes("'safs.agentForwardingFocus'"));
  assert.ok(extensionSource.includes('vscode.StatusBarAlignment.Left, 10_000'));
  // SAFS SFTP 入口与转发焦点提示分项显示（与 SAFS SYNC 一致），互不顶替。
  assert.ok(extensionSource.includes("'safs.sftpEntry'"));
  assert.ok(extensionSource.includes("'$(remote) SAFS SCP'"));
  assert.ok(extensionSource.includes("'$(remote) SAFS SFTP'"));
  assert.ok(extensionSource.includes('forwardingFocusStatusBar.show()'));
  assert.ok(extensionSource.includes('forwardingFocusStatusBar.hide()'));
  // 服务器无 SFTP 子系统回退 SCP/exec 时，入口显示为 SAFS SCP 并即时刷新。
  assert.ok(extensionSource.includes('refreshSafsEntryLabel()'));
  // 连接状态变化事件即时刷新入口文案（重连换通道、空闲回收后懒重连）。
  assert.match(extensionSource, /refreshTree\(\);\r?\n      refreshSafsEntryLabel\(\)/);
});

test('uses only the unified cross-platform config path', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  assert.equal(
    manifest.contributes?.configuration?.properties?.['safs.configPath'],
    undefined
  );
  const extensionSource = await readFile(new URL('../src/extension.ts', import.meta.url), 'utf8');
  assert.equal(extensionSource.includes("inspect<string>('configPath')"), false);
  assert.ok(extensionSource.includes("const defaultConfigPath = '~/.safs/config.json'"));
  assert.equal(
    manifest.contributes?.configuration?.properties?.['safs.agentForwardingAgents'],
    undefined
  );
  assert.equal(
    manifest.contributes?.configuration?.properties?.['safs.agentPlatform'],
    undefined
  );
  assert.equal(
    manifest.contributes?.configuration?.properties?.['safs.agentHttpRouterPort']
      ?.default,
    9848
  );
  assert.equal(
    manifest.contributes?.configuration?.properties?.['safs.agentMcpTimeoutMs']
      ?.default,
    120000
  );
  const matches = manifest.contributes?.jsonValidation?.flatMap((item) => item.fileMatch ?? []);
  assert.deepEqual(matches, ['**/.safs/config.json']);
});

test('installs forwarding only for the globally first enabled mount or an explicit command', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  const commands = manifest.contributes?.commands ?? [];
  const install = commands.find((item) => item.command === 'safs.installAgentForwarding');
  const uninstall = commands.find((item) => item.command === 'safs.uninstallAgentForwarding');
  const installCli = commands.find((item) => item.command === 'safs.installCli');
  assert.equal(install?.title, 'SAFS: 为我的Agent安装转发功能');
  assert.equal(uninstall?.title, 'SAFS: 为我的Agent卸载转发功能');
  assert.equal(installCli?.title, 'SAFS: 安装或更新全局 CLI');
  assert.ok(manifest.activationEvents?.includes('onCommand:safs.installAgentForwarding'));
  assert.ok(manifest.activationEvents?.includes('onCommand:safs.uninstallAgentForwarding'));
  assert.ok(manifest.activationEvents?.includes('onCommand:safs.installCli'));
  const extensionSource = await readFile(new URL('../src/extension.ts', import.meta.url), 'utf8');
  assert.ok(extensionSource.includes("command('installAgentForwarding'"));
  assert.equal(extensionSource.includes('.installAgentForwarding`'), false);
  assert.ok(extensionSource.includes(
    'await installAgentForwardingIntegration(vscodeContext, cliExecutable)'
  ));
  assert.ok(extensionSource.includes('enabledValue && enabled.size === 0'));
  assert.ok(extensionSource.includes('if (!shouldInstallIntegration)'));
  assert.ok(extensionSource.includes('let aiForwardUpdate: Promise<void>'));
  assert.ok(extensionSource.includes('if (!changed) return'));
  assert.ok(extensionSource.includes("command('uninstallAgentForwarding'"));
  assert.ok(extensionSource.includes('await uninstallGlobalCli(context)'));
  assert.ok(extensionSource.includes("args: ['install', '--skills', '-g']"));
  assert.ok(extensionSource.includes('streamableHttpMcpUninstallPrompt()'));
  assert.ok(extensionSource.includes('卸载提示词'));
  assert.ok(extensionSource.includes('streamableHttpMcpInstallPrompt'));
  assert.equal(extensionSource.includes('legacyAgentInterfaceMigrationTarget'), false);
  assert.ok(extensionSource.includes('scheduleFirstProxyEnvironmentCheck(context)'));
  assert.ok(extensionSource.includes('检测到代理环境变量，且 NO_PROXY 未完整覆盖本机地址，可能影响 Agent 本机转发连接。'));
  const nativeCliSource = await readFile(new URL('../src/native-cli.ts', import.meta.url), 'utf8');
  assert.ok(nativeCliSource.includes('user-level Streamable HTTP MCP'));
  assert.equal(nativeCliSource.includes('switch the proxy to rule-based mode'), false);
});

test('runs CLI cleanup after the extension is completely uninstalled', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  );
  assert.equal(manifest.scripts?.['vscode:uninstall'], 'node ./scripts/uninstall.js');
});

test('declares host key change action setting', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  const property = manifest.contributes?.configuration?.properties?.[
    'safs.hostKeyChangedAction'
  ] as { type?: string; enum?: string[]; default?: unknown } | undefined;
  assert.equal(property?.type, 'string');
  assert.deepEqual(property?.enum, ['prompt', 'reject', 'accept']);
  assert.equal(property?.default, 'prompt');
});

test('handles high-risk Agent commands without per-command prompts', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  const property = manifest.contributes?.configuration?.properties?.[
    'safs.highRiskCommandAction'
  ] as { type?: string; enum?: string[]; default?: unknown } | undefined;
  assert.equal(property?.type, 'string');
  assert.deepEqual(property?.enum, ['deny', 'allow']);
  assert.equal(property?.default, 'deny');

  const extensionSource = await readFile(new URL('../src/extension.ts', import.meta.url), 'utf8');
  const policySource = await readFile(
    new URL('../src/mcp-command-policy.ts', import.meta.url), 'utf8'
  );
  assert.equal(extensionSource.includes('SAFS：确认高风险远程 Shell 操作'), false);
  assert.equal(extensionSource.includes('允许本次执行'), false);
  assert.ok(policySource.includes("configuredAction === 'allow' ? 'allow' : 'deny'"));
  assert.ok(extensionSource.includes('evaluateMcpCommandPolicy'));
});

test('manifest high-risk defaults are generated from the runtime rule set', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  assert.deepEqual(
    manifest.contributes?.configuration?.properties?.['safs.highRiskCommandPatterns']?.default,
    defaultHighRiskCommandPatterns
  );
});

test('declares the visual download command and the two sync directions', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  const commands = manifest.contributes?.commands ?? [];
  const download = commands.find((item) => item.command === 'safs.visualDownload');
  const sync = commands.find((item) => item.command === 'safs.syncToLocal');
  const reverse = commands.find((item) => item.command === 'safs.syncToRemote');
  assert.equal(download?.title, 'SAFS：可视化下载');
  assert.equal(sync?.title, 'SAFS：同步到本地');
  assert.equal(reverse?.title, 'SAFS：同步到远程');
  const explorerMenu = manifest.contributes?.menus?.['explorer/context'] ?? [];
  assert.equal(
    explorerMenu.some((item) => item.command === 'safs.visualDownload'),
    true
  );
});

test('declares the visual upload command on local file/folder context menus', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  const commands = manifest.contributes?.commands ?? [];
  const upload = commands.find((item) => item.command === 'safs.visualUpload');
  assert.equal(upload?.title, 'SAFS：可视化上传');
  const explorerMenu = manifest.contributes?.menus?.['explorer/context'] ?? [];
  const entry = explorerMenu.find((item) => item.command === 'safs.visualUpload');
  assert.equal(entry?.when, 'resourceScheme == file');
});

test('declares the two sync directions on the matching context menus', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  const explorerMenu = manifest.contributes?.menus?.['explorer/context'] ?? [];
  const remote = explorerMenu.find(
    (item) => item.command === 'safs.syncToLocal'
  );
  const local = explorerMenu.find((item) => item.command === 'safs.syncToRemote');
  assert.equal(remote?.when, 'resourceScheme == safs');
  assert.equal(local?.when, 'resourceScheme == file && explorerResourceIsFolder');
});

test('both sync directions transfer first and register the pair afterwards', async () => {
  const extensionSource = await readFile(
    new URL('../src/extension.ts', import.meta.url), 'utf8'
  );
  const bodyOf = (name: string): string => {
    const start = extensionSource.indexOf(`async function ${name}(`);
    assert.notEqual(start, -1, `missing ${name}`);
    return extensionSource.slice(start, extensionSource.indexOf('\nasync function ', start + 10));
  };
  // 同步到远程 = 先可视化上传（整棵上传到 <所选目录>/<本地目录名>），
  // 再以上传后的远程状态为基线开始双向同步。
  const toRemote = bodyOf('syncLocalTreeToRemote');
  assert.ok(toRemote.includes('visualUpload([vscode.Uri.file(localDir)], mountName, parentDir)'));
  assert.ok(toRemote.includes('scanRemote(session, remotePath)'));
  assert.ok(toRemote.includes('fingerprintLines'));
  // 同步到本地保留"先整棵下载"的首次基线（远端为准），随后建立双向同步。
  const toLocal = bodyOf('syncToLocal');
  assert.ok(toLocal.includes('confirmInitialSyncTarget('));
  assert.ok(toLocal.includes('startSyncMirror(manager'));
  // 两条路径都只有同步成功才写历史列表与配对表。
  const mirror = bodyOf('startSyncMirror');
  assert.ok(mirror.includes('recordDirectoryHistory(vscodeContext, task.mountName, task.remotePath)'));
  assert.ok(mirror.includes('recordSyncedDirectory(vscodeContext'));
  assert.ok(mirror.indexOf('if (!await startRemoteSyncWithProgress(manager, task)) return false;')
    < mirror.indexOf('recordDirectoryHistory('));
});

test('repeating a sync for the same directory prompts instead of transferring again', async () => {
  const extensionSource = await readFile(
    new URL('../src/extension.ts', import.meta.url), 'utf8'
  );
  const start = extensionSource.indexOf('async function promptRepeatSync(');
  assert.notEqual(start, -1);
  const prompt = extensionSource.slice(
    start, extensionSource.indexOf('\nasync function ', start + 10)
  );
  assert.ok(prompt.includes('该目录已在历史列表中，同步过一次了'));
  assert.ok(prompt.includes("'打开副本', '重新同步'"));
  // 两个方向都要先查配对表，命中即弹窗，不再直接搬运。
  for (const entry of ['async function syncToLocal(', 'async function syncToRemote(']) {
    const index = extensionSource.indexOf(entry);
    assert.notEqual(index, -1, `missing ${entry}`);
    const body = extensionSource.slice(index, extensionSource.indexOf('\nasync function ', index + 10));
    assert.ok(body.includes('promptRepeatSync('), `${entry} should prompt on repeat`);
  }
  // 删除历史条目同时忘掉配对，之后是全新一次同步。
  assert.ok(extensionSource.includes('removeSyncedDirectory(vscodeContext, item.mountName, item.path)'));
});

test('history sync buttons read 启动同步 when the directory is not syncing', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  const commands = manifest.contributes?.commands ?? [];
  const enable = commands.find((item) => item.command === 'safs.enableHistorySync');
  const disable = commands.find((item) => item.command === 'safs.disableHistorySync');
  assert.equal(enable?.title, '启动同步');
  assert.equal(disable?.title, '关闭本地同步');
});

test('host items carry a delete button and every item can open the config', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  const itemMenu = manifest.contributes?.menus?.['view/item/context'] ?? [];
  const commands = manifest.contributes?.commands ?? [];
  const hostCondition = 'view == safs.mounts && safs.hierarchicalView && viewItem =~ /safs\\.host/';
  // 主机节点的删除按钮就在行内（挨着 ＋ / 重命名），靠确认弹窗兜底。
  const hostDelete = itemMenu.find(
    (item) => item.command === 'safs.deleteHostGroup' && item.when === hostCondition
  );
  assert.equal(hostDelete?.group, 'inline@6');
  assert.equal(
    commands.find((item) => item.command === 'safs.deleteHostGroup')?.title,
    '删除主机的全部账号'
  );
  // 账号/挂载项原本就命中 safs.connection，主机项靠上面新增的一条补齐。
  assert.equal(
    itemMenu.some(
      (item) => item.command === 'safs.deleteConfigItem'
        && item.when?.includes('viewItem =~ /safs\\.connection/')
    ),
    true
  );
  const openConfig = itemMenu.find((item) => item.command === 'safs.openConfig');
  assert.equal(openConfig?.when, 'view == safs.mounts && viewItem =~ /safs\\./');
});

test('generates config names as host(account) and migrates the old ones', async () => {
  const extensionSource = await readFile(
    new URL('../src/extension.ts', import.meta.url), 'utf8'
  );
  // 两条命名路径：保存账号时立即生成，启动/配置变更时归一化旧名字。
  assert.ok(extensionSource.includes(
    'const generatedName = mountNameFor({ ...host, user: normalizedUser }, config.host_aliases);'
  ));
  assert.ok(extensionSource.includes('const baseName = mountNameFor(host, config.host_aliases);'));
  // 改名后把已打开窗口的工作区 URI（左下角指示器）也换成新名字。
  assert.ok(extensionSource.includes('await guard(refreshRemoteWorkspaceNames)'));
  assert.ok(extensionSource.includes('vscode.workspace.updateWorkspaceFolders(index, 1, {'));
  // 改名后要跟着迁移的持久状态。
  const start = extensionSource.indexOf('async function normalizeHierarchicalConfigNames(');
  assert.notEqual(start, -1);
  const body = extensionSource.slice(
    start, extensionSource.indexOf('\nclass RemoteFoldersProvider', start)
  );
  for (const store of [
    'directoryHistoryKey', 'aiForwardMountsKey', 'syncTasksKey', 'syncedDirectoriesKey'
  ]) {
    assert.ok(body.includes(store), `rename migration should cover ${store}`);
  }
  // 改名后已保存的 safs:// URI 仍能打开：启动时装载映射并注入解析器。
  assert.ok(extensionSource.includes('async function rememberMountAliases('));
  assert.ok(extensionSource.includes('setMountAliasResolver((mountName) => {'));
  assert.ok(extensionSource.includes('return mountRenames.get(mountName) ?? mountName;'));
  assert.ok(body.includes('rememberMountRenames(renamed)'));
  // 改名之前保存的 URI：按历史命名回推候选旧名。
  assert.ok(extensionSource.includes('await guard(registerMountAliases)'));
  assert.ok(extensionSource.includes('addAlias(mountAuthorityAlias(host.name), host.name);'));
  assert.ok(extensionSource.includes('addAlias(mountAuthorityAlias(host.name), host.name);'));
  assert.ok(extensionSource.includes('mountAliasCandidates(host, config.host_aliases)'));
  assert.ok(extensionSource.includes('mountAliasCandidates(host, config.host_aliases)'));
});

test('renames survive activation running before the registry and pool exist', async () => {
  const extensionSource = await readFile(
    new URL('../src/extension.ts', import.meta.url), 'utf8'
  );
  // activate 在创建 registry / pool 之前就归一化旧配置名（历史命名迁移），所以这一步
  // 必须容忍两者尚未初始化：否则 `undefined.rename` 会被守卫捕成弹窗，并中断整段迁移。
  const start = extensionSource.indexOf('async function applyMountRenames(');
  assert.notEqual(start, -1);
  const body = extensionSource.slice(start, extensionSource.indexOf('\n}', start));
  assert.ok(body.includes('registry?.rename(from, to);'));
  assert.ok(body.includes('pool?.rename(from, to);'));
  // 迁移确实早于 registry / pool 的创建，这就是上面必须容错的原因。
  const activateStart = extensionSource.indexOf('export async function activate(');
  assert.notEqual(activateStart, -1);
  const normalizeAt = extensionSource.indexOf(
    'await guard(() => normalizeHierarchicalConfigNames(context));', activateStart
  );
  const registryAt = extensionSource.indexOf('registry = new RemoteFolderRegistry();', activateStart);
  assert.notEqual(normalizeAt, -1);
  assert.notEqual(registryAt, -1);
  assert.ok(normalizeAt < registryAt, 'rename migration still runs before the registry exists');
});

test('every delete button confirms first', async () => {
  const extensionSource = await readFile(
    new URL('../src/extension.ts', import.meta.url), 'utf8'
  );
  // 主机分组删除 / 账号挂载删除 / 历史记录删除，都要先弹确认框。
  assert.ok(extensionSource.includes('确定删除主机"${group.displayName}"的'));
  assert.ok(extensionSource.includes('确定删除"${mount.name}"配置吗？'));
  assert.ok(extensionSource.includes('确定删除历史记录"${item.path}"吗？'));
  // 同步中的历史条目删掉后没法再停，所以一并停同步。
  assert.ok(extensionSource.includes('if (syncing) await stopSync(item.mountName, item.path);'));
  assert.equal(
    extensionSource.includes("command('deleteHistoryItem', async (item: HistoryItem) => {\n    await removeHistoryEntry"),
    false
  );
});

test('打开配置 locates the selected tree item, and deleting a host removes all its accounts', async () => {
  const extensionSource = await readFile(
    new URL('../src/extension.ts', import.meta.url), 'utf8'
  );
  // 命令实参形状不一（树元素/元素数组/显式目标/无参），必须先判形再定位。
  assert.ok(extensionSource.includes('configFocusForArgument(argument)'));
  assert.ok(extensionSource.includes('Array.isArray(argument) ? argument[0] : argument'));
  assert.ok(extensionSource.includes('configFocusForElement(mountsTreeView?.selection[0])'));
  assert.ok(extensionSource.includes('configEntryOffset(content, focus.name)'));
  assert.ok(extensionSource.includes('vscode.window.createTreeView(`${commandPrefix}.mounts`'));
  // 主机节点的 ＋ 只追加账号，不再覆盖单账号主机。
  assert.ok(extensionSource.includes('accountTargetIndex(config, requestedGroup'));
  assert.equal(extensionSource.includes('groupHosts.length === 1'), false);
  assert.ok(extensionSource.includes('更新已有账号'));
  // 删除配置后要清场：停同步任务、清历史目录与本地副本配对。
  assert.ok(extensionSource.includes('async function forgetMountState('));
  assert.ok(extensionSource.includes('await forgetMountState([mount.name]);'));
  assert.ok(extensionSource.includes('await forgetMountState(hostNames);'));
  // 主机分组删除：整组账号 + 各自的挂载配置。
  const start = extensionSource.indexOf('async function deleteHostGroup(');
  assert.notEqual(start, -1);
  const body = extensionSource.slice(start, extensionSource.indexOf('\nasync function ', start + 10));
  assert.ok(body.includes('for (const name of hostNames)'));
  // 账号/挂载的删除只删自己那条，不再有"主机分组删整组"的分支。
  assert.equal(extensionSource.includes("element.type === 'hostGroup') {\n    await deleteHostGroup"), false);
  assert.ok(extensionSource.includes("command('deleteHostGroup', async (group) => {"));
  assert.ok(body.includes('removeMountConfig(config, name)'));
  assert.ok(body.includes('hostNames.filter((name) => enabled.delete(name))'));
});
