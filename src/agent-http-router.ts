import * as http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  DiscoveredAgentWorkspace, agentDiscoveryDirectories, discoverAgentWorkspaces
} from './agent-discovery';
import {
  type AgentToolProfile, configureAgentMcpResources,
  registerAgentMcpTools, routedAgentMcpInstructions,
  terminalCliOnlyCommandMessage, terminalMcpOnlyToolMessage
} from './agent-mcp-tools';
import { AgentActivitySource } from './agent-activity';

const routerIdentity = 'safs-http-router-v1';
const cliToolNames = new Set([
  'list_remote_workspaces',
  'current_remote_file', 'remote_list', 'remote_read', 'remote_read_many', 'remote_search',
  'remote_edit', 'remote_write', 'remote_create', 'remote_delete', 'remote_chmod', 'remote_move',
  'remote_upload', 'remote_download', 'remote_output', 'run_remote_command',
  'safs_cli_batch'
]);
const cliBatchToolNames = new Set([...cliToolNames].filter((name) =>
  name !== 'list_remote_workspaces' && name !== 'safs_cli_batch'
));

export function unwrapCliToolResult(value: any, allowNull = false): Record<string, unknown> {
  const text = Array.isArray(value?.content)
    ? value.content.filter((item: any) => item?.type === 'text')
      .map((item: any) => typeof item.text === 'string' ? item.text : '').join('\n')
    : '';
  let result: unknown;
  try { result = text ? JSON.parse(text) : {}; }
  catch { throw new Error('SAFS backend returned invalid JSON.'); }
  if ((!allowNull || result !== null)
      && (!result || typeof result !== 'object' || Array.isArray(result))) {
    throw new Error('SAFS backend returned an invalid result.');
  }
  return { ok: value?.isError !== true, result: result as Record<string, unknown> };
}

/** 为共用 MCP 地址附加可观测的 Agent 来源标签（不作为身份认证）。 */
export function agentTaggedMcpUrl(
  routerUrl: string, agentName: string, source?: AgentActivitySource
): string {
  const normalized = agentName.trim();
  if (!normalized) throw new Error('Agent name must not be empty');
  if (normalized.length > 100) throw new Error('Agent name must not exceed 100 characters');
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('Agent name must not contain control characters');
  }
  const url = new URL(routerUrl);
  url.searchParams.set('agent', normalized);
  if (source) url.searchParams.set('source', source);
  return url.toString();
}

function requestAgentName(value: unknown, fallback?: string): string | undefined {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().slice(0, 100).replace(/[\u0000-\u001f\u007f]/g, '_');
  return normalized || fallback;
}

/**
 * Return the opaque public route key for one discovered remote workspace.
 * The VS Code instance id alone is window-scoped and can survive a remote
 * folder change, so include the remote coordinates to make stale ids fail
 * closed instead of following the window to a different workspace.
 */
export function workspaceIdFor(workspace: Pick<
  DiscoveredAgentWorkspace, 'instanceId' | 'workspaceUri' | 'host'
>): string {
  return createHash('sha256')
    .update(`${workspace.instanceId}\0${workspace.workspaceUri}\0${workspace.host}`)
    .digest('hex')
    .slice(0, 16);
}

export interface AgentHttpRouterOptions {
  discover?: () => DiscoveredAgentWorkspace[];
  log?: (message: string) => void;
  /** 转发到窗口 MCP 的 fetch 超时（毫秒），缺省 120s。 */
  forwardTimeoutMs?: number;
  toolProfile?: () => AgentToolProfile;
  audit?: (entry: {
    toolName: string; input: Record<string, unknown>;
    agentName?: string;
  }) => void;
}

