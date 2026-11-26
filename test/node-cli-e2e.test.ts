import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AgentBackendServer, AgentToolError } from '../src/agent/agent-backend';
import { AgentIpcRouter, workspaceIdFor } from '../src/agent/agent-ipc-router';
import { ipcPath, ipcRequest, createIpcServer, listenIpc } from '../src/agent/agent-ipc';
import { cliConfigPath, writeCliConnection } from '../src/cli/cli-integration';
import { pageDirectory } from '../src/remote/remote-results';
import { executeCaptured as capture } from '../src/platform/process';

function executeCaptured(plan: Parameters<typeof capture>[0], ...rest: Parameters<typeof capture> extends [any, ...infer R] ? R : never) {
  return capture({ ...plan, command: process.execPath, args: [plan.command, ...(plan.args ?? [])] }, ...rest);
}

function developmentNodeCli(): string {
  return join(process.cwd(), 'dist', 'safs-cli.js');
}

test('Node.js CLI rejects the removed install command', async () => {
  const command = developmentNodeCli();
  const help = await executeCaptured({ command, args: ['--help'] });
  assert.equal(help.exitCode, 0, help.stderr);
  assert.doesNotMatch(help.stdout, /\binstall\b/);

  const result = await executeCaptured({ command, args: ['install', '--skills'] });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Unknown command/);
});

