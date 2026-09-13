import { listDirectories } from './remote-results';
import { readTextBatch } from './remote-read-batch';
import { RemoteSearchOptions } from './remote-search';
import { RemoteReadOptions } from './remote-read';
import { RemoteOutputStore } from './remote-output';
import * as http from 'node:http';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  type AgentToolProfile, configureAgentMcpResources, directAgentMcpInstructions,
  registerAgentMcpTools
} from './agent-mcp-tools';
import { AgentActivitySource } from './agent-activity';

export interface RemoteFolderInfo {
  name: string;
  workspaceUri: string;
  workspaceRoot: string;
  host: string;
}

export interface AgentMcpCallbacks {
  toolProfile?(): AgentToolProfile;
  listFolders(): Promise<RemoteFolderInfo[]>;
  currentWorkspace(): Promise<RemoteFolderInfo | null>;
  /** 当前打开的远程文件元数据（无活动远程文件时为 null）。 */
  currentFile(input: { mountName?: string }): Promise<unknown>;
  list(input: { mountName?: string; path?: string; limit?: number; cursor?: string }): Promise<unknown>;
  read(input: RemoteReadOptions & { mountName?: string }): Promise<unknown>;
  edit(input: {
    mountName?: string; path: string;
    edits: Array<{ oldText: string; newText: string }>;
    expectedHash?: string;
  }): Promise<unknown>;
  write(input: { mountName?: string; path: string; content: string }): Promise<unknown>;
  delete(input: { mountName?: string; path: string; recursive?: boolean }): Promise<unknown>;
  chmod(input: { mountName?: string; path: string; mode: string }): Promise<unknown>;
  move(input: {
    mountName?: string; sourcePath: string; targetPath: string; overwrite?: boolean;
  }): Promise<unknown>;
  upload(input: {
    mountName?: string; localPaths: string[]; remoteDirectory: string;
    agentPlatform?: string;
  }): Promise<unknown>;
  download(input: {
    mountName?: string; remotePath: string; localPath: string;
    agentPlatform?: string;
  }): Promise<unknown>;
  search(input: RemoteSearchOptions & {
    mountName?: string; agentName?: string; agentPlatform?: string;
  }): Promise<unknown>;
  run(input: {
    command: string; mountName?: string; remoteCwd?: string; agentName?: string;
    agentPlatform?: string;
  }): Promise<unknown>;
  request?(agentName?: string, agentPlatform?: string): void;
  audit?(entry: {
    toolName: string; input: Record<string, unknown>;
    agentName?: string; agentPlatform?: string;
  }): void;
  activity?: {
    start(entry: {
      source: AgentActivitySource; toolName: string; input: Record<string, unknown>;
      agentName?: string; agentPlatform?: string;
    }): string | undefined;
    succeed(id: string, result: unknown): void;
    fail(id: string, error: unknown): void;
  };
  log?(message: string): void;
}

/** A structured operation error whose recovery hints are safe to expose to Agents. */
export class AgentToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'AgentToolError';
  }
}

export class AgentMcpServer {
  private readonly outputs = new RemoteOutputStore();
  private httpServer: http.Server | undefined;
  private _portUnavailable = false;
  private listeningPort: number | undefined;

  constructor(
    private readonly port: number,
    private readonly token: string,
    private readonly callbacks: AgentMcpCallbacks
  ) {}

  get url(): string {
    const port = this.listeningPort ?? this.port;
    return `http://127.0.0.1:${port}/mcp?token=${encodeURIComponent(this.token)}`;
  }

  get running(): boolean {
    return this.httpServer !== undefined;
  }

  get portUnavailable(): boolean {
    return this._portUnavailable;
  }

