#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { ipcRequest } from './agent/agent-ipc';
import { resolveWorkspaceId } from './agent/workspace-id';
import { help, commandHelp } from './cli/cli-help';

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
  output: ['output-id', 'stream', 'offset', 'length'], exec: ['command']
};
const positional: Record<string, string[]> = {
  list: ['path'], read: ['path'], edit: ['path'], write: ['path'], delete: ['path'],
  create: ['path', 'type'], search: ['query', 'path'], find: ['name', 'path'],
  chmod: ['path', 'mode'], output: ['outputId', 'stream'], exec: ['command']
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
      if (!(allowed[verb].includes(key) || (key === 'id' && verb !== 'workspaces'))) throw new Error(`Invalid option for ${verb}: ${flag}`);
      const value = args.shift();
      if (value === undefined) throw new Error(`${flag} requires a value`);
      const numeric = ['limit', 'offset', 'length', 'head', 'tail', 'start-line', 'line-count'].includes(key);
      if (numeric && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) throw new Error(`Invalid ${flag}`);
      assign(key === 'id' ? 'workspace' : key === 'output-id' ? 'outputId' : key === 'start-line' ? 'startLine' : key === 'line-count' ? 'lineCount' : key, numeric ? Number(value) : value);
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
    const workspace = values.workspace ?? (verb === 'workspaces' ? undefined : await inferWorkspace()); delete values.workspace;
    if (verb !== 'workspaces' && (typeof workspace !== 'string' || !workspace)) throw new Error('--id is required. Use the workspaceId returned by `safs workspaces`.');
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
      if (!values.outputId) throw new Error('--output-id is required');
      if (!['stdout', 'stderr'].includes(values.stream)) throw new Error('--stream stdout|stderr is required');
    }
    if (verb === 'exec' && (typeof values.command !== 'string' || !values.command.trim())) throw new Error("Remote command is required. Retry with `safs exec --id ID -- 'COMMAND'` or `--command 'COMMAND'`");
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
  if (config.version !== 2 || typeof config.socketPath !== 'string' || typeof config.token !== 'string' || !config.token) throw new Error('Unsupported SAFS connection file');
  token = config.token;
  let timeout = Number.isSafeInteger(config.timeoutMs) && config.timeoutMs >= 0 ? config.timeoutMs : 120000;
  if (timeout && request.name === 'safs_cli_batch') timeout = timeout * request.arguments.operations.length + 5000;
  try {
    const envelope = await ipcRequest<{ result?: unknown }>(config.socketPath, token, 'cli', request, { timeoutMs: timeout });
    if (!envelope || !('result' in envelope)) throw new Error('SAFS router returned no result');
    return envelope.result;
  } catch (error) {
    const unavailable = ['ENOENT', 'ECONNREFUSED'].includes((error as { code?: string })?.code ?? '');
    const hint = unavailable
      ? '\n提示：请先在 VS Code 的 SAFS 侧栏打开远程目录，等待 Agent 转发就绪后重试。若已打开，请检查“Agent 活动”中的转发状态；转发失败时点击刷新按钮重连。'
      : '';
    throw new Error(`Local SAFS router request failed: ${redact(error instanceof Error ? error.message : String(error))}${hint}`);
  }
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
let activeConfig = '';
async function inferWorkspace(): Promise<string> {
  return resolveWorkspaceId(process.cwd(), async () => {
    const result = await invoke(activeConfig, { name: 'list_remote_workspaces', arguments: {} });
    return Array.isArray(result) ? result : result.workspaces ?? [];
  });
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--version', '-V'].includes(args[0])) { console.log(`safs ${CLI_VERSION}`); return; }
  let helpCommand: string | undefined;
  for (let i = 0; i < args.length && args[i] !== '--'; i++) {
    if (['--help', '-h'].includes(args[i])) { process.stdout.write(commandHelp[helpCommand ?? ''] ?? help); return; }
    if (!args[i].startsWith('-') && !helpCommand) helpCommand = args[i];
    if (args[i].startsWith('--') && !['--compact', '--verbose', '--skills', '--global'].includes(args[i]) && !args[i].startsWith('--skills=')) i++;
  }
  const config = option(args, '--config') ?? process.env.SAFS_CONFIG ?? join(dirname(process.argv[1]), '.safs-connection.json');
  let isCompact = false, verbose = false;
  const commandArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { commandArgs.push(...args.slice(i)); break; }
    if (arg === '--compact') { isCompact = true; continue; }
    if (arg === '--verbose') { verbose = true; continue; }
    commandArgs.push(arg);
    if (arg.startsWith('--') && arg !== '--skills' && arg !== '--global' && !arg.startsWith('--skills=') && i + 1 < args.length) {
      commandArgs.push(args[++i]);
    }
  }
  args.splice(0, args.length, ...commandArgs);
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
  activeConfig = config;
  const request = await parse(args);
  let result = await invoke(config, request);
  const code = exitCode(result);
  if (code && (request.name !== 'run_remote_command' || result.code || result.status === 'error')) throw new Error(verbose ? JSON.stringify(result) : concise(result));
  if (request.name === 'list_remote_workspaces' && Array.isArray(result.workspaces)) {
    result = {
      ...result,
      workspaces: result.workspaces.map((workspace: Record<string, unknown>) => {
        const { localRoot: _localRoot, ...display } = workspace;
        return display;
      })
    };
  }
  if (isCompact) result = compact(result);
  if (request.name === 'run_remote_command') {
    process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
    if (result.truncated) process.stderr.write('\n'+JSON.stringify({ safsOutput: result })+'\n');
  } else console.log(JSON.stringify(result));
  process.exitCode = code;
}
main().catch(error => { process.stderr.write(`SAFS: ${redact(error instanceof Error ? error.message : String(error))}\n`); process.exitCode = 1; });