test('Node.js CLI lists and executes through the existing SAFS router', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'safs-node-e2e-'));
  let runs = 0;
  let currentFileReads = 0;
  const operations: string[] = [];
  const activity: Array<{ phase: string; agentName?: string; source?: string }> = [];
  const backend = new AgentBackendServer('node-test', {
    currentWorkspace: async () => ({
      name: 'dev', host: 'dev', workspaceRoot: '/project', workspaceUri: 'safs://dev/project'
    }),
    currentFile: async () => {
      currentFileReads += 1;
      if (currentFileReads > 1) return null;
      return { path: '/project/open.ts', relativePath: 'open.ts', size: 12, dirty: true };
    },
    list: async (input: { path?: string; limit?: number; cursor?: string; mountName?: string }) => {
      assert.equal(input.mountName, 'dev');
      if (input.path === 'forbidden') throw new Error('denied detail');
      operations.push('list');
      const entries = ['src', 'test'].includes(input.path ?? '')
        ? ['a.ts', 'b.ts'].map(name => ({ name, type: 'file' }))
        : [];
      return { path: input.path, ...pageDirectory(entries, input.path ?? '/', input) };
    },
    read: async (input: { path: string; length?: number; mountName?: string }) => {
      assert.equal(input.mountName, 'dev');
      if (input.path === 'forbidden') throw new Error('read denied');
      operations.push('read');
      if (input.length === 32) return { path: input.path, content: 'content:a.txt', length: input.length };
      return { path: input.path, content: `content:${input.path}`, truncated: false };
    },
    search: async (input) => {
      operations.push('search');
      return input.query === '*.missing'
        ? { status: 'no_matches', exitCode: 1 } : { status: 'matches', exitCode: 0 };
    },
    edit: async () => { operations.push('edit'); return { status: 'ok' }; },
    write: async () => { operations.push('write'); return { status: 'ok' }; },
    delete: async () => { operations.push('delete'); return { status: 'ok' }; },
    chmod: async () => { operations.push('chmod'); return { status: 'ok' }; },
    move: async () => { operations.push('move'); return { status: 'ok' }; },
    upload: async (input) => {
      operations.push('upload');
      return { status: 'ok', remoteDirectory: input.remoteDirectory, localPaths: input.localPaths };
    },
    download: async (input) => {
      assert.equal(input.localPath, resolve('downloads'));
      operations.push('download');
      return { status: 'ok' };
    },
    run: async (input: { command: string }) => {
      if (input.command === 'blocked-write') {
        throw new AgentToolError(
          'WORKSPACE_BOUNDARY_VIOLATION', 'outside workspace', {
            nonRetryable: true, mustStopNow: true, prohibitedFallback: 'safs exec'
          }
        );
      }
      runs += 1;
      return { stdout: 'node-out', stderr: 'node-err', exitCode: 7 };
    },
    activity: {
      start: (entry: { agentName?: string; source: string }) => {
        const id = `activity-${activity.length}`;
        activity.push({ phase: 'start', agentName: entry.agentName, source: entry.source });
        return id;
      },
      succeed: () => activity.push({ phase: 'success' }),
      fail: () => activity.push({ phase: 'error' })
    }
  } as any);
  await backend.start();
  const routerToken = 'native-router';
  const router = new AgentIpcRouter(ipcPath('e2e-router-' + temporary), routerToken, {
    discover: () => [{
      instanceId: 'node-window', workspaceRoot: '/project', localRoot: temporary,
      workspaceUri: 'safs://dev/project', mountName: 'dev', host: 'dev', focused: true, backendSocketPath: backend.socketPath, backendToken: 'node-test'
    } as any]
  });
  await router.start();
  const config = cliConfigPath(temporary);
  const executable = developmentNodeCli();
  const extensionVersion = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ).version as string;
  try {
    await writeCliConnection(temporary, router.socketPath, routerToken);
    const version = await executeCaptured({ command: executable, args: ['--version'] });
    assert.equal(version.exitCode, 0, version.stderr);
    assert.equal(version.stdout.trim(), `safs ${extensionVersion}`);
    const help = await executeCaptured({ command: executable, args: ['edit', '--help'] });
    assert.equal(help.exitCode, 0, help.stderr);
    assert.match(help.stdout, /^Usage: safs edit /);
    assert.equal(help.stdout.includes('Usage: safs upload'), false);
    const workspaces = await executeCaptured({ command: executable, args: [
      '--config', config, 'workspaces'
    ] });
    assert.equal(workspaces.exitCode, 0, workspaces.stderr);
    assert.deepEqual(JSON.parse(workspaces.stdout), { workspaces: [{
      workspaceId: workspaceIdFor({
        instanceId: 'node-window', workspaceUri: 'safs://dev/project', host: 'dev'
      }), workspaceRoot: '/project', host: 'dev', mode: 'workspace'
    }] });
    const workspaceId = JSON.parse(workspaces.stdout).workspaces[0].workspaceId as string;
    const positionalRead = await executeCaptured({ command: executable, args: [
      '--config', config, 'read', 'concise.txt', '--id', workspaceId
    ] });
    assert.equal(positionalRead.exitCode, 0, positionalRead.stderr);
    assert.equal(JSON.parse(positionalRead.stdout).content, 'content:concise.txt');
    const run = await executeCaptured({ command: executable, args: [
      '--config', config, 'exec', 'exit 7', '--id', workspaceId
    ] });
    assert.equal(run.exitCode, 7);
    assert.equal(JSON.parse(run.stdout).stdout, 'node-out');
    assert.equal(JSON.parse(run.stdout).stderr, 'node-err');
    assert.equal(run.stderr, '');
    assert.equal(runs, 1);
    const raw = await executeCaptured({ command: executable, args: [
      '--config', config, 'exec', '--raw', '--id', workspaceId, '--', 'exit 7'
    ] });
    assert.equal(raw.exitCode, 7);
    assert.equal(raw.stdout, 'node-out');
    assert.equal(raw.stderr, 'node-err');
    const blockedRun = await executeCaptured({ command: executable, args: [
      '--config', config, 'exec', '--id', workspaceId, '--', 'blocked-write'
    ] });
    assert.equal(blockedRun.exitCode, 1);
    assert.equal(blockedRun.stdout, '');
    assert.match(
      blockedRun.stderr,
      /WORKSPACE_BOUNDARY_VIOLATION: outside workspace/
    );
    assert.equal(runs, 2);
    const currentFile = await executeCaptured({ command: executable, args: [
      '--config', config, 'current-file', '--id', workspaceId
    ] });
    assert.equal(currentFile.exitCode, 0, currentFile.stderr);
    assert.deepEqual(JSON.parse(currentFile.stdout), {
      path: '/project/open.ts', relativePath: 'open.ts', size: 12, dirty: true
    });
    assert.equal(currentFileReads, 1);
    const noCurrentFile = await executeCaptured({ command: executable, args: [
      '--config', config, 'current-file', '--id', workspaceId
    ] });
    assert.equal(noCurrentFile.exitCode, 0, noCurrentFile.stderr);
    assert.equal(JSON.parse(noCurrentFile.stdout), null);
    const noMatches = await executeCaptured({ command: executable, args: [
      '--config', config, 'find-name', '*.missing', '--id', workspaceId
    ] });
    assert.equal(noMatches.exitCode, 1);
    assert.equal(noMatches.stderr, '');
    assert.equal(JSON.parse(noMatches.stdout).status, 'no_matches');
    const structuredCalls: string[][] = [
      ['read', '--json', JSON.stringify([{ path: 'a.txt' }])],
      ['find-text', '--query', 'TODO', '--mode', 'files'],
      ['find-name', '*.ts', 'src'],
      ['delete', '--path', 'a.txt'],
      ['chmod', '--path', 'a.txt', '--mode', '644'],
      ['move', 'a', 'b'],
      ['upload', 'upload.txt', '.'],
      ['download', 'a.txt', 'downloads']
    ];
    const editJsonFile = join(temporary, 'edit.json');
    await writeFile(editJsonFile, JSON.stringify({ edits: [{ oldText: 'a', newText: 'b' }] }));
    const edit = await executeCaptured({
      command: executable,
      args: [
        '--config', config, 'edit', '--id', workspaceId,
        '--path', 'a.txt', '--json-file', editJsonFile
      ]
    });
    assert.equal(edit.exitCode, 0, edit.stderr);
    const readJsonFile = join(temporary, 'read.json');
    await writeFile(readJsonFile, JSON.stringify([{ path: 'a.txt', length: 32 }, { path: 'forbidden' }]));
    const bulkRead = await executeCaptured({ command: executable, args: [
      '--config', config, 'read', '--id', workspaceId, '--json-file', readJsonFile
    ] });
    assert.equal(bulkRead.exitCode, 1);
    assert.match(bulkRead.stderr, /forbidden: read denied/);
    const [readOk, readError] = JSON.parse(bulkRead.stdout).results;
    assert.equal(readOk.content, 'content:a.txt');
    assert.equal(readOk.length, 32);
    assert.equal(readError.status, 'error');
    for (const [verb, flag, value] of [
      ['write', '--json', '{"content":"replacement"}'],
      ['exec', '--json-file', editJsonFile]
    ]) {
      const rejected = await executeCaptured({ command: executable, args: [
        '--config', config, verb, '--id', workspaceId, flag, value
      ] });
      assert.equal(rejected.exitCode, 1);
      assert.match(rejected.stderr, /only supported by list, read, find-text, and edit/);
    }
    for (const [verb, flag] of [['upload', '--remote-directory'], ['download', '--local-path']]) {
      const rejected = await executeCaptured({ command: executable, args: [
        '--config', config, verb, '--id', workspaceId, flag, '.'
      ] });
      assert.equal(rejected.exitCode, 1);
      assert.match(rejected.stderr, /Invalid option/);
    }
    const filenameMode = await executeCaptured({ command: executable, args: [
      '--config', config, 'find-text', '*.ts', '--id', workspaceId, '--mode', 'names'
    ] });
    assert.equal(filenameMode.exitCode, 1);
    assert.match(filenameMode.stderr, /Use find-name to match filenames/);
    const legacyInput = await executeCaptured({ command: executable, args: [
      '--config', config, 'read-many', '--id', workspaceId
    ] });
    assert.equal(legacyInput.exitCode, 1);
    assert.match(legacyInput.stderr, /Unknown command/);
    for (const call of structuredCalls) {
      const result = await executeCaptured({ command: executable, args: [
        '--config', config, call[0], '--id', workspaceId, ...call.slice(1)
      ] });
      assert.equal(result.exitCode, 0, `${call[0]}: ${result.stderr}`);
    }
    for (const [verb, source, target] of [
      ['upload', 'upload.txt', '.'],
      ['download', 'a.txt', 'downloads']
    ]) {
      for (const args of [
        [verb, '--id', workspaceId, source, target],
        [verb, source, '--id', workspaceId, target],
        [verb, source, target, '--id', workspaceId]
      ]) {
        const transfer = await executeCaptured({ command: executable, args: ['--config', config, ...args] });
        assert.equal(transfer.exitCode, 0, `${args.join(' ')}: ${transfer.stderr}`);
      }
    }
    const singleUpload = await executeCaptured({ command: executable, args: [
      '--config', config, 'upload', 'upload.txt', '--id', workspaceId, 'reports'
    ] });
    assert.equal(singleUpload.exitCode, 0, singleUpload.stderr);
    assert.deepEqual(JSON.parse(singleUpload.stdout), {
      status: 'ok', localPaths: [resolve('upload.txt')], remoteDirectory: 'reports'
    });
    for (const [verb, first, second, target] of [
      ['upload', 'first.txt', 'second.txt', 'reports'],
      ['download', 'reports/first.txt', 'reports/second.txt', 'downloads']
    ]) {
      const multipleSources = await executeCaptured({ command: executable, args: [
        '--config', config, verb, first, second, target, '--id', workspaceId
      ] });
      assert.equal(multipleSources.exitCode, 1);
      assert.match(multipleSources.stderr, new RegExp('Too many arguments for ' + verb));
    }
    const defaultUpload = await executeCaptured({ command: executable, args: [
      '--config', config, 'upload', 'reports', '--id', workspaceId
    ] });
    assert.equal(defaultUpload.exitCode, 0, defaultUpload.stderr);
    assert.deepEqual(JSON.parse(defaultUpload.stdout), { status: 'ok', remoteDirectory: 'reports' });

    const writeFilePath = join(temporary, 'replacement.txt');
    await writeFile(writeFilePath, 'replacement');
    const write = await executeCaptured({
      command: executable,
      args: [
        '--config', config, 'write', '--id', workspaceId,
        'write.txt', 'replacement'
      ]
    });
    for (const [verb, flag] of [
      ['exec', '--file'],
      ['edit', '--json-file']
    ]) {
      const rejected = await executeCaptured({ command: executable, args: [
        '--config', config, verb, '--id', workspaceId, flag, '-'
      ] });
      assert.equal(rejected.exitCode, 1);
      assert.match(rejected.stderr, /Pass a local file path instead of -/);
    }
    const writeFromFile = await executeCaptured({ command: executable, args: [
      '--config', config, 'write', 'write.txt', '--id', workspaceId, '--file', writeFilePath
    ] });
    assert.equal(writeFromFile.exitCode, 1);
    assert.match(writeFromFile.stderr, /--file is not valid for write/);
    const createFromFile = await executeCaptured({ command: executable, args: [
      '--config', config, 'create', 'new.txt', 'file', '--id', workspaceId, '--file', writeFilePath
    ] });
    assert.equal(createFromFile.exitCode, 1);
    assert.match(createFromFile.stderr, /--file is not valid for create/);
    assert.equal(write.exitCode, 0, write.stderr);
    assert.deepEqual(
      [...new Set(operations)],
      ['read', 'search', 'edit', 'delete', 'chmod', 'move', 'upload', 'download', 'write']
    );
    const namedExecCommand = await executeCaptured({ command: executable, args: [
      '--config', config, 'exec', '--id', workspaceId, '--command', 'npm test'
    ] });
    assert.equal(namedExecCommand.exitCode, 1);
    assert.match(namedExecCommand.stderr, /Invalid option for exec: --command/);

    const namedReadPath = await executeCaptured({ command: executable, args: [
      '--config', config, 'read', '--id', workspaceId, '--path', 'a.txt'
    ] });
    assert.equal(namedReadPath.exitCode, 1);
    assert.match(namedReadPath.stderr, /Invalid option for read: --path/);

    const multiList = await executeCaptured({ command: executable, args: [
      '--config', config, 'list', '--id', workspaceId, '--json', JSON.stringify([{ path: 'src', limit: 1 }, { path: 'test', limit: 2 }])
    ] });
    assert.equal(multiList.exitCode, 0, multiList.stderr);
    const multiListResults = JSON.parse(multiList.stdout).results;
    assert.deepEqual(multiListResults.map(({ path, entries }: { path: string; entries: unknown[] }) =>
      [path, entries.length]), [['src', 1], ['test', 2]]);

    const firstPage = await executeCaptured({ command: executable, args: [
      '--config', config, 'list', 'test', '--id', workspaceId, '--limit', '1'
    ] });
    assert.equal(firstPage.exitCode, 0, firstPage.stderr);
    const { nextCursor } = JSON.parse(firstPage.stdout);
    assert.ok(nextCursor);

    const listRequestFile = join(temporary, 'list-request.json');
    await writeFile(listRequestFile, JSON.stringify([{ path: 'src' }, { path: 'test', limit: 1, cursor: nextCursor }]));
    const resumedList = await executeCaptured({ command: executable, args: [
      '--config', config, 'list', '--id', workspaceId, '--json-file', listRequestFile
    ] });
    assert.equal(resumedList.exitCode, 0, resumedList.stderr);
    assert.deepEqual(JSON.parse(resumedList.stdout).results.map((result: { entries: { name: string }[] }) =>
      result.entries.map(entry => entry.name)), [['a.ts', 'b.ts'], ['b.ts']]);

    const objectList = await executeCaptured({ command: executable, args: [
      '--config', config, 'list', '--id', workspaceId, '--json',
      JSON.stringify({ paths: ['src', 'test'] })
    ] });
    assert.equal(objectList.exitCode, 1);
    assert.match(objectList.stderr, /List JSON must contain an array/);

    const partialList = await executeCaptured({ command: executable, args: [
      '--config', config, 'list', '--id', workspaceId, '--json', JSON.stringify([{ path: 'forbidden' }, { path: 'test', limit: 1 }])
    ] });
    assert.equal(partialList.exitCode, 1);
    assert.match(partialList.stderr, /forbidden: denied detail/);
    const partialListResults = JSON.parse(partialList.stdout).results;
    assert.deepEqual(partialListResults.map(({ status }: { status: string }) => status), ['error', 'ok']);
    assert.ok(partialListResults[1].nextCursor);

    const removedBatch = await executeCaptured({ command: executable, args: ['batch'] });
    assert.equal(removedBatch.exitCode, 1);
    assert.match(removedBatch.stderr, /Unknown command/);

    await assert.rejects(ipcRequest(router.socketPath, routerToken, 'cli', {
      name: 'remote_read', arguments: { workspaceId, requests: [null] }
    }), /Expected 1 to 16 requests with a path per item/);

    const conciseError = await executeCaptured({ command: executable, args: [
      '--config', config, 'list', '--id', workspaceId, '--path', 'forbidden'
    ] });
    assert.equal(conciseError.exitCode, 1);
    assert.match(conciseError.stderr, /REMOTE_TOOL_ERROR: denied detail/);
    assert.equal(conciseError.stderr.includes('{"code"'), false);
    const syntaxError = await executeCaptured({ command: executable, args: [
      '--config', config, 'read', '--id', workspaceId, '--unknown', 'value'
    ] });
    assert.equal(syntaxError.exitCode, 1);
    assert.match(syntaxError.stderr, /Invalid option for read: --unknown/);
    assert.match(syntaxError.stderr, /Usage: safs read/);
    assert.equal(syntaxError.stderr.includes('Usage: safs upload'), false);
    assert.ok(activity.some((event) => event.phase === 'start'));
    assert.ok(activity.filter((event) => event.phase === 'start').every(
      (event) => event.source === 'cli'
    ));
    const removedAgentOption = await executeCaptured({ command: executable, args: [
      '--config', config, 'read', 'named.txt', '--id', workspaceId,
      '--agent', 'Explicit Agent'
    ] });
    assert.equal(removedAgentOption.exitCode, 1);
    assert.match(removedAgentOption.stderr, /Invalid option for read: --agent/);
    const removedCwdOption = await executeCaptured({ command: executable, args: [
      '--config', config, 'exec', 'pwd', '--id', workspaceId, '--cwd', 'subdirectory'
    ] });
    assert.equal(removedCwdOption.exitCode, 1);
    assert.match(removedCwdOption.stderr, /Invalid option for exec: --cwd/);
  } finally {
    await router.stop();
    await backend.stop();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('Node.js CLI applies IPC connection-file timeout', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'safs-node-timeout-'));
  const socketPath = ipcPath('missing-' + temporary);
  try {
    await writeCliConnection(temporary, socketPath, 'timeout-token', 50);
    const started = Date.now();
    const result = await executeCaptured({ command: developmentNodeCli(), args: [
      '--config', cliConfigPath(temporary), 'workspaces'
    ] });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /Local SAFS router request failed/);
    assert.match(result.stderr, /请先在 VS Code 的 SAFS 侧栏打开远程目录/);
    assert.match(result.stderr, /Agent 转发就绪/);
    assert.ok(Date.now() - started < 2_000);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('Node.js CLI global options preserve content values over IPC', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'safs-node-option-values-'));
  const socketPath = ipcPath('options-' + temporary);
  const server = createIpcServer(({ action, payload }) => {
    assert.equal(action, 'cli');
    return { result: (payload as { value: { arguments: unknown } }).value.arguments };
  });
  await listenIpc(server, socketPath);
  try {
    await writeCliConnection(temporary, socketPath, 'options-token');
    const config = cliConfigPath(temporary);
    const help = await executeCaptured({ command: developmentNodeCli(), args: ['--config', config, 'edit', '--help'] });
    assert.equal(help.exitCode, 0, help.stderr);
    assert.match(help.stdout, /^Usage: safs edit /);
    const write = (...args: string[]) => executeCaptured({
      command: developmentNodeCli(),
      args: ['--config', config, 'write', 'note.txt', '--id', 'chosen', ...args]
    });
    for (const [flags, append] of [
      [[], undefined], [['--append'], true], [['--overwrite'], false]
    ] as const) {
      const result = await write('new text', ...flags);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).content, 'new text');
      assert.equal(JSON.parse(result.stdout).append, append);
    }
    for (const flags of [['--append', '--overwrite'], ['--overwrite', '--append']]) {
      const result = await write('new text', ...flags);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /Specify at most one write mode/);
      assert.equal(result.stdout, '');
    }
    const legacy = await write('--content', 'new text');
    assert.equal(legacy.exitCode, 1);
    assert.match(legacy.stderr, /Invalid option for write: --content/);
    for (const content of ['--compact', '--verbose', '--help', '-h']) {
      const result = await executeCaptured({ command: developmentNodeCli(), args: [
        '--config', config, '--compact', 'write', 'note.txt', '--id', 'chosen', '--', content
      ] });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).content, content);
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(temporary, { recursive: true, force: true });
  }
});
