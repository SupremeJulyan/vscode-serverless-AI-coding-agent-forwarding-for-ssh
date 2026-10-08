import * as path from 'node:path';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { CommandPlan } from './platform';

export class NodeRuntimeUnavailableError extends Error {
  constructor() {
    super('未检测到可用的 Node.js 18 或以上版本。请安装或升级 Node.js，并重启 VS Code，插件会自动安装 CLI。');
    this.name = 'NodeRuntimeUnavailableError';
  }
}

export async function requireNodeRuntime(
  probe: () => Promise<{ exitCode: number; stdout: string }>
): Promise<void> {
  const result = await probe().catch(() => undefined);
  if (!result || result.exitCode !== 0 || Number(/^v(\d+)\.\d+\.\d+\s*$/.exec(result.stdout.trim())?.[1] ?? 0) < 18) {
    throw new NodeRuntimeUnavailableError();
  }
}

export type NodeCliPlatform = NodeJS.Platform;

/** Parse the stable `safs --version` output without accepting unrelated numbers. */
export function parseNodeCliVersion(output: string): string | undefined {
  return /^safs\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/m.exec(output)?.[1];
}

export function globalNodeCli(home: string, platform: NodeCliPlatform): string {
  return platform === 'win32'
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

const windowsCliLauncher = '@echo off\r\nnode "%~dp0safs-cli.js" %*\r\n';

/** Verify payload and launcher, including legacy executables that shadow .cmd. */
export async function nodeCliMatchesBundle(
  executable: string, platform: NodeCliPlatform, source: string
): Promise<boolean> {
  try {
    const directory = path.dirname(executable);
    const payload = platform === 'win32' ? path.join(directory, 'safs-cli.js') : executable;
    const [installed, bundled] = await Promise.all([readFile(payload), readFile(source)]);
    if (!installed.equals(bundled)) return false;
    if (platform === 'win32') {
      if (await readFile(executable, 'utf8') !== windowsCliLauncher) return false;
      if (await lstat(path.join(directory, 'safs.exe')).then(() => true, () => false)) return false;
    }
    return true;
  } catch { return false; }
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
  const payload = platform === 'win32' ? path.join(directory, 'safs-cli.js') : destination;
  const temporary = `${payload}.${randomBytes(6).toString('hex')}.tmp`;
  const launcherTemporary = `${destination}.${randomBytes(6).toString('hex')}.tmp`;
  if (platform === 'win32') {
    const existing = await lstat(destination).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return undefined;
    });
    if (existing && !existing.isFile()) throw new Error('SAFS CLI 启动入口不是普通文件');
  }
  try {
    await writeFile(temporary, content, { mode: 0o755, flag: 'wx' });
    if (platform === 'win32') await writeFile(launcherTemporary, windowsCliLauncher, { flag: 'wx' });
    await rename(temporary, payload);
    if (platform === 'win32') {
      await rename(launcherTemporary, destination);
      await rm(path.join(directory, 'safs.exe'), { force: true });
    } else { await chmod(destination, 0o755); }
  } finally {
    await Promise.all([rm(temporary, { force: true }), rm(launcherTemporary, { force: true })]);
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

/** Remove the global CLI, all supported global Skills, and Unix PATH entries. */
export async function removeNodeCli(
  home: string, platform: NodeCliPlatform
): Promise<string> {
  const executable = globalNodeCli(home, platform);
  await Promise.all([
    rm(executable, { force: true }),
    rm(path.join(path.dirname(executable), 'safs-cli.js'), { force: true }),
    ...(platform === 'win32' ? [rm(path.join(path.dirname(executable), 'safs.exe'), { force: true })] : []),
    rm(nodeCliConnectionPath(executable), { force: true }),
    ...(['agents', 'claude', 'codex', 'copilot'] as const).map((target) =>
      rm(globalNodeCliSkill(home, target), { recursive: true, force: true })
    ),
    ...(platform !== 'win32' ? [
      removeUnixProfilePath(path.join(home, '.profile')),
      removeUnixProfilePath(path.join(home, '.zprofile'))
    ] : [])
  ]);
  return executable;
}
