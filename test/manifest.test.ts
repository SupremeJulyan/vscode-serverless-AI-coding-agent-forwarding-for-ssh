import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { directAgentMcpInstructions, routedAgentMcpInstructions } from '../src/mcp/agent-mcp-tools';
import { defaultHighRiskCommandPatterns } from '../src/security/high-risk-commands';

interface ExtensionManifest {
  version: string;
  activationEvents?: string[];
  extensionKind?: string[];
  contributes?: {
    commands?: Array<{ command: string; title: string; category?: string }>;
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
    views?: Record<string, Array<{
      id: string; name: string; type?: string; icon?: string; contextualTitle?: string;
      visibility?: string;
    }>>;
  };
}

test('extension declares the SFTP filesystem activation event', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;

  assert.ok(manifest.activationEvents?.includes('onFileSystem:safs'));
  assert.ok(manifest.activationEvents?.includes('onCommand:safs.switchRemoteDirectory'));
  assert.equal(manifest.activationEvents?.includes('*'), false);
  assert.deepEqual(manifest.extensionKind, ['workspace']);
  assert.equal(
    manifest.contributes?.configuration?.properties?.['safs.terminalAutoReconnect']?.default,
    true
  );
  const settings = manifest.contributes?.configuration?.properties ?? {};
  for (const name of ['agentInterface', 'agentMcpToolProfile', 'agentMcpTimeoutMs', 'agentMcpPort', 'agentHttpRouterPort']) {
    assert.equal(Object.hasOwn(settings, `safs.${name}`), false);
  }
});

test('bundled Node CLI reports the extension release version', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  const output = execFileSync(process.execPath, ['dist/safs-cli.js', '--version'], { encoding: 'utf8' });
  assert.equal(output.trim(), `safs ${manifest.version}`);
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

test('contributes SAFS navigation and filename search to remote explorer menus', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  assert.ok(manifest.activationEvents?.includes('onCommand:safs.searchRemoteDirectory'));
  assert.ok(manifest.contributes?.commands?.some(
    (item) => item.command === 'safs.searchRemoteDirectory'
  ));
  const explorer = manifest.contributes?.menus?.['explorer/context'] ?? [];
  for (const command of [
    'safs.openFolder', 'safs.switchRemoteDirectory', 'safs.openTerminal'
  ]) {
    assert.ok(explorer.some((item) => item.command === command
      && item.when === 'resourceScheme == safs'));
  }
  assert.ok(explorer.some((item) => item.command === 'safs.searchRemoteDirectory'
    && item.when === 'resourceScheme == safs && explorerResourceIsFolder'));
});

test('declares the add-host configuration command', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  assert.equal(
    manifest.contributes?.commands?.find(item => item.command === 'safs.addRemoteDirectory')?.title,
    '新增主机配置'
  );
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
});

test('shows a restart action for automatic Agent forwarding', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  const commands = manifest.contributes?.commands ?? [];
  assert.ok(commands.some((item) => item.command === 'safs.restartAgentForwardItem'));
  assert.equal(commands.some((item) => item.command === 'safs.enableAiForwardItem'), false);
  assert.equal(commands.some((item) => item.command === 'safs.disableAiForwardItem'), false);
  const menu = manifest.contributes?.menus?.['view/item/context'] ?? [];
  assert.ok(menu.some((item) => item.command === 'safs.restartAgentForwardItem'
    && item.when?.includes('safs\\.connection')));
});

test('the VSIX file list includes the CLI, Skill and shell integration resources', () => {
  const files = execFileSync(process.execPath, [
    'node_modules/@vscode/vsce/vsce', 'ls', '--no-dependencies'
  ], { encoding: 'utf8' }).split(/\r?\n/).map(file => file.replaceAll('\\', '/'));
  for (const required of [
    'dist/extension.js',
    'dist/safs-cli.js',
    'skills/safs-cli/SKILL.md',
    'skills/safs-cli/references/commands.md',
    ...['bash.sh', 'fish.fish', 'zsh-env.zsh', 'zsh-profile.zsh', 'zsh-rc.zsh']
      .map(file => `resources/shell-integration/${file}`)
  ]) {
    assert.ok(files.includes(required), `Missing from VSIX: ${required}`);
  }
  assert.deepEqual(files.filter(file => /^(?:bin\/|plugins\/safs\/)|(?:backend-router|backend-bridge)\.cjs$/.test(file)), []);
});

test('the bundled CLI rejects the retired Skill installation command', () => {
  const result = spawnSync(process.execPath, ['dist/safs-cli.js', 'install', '--skills', '-g'], {
    encoding: 'utf8'
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command/);
});

test('Git webview hosts its controls without duplicate native tree actions', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as ExtensionManifest;
  for (const items of Object.values(manifest.contributes?.menus ?? {})) {
    assert.equal(items.some(item => item.when?.includes('safs.gitChanges') || item.when?.includes('safs.gitHistory')), false);
  }
});