  private createProtocolServer(
    agentName?: string, agentPlatform?: string, source: AgentActivitySource = 'mcp'
  ): McpServer {
    const server = new McpServer(
      { name: 'safs', version: '1.0.0' },
      { instructions: directAgentMcpInstructions }
    );
    configureAgentMcpResources(server);
    // 紧凑 JSON：结果只回传必要字段，缩进空白会白白消耗模型 token。
    const result = (value: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(value) }]
    });
    // 业务错误作为 MCP tool result 返回，使固定路由器能原样透传；
    // 只有 HTTP/转发层故障才应被标记为 REMOTE_UNAVAILABLE。
    const toolError = (error: unknown) => {
      const structured = error instanceof AgentToolError ? error : undefined;
      return {
        isError: true,
        content: [{ type: 'text' as const, text: JSON.stringify({
          ...(structured?.details ?? {}),
          code: structured?.code ?? 'REMOTE_TOOL_ERROR',
          message: error instanceof Error ? error.message : String(error)
        }) }]
      };
    };
    const trackedTools = new Set([
      'current_remote_file', 'remote_list', 'remote_read', 'remote_read_many',
      'remote_edit', 'remote_write', 'remote_delete', 'remote_chmod', 'remote_move',
      'remote_upload', 'remote_download', 'remote_output', 'remote_search', 'run_remote_command'
    ]);
    const invoke = async (
      toolName: string, input: Record<string, unknown>, callback: () => Promise<unknown>
    ) => {
      let activityId: string | undefined;
      if (trackedTools.has(toolName)) {
        try {
          activityId = this.callbacks.activity?.start({
            source, toolName, input, agentName, agentPlatform
          });
        } catch (error) {
          this.callbacks.log?.(
            `Agent 活动开始记录失败：${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      try {
        const value = await callback();
        if (activityId) {
          try { this.callbacks.activity?.succeed(activityId, value); }
          catch (error) {
            this.callbacks.log?.(
              `Agent 活动完成记录失败：${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        return result(value);
      } catch (error) {
        if (activityId) {
          try { this.callbacks.activity?.fail(activityId, error); }
          catch (activityError) {
            this.callbacks.log?.(
              `Agent 活动失败记录失败：${activityError instanceof Error ? activityError.message : String(activityError)}`
            );
          }
        }
        return toolError(error);
      }
    };
    // name/workspaceUri 是内部路由标识，不对 Agent 暴露。
    const publicFolder = (info: RemoteFolderInfo) => ({
      workspaceRoot: info.workspaceRoot,
      host: info.host
    });
    const publicCurrentFile = (value: unknown): unknown => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      const { mountName: _mountName, ...publicValue } = value as Record<string, unknown>;
      return publicValue;
    };
    const outputScope = async () => {
      const workspace = await this.callbacks.currentWorkspace();
      if (!workspace) throw new Error('No active workspace for retained output.');
      return JSON.stringify([workspace.host, workspace.workspaceUri, agentName, agentPlatform]);
    };
    const capture = async (callback: () => Promise<unknown>) => {
      const scope = await outputScope();
      const value = await callback();
      if (scope !== await outputScope()) throw new Error('Workspace changed during execution.');
      return this.outputs.capture(value, scope);
    };
    registerAgentMcpTools(server, {
      routed: false,
      profile: this.callbacks.toolProfile?.(),
      invoke: (name, input) => {
        switch (name) {
          case 'get_remote_workspace':
            return invoke(name, input, async () => {
              const current = await this.callbacks.currentWorkspace();
              return current ? {
                workspace: publicFolder(current)
              } : { workspace: null };
            });
          case 'switch_remote_workspace':
            return invoke(name, input, async () => {
              throw new Error('Workspace switching is only available through the SAFS router');
            });
          case 'current_remote_file':
            return invoke(name, input, async () => publicCurrentFile(
              await this.callbacks.currentFile(input)
            ));
          case 'remote_list':
            return invoke(name, input, () => {
              if (!input.paths) return this.callbacks.list(input);
              if (input.path !== undefined || input.cursor !== undefined) {
                throw new Error('Choose paths for a batch or path/cursor for a single directory.');
              }
              return listDirectories(input.paths as string[], (input.limit as number | undefined) ?? 100,
                request => this.callbacks.list(request));
            });
          case 'remote_read_many':
            return invoke(name, input, () => readTextBatch(input.requests as RemoteReadOptions[],
              (input.maxBytes as number | undefined) ?? 16384,
              request => this.callbacks.read(request)));
          case 'remote_read':
            return invoke(name, input, () => this.callbacks.read(input as {
              mountName?: string; path: string; offset?: number; length?: number;
            }));
          case 'remote_edit':
            return invoke(name, input, () => this.callbacks.edit(input as {
              mountName?: string; path: string;
              edits: Array<{ oldText: string; newText: string }>;
              expectedHash?: string;
            }));
          case 'remote_write':
            return invoke(name, input, () => this.callbacks.write(input as {
              mountName?: string; path: string; content: string;
            }));
          case 'remote_delete':
            return invoke(name, input, () => this.callbacks.delete(input as {
              mountName?: string; path: string; recursive?: boolean;
            }));
          case 'remote_chmod':
            return invoke(name, input, () => this.callbacks.chmod(input as {
              mountName?: string; path: string; mode: string;
            }));
          case 'remote_move':
            return invoke(name, input, () => this.callbacks.move(input as {
              mountName?: string; sourcePath: string; targetPath: string; overwrite?: boolean;
            }));
          case 'remote_upload':
            return invoke(name, input, () => this.callbacks.upload({
              ...input, agentPlatform
            } as Parameters<AgentMcpCallbacks['upload']>[0]));
          case 'remote_download':
            return invoke(name, input, () => this.callbacks.download({
              ...input, agentPlatform
            } as Parameters<AgentMcpCallbacks['download']>[0]));
          case 'remote_output':
            return invoke(name, input, async () => this.outputs.read(
              input.outputId as string, await outputScope(),
              input.stream as 'stdout' | 'stderr', input.offset as number | undefined,
              input.length as number | undefined
            ));
          case 'remote_search':
            return invoke(name, input, () => capture(() => this.callbacks.search({
              ...input, agentName, agentPlatform
            } as Parameters<AgentMcpCallbacks['search']>[0])));
          case 'run_remote_command':
            return invoke(name, input, () => capture(() => this.callbacks.run({
              ...input, agentName, agentPlatform
            } as Parameters<AgentMcpCallbacks['run']>[0])));
        }
      }
    });
    return server;
  }

  async start(): Promise<void> {
    if (this.httpServer) return;
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.all('/mcp', async (request, response) => {
      if (request.query.token !== this.token) {
        this.callbacks.log?.(`拒绝未授权 MCP 请求：${request.method}`);
        response.status(401).json({ error: 'Unauthorized' });
        return;
      }
      if (request.method !== 'POST') {
        this.callbacks.log?.(`拒绝不支持的 MCP 请求方法：${request.method}`);
        response.status(405).json({ error: 'Method not allowed' });
        return;
      }
      const agentName = typeof request.query.agent === 'string'
        ? request.query.agent.trim().slice(0, 100).replace(/[\u0000-\u001f\u007f]/g, '_')
        : undefined;
      const platformValue = request.query.platform;
      const agentPlatform = typeof platformValue === 'string'
        && ['wsl', 'mac', 'linux', 'win'].includes(platformValue)
        ? platformValue
        : undefined;
      const source: AgentActivitySource = request.query.source === 'cli' ? 'cli' : 'mcp';
      const method = typeof request.body?.method === 'string' ? request.body.method : 'unknown';
      const tool = request.body?.params?.name;
      this.callbacks.log?.(`收到 MCP 请求：${method}${tool ? ` (${tool})` : ''}${
        agentName ? `，agent=${agentName}` : '，agent=<unknown>'
      }${agentPlatform ? `，platform=${agentPlatform}` : ''
      }`);
      this.callbacks.request?.(agentName, agentPlatform);
      if (method === 'tools/call' && typeof tool === 'string') {
        const input = request.body?.params?.arguments;
        this.callbacks.audit?.({
          toolName: tool,
          input: input && typeof input === 'object' ? input as Record<string, unknown> : {},
          agentName, agentPlatform
        });
      }
      const protocol = this.createProtocolServer(agentName, agentPlatform, source);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      try {
        await protocol.connect(transport);
        await transport.handleRequest(request, response, request.body);
      } catch (error) {
        this.callbacks.log?.(
          `MCP 请求失败：${error instanceof Error ? error.message : String(error)}`
        );
        if (!response.headersSent) {
          response.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
            id: null
          });
        }
      } finally {
        await transport.close();
        await protocol.close();
      }
    });
    const server = http.createServer(app);
    this._portUnavailable = false;
    await new Promise<void>((resolve, reject) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          this._portUnavailable = true;
          this.callbacks.log?.(
            `MCP 端口 ${this.port} 已被其他窗口占用；请将 agentMcpPort 设为 0 以启用每窗口独立端口。`
          );
          resolve();
        } else {
          reject(err);
        }
      });
      server.listen(this.port, '127.0.0.1', () => {
        server.off('error', reject);
        const address = server.address();
        if (address && typeof address !== 'string') this.listeningPort = address.port;
        resolve();
      });
    });
    if (this._portUnavailable) {
      // A fixed port can collide with another window. Do not claim that the
      // other server represents this window; no cross-window reuse is safe.
      return;
    }
    this.httpServer = server;
    this.callbacks.log?.(
      `MCP 已启动：http://127.0.0.1:${this.listeningPort ?? this.port}/mcp?token=<hidden>`
    );
  }

  async stop(): Promise<void> {
    this.outputs.clear();
    const server = this.httpServer;
    this.httpServer = undefined;
    this.listeningPort = undefined;
    if (!server) return;
    this.callbacks.log?.('正在停止 MCP');
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    this.callbacks.log?.('MCP 已停止');
  }
}
