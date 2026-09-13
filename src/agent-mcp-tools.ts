import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ListResourcesRequestSchema, ListResourceTemplatesRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const workspaceInstructions = [
  'SAFS tools operate on remote files, not the local host filesystem. Do not call SAFS tools for ordinary local workspaces. Use only for explicit SAFS tasks or known safs:// context.',
  'For SAFS remote operations, use the MCP tools only. Never pass remote paths to local filesystem tools or a local shell.',
  'Relative paths use the bound workspace root. Use search to locate relevant files and bounded reads for evidence; batch independent selections with remote_read_many.',
  'Prefer remote_edit for small edits and remote_write for full replacements. When available, use structured delete/move/chmod tools for those changes.',
  'Structured mutation tools are strictly limited to the selected workspace root. run_remote_command is not a general-purpose filesystem sandbox; never use it or shell redirection for file operations or to bypass a rejected structured operation.',
  'Inspect truncation and per-item status. For commands, a nonzero exitCode means failure. For searches, inspect status. Continue reads with returned cursors/offsets; fetch retained output with remote_output instead of rerunning commands. Binary/large transfers use transfer tools when available.'
].join(' ');

export const directAgentMcpInstructions = workspaceInstructions +
  ' Call get_remote_workspace once to identify this window workspace.';

export const routedAgentMcpInstructions = workspaceInstructions + ' ' + [
  'Initially bind with get_remote_workspace(agentCwd=the absolute cwd on the Agent machine). An exact placeholder cwd, the unique previously selected logical target, or one uniquely focused window can bind automatically.',
  'If candidates are returned, show them and wait for the user to choose. Never select in the same turn as asking or infer consent from a single candidate. Only after the reply call switch_remote_workspace(workspaceId, userConfirmed=true).',
  'Call switch_remote_workspace without arguments to list workspaces before a user-directed change. A successful switch cancels the old task: stop and wait for a new request.',
  'Pass bindingId to subsequent tools. It stays pinned to the selected logical workspace and may follow its unique republished instance; on expiry stop and report, never silently select or switch to another workspace.'
].join(' ');

export const hybridCliInstructions = [
  'Run every remote operation through the global safs CLI and pass --binding <bindingId> using the bindingId from this result.',
  'Use structured safs commands for every remote file operation. Never use local filesystem tools or safs exec to read, list, search, write, edit, move, delete, change permissions, upload, or download remote files.',
  'Reserve safs exec for task commands such as builds and tests. If a structured file operation is rejected, report the error and do not retry it through safs exec.'
].join(' ');

export const hybridAgentMcpInstructions = [
  'Use get_remote_workspace to bind the current SAFS workspace.',
  'Use switch_remote_workspace only after the user explicitly chooses a candidate, whether for initial selection or a later change.',
  'After either tool returns a bindingId, follow the cliInstructions in that binding result; use safs --help for command syntax.',
  'A successful switch cancels the previous task, so stop and wait for a new user request.'
].join(' ');

export type AgentToolProfile = 'full' | 'core' | 'hybrid';
const extendedTools = new Set(['current_remote_file', 'remote_delete', 'remote_chmod',
  'remote_move', 'remote_upload', 'remote_download']);
const hybridTools = new Set<AgentMcpToolName>([
  'get_remote_workspace', 'switch_remote_workspace'
]);

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
  path: z.string().min(1).describe('Remote file path. Relative paths start at workspaceRoot.'),
  offset: z.number().int().min(0).optional().describe('UTF-8 byte offset; mutually exclusive with head, tail, and startLine.'),
  length: z.number().int().min(4).max(65536).optional().describe('Maximum returned content bytes; defaults to 8192.'),
  head: z.number().int().min(1).optional().describe('Return at most this many leading lines; mutually exclusive with offset, tail, and startLine.'),
  tail: z.number().int().min(1).optional().describe('Return at most this many trailing lines; mutually exclusive with offset, head, and startLine.'),
  startLine: z.number().int().min(1).optional().describe('One-based first line; mutually exclusive with offset, head, and tail.'),
  lineCount: z.number().int().min(1).optional().describe('Line count used only with startLine; defaults to 100.')
};

