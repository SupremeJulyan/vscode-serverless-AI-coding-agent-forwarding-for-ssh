#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { ipcRequest } from './agent/agent-ipc';
import { resolveWorkspaceId } from './agent/workspace-id';
import { help, commandHelp } from './cli/cli-help';

declare const CLI_VERSION: string;
const tools: Record<string, string> = {
  workspaces: 'list_remote_workspaces', 'current-file': 'current_remote_file', list: 'remote_list',
  read: 'remote_read', 'find-text': 'remote_search', 'find-name': 'remote_search',
  edit: 'remote_edit', write: 'remote_write', create: 'remote_create', delete: 'remote_delete',
  chmod: 'remote_chmod', move: 'remote_move', upload: 'remote_upload', download: 'remote_download',
  output: 'remote_output', exec: 'run_remote_command'
};
const allowed: Record<string, string[]> = {
  workspaces: [], 'current-file': [], list: ['path', 'limit', 'cursor'],
  read: ['offset', 'length', 'head', 'tail', 'start-line', 'line-count'],
  'find-text': ['path', 'query', 'mode'], 'find-name': ['path', 'name'], edit: ['path'],
  write: ['path', 'content'], create: ['path', 'type', 'content'], delete: ['path'],
  chmod: ['path', 'mode'], move: ['source-path', 'target-path'], upload: [], download: [],
  output: ['output-id', 'stream', 'offset', 'length'], exec: []
};
const positional: Record<string, string[]> = {
  list: ['path'], read: ['path'], edit: ['path'], write: ['path'], delete: ['path'],
  create: ['path', 'type'], 'find-text': ['query', 'path'], 'find-name': ['name', 'path'],
  chmod: ['path', 'mode'], move: ['sourcePath', 'targetPath'],
  download: ['remotePath', 'localPath'], output: ['outputId', 'stream'], exec: ['command']
};
const jsonCommands = new Set(['list', 'read', 'find-text', 'edit']);
const namedFields: Record<string, string> = {
  id: 'workspace', 'output-id': 'outputId', 'start-line': 'startLine', 'line-count': 'lineCount',
  'source-path': 'sourcePath', 'target-path': 'targetPath'
};
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const booleanOptions = new Set(['--compact', '--verbose', '--raw', '--allow-empty', '--recursive', '--overwrite']);
function option(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length && args[i] !== '--'; i++) {
    const arg = args[i];
    if (arg === flag) {
      if (i + 1 >= args.length) throw new Error(`${flag} requires a value`);
      return args.splice(i, 2)[1];
    }
    if (arg.startsWith('--') && !booleanOptions.has(arg)) i++;
  }
}
function helpFor(command: string): string {
  return Object.hasOwn(commandHelp, command) ? commandHelp[command] : help;
}

