import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { redactSensitiveText } from '../security/redact';

export interface BackendCommandLogEntry {
  source: string;
  /** URL 中由 CLI 注册方声明的来源标签，仅用于日志/诊断。 */
  agentName?: string;
  mountName: string;
  remoteCwd: string;
  command: string;
}

export interface BackendToolLogEntry {
  toolName: string;
  agentName?: string;
  input?: Record<string, unknown>;
}

export function backendLogDirectory(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, '.safs', 'backend_logs');
}

export function backendLogFilePath(
  directory = backendLogDirectory(), now = new Date()
): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return path.join(directory, `backend-${year}-${month}-${day}.log`);
}

export function formatBackendCommandLogLine(
  entry: BackendCommandLogEntry, now = new Date()
): string {
  const agent = entry.agentName?.trim().slice(0, 100)
    .replace(/[\]\r\n\t]/g, '_');
  // Persist the command for auditability, but redact common credentials first.
  // JSON encoding keeps multiline commands and control characters on one log line.
  const command = JSON.stringify(redactSensitiveText(entry.command));
  const commandBytes = Buffer.byteLength(entry.command, 'utf8');
  const commandSha256 = createHash('sha256').update(entry.command).digest('hex');
  return `${now.toISOString()} [${entry.source}]${agent ? ` [agent=${agent}]` : ''} [mount=${entry.mountName}] [cwd=${entry.remoteCwd}] command=${command} command_bytes=${commandBytes} command_sha256=${commandSha256}`;
}

export async function appendBackendCommandLog(
  entry: BackendCommandLogEntry,
  directory = backendLogDirectory(),
  now = new Date()
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filePath = backendLogFilePath(directory, now);
  await appendFile(filePath, `${formatBackendCommandLogLine(entry, now)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  return filePath;
}

function safeToolInput(toolName: string, input: Record<string, unknown> = {}): string {
  const summary: Record<string, unknown> = {};
  for (const key of [
    'mountName', 'host', 'workspaceRoot', 'path', 'sourcePath', 'targetPath',
    'remoteDirectory', 'remotePath', 'localPath', 'mode', 'type', 'limit', 'offset', 'length',
    'recursive', 'overwrite', 'query', 'remoteCwd'
  ]) {
    const value = input[key];
    if (typeof value === 'string') summary[key] = redactSensitiveText(value).slice(0, 500);
    else if (typeof value === 'number' || typeof value === 'boolean') summary[key] = value;
  }
  if ((toolName === 'remote_write' || toolName === 'remote_create')
      && typeof input.content === 'string') {
    summary.contentBytes = Buffer.byteLength(input.content, 'utf8');
  }
  if (toolName === 'remote_edit' && Array.isArray(input.edits)) {
    summary.editCount = input.edits.length;
    const expectedHash = input.expectedHash;
    if (typeof expectedHash === 'string' && /^[0-9a-f]{64}$/i.test(expectedHash)) {
      summary.expectedHash = expectedHash.toLowerCase();
    }
  }
  if (toolName === 'remote_upload' && Array.isArray(input.localPaths)) {
    summary.localPaths = input.localPaths.slice(0, 20).flatMap((value) =>
      typeof value === 'string' ? [redactSensitiveText(value).slice(0, 500)] : []
    );
  }
  if (toolName === 'run_remote_command' && typeof input.command === 'string') {
    summary.commandBytes = Buffer.byteLength(input.command, 'utf8');
  }
  return JSON.stringify(summary);
}

export function formatBackendToolLogLine(entry: BackendToolLogEntry, now = new Date()): string {
  const agent = entry.agentName?.trim().slice(0, 100).replace(/[\]\r\n\t]/g, '_');
  const tool = entry.toolName.trim().replace(/[^a-z0-9_.-]/gi, '_').slice(0, 100);
  return `${now.toISOString()} [tool=${tool || 'unknown'}]${agent ? ` [agent=${agent}]` : ' [agent=unknown]'} args=${safeToolInput(tool, entry.input)}`;
}

export async function appendBackendToolLog(
  entry: BackendToolLogEntry, directory = backendLogDirectory(), now = new Date()
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filePath = backendLogFilePath(directory, now);
  await appendFile(filePath, `${formatBackendToolLogLine(entry, now)}\n`, {
    encoding: 'utf8', mode: 0o600
  });
  return filePath;
}
