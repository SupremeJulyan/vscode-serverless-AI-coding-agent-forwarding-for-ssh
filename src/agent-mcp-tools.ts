import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ListResourcesRequestSchema, ListResourceTemplatesRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const workspaceInstructions = [
  'SAFS tools operate on remote files, not the local host filesystem. Do not call SAFS tools for ordinary local workspaces. Use only for explicit SAFS tasks or known safs:// context.',
  'Relative paths use the bound workspace root. Use search to locate relevant files and bounded reads for evidence; batch independent selections with remote_read_many.',
  'Prefer remote_edit for small edits and remote_write for full replacements. When available, use structured delete/move/chmod tools for those changes.',
  'Inspect truncation and per-item status. Continue reads with returned cursors/offsets; fetch command output with remote_output instead of rerunning commands. Binary/large transfers use transfer tools when enabled.',
  'Local shell may invoke the SAFS CLI transport only; never treat remote paths as local files.'
].join(' ');

export const directAgentMcpInstructions = workspaceInstructions +
  ' Call get_remote_workspace once to identify this window workspace.';

export const routedAgentMcpInstructions = workspaceInstructions + ' ' + [
  'Bind once with get_remote_workspace(agentCwd=actual cwd). Exact placeholder cwd or one uniquely focused window binds automatically.',
  'If candidates are returned, ask the user to choose; Never select in the same turn as asking; only after their reply call switch_remote_workspace(workspaceId, userConfirmed=true). Never infer consent from a single candidate.',
  'For listing or switching workspaces use switch_remote_workspace. A successful switch cancels the old task: stop and wait for a new request.',
  'Pass bindingId to subsequent tools. It is pinned to the window instance; on expiry stop and report, never silently rebind or switch.'
].join(' ');

export type AgentToolProfile = 'full' | 'core';
const extendedTools = new Set(['current_remote_file', 'remote_delete', 'remote_chmod',
  'remote_move', 'remote_upload', 'remote_download']);

export type AgentMcpToolName =
  | 'get_remote_workspace'
  | 'switch_remote_workspace'
  | 'current_remote_file'
  | 'remote_list'
  | 'remote_read'
  | 'remote_read_many'
  | 'remote_output'
  | 'remote_edit'
  | 'remote_write'
  | 'remote_delete'
  | 'remote_chmod'
  | 'remote_move'
  | 'remote_upload'
  | 'remote_download'
  | 'remote_search'
  | 'run_remote_command';

interface AgentMcpToolDefinition {
  name: AgentMcpToolName;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
  };
}

const textReadSchema = {
  path: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  length: z.number().int().min(4).max(65536).optional(),
  head: z.number().int().min(1).optional(), tail: z.number().int().min(1).optional(),
  startLine: z.number().int().min(1).optional(), lineCount: z.number().int().min(1).optional()
};

