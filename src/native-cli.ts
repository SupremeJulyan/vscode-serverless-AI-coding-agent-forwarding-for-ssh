import * as path from 'node:path';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { CommandPlan } from './platform';

export type NativeCliPlatform =
  | 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64'
  | 'win32-x64' | 'win32-arm64';

export function nativeCliPlatform(
  host: NodeJS.Platform, arch: string
): NativeCliPlatform {
  const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : undefined;
  if (!cpu) throw new Error(`SAFS CLI 不支持 CPU 架构：${arch}`);
  const os = host === 'linux' ? 'linux'
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

export function streamableHttpMcpInstallPrompt(url: string): string {
  return [
    `Install a user-level Streamable HTTP MCP server named "safs" with this URL: ${url}`,
    'After installation, tell me to restart the Agent.'
  ].join('\n');
}

export function nativeCliUsagePrompt(): string {
  return [
    'Create or replace exactly one block delimited by `<!-- SAFS CLI BEGIN -->` and `<!-- SAFS CLI END -->` in your user-level global persistent instructions, not in the current conversation or project instructions. Preserve every unrelated instruction and do not append a duplicate block. If you do not support user-level global persistent instructions, tell me explicitly.',
    '<!-- SAFS CLI BEGIN -->',
    'For tasks where the user explicitly asks to use SAFS for a remote environment: `safs` is an installed global CLI. Start by running `safs bind --agent "<your Agent name>"`, reuse the returned `--binding` in every later command, and consult `safs --help` for syntax. Use structured SAFS commands for every remote file operation; never use local filesystem tools or `safs exec` to read, list, search, write, edit, move, delete, change permissions, upload, or download remote files. Reserve `safs exec` for task commands such as builds and tests.',
    '<!-- SAFS CLI END -->',
    'When finished, tell me where you saved the block.'
  ].join('\n');
}

export function nativeCliUninstallPrompt(): string {
  return 'Remove the single block delimited by `<!-- SAFS CLI BEGIN -->` and `<!-- SAFS CLI END -->` from your user-level global persistent instructions. Remove only that SAFS block, preserve every unrelated instruction, and tell me which file or setting you changed. If the block does not exist, tell me without changing anything else.';
}

export function streamableHttpMcpUninstallPrompt(): string {
  return [
    'Uninstall the user-level MCP server named "safs" that you previously installed. Remove only that MCP entry and do not change any other configuration or Agent.',
    'When finished, tell me it was removed, then tell me to restart the Agent and start a new conversation to confirm that SAFS tools are no longer loaded.'
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
