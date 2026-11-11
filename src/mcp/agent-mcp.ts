import { operationMetric } from '../shared/operation-metric';
import * as http from 'node:http';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { RemoteOutputStore } from '../remote/remote-output';
import {
  type AgentToolProfile, configureAgentMcpResources, directAgentMcpInstructions,
  registerAgentMcpTools, terminalAgentMcpInstructions, terminalMcpOnlyToolError
} from './agent-mcp-tools';
type AgentActivitySource = 'mcp';

import {
  createAgentOperationRuntime, dispatchAgentOperation, AgentOperationCallbacks, AgentRemoteFolderInfo, AgentToolError
} from '../agent/agent-operation-dispatcher';
export { AgentToolError } from '../agent/agent-operation-dispatcher';
export type RemoteFolderInfo = AgentRemoteFolderInfo;
export type AgentMcpCallbacks = AgentOperationCallbacks<'mcp'>;

export class AgentMcpServer {
  private readonly outputs = new RemoteOutputStore();
  private httpServer: http.Server | undefined;
  private _portUnavailable = false;

  constructor(
    private port: number,
    private readonly token: string,
    private readonly callbacks: AgentMcpCallbacks
  ) {}

  get portValue(): number { return this.port; }

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp?token=${encodeURIComponent(this.token)}`;
  }

  get running(): boolean {
    return this.httpServer !== undefined;
  }

  get portUnavailable(): boolean {
    return this._portUnavailable;
  }

  private async callOperation(
    name: string, input: Record<string, unknown>, agentName: string | undefined,
    source: AgentActivitySource, profile?: AgentToolProfile
  ) {
    const runtime = createAgentOperationRuntime({
      callbacks: this.callbacks, outputs: this.outputs, source, agentName, profile,
      formatResult: value => ({
        content: [{ type: 'text' as const, text: JSON.stringify(value) }]
      }),
      formatError: error => {
        const structured = error instanceof AgentToolError ? error : undefined;
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({
          ...(structured?.details ?? {}), code: structured?.code ?? 'REMOTE_TOOL_ERROR',
          message: error instanceof Error ? error.message : String(error)
        }) }] };
      }
    });
    try { return await dispatchAgentOperation(this.callbacks, this.outputs, name, input, runtime); }
    catch (error) { return runtime.formatError(error); }
  }

  private createProtocolServer(
    agentName?: string, source: AgentActivitySource = 'mcp'
  ): McpServer {
    const profile = this.callbacks.toolProfile?.();
    const server = new McpServer(
      { name: 'safs', version: '1.0.0' },
      { instructions: profile === 'terminal'
        ? terminalAgentMcpInstructions
        : directAgentMcpInstructions }
    );
    configureAgentMcpResources(server);
    registerAgentMcpTools(server, {
      routed: false, profile,
      invoke: (name, input) => this.callOperation(name, input, agentName, source, profile)
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
      const source: AgentActivitySource = 'mcp';
      const method = typeof request.body?.method === 'string' ? request.body.method : 'unknown';
      const tool = request.body?.params?.name;
      this.callbacks.log?.(`收到 MCP 请求：${method}${tool ? ` (${tool})` : ''}${
        agentName ? `，agent=${agentName}` : '，agent=<unknown>'
      }`);
      this.callbacks.request?.(agentName);
      if (method === 'tools/call' && typeof tool === 'string') {
        const input = request.body?.params?.arguments;
        this.callbacks.audit?.({
          toolName: tool,
          input: input && typeof input === 'object' ? input as Record<string, unknown> : {},
          agentName
        });
      }
      // A connected Agent can cache tools from workspace mode. Give it the
      // terminal-mode replacement instead of a generic "Tool not found".
      if (method === 'tools/call' && typeof tool === 'string'
          && this.callbacks.toolProfile?.() === 'terminal'
          && tool !== 'run_remote_command') {
        response.json({
          jsonrpc: '2.0', id: request.body?.id ?? null,
          result: terminalMcpOnlyToolError()
        });
        return;
      }
      const requestStarted = performance.now();
      const protocol = this.createProtocolServer(agentName, source);
      operationMetric(this.callbacks.log, 'mcp.protocol.setup', requestStarted);
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
        operationMetric(this.callbacks.log, 'mcp.request', requestStarted);
      }
    });
    const server = http.createServer(app);
    this._portUnavailable = false;
    const preferred = this.port;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(preferred, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      this.port = preferred;
    } catch (error) { this._portUnavailable = true; throw error; }
    this.httpServer = server;
    this.callbacks.log?.(
      `Agent MCP HTTP 已启动，port=${this.port}`
    );
  }

  async stop(): Promise<void> {
    this.outputs.clear();
    const server = this.httpServer;
    this.httpServer = undefined;
    if (!server) return;
    this.callbacks.log?.('正在停止 MCP');
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    this.callbacks.log?.('MCP 已停止');
  }
}