function toolDefinitions(routed: boolean): AgentMcpToolDefinition[] {
  const binding: Record<string, z.ZodTypeAny> = routed
    ? { bindingId: z.string().min(1).describe('Binding returned by get_remote_workspace or switch_remote_workspace.') }
    : {};
  const definitions: AgentMcpToolDefinition[] = [
    {
      name: 'get_remote_workspace',
      title: routed ? 'Bind a SAFS remote workspace' : 'Bind this SAFS remote workspace',
      description: routed
        ? 'Initially binds a SAFS workspace. agentCwd is the absolute local cwd on the Agent machine, usually a SAFS placeholder; never pass a remote path or workspaceRoot. Resolution prefers an exact placeholder match, then the unique previously selected logical target, then one uniquely focused SAFS window. This tool never switches to a different target. If selection is ambiguous, show the returned candidates and wait for the user before calling switch_remote_workspace. Returns workspace and bindingId; hybrid mode also returns cliInstructions.'
        : 'Returns the SAFS workspace served by this exact VS Code window for later remote tool calls.',
      inputSchema: routed ? {
        agentCwd: z.string().min(1).describe('Absolute current working directory on the Agent machine; not a remote path.')
      } : {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    {
      name: 'current_remote_file',
      title: 'Get the currently open remote file',
      description: routed
        ? 'Returns the remote file open in the active VS Code editor of the bound window, or null when none is open. Fields are path, relative (from the mount root), size, modified, dirty, and exists.'
        : 'Returns the remote file open in the active VS Code editor of this window, or null when none is open. Fields are path, relative (from the mount root), size, modified, dirty, and exists.',
      inputSchema: binding,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    {
      name: 'remote_list',
      title: 'List a remote directory',
      description: 'Lists directory entries directly over SFTP. Use either path/cursor for one directory or paths for a batch; never combine paths with path or cursor. Omitting path lists workspaceRoot. Relative paths start at workspaceRoot; an explicit absolute path may perform read-only inspection outside it. limit defaults to 100 and is shared by a batch of up to 16 paths. Results are sorted and include path, entries, total, truncated, and optionally nextCursor. A changed directory invalidates its cursor; resume batched paths individually.',
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
      description: 'Reads a bounded UTF-8 text chunk directly over SFTP. Relative paths start at workspaceRoot; an explicit absolute path may perform read-only inspection outside it. Choose at most one selector: offset (bytes), head, tail, or startLine with optional lineCount. length is the content-byte budget, default 8192 and maximum 65536. Tail is limited to the last length bytes; selectionTruncated means the requested lines did not fit. Line lookup scans at most 16 MiB. Binary or invalid UTF-8 content is rejected; remote_download is available only when that file is inside workspaceRoot. Continue truncated reads with nextOffset.',
      inputSchema: {
        ...binding,
        ...textReadSchema
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    {
      name: 'remote_read_many', title: 'Read selected chunks from multiple files',
      description: 'Reads up to 16 independent text selections using the same path and selector rules as remote_read. maxBytes is a shared content-byte budget, default 16384 and maximum 65536. Each item is ok, error, or not_read when the budget is exhausted; one failure does not stop later items. Returns results, contentBytes, and maxBytes.',
      inputSchema: { ...binding, requests: z.array(z.object(textReadSchema)).min(1).max(16),
        maxBytes: z.number().int().min(4).max(65536).optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    {
      name: 'remote_edit',
      title: 'Edit a remote text file',
      description: 'Atomically applies exact text replacements to an existing UTF-8 file inside workspaceRoot. Each oldText must match exactly once; all edits are validated in order before anything is written. expectedHash accepts the hash returned by a previous remote_edit to reject later unrelated changes. The source and result are capped at 1 MiB. Returns path, replacements, bytes, beforeHash, and the new hash.',
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
      description: 'Creates or completely replaces one UTF-8 file inside workspaceRoot directly over SFTP. The parent directory must already exist; use remote_edit for small changes and remote_upload for large content. Returns the normalized path and UTF-8 byte count.',
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
      description: 'Streams up to 100 local files or folders to a directory inside workspaceRoot with VS Code progress and cancellation. The Agent supplies paths directly; no picker opens and file bytes do not pass through the MCP conversation. localPaths must be absolute existing paths inside the bound workspace\'s SAFS staging root, normally the placeholder matched by agentCwd. Relative remoteDirectory starts at workspaceRoot. Returns completed and the normalized remoteDirectory.',
      inputSchema: {
        ...binding,
        localPaths: z.array(z.string().min(1)).min(1).max(100),
        remoteDirectory: z.string().min(1)
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    },
    {
      name: 'remote_download',
      title: 'Download a remote file or folder locally',
      description: 'Streams a file or folder from inside workspaceRoot to the local SAFS staging root with VS Code progress and cancellation. Relative remotePath starts at workspaceRoot. localPath is the exact absolute destination inside the bound workspace\'s staging root, normally the placeholder matched by agentCwd; an existing destination may be replaced. No picker opens. Returns completed plus the normalized remotePath and localPath.',
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
      description: 'Searches read-only on the remote SSH host. Relative paths start at workspaceRoot; an explicit absolute path may inspect outside it. Modes: content (default, matching lines), files (files whose content matches), count (per-file content match counts, including zeros), and names (files whose basename matches a shell glob such as *.ts). content/files/count use basic grep regex unless fixedStrings=true. names supports ignoreCase but not fixedStrings or contextLines. include filters basenames; excludeDirs replaces the default dependency/build exclusions, and [] searches every directory. Returns mode, status (matches, no_matches, or error), exitCode, stdout/stderr preview, returnedLineCount, and truncation/continuation metadata when needed.',
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
      description: 'Reads retained stdout or stderr without rerunning a command or search. Use outputId and the selected stream nextOffset from its preview. offset defaults to 0; length defaults to 8192 bytes and is capped at 65536. Handles expire after 10 minutes or earlier under memory pressure. retentionTruncated means the original capture was incomplete.',
      inputSchema: { ...binding, outputId: z.string().regex(/^[a-f0-9]{32}$/),
        stream: z.enum(['stdout', 'stderr']), offset: z.number().int().min(0).optional(),
        length: z.number().int().min(4).max(65536).optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    {
      name: 'run_remote_command',
      title: 'Run a remote SSH command',
      description: routed
        ? 'Runs a task command such as a build or test on the bound SSH host. The default working directory is workspaceRoot; relative remoteCwd starts there and every remoteCwd must remain inside it. Common outside-workspace shell write targets are rejected, but this is not a general-purpose filesystem sandbox: use structured tools for every file operation. Returns remoteCwd, exitCode, stdout/stderr preview, and truncation/continuation metadata when needed. A nonzero exitCode means the command failed even when the MCP call itself succeeded.'
        : 'Runs a task command such as a build or test on the selected SSH host. The default working directory is workspaceRoot; relative remoteCwd starts there and every remoteCwd must remain inside it. Common outside-workspace shell write targets are rejected, but this is not a general-purpose filesystem sandbox: use structured tools for every file operation. Returns remoteCwd, exitCode, stdout/stderr preview, and truncation/continuation metadata when needed. A nonzero exitCode means the command failed even when the MCP call itself succeeded.',
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
      description: 'Use exactly one of two forms. Call with no arguments to list active candidates. After showing them and receiving an explicit user choice in a later turn, call with both workspaceId and userConfirmed=true. Never infer confirmation from one candidate. Success returns workspace and a new bindingId, cancels the previous task, and requires stopping immediately for a new user request.',
      inputSchema: {
        workspaceId: z.string().min(1).optional().describe('Candidate workspaceId explicitly chosen by the user; omit only when listing.'),
        userConfirmed: z.literal(true).optional().describe('Must be true with workspaceId, and only after an explicit user reply; omit when listing.')
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
    if (options.profile === 'hybrid' && !hybridTools.has(definition.name)) continue;
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