async function parse(args: string[]) {
  const verb = args.shift() ?? '';
  try {
    if (!Object.hasOwn(tools, verb)) throw new Error('Unknown command; use --help');
    const json = option(args, '--json');
    const jsonFile = option(args, '--json-file');
    const file = option(args, '--file');
    if (json !== undefined && jsonFile !== undefined) throw new Error('Use either --json or --json-file, not both');
    if ((json !== undefined || jsonFile !== undefined) && !jsonCommands.has(verb)) {
      throw new Error('--json and --json-file are only supported by list, read, find-text, and edit');
    }
    if (file !== undefined && verb !== 'exec') throw new Error(`--file is not valid for ${verb}`);
    if (file === '-' || jsonFile === '-') throw new Error('Pass a local file path instead of -');
    const input = jsonFile === undefined ? json : await readFile(jsonFile, 'utf8');
    if (input === '-') throw new Error('--json accepts inline JSON; use --json-file PATH to read a file');
    const data = input === undefined ? {} : JSON.parse(input);
    let values: Record<string, any>;
    if (verb === 'list' && input !== undefined) {
      if (!Array.isArray(data)) throw new Error('List JSON must contain an array of directory requests');
      if (data.length < 1 || data.length > 16) throw new Error('List JSON requires 1 to 16 directory requests');
      const requests = data.map(item => {
        if (!object(item) || typeof item.path !== 'string' || item.path.length === 0
          || (item.cursor != null && (typeof item.cursor !== 'string' || item.cursor.length > 2048))
          || Object.keys(item).some(key => !['path', 'limit', 'cursor'].includes(key))) {
          throw new Error('Each list request requires path and accepts optional limit and cursor');
        }
        if (item.limit !== undefined && (!Number.isInteger(item.limit) || item.limit < 1 || item.limit > 10000)) {
          throw new Error('Each list request limit must be an integer between 1 and 10000');
        }
        return { path: item.path, limit: item.limit, cursor: item.cursor ?? undefined };
      });
      values = { requests };
    } else if (verb === 'read' && input !== undefined) {
      if (!Array.isArray(data) || data.length < 1 || data.length > 16) {
        throw new Error('Read JSON requires an array of 1 to 16 file requests');
      }
      const fields = ['offset', 'length', 'head', 'tail', 'startLine', 'lineCount'];
      for (const item of data) {
        if (!object(item) || typeof item.path !== 'string' || !item.path
          || Object.keys(item).some(key => key !== 'path' && !fields.includes(key))) {
          throw new Error('Each read request requires path and accepts offset, length, head, tail, startLine, and lineCount');
        }
      }
      values = { requests: data };
    } else {
      if (!object(data)) throw new Error('--json must contain a JSON object');
      values = data;
    }
    if ('workspaceId' in values || 'mountName' in values) throw new Error('--json must not override workspaceId or mountName');
    let pos = 0;
    const assign = (key: string, value: unknown) => {
      if (key in values) throw new Error(`Duplicate input field: ${key}`);
      values[key] = value;
    };
    const uploadPaths: string[] = [];
    while (args.length) {
      const flag = args.shift()!;
      if ((verb === 'write' && flag === '--allow-empty') || (verb === 'delete' && ['-r', '--recursive'].includes(flag))) {
        assign(verb === 'write' ? 'allowEmpty' : 'recursive', true); continue;
      }
      if (verb === 'move' && flag === '--overwrite') {
        assign('overwrite', true); continue;
      }
      if (flag === '--') {
        if (verb !== 'exec' || args.length !== 1) throw new Error('Pass one remote command after --');
        assign('command', args.shift()); break;
      }
      if (!flag.startsWith('--')) {
        if (verb === 'upload') { uploadPaths.push(flag); continue; }
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
      assign(namedFields[key] ?? key, numeric ? Number(value) : value);
    }
    if (verb === 'upload') {
      if (uploadPaths.length > 2) throw new Error('Too many arguments for upload. Pass one local source and one remote directory.');
      const remoteDirectory = uploadPaths.pop();
      if (!remoteDirectory) throw new Error('Remote upload directory is required');
      values.remoteDirectory = remoteDirectory;
      if (uploadPaths[0]) values.localPaths = [resolve(uploadPaths[0])];
    }
    if (verb === 'download' && values.localPath) {
      values.localPath = resolve(values.localPath);
    }
    if (verb === 'list' && 'requests' in values && ('path' in values || 'limit' in values || 'cursor' in values)) {
      throw new Error('Specify each directory path, limit, and cursor inside the JSON array');
    }
    if (verb === 'read' && 'requests' in values
      && Object.keys(values).some(key => key !== 'requests' && key !== 'workspace')) {
      throw new Error('Specify each file path and selection inside the JSON array');
    }
    if (verb === 'find-name') {
      if (typeof values.name !== 'string') throw new Error('Filename glob is required');
      values.query = values.name;
      delete values.name;
      values.mode = 'names';
    }
    if (verb === 'find-text') {
      if (typeof values.query !== 'string') throw new Error('Text search query is required');
      if (values.mode !== undefined && !['content', 'files', 'count'].includes(values.mode)) {
        throw new Error('--mode must be content, files, or count. Use find-name to match filenames.');
      }
    }
    if (file !== undefined) assign('command', await readFile(file, 'utf8'));
    const workspace = values.workspace ?? (verb === 'workspaces' ? undefined : await inferWorkspace()); delete values.workspace;
    if (verb !== 'workspaces' && (typeof workspace !== 'string' || !workspace)) throw new Error('--id is required. Use the workspaceId returned by `safs workspaces`.');
    if (verb !== 'workspaces') values.workspaceId = workspace;
    if (verb === 'output') {
      if (!values.outputId) throw new Error('--output-id is required');
      if (!['stdout', 'stderr'].includes(values.stream)) throw new Error('--stream stdout|stderr is required');
    }
    if (verb === 'exec' && (typeof values.command !== 'string' || !values.command.trim())) throw new Error('Remote command is required');
    if (verb === 'write' && !('content' in values)) throw new Error('Write content is required. Use --content TEXT, or upload a local file for large replacements.');
    if (verb === 'create') {
      if (!['file', 'directory'].includes(values.type)) throw new Error('Create type must be file or directory');
      if (values.type === 'directory' && 'content' in values) throw new Error('Directory creation does not accept content');
    }
    return { name: tools[verb], arguments: values };
  } catch (error) { throw new Error(`${error instanceof Error ? error.message : error}\n\n${helpFor(verb)}`); }
}
let token = '';
function redact(message: string) { return token ? message.replaceAll(token, '<hidden>').replaceAll(encodeURIComponent(token), '<hidden>') : message; }
async function invoke(configPath: string, request: Awaited<ReturnType<typeof parse>>): Promise<any> {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (config.version !== 2 || typeof config.socketPath !== 'string' || typeof config.token !== 'string' || !config.token) throw new Error('Unsupported SAFS connection file');
  token = config.token;
  const timeout = Number.isSafeInteger(config.timeoutMs) && config.timeoutMs >= 0 ? config.timeoutMs : 120000;
  try {
    const envelope = await ipcRequest<{ result?: unknown }>(config.socketPath, token, 'cli', request, { timeoutMs: timeout });
    if (!envelope || !('result' in envelope)) throw new Error('SAFS router returned no result');
    return envelope.result;
  } catch (error) {
    const code = (error as { code?: string })?.code;
    const permissionDenied = ['EACCES', 'EPERM'].includes(code ?? '');
    const unavailable = ['ENOENT', 'ECONNREFUSED'].includes(code ?? '');
    const hint = permissionDenied
      ? '\n提示：Agent 无权访问本地 SAFS IPC（Unix socket / Windows 命名管道）。若 Agent 正在沙箱或受限权限模式下运行，请将 Agent 权限设为“完全访问”（Full Access）后重试；仍失败时，请确认 Agent 与 VS Code 使用同一用户运行，并检查 IPC 路径权限。无需修改远程 SSH 权限。'
      : unavailable
      ? '\n提示：请先在 VS Code 的 SAFS 侧栏打开远程目录，等待 Agent 转发就绪后重试。若已打开，请检查“Agent 活动”中的转发状态；转发失败时点击刷新按钮重连。'
      : '';
    throw new Error(`Local SAFS router request failed${code ? ` [${code}]` : ''}: ${redact(error instanceof Error ? error.message : String(error))}${hint}`);
  }
}
function exitCode(result: any): number {
  if (result === null) return 0;
  if (Number.isInteger(result.exitCode) && result.exitCode >= 0 && result.exitCode <= 255) return result.exitCode;
  return result.code || result.status === 'error' || result.results?.some((r: any) => r.status === 'error') ? 1 : 0;
}
function concise(result: any): string {
  const failedPath = result.results?.find((r: any) => r.status === 'error');
  if (failedPath) return `${failedPath.path}: ${concise(failedPath)}`;
  return [result.code, result.message ?? result.error].filter(Boolean).join(': ') || 'SAFS operation failed';
}
function compact(result: any): any {
  if (Array.isArray(result)) return result.map(compact);
  if (!object(result)) return result;
  return Object.fromEntries(Object.entries(result).filter(([k, v]) => !(k === 'status' && v === 'ok')).map(([k,v]) => [k,compact(v)]));
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
    if (['--help', '-h'].includes(args[i])) { process.stdout.write(helpFor(helpCommand ?? '')); return; }
    if (!args[i].startsWith('-') && !helpCommand) helpCommand = args[i];
    if (args[i].startsWith('--') && !booleanOptions.has(args[i])) i++;
  }
  const config = option(args, '--config') ?? process.env.SAFS_CONFIG ?? join(dirname(process.argv[1]), '.safs-connection.json');
  let isCompact = false, verbose = false, raw = false;
  const commandArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { commandArgs.push(...args.slice(i)); break; }
    if (arg === '--compact') { isCompact = true; continue; }
    if (arg === '--verbose') { verbose = true; continue; }
    if (arg === '--raw') { raw = true; continue; }
    commandArgs.push(arg);
    if (arg.startsWith('--') && !booleanOptions.has(arg) && i + 1 < args.length) {
      commandArgs.push(args[++i]);
    }
  }
  args.splice(0, args.length, ...commandArgs);
  activeConfig = config;
  const request = await parse(args);
  if (raw && request.name !== 'run_remote_command') throw new Error('--raw is only valid for exec');
  let result = await invoke(config, request);
  const code = exitCode(result);
  if (code && (request.name !== 'run_remote_command' || result.code || result.status === 'error')) {
    const message = verbose ? JSON.stringify(result) : concise(result);
    if (!['remote_list', 'remote_read'].includes(request.name) || !Array.isArray(result.results)) {
      throw new Error(message);
    }
    process.stderr.write(`SAFS: ${redact(message)}\n`);
  }
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
  if (raw && request.name === 'run_remote_command') {
    process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
    if (result.truncated) process.stderr.write('\n'+JSON.stringify({ safsOutput: result })+'\n');
  } else console.log(JSON.stringify(result));
  process.exitCode = code;
}
main().catch(error => { process.stderr.write(`SAFS: ${redact(error instanceof Error ? error.message : String(error))}\n`); process.exitCode = 1; });
