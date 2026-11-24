import { createIpcServer, ipcRequest, listenIpc, IpcRequestError } from './agent-ipc';
import { operationMetric } from '../shared/operation-metric';
import { createHash } from 'node:crypto';
import {
  DiscoveredAgentWorkspace, agentDiscoveryDirectories, discoverAgentWorkspaces
} from './agent-discovery';
import { terminalCliOnlyCommandMessage } from './agent-operations';

const routerIdentity = 'safs-ipc-router-v2';
const cliToolNames = new Set([
  'list_remote_workspaces',
  'current_remote_file', 'remote_list', 'remote_read', 'remote_search',
  'remote_edit', 'remote_write', 'remote_create', 'remote_delete', 'remote_chmod', 'remote_move',
  'remote_upload', 'remote_download', 'remote_output', 'run_remote_command'
]);

export function unwrapCliToolResult(value: any, allowNull = false): Record<string, unknown> {
  if (!value || typeof value.ok !== 'boolean') throw new Error('Invalid backend response');
  const result = value.ok ? value.result : value.error;
  if ((!allowNull || result !== null) && (!result || typeof result !== 'object' || Array.isArray(result))) {
    throw new Error('Invalid backend result');
  }
  return { ok: value.ok, result };
}
function requestAgentName(value: unknown, fallback?: string): string | undefined {
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, 100).replace(/[\u0000-\u001f\u007f]/g, '_') || fallback;
}

export function workspaceIdFor(workspace: Pick<
  DiscoveredAgentWorkspace, 'instanceId' | 'workspaceUri' | 'host'
>): string {
  return createHash('sha256')
    .update(`${workspace.instanceId}\0${workspace.workspaceUri}\0${workspace.host}`)
    .digest('hex')
    .slice(0, 16);
}

export interface AgentIpcRouterOptions {
  discover?: () => DiscoveredAgentWorkspace[];
  log?: (message: string) => void;
  /** 转发到窗口 IPC 后端的超时（毫秒），缺省 120s。 */
  forwardTimeoutMs?: number;
}

