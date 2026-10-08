import * as path from 'node:path';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { CommandPlan } from './platform';

export type NodeCliPlatform =
  | 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64'
  | 'win32-x64' | 'win32-arm64';

export function nodeCliPlatform(
  host: NodeJS.Platform, arch: string
): NodeCliPlatform {
  const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : undefined;
  if (!cpu) throw new Error(`SAFS CLI 不支持 CPU 架构：${arch}`);
  const os = host === 'linux' ? 'linux'
    : host === 'darwin' ? 'darwin' : host === 'win32' ? 'win32' : undefined;
  if (!os) throw new Error(`SAFS CLI 不支持操作系统：${host}`);
  return `${os}-${cpu}` as NodeCliPlatform;
}

/** Parse the stable `safs --version` output without accepting unrelated numbers. */
export function parseNodeCliVersion(output: string): string | undefined {
  return /^safs\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/m.exec(output)?.[1];
}

export function globalNodeCli(home: string, platform: NodeCliPlatform): string {
  return platform.startsWith('win32-')
    ? path.join(home, 'AppData', 'Local', 'SAFS', 'bin', 'safs.cmd')
    : path.join(home, '.local', 'bin', 'safs');
}

export function nodeCliConnectionPath(executable: string): string {
  return path.join(path.dirname(executable), '.safs-connection.json');
}

export function streamableHttpMcpInstallPrompt(url: string): string {
  return [
    `Install a user-level Streamable HTTP MCP server named "safs" with this URL: ${url}`,
    'After installation, tell me to restart the Agent.'
  ].join('\n');
}

export type NodeCliSkillTarget = 'agents' | 'claude' | 'codex' | 'copilot';

export function globalNodeCliSkill(
  home: string, target: NodeCliSkillTarget = 'agents'
): string {
  const directory = target === 'copilot' ? '.copilot' : `.${target}`;
  return path.join(home, directory, 'skills', 'safs-cli');
}

export async function removeGlobalNodeCliSkill(
  home: string, target: NodeCliSkillTarget = 'agents'
): Promise<string> {
  const directory = globalNodeCliSkill(home, target);
  await rm(directory, { recursive: true, force: true });
  return directory;
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

/** Install the bundled Node.js CLI without downloading platform binaries. */
export async function installNodeCli(
  home: string, platform: NodeCliPlatform, version: string,
  source: string
): Promise<string> {
  const destination = globalNodeCli(home, platform);
  const directory = path.dirname(destination);
  const content = await readFile(source, 'utf8');
  if (!content.startsWith('#!/usr/bin/env node') || !content.includes(version)) {
    throw new Error('打包的 Node.js CLI 无效或版本不一致');
  }
  await mkdir(directory, { recursive: true });
  const payload = platform.startsWith('win32-') ? path.join(directory, 'safs-cli.js') : destination;
  const temporary = `${payload}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o755, flag: 'wx' });
    await rename(temporary, payload);
  } finally { await rm(temporary, { force: true }); }
  if (platform.startsWith('win32-')) {
    await writeFile(destination, '@echo off\r\nnode "%~dp0safs-cli.js" %*\r\n', 'utf8');
    await rm(path.join(directory, 'safs.exe'), { force: true });
  } else { await chmod(destination, 0o755); }
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

/** Remove the global CLI, all supported global Skills, and Unix PATH entries. */
export async function removeNodeCli(
  home: string, platform: NodeCliPlatform
): Promise<string> {
  const executable = globalNodeCli(home, platform);
  await Promise.all([
    rm(executable, { force: true }),
    rm(path.join(path.dirname(executable), 'safs-cli.js'), { force: true }),
    ...(platform.startsWith('win32-') ? [rm(path.join(path.dirname(executable), 'safs.exe'), { force: true })] : []),
    rm(nodeCliConnectionPath(executable), { force: true }),
    ...(['agents', 'claude', 'codex', 'copilot'] as const).map((target) =>
      rm(globalNodeCliSkill(home, target), { recursive: true, force: true })
    ),
    ...(!platform.startsWith('win32-') ? [
      removeUnixProfilePath(path.join(home, '.profile')),
      removeUnixProfilePath(path.join(home, '.zprofile'))
    ] : [])
  ]);
  return executable;
}
