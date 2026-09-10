import * as path from 'node:path';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { CommandPlan } from './platform';

export type NativeCliPlatform =
  | 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64'
  | 'win32-x64' | 'win32-arm64';

export function nativeCliPlatform(
  host: NodeJS.Platform, arch: string, agentInWsl = false
): NativeCliPlatform {
  const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : undefined;
  if (!cpu) throw new Error(`SAFS CLI 不支持 CPU 架构：${arch}`);
  const os = agentInWsl || host === 'linux' ? 'linux'
    : host === 'darwin' ? 'darwin' : host === 'win32' ? 'win32' : undefined;
  if (!os) throw new Error(`SAFS CLI 不支持操作系统：${host}`);
  return `${os}-${cpu}` as NativeCliPlatform;
}

export function bundledNativeCli(extensionRoot: string, platform: NativeCliPlatform): string {
  return path.join(extensionRoot, 'bin', platform, platform.startsWith('win32-') ? 'safs.exe' : 'safs');
}

/** Parse the stable `safs --version` output without accepting unrelated numbers. */
export function parseNativeCliVersion(output: string): string | undefined {
  return /^safs\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/m.exec(output)?.[1];
}

function validateNativeCli(content: Uint8Array, platform: NativeCliPlatform): void {
  if (content.byteLength < 100 * 1024 || content.byteLength > 10 * 1024 * 1024) {
    throw new Error(`插件内置的 SAFS CLI 大小异常：${content.byteLength} 字节`);
  }
  const expected = platform.startsWith('win32-') ? '4d5a'
    : platform.startsWith('darwin-') ? 'cffaedfe' : '7f454c46';
  const actual = Buffer.from(content.subarray(0, expected.length / 2)).toString('hex');
  if (actual !== expected) throw new Error(`插件内置的 SAFS CLI 文件格式与 ${platform} 不符`);
}

export function globalNativeCli(home: string, platform: NativeCliPlatform): string {
  return platform.startsWith('win32-')
    ? path.join(home, 'AppData', 'Local', 'SAFS', 'bin', 'safs.exe')
    : path.join(home, '.local', 'bin', 'safs');
}

export function nativeCliConnectionPath(executable: string): string {
  return path.join(path.dirname(executable), '.safs-connection.json');
}

export function nativeMcpBridgeInstallPrompt(
  executable: string, agentName: string, platform: 'wsl' | 'mac' | 'linux' | 'win'
): string {
  // The WSL install lives in the WSL user's ~/.local/bin. Its Windows-visible
  // UNC path cannot be executed by a Linux Agent, so use the PATH entry that
  // ensureUnixCliPath installs and takes effect after the requested restart.
  const command = platform === 'wsl' ? 'safs' : executable;
  const args = ['mcp-bridge', '--agent', agentName, '--platform', platform];
  return [
    '请为自己安装名为 safs 的用户级 MCP 服务器；如果已存在同名条目，请将其替换为下面的配置。传输类型使用 stdio（不要使用 Streamable HTTP）：',
    `command: ${JSON.stringify(command)}`,
    `args: ${JSON.stringify(args)}`,
    '只执行 MCP 配置安装，不要运行或探测其他 Agent。完成后提醒我重启并新建对话生效。'
  ].join('\n');
}

/**
 * Build the PowerShell invocation that adds the installed CLI directory to the
 * user's PATH. Windows PowerShell treats arguments following `-Command` as
 * more command text in some invocation modes, so pass the directory through
 * the child environment instead of appending it after the script.
 */
export function windowsUserPathUpdatePlan(binDirectory: string): CommandPlan {
  const variable = 'SAFS_CLI_BIN_DIRECTORY';
  const script = [
    `$dir=$env:${variable}`,
    "if([string]::IsNullOrWhiteSpace($dir)){throw 'Missing SAFS CLI bin directory'}",
    "$value=[Environment]::GetEnvironmentVariable('Path','User')",
    "$parts=if($value){$value -split ';'}else{@()}",
    "if($parts -notcontains $dir){[Environment]::SetEnvironmentVariable('Path',(($parts+$dir)-join ';'),'User')}"
  ].join(';');
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', script],
    env: { [variable]: binDirectory }
  };
}