export class AgentHttpRouter {
  private httpServer: http.Server | undefined;
  private _available = false;
  private _leader = false;
  private readonly discover: () => DiscoveredAgentWorkspace[];
  constructor(
    private readonly port: number,
    private readonly token: string,
    private readonly options: AgentHttpRouterOptions = {}
  ) {
    if (options.discover) {
      this.discover = options.discover;
    } else {
      const directories = agentDiscoveryDirectories();
      this.discover = () => discoverAgentWorkspaces(directories);
    }
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp?token=${encodeURIComponent(this.token)}`;
  }

  get available(): boolean {
    return this._available;
  }

  get leader(): boolean {
    return this._leader;
  }

  private workspaces(): DiscoveredAgentWorkspace[] {
    return this.discover();
  }

  private activeToolProfile(): AgentToolProfile {
    // The shared MCP URL has no window identity before workspace selection.
    // Tool schemas must stay stable; workspaceId determines each window's mode.
    return this.options.toolProfile?.() ?? 'full';
  }

  private workspace(workspaceId: string): DiscoveredAgentWorkspace | undefined {
    // workspaceId is the exact route key. Never fall back to focus,
    // host, mount, or remote path after an operation has named its target.
    return this.workspaces().find((workspace) => workspaceIdFor(workspace) === workspaceId);
  }

  private publicWorkspace(workspace: DiscoveredAgentWorkspace): Record<string, unknown> {
    return {
      workspaceRoot: workspace.workspaceRoot,
      host: workspace.host,
      mode: workspace.terminalCommandOnly ? 'terminal' : 'workspace',
      ...(workspace.terminalCommandOnly ? { terminalCommandOnly: true } : {})
    };
  }

  private selectableWorkspace(workspace: DiscoveredAgentWorkspace): Record<string, unknown> {
    return {
      workspaceId: workspaceIdFor(workspace),
      ...this.publicWorkspace(workspace)
    };
  }

  private toolError(code: string, message: string, details: Record<string, unknown> = {}) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: JSON.stringify({
        code, message, ...details
      }) }]
    };
  }

  private parseSse(text: string, requestId: string): unknown {
    const messages = text.split(/\r?\n\r?\n/).flatMap((event) => {
      const data = event.split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (!data) return [];
      try {
        return [JSON.parse(data) as { id?: unknown }];
      } catch {
        return [];
      }
    });
    return messages.find((message) => message.id === requestId) ?? messages.at(-1);
  }

  private async forward(
    workspace: DiscoveredAgentWorkspace, name: string, args: Record<string, unknown>,
    agentName?: string, source: AgentActivitySource = 'mcp'
  ): Promise<any> {
    const url = new URL(workspace.mcpUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
      throw new Error('Refusing to forward to a non-loopback MCP endpoint');
    }
    // 拒绝转发到路由器自身端口：伪造/损坏的发现记录若指向本路由器，会无限递归。
    if (url.port === String(this.port)) {
      throw new Error('Refusing to forward to the router itself');
    }
    if (agentName) url.searchParams.set('agent', agentName);
    url.searchParams.set('source', source);
    const requestId = `http-router-${process.pid}-${Date.now()}-${randomUUID()}`;
    this.options.log?.(
      `转发工具 ${name} 到 mount=${workspace.mountName}，port=${url.port}${
        agentName ? `，agent=${agentName}` : ''
      }`
    );
    const forwardTimeoutMs = this.options.forwardTimeoutMs ?? 120_000;
    const response = await fetch(url, {
      method: 'POST',
      // redirect: manual —— 不允许 3xx 重定向跳出 loopback（SSRF 防护）。
      redirect: 'manual',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        // 标记这是路由器发起的转发；目标若是另一个路由器会拒绝（防路由器间环）。
        'x-safs-forwarded': '1'
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: requestId, method: 'tools/call',
        params: { name, arguments: args }
      }),
      signal: forwardTimeoutMs > 0 ? AbortSignal.timeout(forwardTimeoutMs) : undefined
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Window MCP returned HTTP ${response.status}: ${body.slice(0, 500)}`);
    }
    const downstream = (response.headers.get('content-type')?.includes('text/event-stream')
      ? this.parseSse(body, requestId)
      : JSON.parse(body)) as { result?: unknown; error?: { message?: string } } | undefined;
    if (!downstream) throw new Error('Window MCP returned no JSON-RPC response');
    if (downstream.error) {
      throw new Error(downstream.error.message || 'Window MCP request failed');
    }
    return downstream.result;
  }

  private async callTool(
    name: string, input: Record<string, unknown>, agentName?: string,
    source: AgentActivitySource = 'mcp'
  ): Promise<any> {
    if (name === 'list_remote_workspaces') {
      const workspaces = this.workspaces();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          workspaces: workspaces.map((workspace) => this.selectableWorkspace(workspace))
        }) }]
      };
    }
    const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId.trim() : '';
    if (!workspaceId) {
      return this.toolError(
        'WORKSPACE_ID_REQUIRED',
        'Pass the workspaceId returned by list_remote_workspaces.'
      );
    }
    const workspace = this.workspace(workspaceId);
    if (!workspace) {
      return this.toolError(
        'REMOTE_WORKSPACE_NOT_FOUND',
        'The selected remote workspace is no longer active. List workspaces and select an active workspace again.',
        { workspaceId }
      );
    }
    const { workspaceId: _workspaceId, ...publicInput } = input;
    let args: Record<string, unknown> = { ...publicInput, mountName: workspace.mountName };
    if (workspace.terminalCommandOnly) {
      if (name !== 'run_remote_command') {
        const cliCommand = `safs exec --workspace ${workspaceId} -- 'COMMAND'`;
        return this.toolError(
          'TERMINAL_COMMAND_ONLY',
          source === 'cli'
            ? terminalCliOnlyCommandMessage.replace('<workspaceId>', workspaceId)
            : terminalMcpOnlyToolMessage,
          source === 'cli'
            ? { allowedCommand: cliCommand }
            : { allowedTool: 'run_remote_command' }
        );
      }
      if (publicInput.remoteCwd !== undefined) {
        return this.toolError(
          'TERMINAL_CWD_FIXED',
          'The working directory is fixed to the selected terminal directory; omit --cwd.'
        );
      }
      args = { command: publicInput.command, mountName: workspace.mountName };
    }
    const effectiveAgentName = source === 'cli'
      ? requestAgentName(publicInput.agentName, agentName)
      : agentName;
    try {
      return await this.forward(
        workspace, name, args, effectiveAgentName, source
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.options.log?.(`工具 ${name} 失败，mount=${workspace.mountName}：${detail}`);
      return this.toolError(
        'REMOTE_UNAVAILABLE',
        `Serverless Remote mount ${workspace.mountName} is currently unavailable: ${detail}`,
        { mountName: workspace.mountName }
      );
    }
  }

  private createProtocolServer(agentName?: string): McpServer {
    const profile = this.activeToolProfile();
    const server = new McpServer(
      { name: 'safs-http-router', version: '1.0.0' },
      { instructions: routedAgentMcpInstructions }
    );
    configureAgentMcpResources(server);
    registerAgentMcpTools(server, {
      routed: true,
      profile,
      invoke: (name, input) => this.callTool(name, input, agentName, 'mcp')
    });
    return server;
  }

  private async isExistingRouter(): Promise<boolean> {
    try {
      const response = await fetch(
        `http://127.0.0.1:${this.port}/health?token=${encodeURIComponent(this.token)}`,
        { signal: AbortSignal.timeout(1500) }
      );
      if (!response.ok) return false;
      const value = await response.json() as { identity?: unknown };
      return value.identity === routerIdentity;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    if (this.httpServer) return;
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.get('/health', (request, response) => {
      if (request.query.token !== this.token) {
        response.status(401).json({ error: 'Unauthorized' });
        return;
      }
      response.json({ identity: routerIdentity, leaderProcessId: process.pid });
    });
    app.post('/cli', async (request, response) => {
      if (request.query.token !== this.token) {
        response.status(401).json({ ok: false, error: 'Unauthorized' });
        return;
      }
      const name = request.body?.name;
      const input = request.body?.arguments;
      if (typeof name !== 'string' || !cliToolNames.has(name)
          || !input || typeof input !== 'object' || Array.isArray(input)) {
        response.status(400).json({ ok: false, error: 'Invalid CLI request' });
        return;
      }
      const agentName = requestAgentName(request.query.agent);
      try {
        if (name === 'safs_cli_batch') {
          const operations = (input as { operations?: unknown }).operations;
          if (!Array.isArray(operations) || operations.length === 0 || operations.length > 50) {
            response.status(400).json({ ok: false, error: 'CLI batch requires 1 to 50 operations' });
            return;
          }
          const terminalBatch = operations.some((operation) => {
            if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return false;
            const args = (operation as { arguments?: unknown }).arguments;
            if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
            const workspaceId = (args as { workspaceId?: unknown }).workspaceId;
            return typeof workspaceId === 'string'
              && this.workspace(workspaceId)?.terminalCommandOnly === true;
          });
          if (terminalBatch) {
            response.json({ ok: false, result: {
              code: 'TERMINAL_COMMAND_ONLY',
              message: terminalCliOnlyCommandMessage,
              allowedCommand: "safs exec --workspace <workspaceId> -- 'COMMAND'"
            } });
            return;
          }
          const results: Record<string, unknown>[] = [];
          for (let index = 0; index < operations.length; index += 1) {
            const operation = operations[index] as { name?: unknown; arguments?: unknown };
            if (!operation || typeof operation !== 'object'
                || typeof operation.name !== 'string'
                || !cliBatchToolNames.has(operation.name)
                || !operation.arguments || typeof operation.arguments !== 'object'
                || Array.isArray(operation.arguments)) {
              response.status(400).json({ ok: false, error: `Invalid CLI batch operation at index ${index}` });
              return;
            }
            const item = unwrapCliToolResult(
              await this.callTool(
                operation.name, operation.arguments as Record<string, unknown>,
                agentName, 'cli'
              ),
              operation.name === 'current_remote_file'
            );
            results.push({ index, name: operation.name, ...item });
          }
          response.json({ ok: true, result: { results } });
          return;
        }
        response.json(unwrapCliToolResult(
          await this.callTool(
            name, input as Record<string, unknown>, agentName, 'cli'
          ),
          name === 'current_remote_file'
        ));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        response.status(500).json({ ok: false, error: message });
      }
    });
    app.all('/mcp', async (request, response) => {
      if (request.query.token !== this.token) {
        response.status(401).json({ error: 'Unauthorized' });
        return;
      }
      // 路由器绝不能作为另一个路由器的转发目标：带 x-safs-forwarded 标记的请求
      // 说明来源是路由器转发，直接拒绝，防止路由器间形成转发环。
      if (request.headers['x-safs-forwarded']) {
        this.options.log?.('拒绝路由器转发请求（x-safs-forwarded）');
        response.status(403).json({ error: 'Forwarding target must not be another router' });
        return;
      }
      if (request.method !== 'POST') {
        response.status(405).json({ error: 'Method not allowed' });
        return;
      }
      const agentName = requestAgentName(request.query.agent);
      const method = typeof request.body?.method === 'string' ? request.body.method : 'unknown';
      const tool = request.body?.params?.name;
      this.options.log?.(
        `收到 MCP 请求：${method}${tool ? ` (${tool})` : ''}${
          agentName ? `，agent=${agentName}` : '，agent=<unknown>'
        }`
      );
      const protocol = this.createProtocolServer(agentName);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      try {
        await protocol.connect(transport);
        await transport.handleRequest(request, response, request.body);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.options.log?.(`固定 HTTP MCP 请求失败：${detail}`);
        if (!response.headersSent) {
          response.status(500).json({
            jsonrpc: '2.0', error: { code: -32603, message: detail }, id: null
          });
        }
      } finally {
        await transport.close();
        await protocol.close();
      }
    });
    const candidate = http.createServer(app);
    const outcome = await new Promise<'leader' | 'occupied'>((resolve, reject) => {
      const startupError = (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') resolve('occupied');
        else reject(error);
      };
      candidate.once('error', startupError);
      candidate.listen(this.port, '127.0.0.1', () => {
        candidate.off('error', startupError);
        resolve('leader');
      });
    });
    if (outcome === 'leader') {
      candidate.on('error', (error) => {
        this.options.log?.(`固定 HTTP MCP 服务错误：${error.message}`);
      });
      this.httpServer = candidate;
      this._leader = true;
      this._available = true;
      this.options.log?.(`固定 HTTP MCP 路由器已接管端口 ${this.port}`);
      return;
    }
    this._leader = false;
    this._available = await this.isExistingRouter();
    if (!this._available) {
      throw new Error(
        `固定 HTTP MCP 端口 ${this.port} 已被其他程序占用；请修改 safs.agentHttpRouterPort。`
      );
    }
  }

  async stop(): Promise<void> {
    const server = this.httpServer;
    this.httpServer = undefined;
    this._leader = false;
    this._available = false;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}
