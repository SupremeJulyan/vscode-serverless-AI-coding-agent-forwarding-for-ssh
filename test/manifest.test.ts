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
    menus?: Record<string, Array<{ command: string; when?: string }>>;
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

  assert.equal(manifest.version, '1.8.3');
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
    ['mcp', 'hybrid', 'cli']
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
  await assert.rejects(access(new URL(
    '../plugins/safs/.codex-plugin/plugin.json', import.meta.url
  )));
});

test('Agent integration uses copied prompts instead of probing Agent installations', async () => {
  const extensionSource = await readFile(new URL('../src/extension.ts', import.meta.url), 'utf8');
  const nativeCliSource = await readFile(new URL('../src/native-cli.ts', import.meta.url), 'utf8');
  assert.ok(nativeCliSource.includes('`safs --help`'));
  assert.ok(extensionSource.includes('nativeCliUsagePrompt'));
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
  assert.ok(tools.includes("'get_remote_workspace'"));
  assert.ok(tools.includes("'switch_remote_workspace'"));
  assert.ok(direct.includes('registerAgentMcpTools'));
  assert.ok(router.includes('registerAgentMcpTools'));
  assert.equal(direct.includes('safs_list_remote_workspaces'), false);
  assert.equal(router.includes('safs_list_remote_workspaces'), false);
  assert.equal(direct.includes('safs_select_remote_workspace'), false);
  assert.equal(router.includes('safs_select_remote_workspace'), false);
  assert.ok(tools.includes('agentCwd'));
  assert.ok(tools.includes('workspaceId'));
  assert.ok(router.includes('instanceId'));
  assert.ok(tools.includes('userConfirmed: z.literal(true).optional()'));
  assert.ok(tools.includes('Never select in the same turn as asking'));
  assert.ok(router.includes('mustWaitForNewUserRequest: true'));
  assert.ok(tools.includes('Use exactly one of two forms'));
  assert.ok(tools.includes('receiving an explicit user choice in a later turn'));
  const extension = await readFile(new URL('../src/extension.ts', import.meta.url), 'utf8');
  assert.ok(extension.includes('callback((options.input ?? {}) as T)'));
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
  assert.ok(extensionSource.includes('refreshTree();\n      refreshSafsEntryLabel()'));
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

test('shows the install prompt only after enabling a parent mount or an explicit command', async () => {
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
  assert.ok(extensionSource.includes('await copyAgentForwardingInstallPrompt(vscodeContext)'));
  assert.ok(extensionSource.includes('if (!changed) return'));
  assert.ok(extensionSource.includes("command('uninstallAgentForwarding'"));
  assert.ok(extensionSource.includes('卸载提示词'));
  assert.ok(extensionSource.includes('streamableHttpMcpInstallPrompt'));
  assert.equal(extensionSource.includes('hybridAgentInstallPrompt'), false);
  assert.equal(extensionSource.includes('agentInterfaceHybridMigrationV1'), false);
  assert.equal(extensionSource.includes('legacyAgentInterfaceMigrationTarget'), false);
  assert.ok(extensionSource.includes('scheduleFirstProxyEnvironmentCheck(context)'));
  assert.ok(extensionSource.includes('NO_PROXY 环境变量绕过 localhost'));
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

test('declares the visual download command and the renamed sync command', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  const commands = manifest.contributes?.commands ?? [];
  const download = commands.find((item) => item.command === 'safs.visualDownload');
  const sync = commands.find((item) => item.command === 'safs.syncToLocal');
  assert.equal(download?.title, 'SAFS：可视化下载');
  assert.equal(sync?.title, 'SAFS：可视化同步');
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
