import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, lstatSync, unlinkSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';

const maxRecordAgeMs = 35_000;
const cleanupGraceMs = 5 * 60_000;

/** Clean only this runtime's directory; discovery may also read another OS's files. */
export function cleanupAgentWorkspaceRecords(directory = agentDiscoveryDirectory(), now = Date.now()): void {
  let names: string[];
  try { names = readdirSync(directory); } catch { return; }
  for (const name of names) {
    if (!/^[\w-]+\.json(?:\.tmp)?$/.test(name)) continue;
    const file = path.join(directory, name);
    try {
      const before = lstatSync(file);
      if (!before.isFile() || now - before.mtimeMs <= cleanupGraceMs) continue;
      let record: Partial<AgentWorkspaceRecord> | undefined;
      try { record = JSON.parse(readFileSync(file, 'utf8')); } catch { /* Abandoned partial write. */ }
      if (record?.processPlatform && record.processPlatform !== process.platform) continue;
      if (record && Number.isInteger(record.processId) && record.processId! > 0) {
        try { process.kill(record.processId!, 0); continue; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
      }
      const updated = Date.parse(record?.updatedAt ?? '');
      if (Number.isFinite(updated) && now - updated <= cleanupGraceMs) continue;
      const current = lstatSync(file);
      if (current.ino !== before.ino || current.mtimeMs !== before.mtimeMs || current.size !== before.size) continue;
      unlinkSync(file);
    } catch { /* A publisher or another cleaner may have replaced/removed the file. */ }
  }
}

export interface AgentWorkspaceRecord {
  version: 2 | 3 | 4;
  instanceId: string;
  processId: number;
  processPlatform?: NodeJS.Platform;
  focused: boolean;
  execution: 'remote';
  workspaceUri: string;
  mountName: string;
  workspaceRoot: string;
  localRoot?: string;
  /** This window currently exposes only command execution in its selected visible terminal. */
  terminalCommandOnly?: true;
  host: string;
  hostName?: string;
  user?: string;
  backendSocketPath?: string;
  backendToken?: string;
  mcpUrl?: string;
  agentInterface?: 'cli' | 'mcp';
  updatedAt: string;
}

export function agentDiscoveryDirectory(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, '.safs', 'agent_discovery');
}

function windowsPathToWsl(value: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(value.trim());
  if (!match) return value.trim();
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
}

export function agentDiscoveryDirectories(): string[] {
  const homes = new Set([os.homedir(), process.env.USERPROFILE].filter(
    (value): value is string => Boolean(value)
  ));
  if (process.platform === 'linux' && /microsoft|wsl/i.test(os.release())) {
    try {
      const windowsHome = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', "[Environment]::GetFolderPath('UserProfile')"],
        { encoding: 'utf8', timeout: 2000, windowsHide: true }
      );
      homes.add(windowsPathToWsl(windowsHome));
    } catch {
      // Native WSL-only installations publish under the WSL home.
    }
  }
  return [...homes].map(agentDiscoveryDirectory);
}

export interface DiscoveredAgentWorkspace extends AgentWorkspaceRecord {
  discoveryFile: string;
  updatedAtMs: number;
}

export function readAgentWorkspaceRecord(
  filePath: string, now = Date.now()
): DiscoveredAgentWorkspace | undefined {
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<AgentWorkspaceRecord> & {
      /** 1.5.5 及更早发现记录的短期兼容字段。 */
      remoteRoot?: string;
    };
    if (!value.workspaceRoot && value.remoteRoot) value.workspaceRoot = value.remoteRoot;
    const updatedAtMs = Date.parse(value.updatedAt ?? '');
    if (![2, 3, 4].includes(value.version as number) || value.execution !== 'remote'
      || (value.version === 2 && (!value.backendSocketPath || !value.backendToken))
      || (value.version === 3 && !value.mcpUrl)
      || (value.version === 4 && ((value.agentInterface === 'cli' && (!value.backendSocketPath || !value.backendToken))
        || (value.agentInterface === 'mcp' && !value.mcpUrl)))
      || !value.instanceId || !value.mountName || !value.workspaceRoot || !Number.isFinite(updatedAtMs)
      || Math.abs(now - updatedAtMs) > maxRecordAgeMs) {
      return undefined;
    }
    if (value.processPlatform && value.processPlatform !== process.platform) return undefined;
    if (!Number.isInteger(value.processId) || value.processId! <= 0) return undefined;
    const samePlatform = value.processPlatform
      ? value.processPlatform === process.platform
      : !(process.platform === 'linux' && /^\/mnt\/[a-z]\//i.test(filePath));
    try { if (samePlatform) process.kill(value.processId!, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return undefined;
    }
    return { ...value, updatedAtMs, discoveryFile: filePath } as DiscoveredAgentWorkspace;
  } catch {
    return undefined;
  }
}

export function discoverAgentWorkspaces(
  directories = agentDiscoveryDirectories(), now = Date.now()
): DiscoveredAgentWorkspace[] {
  cleanupAgentWorkspaceRecords();
  const records: DiscoveredAgentWorkspace[] = [];
  for (const directory of directories) {
    try {
      for (const name of readdirSync(directory)) {
        if (!name.endsWith('.json')) continue;
        const record = readAgentWorkspaceRecord(path.join(directory, name), now);
        if (record) records.push(record);
      }
    } catch {
      // A missing discovery directory means no active remote window there.
    }
  }
  records.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  return records;
}

export class AgentWorkspacePublisher {
  private readonly filePath: string;
  private stopped = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly instanceId: string,
    private readonly directory = agentDiscoveryDirectory()
  ) {
    this.filePath = path.join(directory, `${instanceId}.json`);
  }

  publish(record: Omit<AgentWorkspaceRecord, 'version' | 'instanceId' | 'processId' | 'processPlatform' | 'updatedAt'>): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const next = this.pending.then(async () => {
      if (this.stopped) return;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const value: AgentWorkspaceRecord = {
        version: record.agentInterface ? 4 : record.mcpUrl ? 3 : 2,
        instanceId: this.instanceId,
        processId: process.pid,
        processPlatform: process.platform,
        ...record,
        updatedAt: new Date().toISOString()
      };
      const temporaryPath = `${this.filePath}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
          encoding: 'utf8', mode: 0o600
        });
        await rename(temporaryPath, this.filePath);
      } finally {
        await rm(temporaryPath, { force: true });
      }
    });
    this.pending = next.catch(() => {});
    return next;
  }

  remove(): Promise<void> {
    const next = this.pending.then(() => rm(this.filePath, { force: true }));
    this.pending = next.catch(() => {});
    return next;
  }

  /** Closing a window permanently prevents in-flight heartbeats from republishing it. */
  stop(): Promise<void> {
    this.stopped = true;
    return this.remove();
  }
}
