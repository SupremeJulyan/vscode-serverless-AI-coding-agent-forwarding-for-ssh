import { operationMetric } from '../shared/operation-metric';
import * as http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import { DiscoveredAgentWorkspace, agentDiscoveryDirectories, discoverAgentWorkspaces } from '../agent/agent-discovery';
import {
  type AgentToolProfile,
  terminalMcpOnlyToolMessage
} from './agent-mcp-tools';
type McpWorkspace = Omit<DiscoveredAgentWorkspace, 'backendSocketPath' | 'backendToken' | 'mcpUrl'> & { mcpUrl: string };

const routerIdentity = 'safs-http-router-v1';
/** 为共用 MCP 地址附加可观测的 Agent 来源标签（不作为身份认证）。 */
export function agentTaggedMcpUrl(
  routerUrl: string, agentName: string
): string {
  const normalized = agentName.trim();
  if (!normalized) throw new Error('Agent name must not be empty');
  if (normalized.length > 100) throw new Error('Agent name must not exceed 100 characters');
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('Agent name must not contain control characters');
  }
  const url = new URL(routerUrl);
  url.searchParams.set('agent', normalized);
  return url.toString();
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
  discover?: () => McpWorkspace[];
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
  private readonly discover: () => McpWorkspace[];
  constructor(
    private readonly port: number,
    private readonly token: string,
    private readonly options: AgentHttpRouterOptions = {}
  ) {
    if (options.discover) {
      this.discover = options.discover;
    } else {
      const directories = agentDiscoveryDirectories();
      this.discover = () => discoverAgentWorkspaces(directories).filter((item): item is McpWorkspace => typeof item.mcpUrl === 'string');
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

  private workspaces(): McpWorkspace[] {
    return this.discover().filter((item) => typeof item.mcpUrl === 'string') as McpWorkspace[];
  }

  private workspace(workspaceId: string, snapshot?: McpWorkspace[]): McpWorkspace | undefined {
    // workspaceId is the exact route key. Never fall back to focus,
    // host, mount, or remote path after an operation has named its target.
    return (snapshot ?? this.workspaces()).find((workspace) => workspaceIdFor(workspace) === workspaceId);
  }

  private publicWorkspace(workspace: McpWorkspace): Record<string, unknown> {
    return {
      workspaceRoot: workspace.workspaceRoot,
      localRoot: workspace.localRoot,
      host: workspace.hostName ?? workspace.host,
      ...(workspace.user !== undefined ? { user: workspace.user } : {}),
      ...(workspace.hostName ? { label: [workspace.hostName, workspace.user, workspace.workspaceRoot].filter(Boolean).join(' → ') } : {}),
      mode: workspace.terminalCommandOnly ? 'terminal' : 'workspace',
      ...(workspace.terminalCommandOnly ? { terminalCommandOnly: true } : {})
    };
  }

  private selectableWorkspace(workspace: McpWorkspace): Record<string, unknown> {
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
    workspace: McpWorkspace, name: string, args: Record<string, unknown>,
    agentName?: string
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
    const requestId = `http-router-${process.pid}-${Date.now()}-${randomUUID()}`;
    this.options.log?.(
      `转发工具 ${name} 到 mount=${workspace.mountName}，port=${url.port}${
        agentName ? `，agent=${agentName}` : ''
      }`
    );
    const forwardTimeoutMs = this.options.forwardTimeoutMs ?? 120_000;
    const forwardStarted = performance.now();
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
    operationMetric(this.options.log, 'agent.forward', forwardStarted, Buffer.byteLength(body));
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
    snapshot?: McpWorkspace[]
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
    const workspace = this.workspace(workspaceId, snapshot);
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
        return this.toolError(
          'TERMINAL_COMMAND_ONLY',
          terminalMcpOnlyToolMessage,
          { allowedTool: 'run_remote_command' }
        );
      }
      args = { command: publicInput.command, mountName: workspace.mountName };
    }
    const effectiveAgentName = agentName;
    try {
      return await this.forward(
        workspace, name, args, effectiveAgentName
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.options.log?.(`工具 ${name} 失败，mount=${workspace.mountName}：${detail}`);
      const timedOut = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
      return this.toolError(
        timedOut ? 'REMOTE_TIMEOUT' : 'REMOTE_UNAVAILABLE',
        timedOut ? 'Forwarding timed out. Inspect remote state before retrying; execution may continue.'
          : `Serverless Remote mount ${workspace.mountName} is currently unavailable: ${detail}`,
        { mountName: workspace.mountName, ...(timedOut ? { executionMayContinue: true } : {}) }
      );
    }
  }

  private async isExistingRouter(): Promise<boolean> {
    let response: Response;
    try {
      response = await fetch(
        this.url.replace('/mcp?', '/health?'),
        { signal: AbortSignal.timeout(1500) }
      );
    } catch {
      throw new Error(`固定 HTTP MCP 端口 ${this.port} 的健康检查暂时失败，将在下次心跳重试。`);
    }
    if (response.status === 401) {
      throw new Error(`固定 HTTP MCP 端口 ${this.port} 的健康检查认证失败，请重新加载使用此端口的 SAFS 窗口。`);
    }
    if (!response.ok) return false;
    try {
      const value = await response.json() as { identity?: unknown };
      return value?.identity === routerIdentity;
    } catch (error) {
      if (error instanceof SyntaxError) return false;
      throw new Error(`固定 HTTP MCP 端口 ${this.port} 的健康检查响应未完成，将在下次心跳重试。`);
    }
  }

  /** Inspect the authenticated shared router, including a leader in another window. */
  async healthy(): Promise<boolean> {
    return this.isExistingRouter().catch(() => false);
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
    app.post('/mcp', async (request, response) => {
      if (request.query.token !== this.token) { response.status(401).json({ error: 'Unauthorized' }); return; }
      if (request.get('x-safs-forwarded') === '1') { response.status(508).json({ error: 'Forwarding loop' }); return; }
      const name = request.body?.params?.name;
      if (request.body?.method !== 'tools/call' || typeof name !== 'string') {
        response.status(400).json({ error: 'Only tools/call is supported by the forwarding router' }); return;
      }
      try {
        const result = await this.callTool(name, request.body.params.arguments ?? {},
          typeof request.query.agent === 'string' ? request.query.agent : undefined);
        response.json({ jsonrpc: '2.0', id: request.body.id ?? null, result });
      } catch (error) {
        response.status(500).json({ jsonrpc: '2.0', id: request.body.id ?? null,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
      }
    });
    const candidate = http.createServer(app);
    const outcome = await new Promise<'leader' | 'occupied'>((resolve, reject) => {
      candidate.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') resolve('occupied'); else reject(error);
      });
      candidate.listen(this.port, '127.0.0.1', () => resolve('leader'));
    }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EADDRINUSE') throw error;
      return 'occupied' as const;
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
    this._available = false;
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
