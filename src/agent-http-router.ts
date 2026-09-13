import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  DiscoveredAgentWorkspace, agentDiscoveryDirectories, discoverAgentWorkspaces
} from './agent-discovery';
import {
  type AgentToolProfile, configureAgentMcpResources, hybridAgentMcpInstructions,
  hybridCliInstructions, registerAgentMcpTools, routedAgentMcpInstructions
} from './agent-mcp-tools';
import { AgentActivitySource } from './agent-activity';

const routerIdentity = 'safs-http-router-v1';
const cliToolNames = new Set([
  'get_remote_workspace', 'cli_list_workspaces', 'switch_remote_workspace',
  // Keep already-installed 1.7.8 CLIs working; these aliases are not exposed as MCP tools.
  'safs_get_remote_workspace', 'safs_switch_remote_workspace',
  'current_remote_file', 'remote_list', 'remote_read', 'remote_read_many', 'remote_search',
  'remote_edit', 'remote_write', 'remote_delete', 'remote_chmod', 'remote_move',
  'remote_upload', 'remote_download', 'remote_output', 'run_remote_command',
  'safs_cli_batch'
]);
const cliBatchToolNames = new Set([...cliToolNames].filter((name) =>
  ![
    'get_remote_workspace', 'cli_list_workspaces',
    'switch_remote_workspace', 'safs_get_remote_workspace',
    'safs_switch_remote_workspace', 'safs_cli_batch'
  ].includes(name)
));

function currentCliToolName(name: string): string {
  if (name === 'safs_get_remote_workspace') return 'get_remote_workspace';
  if (name === 'safs_switch_remote_workspace') return 'switch_remote_workspace';
  return name;
}

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

/** Convert MCP-oriented routing instructions into shell CLI guidance. */
export function adaptCliToolResult(
  envelope: Record<string, unknown>, toolName: string
): Record<string, unknown> {
  const result = envelope.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return envelope;
  const value = result as Record<string, unknown>;
  if (value.code === 'WORKSPACE_SELECTION_REQUIRED') {
    const agentArgument = typeof value.agentName === 'string'
      ? ` --agent ${JSON.stringify(value.agentName)}`
      : '';
    const candidates = Array.isArray(value.candidates) ? value.candidates.map((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate;
      const item = candidate as Record<string, unknown>;
      return typeof item.workspaceId === 'string' ? {
        ...item,
        switchCommand: `safs switch${agentArgument} --workspace ${item.workspaceId} --confirmed`
      } : item;
    }) : [];
    return { ...envelope, result: {
      ...value,
      candidates,
      status: 'needs_user_input',
      action: 'select_workspace',
      requiresUserInput: true,
      mustStopNow: true,
      nextCommandAfterUserReply: `safs switch${agentArgument} --workspace <workspaceId> --confirmed`,
      message: 'Ask the user to choose a listed workspace, then stop. Do not run a switch command in this turn. After the user replies, run the candidate switchCommand.'
    } };
  }
  if (toolName === 'switch_remote_workspace'
      && typeof value.bindingId === 'string' && value.previousTaskCancelled === true) {
    return { ...envelope, result: {
      ...value,
      status: 'switched',
      mustStopNow: true,
      message: 'Workspace switched and the previous task was cancelled. Stop now and wait for a new user request.',
      bindingArgument: `--binding ${value.bindingId}`
    } };
  }
  return envelope;
}

/** 为共用 MCP 地址附加可观测的 Agent 来源标签（不作为身份认证）。 */
export type AgentPlatformLabel = 'wsl' | 'mac' | 'linux' | 'win';

export function agentTaggedMcpUrl(
  routerUrl: string, agentName: string, platform?: AgentPlatformLabel,
  source?: AgentActivitySource
): string {
  const normalized = agentName.trim();
  if (!normalized) throw new Error('Agent name must not be empty');
  if (normalized.length > 100) throw new Error('Agent name must not exceed 100 characters');
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('Agent name must not contain control characters');
  }
  const url = new URL(routerUrl);
  url.searchParams.set('agent', normalized);
  if (platform) url.searchParams.set('platform', platform);
  if (source) url.searchParams.set('source', source);
  return url.toString();
}

function requestAgentName(value: unknown, fallback?: string): string | undefined {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().slice(0, 100).replace(/[\u0000-\u001f\u007f]/g, '_');
  return normalized || fallback;
}

