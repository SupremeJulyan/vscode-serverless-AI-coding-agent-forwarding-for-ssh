import { randomUUID } from 'node:crypto';
import { redactSensitiveText } from './redact';

export type AgentActivitySource = 'mcp' | 'cli';
export type AgentActivityStatus = 'running' | 'success' | 'error' | 'interrupted';
export type AgentActivityCategory = 'read' | 'write' | 'command' | 'transfer';

export interface AgentActivitySummary {
  [key: string]: string | number | boolean | string[] | undefined;
}

export interface AgentActivityEvent {
  version: 1;
  id: string;
  source: AgentActivitySource;
  agentName: string;
  agentPlatform?: string;
  toolName: string;
  category: AgentActivityCategory;
  status: AgentActivityStatus;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  mountName: string;
  workspaceRoot: string;
  summary: AgentActivitySummary;
  error?: string;
}

export interface AgentActivityStart {
  source: AgentActivitySource;
  agentName?: string;
  agentPlatform?: string;
  toolName: string;
  input?: Record<string, unknown>;
  mountName: string;
  workspaceRoot: string;
}

export interface ActivityMemento {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

export const agentActivityLimit = 200;
export const agentActivityStorageKey = 'safs.agentActivity.v1';

const writeTools = new Set([
  'remote_edit', 'remote_write', 'remote_delete', 'remote_chmod', 'remote_move'
]);
const transferTools = new Set(['remote_upload', 'remote_download']);

export function agentActivityCategory(toolName: string): AgentActivityCategory {
  if (toolName === 'run_remote_command') return 'command';
  if (transferTools.has(toolName)) return 'transfer';
  if (writeTools.has(toolName)) return 'write';
  return 'read';
}

export function isAgentActivityImportant(event: AgentActivityEvent): boolean {
  return event.status === 'error' || event.status === 'interrupted'
    || event.category !== 'read';
}

function safeText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const redacted = redactSensitiveText(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  return redacted.length > limit ? `${redacted.slice(0, limit)}…` : redacted;
}

function safeStringList(value: unknown, limit = 16): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.slice(0, limit).flatMap((item) => {
    const text = safeText(item, 500);
    return text === undefined ? [] : [text];
  });
  return items.length ? items : undefined;
}

function put(
  summary: AgentActivitySummary, key: string,
  value: string | number | boolean | string[] | undefined
): void {
  if (value !== undefined) summary[key] = value;
}

/** Build the only tool-input representation allowed into persistence or Webviews. */
export function summarizeAgentActivityInput(
  toolName: string, input: Record<string, unknown> = {}
): AgentActivitySummary {
  const summary: AgentActivitySummary = {};
  for (const key of ['path', 'sourcePath', 'targetPath', 'remoteDirectory', 'remotePath', 'localPath', 'remoteCwd']) {
    put(summary, key, safeText(input[key], 500));
  }
  put(summary, 'paths', safeStringList(input.paths));
  put(summary, 'localPaths', safeStringList(input.localPaths));
  if (Array.isArray(input.localPaths)) summary.localPathCount = input.localPaths.length;
  for (const key of ['recursive', 'overwrite', 'fixedStrings', 'ignoreCase']) {
    if (typeof input[key] === 'boolean') summary[key] = input[key] as boolean;
  }
  for (const key of ['offset', 'length', 'head', 'tail', 'startLine', 'lineCount', 'limit', 'contextLines']) {
    if (typeof input[key] === 'number' && Number.isFinite(input[key])) {
      summary[key] = input[key] as number;
    }
  }
  put(summary, 'mode', safeText(input.mode, 32));
  if (toolName === 'remote_search') put(summary, 'query', safeText(input.query, 240));
  if (toolName === 'run_remote_command') put(summary, 'command', safeText(input.command, 500));
  if (toolName === 'remote_write' && typeof input.content === 'string') {
    summary.contentBytes = Buffer.byteLength(input.content, 'utf8');
  }
  if (toolName === 'remote_edit' && Array.isArray(input.edits)) {
    summary.editCount = input.edits.length;
  }
  if (toolName === 'remote_read_many' && Array.isArray(input.requests)) {
    summary.requestCount = input.requests.length;
    const paths = input.requests.slice(0, 16).flatMap((request) => {
      if (!request || typeof request !== 'object' || Array.isArray(request)) return [];
      const value = safeText((request as Record<string, unknown>).path, 500);
      return value === undefined ? [] : [value];
    });
    if (paths.length) summary.paths = paths;
  }
  return summary;
}

/** Extract non-content result metadata only. */
export function summarizeAgentActivityResult(result: unknown): AgentActivitySummary {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return {};
  const value = result as Record<string, unknown>;
  const summary: AgentActivitySummary = {};
  for (const key of [
    'exitCode', 'size', 'completed', 'discovered', 'bytes', 'matchCount',
    'completedFiles', 'discoveredFiles', 'discoveredDirectories'
  ]) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key])) summary[key] = value[key] as number;
    else if (typeof value[key] === 'boolean') summary[key] = value[key] as boolean;
  }
  for (const key of ['truncated', 'retentionTruncated']) {
    if (typeof value[key] === 'boolean') summary[key] = value[key] as boolean;
  }
  put(summary, 'resultStatus', safeText(value.status, 80));
  return summary;
}

