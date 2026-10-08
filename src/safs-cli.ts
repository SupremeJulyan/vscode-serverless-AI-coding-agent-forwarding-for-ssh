#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import * as http from 'node:http';
import { help, commandHelp } from './cli-help';

declare const CLI_VERSION: string;
declare const CLI_SKILL: string;
declare const CLI_REFERENCE: string;
const tools: Record<string, string> = {
  workspaces: 'list_remote_workspaces', 'current-file': 'current_remote_file', list: 'remote_list',
  read: 'remote_read', 'read-many': 'remote_read_many', search: 'remote_search', find: 'remote_search',
  edit: 'remote_edit', write: 'remote_write', create: 'remote_create', delete: 'remote_delete',
  chmod: 'remote_chmod', move: 'remote_move', upload: 'remote_upload', download: 'remote_download',
  output: 'remote_output', exec: 'run_remote_command', batch: 'safs_cli_batch'
};
const allowed: Record<string, string[]> = {
  workspaces: [], 'current-file': [], list: ['path', 'limit', 'cursor'],
  read: ['path', 'offset', 'length', 'head', 'tail', 'start-line', 'line-count'],
  search: ['path', 'query', 'name', 'mode'], find: ['path', 'name'], edit: ['path'],
  write: ['path', 'content'], create: ['path', 'type', 'content'], delete: ['path'],
  chmod: ['path', 'mode'], move: [], upload: [], download: [], 'read-many': [], batch: [],
  output: ['id', 'stream', 'offset', 'length'], exec: ['command']
};
const positional: Record<string, string[]> = {
  list: ['path'], read: ['path'], edit: ['path'], write: ['path'], delete: ['path'],
  create: ['path', 'type'], search: ['query', 'path'], find: ['name', 'path'],
  chmod: ['path', 'mode'], output: ['id', 'stream'], exec: ['command']
};
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
function option(args: string[], flag: string): string | undefined {
  const boundary = args.indexOf('--');
  const i = args.findIndex((v, j) => v === flag && (boundary < 0 || j < boundary));
  if (i < 0) return;
  if (i + 1 >= args.length) throw new Error(`${flag} requires a value`);
  return args.splice(i, 2)[1];
}
async function parse(args: string[]) {
  const verb = args.shift() ?? '';
  try {
    if (!tools[verb]) throw new Error('Unknown command; use --help');
    const input = option(args, '--input');
    const file = option(args, '--file');
    if (input === '-' && file === '-') throw new Error('--input - and --file - cannot read the same stdin');
    let stdin = '';
    if (input === '-' || file === '-') {
      process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) stdin += chunk;
    }
    const values = input === undefined ? {} : JSON.parse(input === '-' ? stdin : input);
    if (!object(values)) throw new Error('--input must contain a JSON object');
    if ('workspaceId' in values || 'mountName' in values) throw new Error('--input must not override workspaceId or mountName');
    let pos = 0;
    const assign = (key: string, value: unknown) => {
      if (key in values) throw new Error(`Duplicate input field: ${key}`);
      values[key] = value;
    };
    while (args.length) {
      const flag = args.shift()!;
      if (flag === '--') {
        if (verb !== 'exec' || args.length !== 1) throw new Error('Pass one remote command after --');
        assign('command', args.shift()); break;
      }
      if (!flag.startsWith('--')) {
        const key = positional[verb]?.[pos++];
        if (!key) throw new Error(`Too many arguments for ${verb}`);
        assign(key, flag); continue;
      }
      const key = flag.slice(2);
      if (!(allowed[verb].includes(key) || (key === 'workspace' && verb !== 'workspaces'))) throw new Error(`Invalid option for ${verb}: ${flag}`);
      const value = args.shift();
      if (value === undefined) throw new Error(`${flag} requires a value`);
      const numeric = ['limit', 'offset', 'length', 'head', 'tail', 'start-line', 'line-count'].includes(key);
      if (numeric && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) throw new Error(`Invalid ${flag}`);
      assign(key === 'start-line' ? 'startLine' : key === 'line-count' ? 'lineCount' : key, numeric ? Number(value) : value);
    }
    if (verb === 'find' || verb === 'search') {
      if ('name' in values) {
        if ('query' in values) throw new Error('Use either --query or --name, not both');
        if (values.mode && values.mode !== 'names') throw new Error('--name requires --mode names');
        values.query = values.name; delete values.name; values.mode = 'names';
      }
      if (verb === 'find') values.mode = 'names';
      if (typeof values.query !== 'string') throw new Error('Search query is required. Use --query for contents or --name for filenames');
      if (values.mode && !['content', 'files', 'count', 'names'].includes(values.mode)) throw new Error('--mode must be content, files, count, or names');
    }
    const workspace = values.workspace; delete values.workspace;
    if (verb !== 'workspaces' && (typeof workspace !== 'string' || !workspace)) throw new Error('--workspace is required. Use the workspaceId returned by `safs workspaces`.');
    if (verb === 'batch') {
      if (!Array.isArray(values.operations) || values.operations.length < 1 || values.operations.length > 50) throw new Error('batch requires 1 to 50 operations');
      const operations = values.operations.map((op: any) => {
        if (!object(op) || !tools[op.command] || ['batch', 'find', 'workspaces'].includes(op.command)) throw new Error(`Unsupported batch command: ${op?.command}`);
        const arguments_ = op.arguments ?? {};
        if (!object(arguments_) || 'workspaceId' in arguments_ || 'mountName' in arguments_) throw new Error('Batch arguments must not override workspaceId or mountName');
        return { name: tools[op.command], arguments: { ...arguments_, workspaceId: workspace } };
      });
      return { name: tools[verb], arguments: { operations } };
    }
    if (verb !== 'workspaces') values.workspaceId = workspace;
    if (verb === 'output') {
      if (!values.id) throw new Error('--id is required');
      values.outputId = values.id; delete values.id;
      if (!['stdout', 'stderr'].includes(values.stream)) throw new Error('--stream stdout|stderr is required');
    }
    if (verb === 'exec' && (typeof values.command !== 'string' || !values.command.trim())) throw new Error("Remote command is required. Retry with `safs exec --workspace ID -- 'COMMAND'` or `--command 'COMMAND'`");
    if (file !== undefined) {
      if (!['write', 'create'].includes(verb)) throw new Error('--file is only valid for write or create');
      assign('content', file === '-' ? stdin : await readFile(file, 'utf8'));
    }
    if (verb === 'write' && !('content' in values)) throw new Error('Write content is required. Retry with `--content TEXT` or pipe UTF-8 data to `--file -`');
    if (verb === 'create') {
      if (!['file', 'directory'].includes(values.type)) throw new Error('Create type must be file or directory');
      if (values.type === 'directory' && 'content' in values) throw new Error('Directory creation does not accept content');
    }
    return { name: tools[verb], arguments: values };
  } catch (error) { throw new Error(`${error instanceof Error ? error.message : error}\n\n${commandHelp[verb] ?? help}`); }
}
let token = '';
function redact(message: string) { return token ? message.replaceAll(token, '<hidden>').replaceAll(encodeURIComponent(token), '<hidden>') : message; }
async function invoke(configPath: string, request: Awaited<ReturnType<typeof parse>>): Promise<any> {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (config.version !== 1) throw new Error('Unsupported SAFS connection file');
  const url = new URL(config.url);
  token = url.searchParams.get('token') ?? '';
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !token || url.username || url.password) throw new Error('SAFS connection must be an authenticated loopback URL');
  url.pathname = '/cli';
  let timeout = Number.isSafeInteger(config.timeoutMs) && config.timeoutMs >= 0 ? config.timeoutMs : 120000;
  if (timeout && request.name === 'safs_cli_batch') timeout = timeout * request.arguments.operations.length + 5000;
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', error => { if (timer) clearTimeout(timer); reject(error); });
      res.on('end', () => {
        if (timer) clearTimeout(timer);
        try {
          const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) throw new Error(`SAFS router HTTP ${res.statusCode}: ${envelope.error ?? 'Router rejected request'}`);
          if (!('result' in envelope)) throw new Error(envelope.error ?? 'SAFS router returned no result');
          resolve(envelope.result);
        } catch (error) { reject(error); }
      });
    });
    req.on('error', error => { if (timer) clearTimeout(timer); reject(new Error(`Local SAFS router request failed: ${error.message}`)); });
    if (timeout) timer = setTimeout(() => req.destroy(new Error('Request timed out; remote operations may still be running. Inspect remote state before retrying.')), timeout);
    req.end(JSON.stringify(request));
  });
}
function exitCode(result: any): number {
  if (Number.isInteger(result.exitCode) && result.exitCode >= 0 && result.exitCode <= 255) return result.exitCode;
  return result.code || result.status === 'error' || result.results?.some((r: any) => r.ok === false || r.status === 'error' || r.result?.exitCode) ? 1 : 0;
}
function concise(result: any): string {
  const failed = result.results?.find((r: any) => r.ok === false);
  if (failed) return `batch[${failed.index ?? 0}]: ${concise(failed.result ?? {})}`;
  return [result.code, result.message ?? result.error].filter(Boolean).join(': ') || 'SAFS operation failed';
}
function compact(result: any): any {
  if (Array.isArray(result)) return result.map(compact);
  if (!object(result)) return result;
  return Object.fromEntries(Object.entries(result).filter(([k, v]) => !(k === 'status' && v === 'ok' || k === 'ok' && v === true || ['truncated', 'hasMore'].includes(k) && v === false)).map(([k,v]) => [k,compact(v)]));
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--version', '-V'].includes(args[0])) { console.log(`safs ${CLI_VERSION}`); return; }
  for (let i = 0; i < args.length && args[i] !== '--'; i++) {
    if (['--help', '-h'].includes(args[i])) { process.stdout.write(commandHelp[args[0]] ?? help); return; }
    if (args[i].startsWith('--') && !['--compact', '--verbose', '--skills', '--global'].includes(args[i]) && !args[i].startsWith('--skills=')) i++;
  }
  if (args[0] === 'install') {
    try {
      const skill = args.find(v => v === '--skills' || v.startsWith('--skills='));
      const target = skill?.split('=')[1] ?? 'agents';
      if (!['agents', 'claude', 'codex', 'copilot'].includes(target)) throw new Error(`Unsupported skill target: ${target}`);
      if (!skill || args.slice(1).some(v => v !== skill && v !== '-g' && v !== '--global')) throw new Error('Use install --skills[=agents|claude|codex|copilot] [-g]');
      const directory = join(args.includes('-g') || args.includes('--global') ? homedir() : process.cwd(), `.${target}`, 'skills', 'safs-cli');
      await mkdir(join(directory, 'references'), { recursive: true });
      await writeFile(join(directory, 'SKILL.md'), CLI_SKILL.replaceAll('\r\n', '\n'));
      await writeFile(join(directory, 'references', 'commands.md'), CLI_REFERENCE.replaceAll('\r\n', '\n'));
      console.log(`Installed SAFS skill to ${directory}`); return;
    } catch (error) { throw new Error(`${error instanceof Error ? error.message : error}\n\n${commandHelp.install}`); }
  }
  const config = option(args, '--config') ?? process.env.SAFS_CONFIG ?? join(dirname(process.argv[1]), '.safs-connection.json');
  const isCompact = args.includes('--compact'), verbose = args.includes('--verbose');
  const boundary = args.indexOf('--');
  const request = await parse(args.filter((v,i) => !(i < (boundary < 0 ? args.length : boundary) && ['--compact','--verbose'].includes(v))));
  let result = await invoke(config, request);
  const code = exitCode(result);
  if (code && (request.name !== 'run_remote_command' || result.code || result.status === 'error')) throw new Error(verbose ? JSON.stringify(result) : concise(result));
  if (isCompact) result = compact(result);
  if (request.name === 'run_remote_command') {
    process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
    if (result.truncated) process.stderr.write('\n'+JSON.stringify({ safsOutput: result })+'\n');
  } else console.log(JSON.stringify(result));
  process.exitCode = code;
}
main().catch(error => { process.stderr.write(`SAFS: ${redact(error instanceof Error ? error.message : String(error))}\n`); process.exitCode = 1; });
