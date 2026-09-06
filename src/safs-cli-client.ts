import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface CliRequest { name: string; arguments: Record<string, unknown> }

export function parseCliRequest(argv: string[], cwd: string): CliRequest {
  const [verb, ...args] = argv;
  const flags: Record<string, string> = {};
  let command: string | undefined;
  const allowed: Record<string, string[]> = {
    bind: ['cwd'], exec: ['binding', 'cwd'], output: ['binding', 'id', 'stream', 'offset', 'length']
  };
  if (!allowed[verb]) throw new Error('Expected bind, exec, or output. Use --help for usage.');
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
  if (!flags.binding) throw new Error('--binding is required; the CLI never automatically rebinds.');
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
