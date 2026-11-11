import { listDirectories } from '../remote/remote-results';
import { readTextBatch } from '../remote/remote-read-batch';
import { RemoteReadOptions } from '../remote/remote-read';
import { RemoteSearchOptions } from '../remote/remote-search';
import { RemoteOutputStore } from '../remote/remote-output';
import { AgentActivitySource } from './agent-activity';
import { AgentToolProfile } from './agent-operations';

/** Shared use cases behind the independent CLI IPC and MCP HTTP adapters. */
export interface AgentOperationCallbacks<Source extends AgentActivitySource> {
  toolProfile?(): AgentToolProfile;
  listFolders(): Promise<AgentRemoteFolderInfo[]>;
  currentWorkspace(): Promise<AgentRemoteFolderInfo | null>;
  currentFile(input: { mountName?: string }): Promise<unknown>;
  list(input: { mountName?: string; path?: string; limit?: number; cursor?: string }): Promise<unknown>;
  read(input: RemoteReadOptions & { mountName?: string }): Promise<unknown>;
  edit(input: {
    mountName?: string; path: string; edits: Array<{ oldText: string; newText: string }>;
    expectedHash?: string;
  }): Promise<unknown>;
  write(input: { mountName?: string; path: string; content: string }): Promise<unknown>;
  create?(input: { mountName?: string; path: string; type: 'file' | 'directory'; content?: string }): Promise<unknown>;
  delete(input: { mountName?: string; path: string; recursive?: boolean }): Promise<unknown>;
  chmod(input: { mountName?: string; path: string; mode: string }): Promise<unknown>;
  move(input: { mountName?: string; sourcePath: string; targetPath: string; overwrite?: boolean }): Promise<unknown>;
  upload(input: { mountName?: string; localPaths: string[]; remoteDirectory: string }): Promise<unknown>;
  download(input: { mountName?: string; remotePath: string; localPath: string }): Promise<unknown>;
  search(input: RemoteSearchOptions & { mountName?: string; agentName?: string }): Promise<unknown>;
  run(input: { command: string; mountName?: string; remoteCwd?: string; agentName?: string }): Promise<unknown>;
  runTerminal?(input: {
    command: string; mountName?: string; agentName?: string; source?: Source;
  }): Promise<unknown>;
  request?(agentName?: string): void;
  audit?(entry: { toolName: string; input: Record<string, unknown>; agentName?: string }): void;
  activity?: {
    start(entry: {
      source: Source; toolName: string; input: Record<string, unknown>; agentName?: string;
    }): string | undefined;
    succeed(id: string, result: unknown): void;
    fail(id: string, error: unknown): void;
  };
  log?(message: string): void;
}

export interface AgentRemoteFolderInfo {
  name: string;
  workspaceUri: string;
  workspaceRoot: string;
  host: string;
}

export class AgentToolError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AgentToolError';
  }
}

export interface AgentOperationRuntime<Source extends AgentActivitySource = AgentActivitySource> {
  source: Source;
  agentName?: string;
  profile?: AgentToolProfile;
  outputScope(): Promise<string>;
  invoke(toolName: string, input: Record<string, unknown>, callback: () => Promise<unknown>): Promise<unknown>;
  capture(callback: () => Promise<unknown>): Promise<unknown>;
  formatError(error: unknown): unknown;
}

export function createAgentOperationRuntime<Source extends AgentActivitySource>(options: {
  callbacks: AgentOperationCallbacks<Source>;
  outputs: RemoteOutputStore;
  source: Source;
  agentName?: string;
  profile?: AgentToolProfile;
  formatResult(value: unknown): unknown;
  formatError(error: unknown): unknown;
}): AgentOperationRuntime<Source> {
  const { callbacks, outputs, source, agentName } = options;
  const trackedTools = new Set([
    'current_remote_file', 'remote_list', 'remote_read', 'remote_read_many',
    'remote_edit', 'remote_write', 'remote_delete', 'remote_chmod', 'remote_move',
    'remote_create', 'remote_upload', 'remote_download', 'remote_output', 'remote_search',
    'run_remote_command'
  ]);
  const outputScope = async () => {
    const workspace = await callbacks.currentWorkspace();
    if (!workspace) throw new Error('No active workspace for retained output.');
    return JSON.stringify([workspace.host, workspace.workspaceUri, agentName]);
  };
  const capture = async (callback: () => Promise<unknown>) => {
    const scope = await outputScope();
    const value = await callback();
    if (scope !== await outputScope()) throw new Error('Workspace changed during execution.');
    return outputs.capture(value, scope);
  };
  const invoke: AgentOperationRuntime<Source>['invoke'] = async (toolName, input, callback) => {
    let activityId: string | undefined;
    if (trackedTools.has(toolName)) {
      try { activityId = callbacks.activity?.start({ source, toolName, input, agentName }); }
      catch (error) { callbacks.log?.(`Agent 活动开始记录失败：${String(error)}`); }
    }
    try {
      const value = await callback();
      if (activityId) {
        try { callbacks.activity?.succeed(activityId, value); }
        catch (error) { callbacks.log?.(`Agent 活动完成记录失败：${String(error)}`); }
      }
      return options.formatResult(value);
    } catch (error) {
      if (activityId) {
        try { callbacks.activity?.fail(activityId, error); }
        catch (activityError) { callbacks.log?.(`Agent 活动失败记录失败：${String(activityError)}`); }
      }
      return options.formatError(error);
    }
  };
  return {
    source, agentName, profile: options.profile, outputScope, capture, invoke,
    formatError: options.formatError
  };
}