function validEvent(value: unknown): value is AgentActivityEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Partial<AgentActivityEvent>;
  return event.version === 1 && typeof event.id === 'string'
    && (event.source === 'mcp' || event.source === 'cli')
    && typeof event.agentName === 'string' && typeof event.toolName === 'string'
    && ['read', 'write', 'command', 'transfer'].includes(event.category ?? '')
    && ['running', 'success', 'error', 'interrupted'].includes(event.status ?? '')
    && typeof event.startedAt === 'string' && Number.isFinite(Date.parse(event.startedAt))
    && typeof event.mountName === 'string' && typeof event.workspaceRoot === 'string'
    && !!event.summary && typeof event.summary === 'object' && !Array.isArray(event.summary);
}

export class AgentActivityStore {
  private events: AgentActivityEvent[] = [];
  private listeners = new Set<(events: readonly AgentActivityEvent[]) => void>();
  private persistTimer: NodeJS.Timeout | undefined;
  private persistPromise: Promise<void> = Promise.resolve();

  constructor(
    private readonly state: ActivityMemento,
    private readonly key = agentActivityStorageKey,
    private readonly now: () => Date = () => new Date()
  ) {}

  async initialize(): Promise<void> {
    const stored = this.state.get<unknown[]>(this.key, []);
    const now = this.now();
    let changed = false;
    this.events = stored.filter(validEvent).slice(-agentActivityLimit).map((event) => {
      const cloned = { ...event, summary: { ...event.summary } };
      if (cloned.status !== 'running') return cloned;
      changed = true;
      cloned.status = 'interrupted';
      cloned.completedAt = now.toISOString();
      cloned.durationMs = Math.max(0, now.getTime() - Date.parse(cloned.startedAt));
      cloned.error = 'VS Code 窗口在操作完成前已关闭或重载';
      return cloned;
    });
    if (changed || this.events.length !== stored.length) await this.persistNow();
    this.emit();
  }

  snapshot(): readonly AgentActivityEvent[] {
    return this.events.map((event) => ({ ...event, summary: { ...event.summary } }));
  }

  onDidChange(listener: (events: readonly AgentActivityEvent[]) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  start(input: AgentActivityStart): string {
    const event: AgentActivityEvent = {
      version: 1,
      id: randomUUID(),
      source: input.source,
      agentName: safeText(input.agentName, 100)?.trim() || 'Unknown Agent',
      agentPlatform: safeText(input.agentPlatform, 16),
      toolName: input.toolName.replace(/[^a-z0-9_.-]/gi, '_').slice(0, 100) || 'unknown',
      category: agentActivityCategory(input.toolName),
      status: 'running',
      startedAt: this.now().toISOString(),
      mountName: safeText(input.mountName, 200) ?? '',
      workspaceRoot: safeText(input.workspaceRoot, 1000) ?? '',
      summary: summarizeAgentActivityInput(input.toolName, input.input)
    };
    this.events.push(event);
    if (this.events.length > agentActivityLimit) {
      this.events.splice(0, this.events.length - agentActivityLimit);
    }
    this.changed();
    return event.id;
  }

  succeed(id: string, result: unknown): void {
    this.finish(id, 'success', result);
  }

  fail(id: string, error: unknown): void {
    this.finish(id, 'error', undefined, error);
  }

  private finish(
    id: string, status: 'success' | 'error', result?: unknown, error?: unknown
  ): void {
    const event = this.events.find((candidate) => candidate.id === id);
    if (!event || event.status !== 'running') return;
    const completed = this.now();
    event.status = status;
    event.completedAt = completed.toISOString();
    event.durationMs = Math.max(0, completed.getTime() - Date.parse(event.startedAt));
    event.summary = { ...event.summary, ...summarizeAgentActivityResult(result) };
    if (status === 'error') {
      const detail = error instanceof Error ? error.message : String(error ?? 'Remote operation failed');
      event.error = safeText(detail, 500) || 'Remote operation failed';
    }
    this.changed();
  }

  async clear(): Promise<void> {
    this.events = [];
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    this.emit();
    await this.persistNow();
  }

  async flush(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    await this.persistNow();
  }

  dispose(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    this.listeners.clear();
  }

  private changed(): void {
    this.emit();
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persistNow().catch(() => undefined);
    }, 250);
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private async persistNow(): Promise<void> {
    const snapshot = this.snapshot();
    this.persistPromise = this.persistPromise.catch(() => undefined).then(async () => {
      await this.state.update(this.key, snapshot);
    });
    await this.persistPromise;
  }
}