export class AgentIpcRouter {
  private server: ReturnType<typeof createIpcServer> | undefined;
  private _available = false;
  private _leader = false;
  private readonly discover: () => DiscoveredAgentWorkspace[];
  constructor(
    readonly socketPath: string,
    private readonly token: string,
    private readonly options: AgentIpcRouterOptions = {}
  ) {
    if (options.discover) {
      this.discover = options.discover;
    } else {
      const directories = agentDiscoveryDirectories();
      this.discover = () => discoverAgentWorkspaces(directories);
    }
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

  private workspace(workspaceId: string): DiscoveredAgentWorkspace | undefined {
    // workspaceId is the exact route key. Never fall back to focus,
    // host, mount, or remote path after an operation has named its target.
    return this.workspaces().find((workspace) => workspaceIdFor(workspace) === workspaceId);
  }

  private publicWorkspace(workspace: DiscoveredAgentWorkspace): Record<string, unknown> {
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

  private selectableWorkspace(workspace: DiscoveredAgentWorkspace): Record<string, unknown> {
    return {
      workspaceId: workspaceIdFor(workspace),
      ...this.publicWorkspace(workspace)
    };
  }

  private toolError(code: string, message: string, details: Record<string, unknown> = {}) {
    return { ok: false, error: { code, message, ...details } };
  }

  private async forward(
    workspace: DiscoveredAgentWorkspace, name: string, args: Record<string, unknown>,
    agentName?: string
  ): Promise<any> {
    if (!workspace.backendSocketPath || !workspace.backendToken) {
      throw new Error('Remote workspace IPC endpoint is unavailable');
    }
    if (workspace.backendSocketPath === this.socketPath) {
      throw new Error('Refusing to forward to the router itself');
    }
    this.options.log?.(`转发工具 ${name} 到 mount=${workspace.mountName}${agentName ? `，agent=${agentName}` : ''}`);
    const forwardTimeoutMs = this.options.forwardTimeoutMs ?? 120_000;
    const forwardStarted = performance.now();
    const result = await ipcRequest<any>(workspace.backendSocketPath, workspace.backendToken, 'operation', {
      operation: name, input: args, agentName, source: 'cli'
    }, { timeoutMs: forwardTimeoutMs });
    operationMetric(this.options.log, 'agent.forward', forwardStarted);
    return result;
  }

  private async callTool(
    name: string, input: Record<string, unknown>, agentName?: string
  ): Promise<any> {
    if (name === 'list_remote_workspaces') {
      const workspaces = this.workspaces();
      return { ok: true, result: {
        workspaces: workspaces.map((workspace) => this.selectableWorkspace(workspace))
      } };
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
        const cliCommand = `safs exec --id ${workspaceId} -- 'COMMAND'`;
        return this.toolError(
          'TERMINAL_COMMAND_ONLY',
          terminalCliOnlyCommandMessage.replace('<workspaceId>', workspaceId),
          { allowedCommand: cliCommand }
        );
      }
      args = { command: publicInput.command, mountName: workspace.mountName };
    }
    const effectiveAgentName = requestAgentName(publicInput.agentName, agentName);
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
    try {
      const value = await ipcRequest<{ identity?: unknown }>(this.socketPath, this.token, 'health', undefined, { timeoutMs: 1500 });
      return value?.identity === routerIdentity;
    } catch (error) {
      if (error instanceof IpcRequestError && error.code === 'UNAUTHORIZED') {
        throw new Error('共享 IPC 路由器认证失败，请重新加载 SAFS 窗口。');
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ECONNREFUSED') return false;
      throw new Error('共享 IPC 路由器健康检查失败，将在下次心跳重试。');
    }
  }

  /** Inspect the authenticated shared router, including a leader in another window. */
  async healthy(): Promise<boolean> {
    return this.isExistingRouter().catch(() => false);
  }

  async start(): Promise<void> {
    if (this.server) return;
    const candidate = createIpcServer(async ({ action, payload }) => {
      const envelope = payload as { token?: unknown; value?: unknown };
      if (envelope.token !== this.token) throw new IpcRequestError('Unauthorized', 'UNAUTHORIZED');
      if (action === 'health') return { identity: routerIdentity, leaderProcessId: process.pid };
      if (action !== 'cli') throw new IpcRequestError('Unknown router action', 'INVALID_ACTION');
      const request = envelope.value as { name?: unknown; arguments?: unknown; agentName?: unknown };
      const name = request?.name;
      const input = request?.arguments;
      if (typeof name !== 'string' || !cliToolNames.has(name)
          || !input || typeof input !== 'object' || Array.isArray(input)) {
        throw new IpcRequestError('Invalid CLI request', 'INVALID_REQUEST');
      }
      const args = input as Record<string, unknown>;
      if ((name === 'remote_list' || name === 'remote_read') && args.requests !== undefined) {
        const requests = args.requests;
        if (!Array.isArray(requests) || requests.length < 1 || requests.length > 16
          || requests.some(item => !item || typeof item.path !== 'string' || !item.path)) {
          throw new IpcRequestError('Expected 1 to 16 requests with a path per item', 'INVALID_REQUEST');
        }
      }
      const agentName = requestAgentName(request.agentName);
      return unwrapCliToolResult(await this.callTool(name, args, agentName), name === 'current_remote_file');
    });
    const outcome = await listenIpc(candidate, this.socketPath).then(() => 'leader', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') return 'occupied';
      throw error;
    });
    if (outcome === 'leader') {
      candidate.on('error', (error) => this.options.log?.(`IPC 路由服务错误：${error.message}`));
      this.server = candidate; this._leader = true; this._available = true;
      this.options.log?.('IPC CLI 路由器已接管本地套接字');
      return;
    }
    this._leader = false;
    this._available = await this.isExistingRouter();
    if (!this._available) throw new Error('本地 IPC 路由地址已被占用。');
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this._leader = false;
    this._available = false;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}