export function windowsUserPathRemovePlan(binDirectory: string): CommandPlan {
  const variable = 'SAFS_CLI_BIN_DIRECTORY';
  const script = [
    `$dir=$env:${variable}`,
    "$value=[Environment]::GetEnvironmentVariable('Path','User')",
    "$target=$dir.TrimEnd('\\')",
    "$parts=if($value){@($value -split ';' | Where-Object { $_ -and $_.Trim().TrimEnd('\\') -ine $target })}else{@()}",
    "$next=$parts -join ';'",
    "if($next -ne $value){[Environment]::SetEnvironmentVariable('Path',$next,'User')}"
  ].join(';');
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', script],
    env: { [variable]: binDirectory }
  };
}

/** Atomically install the matching CLI carried inside the extension package. */
export async function installNativeCli(
  extensionRoot: string, home: string, platform: NativeCliPlatform,
  hostPlatform: NodeJS.Platform = process.platform
): Promise<string> {
  const source = bundledNativeCli(extensionRoot, platform);
  const destination = globalNativeCli(home, platform);
  const destinationDirectory = path.dirname(destination);
  await mkdir(destinationDirectory, { recursive: true });
  const temporary = path.join(
    destinationDirectory, `.safs-install-${process.pid}-${randomBytes(6).toString('hex')}`
  );
  try {
    const content = await readFile(source).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`插件包内缺少 ${platform} SAFS CLI：${detail}`);
    });
    validateNativeCli(content, platform);
    await writeFile(temporary, content, {
      mode: 0o700, flag: 'wx'
    });
    // POSIX rename replaces atomically. Windows cannot replace an existing
    // executable with rename, so remove the old installed copy first.
    if (hostPlatform === 'win32') await rm(destination, { force: true });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  // A Windows extension host installing into WSL addresses the destination via
  // UNC. Node's chmod on that path can fail even though chmod inside WSL works;
  // the caller applies the mode through wsl.exe after the copy.
  if (!platform.startsWith('win32-') && hostPlatform !== 'win32') {
    await chmod(destination, 0o755);
  }
  return destination;
}

const pathBegin = '# SAFS CLI PATH BEGIN';
const pathEnd = '# SAFS CLI PATH END';

async function ensureUnixProfilePath(profile: string): Promise<void> {
  let previous = '';
  try { previous = await readFile(profile, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const start = previous.indexOf(pathBegin), finish = previous.indexOf(pathEnd);
  if ((start < 0) !== (finish < 0) || (start >= 0 && finish < start)) {
    throw new Error(`Malformed SAFS PATH block: ${profile}`);
  }
  const unrelated = start < 0 ? previous
    : previous.slice(0, start) + previous.slice(finish + pathEnd.length).replace(/^\n/, '');
  const block = `${pathBegin}\nexport PATH="$HOME/.local/bin:$PATH"\n${pathEnd}\n`;
  const next = `${unrelated}${unrelated && !unrelated.endsWith('\n') ? '\n' : ''}${block}`;
  if (next !== previous) await writeFile(profile, next, { mode: 0o600 });
}

export function withoutSafsPathBlock(content: string): string {
  const pattern = new RegExp(
    `(?:^|\\n)${pathBegin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\n`
    + `[\\s\\S]*?\\r?\\n${pathEnd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\r?\\n|$)`,
    'g'
  );
  return content.replace(pattern, (match) => match.startsWith('\n') ? '\n' : '');
}

async function removeUnixProfilePath(profile: string): Promise<void> {
  let previous = '';
  try { previous = await readFile(profile, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const next = withoutSafsPathBlock(previous);
  if (next !== previous) await writeFile(profile, next, { mode: 0o600 });
}

export async function ensureUnixCliPath(home: string): Promise<void> {
  // POSIX login shells read .profile, while macOS and many Linux zsh setups
  // read .zprofile instead. Keep both entry points consistent so a newly
  // opened terminal can resolve the user-level global command.
  await ensureUnixProfilePath(path.join(home, '.profile'));
  await ensureUnixProfilePath(path.join(home, '.zprofile'));
}

/** Remove the global CLI files and Unix login-shell PATH entries. */
export async function removeNativeCli(
  home: string, platform: NativeCliPlatform
): Promise<string> {
  const executable = globalNativeCli(home, platform);
  await Promise.all([
    rm(executable, { force: true }),
    rm(nativeCliConnectionPath(executable), { force: true }),
    ...(!platform.startsWith('win32-') ? [
      removeUnixProfilePath(path.join(home, '.profile')),
      removeUnixProfilePath(path.join(home, '.zprofile'))
    ] : [])
  ]);
  return executable;
}
