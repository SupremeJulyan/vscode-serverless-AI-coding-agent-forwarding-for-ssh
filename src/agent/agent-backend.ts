import { createIpcServer, ipcPath, listenIpc, IpcRequestError } from './agent-ipc';
import { operationMetric } from '../shared/operation-metric';
import { RemoteOutputStore } from '../remote/remote-output';
import { terminalCliOnlyCommandMessage } from './agent-operations';
import { createAgentOperationRuntime, dispatchAgentOperation, AgentOperationCallbacks, AgentRemoteFolderInfo, AgentToolError } from './agent-operation-dispatcher';
export { AgentToolError } from './agent-operation-dispatcher';
export type RemoteFolderInfo = AgentRemoteFolderInfo;
export type AgentBackendCallbacks = AgentOperationCallbacks<'cli'>;

export class AgentBackendServer {
  private readonly outputs = new RemoteOutputStore();
  private server: ReturnType<typeof createIpcServer> | undefined;

  constructor(
    private readonly token: string,
    private readonly callbacks: AgentBackendCallbacks
  ) {}

  private async callOperation(name: string, input: Record<string, unknown>, agentName?: string) {
    const runtime = createAgentOperationRuntime({
      callbacks: this.callbacks, outputs: this.outputs, source: 'cli', agentName,
      profile: this.callbacks.toolProfile?.(),
      formatResult: value => ({ ok: true, result: value }),
      formatError: error => {
        const structured = error instanceof AgentToolError ? error : undefined;
        return { ok: false, error: {
          ...(structured?.details ?? {}), code: structured?.code ?? 'REMOTE_TOOL_ERROR',
          message: error instanceof Error ? error.message : String(error)
        } };
      }
    });
    try { return await dispatchAgentOperation(this.callbacks, this.outputs, name, input, runtime); }
    catch (error) { return runtime.formatError(error); }
  }

  get socketPath(): string {
    return ipcPath('window-' + process.pid + '-' + this.token);
  }

  get running(): boolean {
    return this.server !== undefined;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createIpcServer(async ({ action, payload }) => {
      const envelope = payload as { token?: unknown; value?: unknown };
      if (envelope.token !== this.token) throw new IpcRequestError('Unauthorized', 'UNAUTHORIZED');
      if (action !== 'operation') throw new IpcRequestError('Unknown backend action', 'INVALID_ACTION');
      const body = envelope.value as { operation?: unknown; input?: unknown; agentName?: unknown; source?: unknown };
      const name = body?.operation;
      const input = body?.input;
      if (typeof name !== 'string' || !input || typeof input !== 'object' || Array.isArray(input)) {
        throw new IpcRequestError('Invalid operation request', 'INVALID_REQUEST');
      }
      const agentName = typeof body.agentName === 'string'
        ? body.agentName.trim().slice(0, 100).replace(/[\u0000-\u001f\u007f]/g, '_') : undefined;
      if (this.callbacks.toolProfile?.() === 'terminal' && name !== 'run_remote_command') {
        throw new IpcRequestError(terminalCliOnlyCommandMessage, 'TERMINAL_COMMAND_ONLY');
      }
      const started = performance.now();
      try {
        this.callbacks.request?.(agentName);
        this.callbacks.audit?.({ toolName: name, input: input as Record<string, unknown>, agentName });
        return await this.callOperation(name, input as Record<string, unknown>, agentName);
      } catch (error) {
        throw new IpcRequestError(error instanceof Error ? error.message : String(error));
      } finally {
        operationMetric(this.callbacks.log, 'cli.operation', started);
      }
    });
    await listenIpc(server, this.socketPath);
    this.server = server;
    this.callbacks.log?.('Agent IPC 服务已启动');
  }

  async stop(): Promise<void> {
    this.outputs.clear();
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    this.callbacks.log?.('正在停止 CLI');
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    this.callbacks.log?.('CLI 已停止');
  }
}