/** Normalize native Windows and WSL views of the same local Agent cwd. */
export function canonicalAgentCwd(value: string): string {
  let normalized = value.trim().replace(/\\/g, '/');
  const drive = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (drive) normalized = `/mnt/${drive[1].toLowerCase()}/${drive[2]}`.toLowerCase();
  if (/^\/mnt\/[a-z]\//i.test(normalized)) normalized = normalized.toLowerCase();
  normalized = normalized.replace(/\/{2,}/g, '/').replace(/\/$/, '');
  return normalized || '/';
}

function cwdContains(root: string, cwd: string): boolean {
  return cwd === root || cwd.startsWith(`${root}/`);
}

export interface AgentHttpRouterOptions {
  discover?: () => DiscoveredAgentWorkspace[];
  log?: (message: string) => void;
  /** 转发到窗口 MCP 的 fetch 超时（毫秒），缺省 120s。 */
  forwardTimeoutMs?: number;
  toolProfile?: () => AgentToolProfile;
  audit?: (entry: {
    toolName: string; input: Record<string, unknown>;
    agentName?: string; agentPlatform?: AgentPlatformLabel;
  }) => void;
}

export class AgentHttpRouter {
  private httpServer: http.Server | undefined;
  private _available = false;
  private _leader = false;
  private readonly discover: () => DiscoveredAgentWorkspace[];
  private readonly bindings = new Map<string, {
    instanceId: string; host: string; mountName: string; workspaceRoot: string;
    workspaceUri: string; owner: string;
    agentName?: string; agentPlatform?: AgentPlatformLabel;
  }>();
  private readonly preferredTargets = new Map<string, {
    host: string; mountName: string; workspaceRoot: string; workspaceUri: string;
  }>();

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

  private bindingKey(agentName?: string, agentPlatform?: AgentPlatformLabel): string {
    return `${agentName ?? '<unknown>'}\0${agentPlatform ?? '<unknown>'}`;
  }

  private workspace(bindingId: string): DiscoveredAgentWorkspace | undefined {
    const workspaces = this.workspaces();
    const binding = this.bindings.get(bindingId);
    if (!binding) return undefined;
    const exact = workspaces.find((workspace) => workspace.instanceId === binding.instanceId);
    if (exact) return exact;
    const replacements = workspaces.filter((workspace) =>
      this.isSameLogicalTarget(binding, workspace)
    );
    if (replacements.length !== 1) return undefined;
    binding.instanceId = replacements[0].instanceId;
    this.options.log?.(
      `Binding ${bindingId} resumed on republished workspace ${replacements[0].instanceId}`
    );
    return replacements[0];
  }

  private isSameLogicalTarget(
    target: { host: string; mountName: string; workspaceRoot: string; workspaceUri: string },
    workspace: DiscoveredAgentWorkspace
  ): boolean {
    return workspace.host === target.host
      && workspace.mountName === target.mountName
      && workspace.workspaceRoot === target.workspaceRoot
      && workspace.workspaceUri === target.workspaceUri;
  }

  private publicWorkspace(workspace: DiscoveredAgentWorkspace): Record<string, unknown> {
    return {
      workspaceRoot: workspace.workspaceRoot,
      host: workspace.host
    };
  }

  private selectableWorkspace(workspace: DiscoveredAgentWorkspace): Record<string, unknown> {
    return {
      workspaceId: workspace.instanceId,
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
    agentName?: string, agentPlatform?: AgentPlatformLabel,
    source: AgentActivitySource = 'mcp'
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
    if (agentPlatform) url.searchParams.set('platform', agentPlatform);
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
    agentPlatform?: AgentPlatformLabel, source: AgentActivitySource = 'mcp'
  ): Promise<any> {
    if (name === 'cli_list_workspaces') {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          workspaces: this.workspaces().map((workspace) => this.selectableWorkspace(workspace))
        }) }]
      };
    }
    if (name === 'get_remote_workspace' || name === 'switch_remote_workspace') {
      const bindingAgentName = source === 'cli'
        ? requestAgentName(input.agentName)
        : agentName;
      const owner = this.bindingKey(bindingAgentName, agentPlatform);
      if (source === 'cli' && !bindingAgentName) {
        return this.toolError(
          'CLI_AGENT_NAME_REQUIRED',
          'Run safs bind with --agent NAME so this binding can identify the Agent.'
        );
      }
      const workspaces = this.workspaces();
      if (!workspaces.length) {
        return this.toolError(
          'NO_ACTIVE_REMOTE',
          'No active Agent-forwarded Serverless Remote window was found.'
        );
      }
      const switching = name === 'switch_remote_workspace';
      const workspaceId = typeof input.workspaceId === 'string'
        ? input.workspaceId.trim()
        : '';
      const agentCwd = typeof input.agentCwd === 'string' ? input.agentCwd.trim() : '';
      let recoveredLogicalWorkspace = false;
      let workspace = workspaceId
        ? workspaces.find((candidate) => candidate.instanceId === workspaceId)
        : undefined;
      if (switching && workspaceId && input.userConfirmed !== true) {
        return this.toolError(
          'WORKSPACE_SELECTION_NOT_CONFIRMED',
          'Ask the user to choose in the Agent conversation first, then call again with workspaceId and userConfirmed=true.'
        );
      }
      if (workspaceId && !workspace) {
        return this.toolError(
          'REMOTE_WORKSPACE_NOT_FOUND',
          'The selected remote workspace is no longer active.',
          { workspaceId }
        );
      }
      if (switching && !workspaceId) {
        return this.toolError(
          'WORKSPACE_SELECTION_REQUIRED',
          'Active SAFS workspace candidates are listed below. Ask the user to choose one in the Agent conversation, then call this tool again with its workspaceId and userConfirmed=true.',
          {
            candidates: workspaces.map((candidate) => this.selectableWorkspace(candidate)),
            ...(source === 'cli' ? { agentName: bindingAgentName } : {})
          }
        );
      }
      if (!switching) {
        const canonicalCwd = agentCwd ? canonicalAgentCwd(agentCwd) : '';
        const matches = canonicalCwd ? workspaces.filter((candidate) => candidate.agentCwd
          && cwdContains(canonicalAgentCwd(candidate.agentCwd), canonicalCwd)) : [];
        const longest = matches.reduce(
          (length, candidate) => Math.max(length, canonicalAgentCwd(candidate.agentCwd!).length),
          0
        );
        const closest = matches.filter(
          (candidate) => canonicalAgentCwd(candidate.agentCwd!).length === longest
        );
        if (closest.length === 1) workspace = closest[0];
        if (!workspace) {
          const preferred = this.preferredTargets.get(owner);
          const previous = preferred
            ? workspaces.filter((candidate) => this.isSameLogicalTarget(preferred, candidate))
            : [];
          if (previous.length === 1) {
            workspace = previous[0];
            recoveredLogicalWorkspace = true;
          }
        }
        if (!workspace && closest.length === 0) {
          const focused = workspaces.filter((candidate) => candidate.focused);
          if (focused.length === 1) workspace = focused[0];
        }
        if (!workspace) {
          return this.toolError(
            'WORKSPACE_SELECTION_REQUIRED',
            closest.length > 1
              ? 'The Agent cwd matches multiple active SAFS windows. Ask the user to choose one candidate in the Agent conversation, then call this tool again with its workspaceId.'
              : 'The Agent cwd does not match an active SAFS placeholder and there is no unique focused SAFS window. Ask the user to choose one candidate in the Agent conversation, then call switch_remote_workspace with its workspaceId.',
            {
              candidates: workspaces.map((candidate) => this.selectableWorkspace(candidate)),
              ...(source === 'cli' ? { agentName: bindingAgentName } : {})
            }
          );
        }
      }
      const selectedWorkspace = workspace!;
      const bindingId = randomUUID().replace(/-/g, '').slice(0, 16);
      const hybridMcp = source === 'mcp' && this.options.toolProfile?.() === 'hybrid';
      this.bindings.set(bindingId, {
        instanceId: selectedWorkspace.instanceId,
        host: selectedWorkspace.host,
        mountName: selectedWorkspace.mountName,
        workspaceRoot: selectedWorkspace.workspaceRoot,
        workspaceUri: selectedWorkspace.workspaceUri,
        owner,
        agentName: bindingAgentName,
        agentPlatform
      });
      this.preferredTargets.set(owner, {
        host: selectedWorkspace.host,
        mountName: selectedWorkspace.mountName,
        workspaceRoot: selectedWorkspace.workspaceRoot,
        workspaceUri: selectedWorkspace.workspaceUri
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          workspace: this.publicWorkspace(selectedWorkspace),
          bindingId,
          ...(hybridMcp ? {
            cliInstructions: hybridCliInstructions
          } : {}),
          ...(source === 'cli' ? {
            agentName: bindingAgentName,
            selectedAutomatically: !switching,
            ...(recoveredLogicalWorkspace ? { recoveredLogicalWorkspace: true } : {}),
            localFilesystemAllowed: false,
            localShellAllowed: false
          } : {}),
          ...(switching && source === 'cli' ? {
            previousTaskCancelled: true,
            mustWaitForNewUserRequest: true,
            mustStopNow: true,
            message: 'Workspace switched. Stop now and wait for a new user request before doing any remote work.'
          } : switching ? {
            mustStopNow: true,
            message: 'Workspace switched. Stop now and wait for a new user request.'
          } : {})
        }) }]
      };
    }
    const bindingId = typeof input.bindingId === 'string' ? input.bindingId : '';
    if (!bindingId) {
      return this.toolError(
        'WORKSPACE_BINDING_REQUIRED',
        'Call get_remote_workspace first with the Agent current working directory in agentCwd, then pass the returned bindingId.'
      );
    }
    const binding = this.bindings.get(bindingId);
    const cliBindingRequest = source === 'cli';
    if (!binding || (!cliBindingRequest
      && binding.owner !== this.bindingKey(agentName, agentPlatform))) {
      return this.toolError(
        'WORKSPACE_BINDING_INVALID',
        'The workspace binding is invalid for this Agent session. Select the workspace again.'
      );
    }
    const workspace = this.workspace(bindingId);
      if (!workspace) {
        this.bindings.delete(bindingId);
        return this.toolError(
          'WORKSPACE_BINDING_EXPIRED',
          'The selected remote workspace is no longer active. Ask the user before selecting any workspace again.',
          { host: binding.host, workspaceRoot: binding.workspaceRoot }
        );
    }
    const { bindingId: _bindingId, ...publicInput } = input;
    const args = { ...publicInput, mountName: workspace.mountName };
    const effectiveAgentName = cliBindingRequest ? binding.agentName : agentName;
    const effectiveAgentPlatform = cliBindingRequest ? binding.agentPlatform : agentPlatform;
    try {
      return await this.forward(
        workspace, name, args, effectiveAgentName, effectiveAgentPlatform, source
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

  private createProtocolServer(
    agentName?: string, agentPlatform?: AgentPlatformLabel
  ): McpServer {
    const profile = this.options.toolProfile?.();
    const server = new McpServer(
      { name: 'safs-http-router', version: '1.0.0' },
      {
        instructions: profile === 'hybrid'
          ? hybridAgentMcpInstructions
          : routedAgentMcpInstructions
      }
    );
    configureAgentMcpResources(server);
    registerAgentMcpTools(server, {
      routed: true,
      profile,
      invoke: (name, input) => this.callTool(name, input, agentName, agentPlatform, 'mcp')
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
      const platformValue = request.query.platform;
      const agentPlatform = typeof platformValue === 'string'
        && ['wsl', 'mac', 'linux', 'win'].includes(platformValue)
        ? platformValue as AgentPlatformLabel
        : undefined;
      const agentName = requestAgentName(request.query.agent);
      const currentName = currentCliToolName(name);
      try {
        if (name === 'safs_cli_batch') {
          const operations = (input as { operations?: unknown }).operations;
          if (!Array.isArray(operations) || operations.length === 0 || operations.length > 50) {
            response.status(400).json({ ok: false, error: 'CLI batch requires 1 to 50 operations' });
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
                agentName, agentPlatform, 'cli'
              ),
              operation.name === 'current_remote_file'
            );
            results.push({ index, name: operation.name, ...item });
          }
          response.json({ ok: true, result: { results } });
          return;
        }
        response.json(adaptCliToolResult(unwrapCliToolResult(
          await this.callTool(
            currentName, input as Record<string, unknown>, agentName, agentPlatform, 'cli'
          ),
          currentName === 'current_remote_file'
        ), currentName));
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
      const platformValue = request.query.platform;
      const agentPlatform = typeof platformValue === 'string'
        && ['wsl', 'mac', 'linux', 'win'].includes(platformValue)
        ? platformValue as AgentPlatformLabel
        : undefined;
      const method = typeof request.body?.method === 'string' ? request.body.method : 'unknown';
      const tool = request.body?.params?.name;
      this.options.log?.(
        `收到 MCP 请求：${method}${tool ? ` (${tool})` : ''}${
          agentName ? `，agent=${agentName}` : '，agent=<unknown>'
        }${agentPlatform ? `，platform=${agentPlatform}` : ''
        }`
      );
      // 绑定工具由固定路由器本地完成；其它工具只在实际执行窗口记录，避免双份日志。
      if (method === 'tools/call' && typeof tool === 'string'
        && ['get_remote_workspace', 'switch_remote_workspace'].includes(tool)) {
        const input = request.body?.params?.arguments;
        this.options.audit?.({
          toolName: tool,
          input: input && typeof input === 'object' ? input as Record<string, unknown> : {},
          agentName, agentPlatform
        });
      }
      const protocol = this.createProtocolServer(agentName, agentPlatform);
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
