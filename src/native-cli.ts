import * as path from 'node:path';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
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

export function globalNativeCli(home: string, platform: NativeCliPlatform): string {
  return platform.startsWith('win32-')
    ? path.join(home, 'AppData', 'Local', 'SAFS', 'bin', 'safs.exe')
    : path.join(home, '.local', 'bin', 'safs');
}

export function nativeCliConnectionPath(executable: string): string {
  return path.join(path.dirname(executable), '.safs-connection.json');
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

/** Copy out of the immutable extension bundle and return a stable absolute path. */
export async function installNativeCli(
  extensionRoot: string, home: string, platform: NativeCliPlatform,
  hostPlatform: NodeJS.Platform = process.platform
): Promise<string> {
  const source = bundledNativeCli(extensionRoot, platform);
  const destination = globalNativeCli(home, platform);
  const destinationDirectory = path.dirname(destination);
  await mkdir(destinationDirectory, { recursive: true });
  await copyFile(source, destination);
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

export async function ensureUnixCliPath(home: string): Promise<void> {
  // POSIX login shells read .profile, while macOS and many Linux zsh setups
  // read .zprofile instead. Keep both entry points consistent so a newly
  // opened terminal can resolve the user-level global command.
  await ensureUnixProfilePath(path.join(home, '.profile'));
  await ensureUnixProfilePath(path.join(home, '.zprofile'));
}
