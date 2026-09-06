import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface CliRequest { name: string; arguments: Record<string, unknown> }

export function parseCliRequest(argv: string[], cwd: string): CliRequest {
  const [verb, ...args] = argv;
  const flags: Record<string, string> = {};
  let command: string | undefined;
  const allowed: Record<string, string[]> = {
    list: ['binding', 'path', 'limit', 'cursor'], read: ['binding', 'path', 'offset', 'length', 'head', 'tail', 'start-line', 'line-count'],
    search: ['binding', 'path', 'query', 'mode'], edit: ['binding', 'path'], write: ['binding', 'path'],
    upload: ['binding'], download: ['binding'], delete: ['binding', 'path'], move: ['binding'], chmod: ['binding', 'path', 'mode'],
    'read-many': ['binding'], workspaces: [], switch: ['workspace', 'confirmed'],
    bind: ['cwd'], exec: ['binding', 'cwd'], output: ['binding', 'id', 'stream', 'offset', 'length']
  };
  if (!allowed[verb]) throw new Error('Unknown command. Use --help for usage.');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') {
      if (verb !== 'exec' || args.length - i !== 2) throw new Error('Pass one quoted remote command after --.');
      command = args[i + 1]; break;
    }
    const key = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !allowed[verb].includes(key) || flags[key] !== undefined || args[i + 1] === undefined) {
      throw new Error(`Invalid or duplicate option: ${args[i]}`);
    }
    flags[key] = args[++i];
  }
  if (verb === 'bind') return { name: 'safs_get_remote_workspace', arguments: { agentCwd: flags.cwd ?? cwd } };
  if (verb === 'workspaces') return { name: 'safs_switch_remote_workspace', arguments: {} };
  if (verb === 'switch') {
    if (!flags.workspace || flags.confirmed !== 'true') throw new Error('Switch requires --workspace ID --confirmed true after user confirmation.');
    return { name: 'safs_switch_remote_workspace', arguments: { workspaceId: flags.workspace, userConfirmed: true } };
  }
  const toolNames: Record<string, string> = { list: 'remote_list', read: 'remote_read', search: 'remote_search',
    edit: 'remote_edit', write: 'remote_write', upload: 'remote_upload', download: 'remote_download',
    delete: 'remote_delete', move: 'remote_move', chmod: 'remote_chmod', 'read-many': 'remote_read_many' };
  if (!flags.binding) throw new Error('--binding is required; the CLI never automatically rebinds.');
  if (toolNames[verb]) {
    const input: Record<string, unknown> = { bindingId: flags.binding };
    const numeric = new Set(['limit', 'offset', 'length', 'head', 'tail', 'start-line', 'line-count']);
    for (const [key, value] of Object.entries(flags)) {
      if (key === 'binding') continue;
      if (numeric.has(key) && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) throw new Error(`Invalid --${key}.`);
      const name = key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      input[name] = numeric.has(key) ? Number(value) : value;
    }
    return { name: toolNames[verb], arguments: input };
  }
  if (verb === 'exec') {
    if (!command?.trim()) throw new Error('Pass one quoted remote command after --.');
    return { name: 'run_remote_command', arguments: { bindingId: flags.binding, command,
      ...(flags.cwd ? { remoteCwd: flags.cwd } : {}) } };
  }
  if (!flags.id || !['stdout', 'stderr'].includes(flags.stream)) throw new Error('--id and --stream stdout|stderr are required.');
  const numbers: Record<string, number> = {};
  for (const key of ['offset', 'length']) if (flags[key] !== undefined) {
    const value = Number(flags[key]);
    if (!/^\d+$/.test(flags[key]) || !Number.isSafeInteger(value)) throw new Error(`Invalid --${key}.`);
    numbers[key] = value;
  }
  return { name: 'remote_output', arguments: { bindingId: flags.binding, outputId: flags.id,
    stream: flags.stream, ...numbers } };
}

/** JSON files carry arrays/edits without shell escaping; binding is always explicit. */
export async function prepareCliRequest(argv: string[], cwd: string, load: (path: string) => Promise<string>) {
  const args = [...argv];
  const take = (flag: string) => {
    const separator = args.indexOf('--');
    const index = args.findIndex((arg, i) => arg === flag && (separator < 0 || i < separator));
    if (index < 0) return undefined;
    if (!args[index + 1]) throw new Error(`${flag} requires a file path.`);
    return args.splice(index, 2)[1];
  };
  const inputFile = take('--input');
  const contentFile = take('--file');
  const request = parseCliRequest(args, cwd);
  if (inputFile) {
    if (!request.name.startsWith('remote_')) throw new Error('--input is only supported for structured file commands.');
    const input = JSON.parse(await load(inputFile));
    if (!input || typeof input !== 'object' || Array.isArray(input) || 'bindingId' in input || 'mountName' in input) {
      throw new Error('Input must be an object without bindingId or mountName.');
    }
    for (const key of Object.keys(input)) if (key in request.arguments) throw new Error(`Duplicate input field: ${key}`);
    request.arguments = { ...input, ...request.arguments };
  }
  if (contentFile) {
    if (request.name !== 'remote_write' || 'content' in request.arguments) throw new Error('--file is only valid for write and cannot duplicate content.');
    request.arguments.content = await load(contentFile);
  }
  return request;
}

export async function callSafs(urlValue: string, request: CliRequest) {
  const url = new URL(urlValue);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || !url.searchParams.get('token')) {
    throw new Error('SAFS_MCP_URL must be an authenticated loopback HTTP MCP URL.');
  }
  if (!url.searchParams.has('agent')) url.searchParams.set('agent', 'safs-cli');
  const client = new Client({ name: 'safs-cli', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url, { fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }) }));
    const result = await client.callTool(request, undefined, { timeout: 120_000 });
    const text = (result.content as Array<{ type: string; text?: string }>)
      .filter(item => item.type === 'text').map(item => item.text ?? '').join('\n');
    if (result.isError) throw new Error(text || 'SAFS tool failed.');
    return JSON.parse(text) as Record<string, unknown>;
  } finally { await client.close(); }
}