function toolDefinitions(routed: boolean): AgentMcpToolDefinition[] {
  const binding: Record<string, z.ZodTypeAny> = routed
    ? { bindingId: z.string().min(1) }
    : {};
  const definitions: AgentMcpToolDefinition[] = [
    {
      name: 'get_remote_workspace',
      title: routed ? 'Bind a SAFS remote workspace' : 'Bind this SAFS remote workspace',
      description: routed
        ? 'Gets and initially binds the SAFS workspace matching the Agent actual current working directory in agentCwd, or the uniquely focused SAFS window when cwd does not match. This tool never switches workspaces. If neither is unique, ask the user to choose a returned candidate and use switch_remote_workspace. The returned bindingId stays pinned to that window instance.'
        : 'Returns the SAFS workspace served by this exact VS Code window for later remote tool calls.',
      inputSchema: routed ? {
        agentCwd: z.string().min(1)
      } : {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    {
      name: 'current_remote_file',
      title: 'Get the currently open remote file',
      description: routed
        ? 'Returns the remote file open in the active VS Code editor of the bound window (absolute path, relative path, size, dirty), or null when none is open.'
        : 'Returns the remote file open in the active VS Code editor of this window: absolute path, relative path, size, and dirty (unsaved changes). null when none is open.',
      inputSchema: binding,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    {
      name: 'remote_list',
      title: 'List a remote directory',
      description: 'Lists files directly over SFTP. Relative paths start at the current VS Code workspace root. Returns up to 100 sorted entries by default. Continue with nextCursor; a changed directory invalidates the cursor. Alternatively pass paths (up to 16) for a batch sharing limit; each item reports status and its own nextCursor. Resume individual paths separately.',
      inputSchema: {
        ...binding,
        path: z.string().optional(),
        paths: z.array(z.string().min(1)).min(1).max(16).optional(),
        limit: z.number().int().min(1).max(10000).optional(),
        cursor: z.string().max(2048).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    {
      name: 'remote_read',
      title: 'Read a remote text file',
      description: 'Reads a bounded UTF-8 text chunk directly over SFTP. Relative paths start at the current VS Code workspace root; absolute paths may inspect files outside it for environment diagnostics. Choose offset (bytes), head/tail (lines), or startLine with optional lineCount (default 100). length is a byte budget, default 8192, maximum 65536. Tail is limited to the last length bytes; selectionTruncated means requested lines did not fit. Line lookup scans at most 16 MiB. Binary or invalid UTF-8 content is rejected; use remote_download instead. Continue truncated reads with nextOffset.',
      inputSchema: {
        ...binding,
        ...textReadSchema
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    {
      name: 'remote_read_many', title: 'Read selected chunks from multiple files',
      description: 'Reads up to 16 independent text selections with a shared content-byte budget (default 16384). Same selectors as remote_read. Each result is ok, error, or not_read when the budget is exhausted; failures do not stop later reads. Metadata is outside the content budget.',
      inputSchema: { ...binding, requests: z.array(z.object(textReadSchema)).min(1).max(16),
        maxBytes: z.number().int().min(4).max(65536).optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    {
      name: 'remote_edit',
      title: 'Edit a remote text file',
      description: 'Atomically applies exact text replacements to an existing UTF-8 file inside the current workspace. Each oldText must match exactly once; all edits are validated in order before anything is written. Use expectedHash from a prior result to reject stale edits. Files and resulting content are capped at 1 MiB.',
      inputSchema: {
        ...binding,
        path: z.string().min(1),
        edits: z.array(z.object({
          oldText: z.string().min(1),
          newText: z.string()
        })).min(1).max(100),
        expectedHash: z.string().regex(/^[0-9a-fA-F]{64}$/).optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    {
      name: 'remote_write',
      title: 'Write a remote file',
      description: 'Creates or replaces a UTF-8 file directly over SFTP.',
      inputSchema: { ...binding, path: z.string().min(1), content: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    {
      name: 'remote_delete',
      title: 'Delete a remote file or directory',
      description: 'Deletes a path directly over SFTP after verifying it stays inside the current remote workspace. Set recursive=true for a non-empty directory. The workspace root itself cannot be deleted.',
      inputSchema: {
        ...binding,
        path: z.string().min(1),
        recursive: z.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    {
      name: 'remote_chmod',
      title: 'Change remote file permissions',
      description: 'Changes one remote file or directory mode directly over SFTP after real-path workspace validation. mode is exactly three octal digits such as 644 or 755; setuid, setgid, and sticky bits are not accepted.',
      inputSchema: {
        ...binding,
        path: z.string().min(1),
        mode: z.string().regex(/^[0-7]{3}$/)
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    {
      name: 'remote_move',
      title: 'Move or rename a remote path',
      description: 'Moves or renames a remote file or directory directly over SFTP. Both paths and their real parents must stay inside the current remote workspace. overwrite defaults to false. The workspace root itself cannot be moved.',
      inputSchema: {
        ...binding,
        sourcePath: z.string().min(1),
        targetPath: z.string().min(1),
        overwrite: z.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    {
      name: 'remote_upload',
      title: 'Upload local files to the remote workspace',
      description: 'Streams local files or folders to a remote directory with VS Code progress and cancellation. The Agent supplies paths directly; no path picker is opened and file bytes do not pass through the MCP conversation. localPaths must be absolute existing paths inside the Agent current cwd staging directory. Relative remoteDirectory starts at the current remote workspace root.',
      inputSchema: {
        ...binding,
        localPaths: z.array(z.string().min(1)).min(1),
        remoteDirectory: z.string().min(1)
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    {
      name: 'remote_download',
      title: 'Download a remote file or folder locally',
      description: 'Streams a remote file or folder to localPath with VS Code progress and cancellation. The Agent supplies both paths directly; no path picker is opened. Relative remotePath starts at the current remote workspace root. localPath is the exact absolute destination file or directory path inside the Agent current cwd staging directory.',
      inputSchema: {
        ...binding,
        remotePath: z.string().min(1),
        localPath: z.string().min(1)
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    {
      name: 'remote_search',
      title: 'Search remote files',
      description: 'Searches on the remote SSH host. Relative paths start at the current VS Code workspace root. Modes: content (default, matching content lines), files (paths of files whose CONTENT matches), count (content-match counts per file, including zeros), names (paths of files whose BASENAME matches the query glob). For content/files/count, query uses basic grep regex unless fixedStrings=true. For names, query is a shell-style basename glob such as *.ts and ignoreCase selects case-insensitive matching; fixedStrings/contextLines are invalid. include filters basenames; excludeDirs overrides default dependency/build exclusions (use [] to search all directories). status distinguishes matches, no_matches and error; truncated means results are incomplete.',
      inputSchema: {
        ...binding, query: z.string().min(1), path: z.string().optional(),
        mode: z.enum(['content', 'files', 'count', 'names']).optional(),
        fixedStrings: z.boolean().optional(), ignoreCase: z.boolean().optional(),
        contextLines: z.number().int().min(0).max(20).optional(),
        include: z.array(z.string().min(1).max(256)).max(20).optional(),
        excludeDirs: z.array(z.string().min(1).max(256)).max(40).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    {
      name: 'remote_output', title: 'Read retained command output',
      description: 'Reads original retained stdout or stderr without rerunning a command. Use outputId and stream nextOffset from the preview. Handles expire after 10 minutes or earlier under memory pressure; retentionTruncated on the preview means the capture itself was incomplete.',
      inputSchema: { ...binding, outputId: z.string().regex(/^[a-f0-9]{32}$/),
        stream: z.enum(['stdout', 'stderr']), offset: z.number().int().min(0).optional(),
        length: z.number().int().min(4).max(65536).optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    {
      name: 'run_remote_command',
      title: 'Run a remote SSH command',
      description: routed
        ? 'Runs a command on the bound SSH host. The default working directory is the current VS Code workspace root. This is not a filesystem sandbox: the command has all permissions of the configured SSH account; prefer structured file tools for workspace changes.'
        : 'Runs a shell command on the selected SSH host. The default working directory is the current VS Code workspace root. This is not a filesystem sandbox: the command has all permissions of the configured SSH account; prefer structured file tools for workspace changes.',
      inputSchema: {
        ...binding, command: z.string().min(1), remoteCwd: z.string().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
    }
  ];
  if (routed) {
    definitions.splice(1, 0, {
      name: 'switch_remote_workspace',
      title: 'Switch SAFS remote workspace',
      description: 'Lists active SAFS workspaces when called without workspaceId. Ask the user to choose a candidate, then call again with workspaceId and userConfirmed=true. A successful switch returns a new bindingId and cancels the previous task. No VS Code Quick Pick or focused-window fallback is used.',
      inputSchema: {
        workspaceId: z.string().min(1).optional(),
        userConfirmed: z.literal(true).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    });
  }
  return definitions;
}

export function configureAgentMcpResources(server: McpServer): void {
  server.server.registerCapabilities({ resources: {} });
  server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  server.server.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    async () => ({ resourceTemplates: [] })
  );
}

export function registerAgentMcpTools(
  server: McpServer,
  options: {
    routed: boolean;
    profile?: AgentToolProfile;
    invoke(name: AgentMcpToolName, input: Record<string, unknown>): Promise<any>;
  }
): void {
  for (const definition of toolDefinitions(options.routed)) {
    if (options.profile === 'core' && extendedTools.has(definition.name)) continue;
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: definition.annotations
      },
      async (input) => options.invoke(
        definition.name, (input ?? {}) as Record<string, unknown>
      )
    );
  }
}