/** Strategy dispatch: protocol adapters provide response and activity policies; this owns use-case routing. */
export function dispatchAgentOperation<Source extends AgentActivitySource>(
  callbacks: AgentOperationCallbacks<Source>,
  outputs: RemoteOutputStore,
  name: string,
  input: Record<string, unknown>,
  runtime: AgentOperationRuntime<Source>
): Promise<unknown> {
  const invoke = runtime.invoke;
  const capture = runtime.capture;
  const agentName = runtime.agentName;
  switch (name) {
    case 'list_remote_workspaces':
      return invoke(name, input, async () => {
        throw new Error('Workspace listing is only available through the SAFS router');
      });
    case 'current_remote_file':
      return invoke(name, input, async () => {
        const value = await callbacks.currentFile(input);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const { mountName: _mountName, ...publicValue } = value as Record<string, unknown>;
        return publicValue;
      });
    case 'remote_list':
      return invoke(name, input, () => {
        if (!input.paths) return callbacks.list(input);
        if (input.path !== undefined || input.cursor !== undefined) {
          throw new Error('Choose paths for a batch or path/cursor for a single directory.');
        }
        return listDirectories(input.paths as string[], (input.limit as number | undefined) ?? 100,
          request => callbacks.list(request));
      });
    case 'remote_read_many':
      return invoke(name, input, () => readTextBatch(input.requests as RemoteReadOptions[],
        (input.maxBytes as number | undefined) ?? 16384, request => callbacks.read(request)));
    case 'remote_read':
      return invoke(name, input, () => callbacks.read(
        input as unknown as Parameters<typeof callbacks.read>[0]
      ));
    case 'remote_edit':
      return invoke(name, input, () => callbacks.edit(input as Parameters<typeof callbacks.edit>[0]));
    case 'remote_write':
      return invoke(name, input, () => callbacks.write(input as Parameters<typeof callbacks.write>[0]));
    case 'remote_create':
      return invoke(name, input, () => {
        if (!callbacks.create) throw new Error('Remote create is unavailable.');
        return callbacks.create(input as Parameters<NonNullable<typeof callbacks.create>>[0]);
      });
    case 'remote_delete':
      return invoke(name, input, () => callbacks.delete(input as Parameters<typeof callbacks.delete>[0]));
    case 'remote_chmod':
      return invoke(name, input, () => callbacks.chmod(input as Parameters<typeof callbacks.chmod>[0]));
    case 'remote_move':
      return invoke(name, input, () => callbacks.move(input as Parameters<typeof callbacks.move>[0]));
    case 'remote_upload':
      return invoke(name, input, () => callbacks.upload(input as Parameters<typeof callbacks.upload>[0]));
    case 'remote_download':
      return invoke(name, input, () => callbacks.download(input as Parameters<typeof callbacks.download>[0]));
    case 'remote_output':
      return invoke(name, input, async () => outputs.read(
        input.outputId as string, await runtime.outputScope(), input.stream as 'stdout' | 'stderr',
        input.offset as number | undefined, input.length as number | undefined
      ));
    case 'remote_search':
      return invoke(name, input, () => capture(() => callbacks.search({
        ...input, agentName
      } as Parameters<typeof callbacks.search>[0])));
    case 'run_remote_command':
      return invoke(name, input, () => {
        if (runtime.profile !== 'terminal') {
          return capture(() => callbacks.run({
            ...input, agentName
          } as Parameters<typeof callbacks.run>[0]));
        }
        if (!callbacks.runTerminal) throw new Error('No SAFS terminal is selected for Agent command forwarding.');
        return callbacks.runTerminal({
          command: input.command as string,
          ...(typeof input.mountName === 'string' ? { mountName: input.mountName } : {}),
          agentName,
          source: runtime.source
        });
      });
    default:
      throw new AgentToolError('UNKNOWN_OPERATION', `Unknown ${runtime.source.toUpperCase()} operation: ${name}`);
  }
}