test('git commands keep short titles and group under the SAFS Git category', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  const git = (manifest.contributes?.commands ?? []).filter(item => item.command.startsWith('safs.git.'));
  // 面板按钮/菜单只显示 title，命令面板用 category 补前缀，所以标题里不再重复 "SAFS Git"。
  assert.deepEqual(git.map(item => [item.command, item.category, item.title]), [
    ['safs.git.checkoutBranch', 'SAFS Git', '切换到此分支'],
    ['safs.git.init', 'SAFS Git', '初始化远程仓库'],
    ['safs.git.refresh', 'SAFS Git', '刷新'],
    ['safs.git.branch', 'SAFS Git', '分支'],
    ['safs.git.switchBranch', 'SAFS Git', '切换分支'],
    ['safs.git.createBranch', 'SAFS Git', '创建分支'],
    ['safs.git.stage', 'SAFS Git', '暂存'],
    ['safs.git.unstage', 'SAFS Git', '取消暂存'],
    ['safs.git.discard', 'SAFS Git', '还原更改'],
    ['safs.git.commit', 'SAFS Git', '提交'],
    ['safs.git.fetch', 'SAFS Git', '提取 (Fetch)'],
    ['safs.git.pull', 'SAFS Git', '拉取 (Pull)（仅快进）'],
    ['safs.git.push', 'SAFS Git', '推送'],
    ['safs.git.refreshHistory', 'SAFS Git', '刷新历史'],
    ['safs.git.copyCommitId', 'SAFS Git', '复制提交 ID']
  ]);
});

test('contributes the unified Git webview only to Source Control', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as ExtensionManifest;
  assert.deepEqual(manifest.contributes?.views?.scm, [{id:'safs.gitHistory',name:'SAFS Git',type:'webview',contextualTitle:'SAFS Git',visibility:'visible',icon:'resources/git-branch.svg'}]);
  assert.equal(manifest.contributes?.views?.safs?.some(view => view.id === 'safs.gitHistory' || view.id === 'safs.gitChanges'), false);
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
});

test('MCP instructions restrict remote tools to SAFS tasks and require explicit routing', () => {
  for (const instructions of [directAgentMcpInstructions, routedAgentMcpInstructions]) {
    assert.match(instructions, /Do not call SAFS tools for ordinary local workspaces/);
    assert.match(instructions, /explicit SAFS tasks or known safs:\/\/ context/);
  }
  assert.match(routedAgentMcpInstructions, /explicitly chosen workspaceId/);
  assert.match(routedAgentMcpInstructions, /never fall back to another window/);
});

test('uses only the unified cross-platform config path', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  assert.equal(
    manifest.contributes?.configuration?.properties?.['safs.configPath'],
    undefined
  );
  assert.equal(
    manifest.contributes?.configuration?.properties?.['safs.agentForwardingAgents'],
    undefined
  );
  assert.equal(
    manifest.contributes?.configuration?.properties?.['safs.agentPlatform'],
    undefined
  );
  assert.equal(
    manifest.contributes?.configuration?.properties?.['safs.agentBackendTimeoutMs']
      ?.default,
    120000
  );
  const matches = manifest.contributes?.jsonValidation?.flatMap((item) => item.fileMatch ?? []);
  assert.deepEqual(matches, ['**/.safs/config.json']);
});

test('contributes Agent forwarding installation and uninstall commands', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as ExtensionManifest;
  const commands = manifest.contributes?.commands ?? [];
  for (const name of ['installAgentForwarding', 'uninstallAgentForwarding']) {
    assert.ok(commands.some(item => item.command === `safs.${name}`));
    assert.ok(manifest.activationEvents?.includes(`onCommand:safs.${name}`));
  }
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

test('declares the supported high-risk command policies', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as ExtensionManifest;
  const property = manifest.contributes?.configuration?.properties?.[
    'safs.highRiskCommandAction'
  ] as { type?: string; enum?: string[]; default?: unknown } | undefined;
  assert.equal(property?.type, 'string');
  assert.deepEqual(property?.enum, ['deny', 'allow']);
  assert.equal(property?.default, 'deny');
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
  const local = explorerMenu.find((item) => item.command === 'safs.visualSync');
  const command = manifest.contributes?.commands?.find((item) => item.command === 'safs.visualSync');
  assert.equal(command?.title, 'SAFS：可视化同步');
  assert.equal(explorerMenu.some((item) => item.command === 'safs.syncToRemote'), false);
  assert.equal(remote?.when, 'resourceScheme == safs');
  assert.equal(local?.when, 'resourceScheme == file && explorerResourceIsFolder');
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

test('host items offer inline host configuration and omit redundant context actions', async () => {
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
  assert.equal(itemMenu.some(item => item.command === 'safs.openConfig'), false);
  assert.equal(itemMenu.some(item => item.command === 'safs.editHostCredentials'), false);
  const openHost = itemMenu.find(item => item.command === 'safs.openHostConfig');
  assert.equal(openHost?.group, 'inline@5');
  assert.equal(commands.find(item => item.command === 'safs.openHostConfig')?.title, '打开主机配置');
});
