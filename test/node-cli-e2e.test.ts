import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentBackendServer, AgentToolError } from '../src/agent/agent-backend';
import { AgentIpcRouter, workspaceIdFor } from '../src/agent/agent-ipc-router';
import { ipcPath, createIpcServer, listenIpc } from '../src/agent/agent-ipc';
import { cliConfigPath, writeCliConnection } from '../src/cli/cli-integration';
import { executeCaptured as capture } from '../src/platform/process';

function executeCaptured(plan: Parameters<typeof capture>[0], ...rest: Parameters<typeof capture> extends [any, ...infer R] ? R : never) {
  return capture({ ...plan, command: process.execPath, args: [plan.command, ...(plan.args ?? [])] }, ...rest);
}

function developmentNodeCli(): string {
  return join(process.cwd(), 'dist', 'safs-cli.js');
}

test('Node.js CLI installs its bundled Agent Skill without a router', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'safs-node-skill-'));
  const executable = developmentNodeCli();
  try {
    await mkdir(join(temporary, 'project'));
    const installed = await executeCaptured({
      command: executable,
      args: ['install', '--skills'],
      cwd: join(temporary, 'project')
    });
    assert.equal(installed.exitCode, 0, installed.stderr);
    assert.match(installed.stdout, /\.agents[/\\]skills[/\\]safs-cli/);
    const skillRoot = join(temporary, 'project', '.agents', 'skills', 'safs-cli');
    const skill = await readFile(join(skillRoot, 'SKILL.md'), 'utf8');
    const commands = await readFile(join(skillRoot, 'references', 'commands.md'), 'utf8');
    assert.match(skill, /^---\nname: safs-cli\n/);
    assert.match(skill, /safs workspaces/);
    assert.match(commands, /safs read PATH --id ID/);

    const globalCodex = await executeCaptured({
      command: executable,
      args: ['install', '--skills=codex', '-g'],
      cwd: join(temporary, 'project'),
      env: { HOME: temporary, USERPROFILE: temporary }
    });
    assert.equal(globalCodex.exitCode, 0, globalCodex.stderr);
    assert.match(globalCodex.stdout, /\.codex[/\\]skills[/\\]safs-cli/);
    await readFile(join(temporary, '.codex', 'skills', 'safs-cli', 'SKILL.md'));

    const invalid = await executeCaptured({
      command: executable,
      args: ['install', '--skills=unknown'],
      cwd: join(temporary, 'project')
    });
    assert.equal(invalid.exitCode, 1);
    assert.match(invalid.stderr, /Unsupported skill target/);
    assert.match(invalid.stderr, /Usage: safs install --skills/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
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
      return { path: '/project/open.ts', relativePath: 'open.ts', size: 12, dirty: true };
    },
    list: async (input: { path?: string }) => {
      if (input.path === 'forbidden') throw new Error('denied detail');
      operations.push('list');
      return { path: input.path, entries: [], truncated: false };
    },
    read: async (input: { path: string }) => {
      operations.push('read');
      return { path: input.path, content: `content:${input.path}`, truncated: false };
    },
    search: async () => { operations.push('search'); return { status: 'no_matches' }; },
    edit: async () => { operations.push('edit'); return { status: 'ok' }; },
    write: async () => { operations.push('write'); return { status: 'ok' }; },
    delete: async () => { operations.push('delete'); return { status: 'ok' }; },
    chmod: async () => { operations.push('chmod'); return { status: 'ok' }; },
    move: async () => { operations.push('move'); return { status: 'ok' }; },
    upload: async () => { operations.push('upload'); return { status: 'ok' }; },
    download: async () => { operations.push('download'); return { status: 'ok' }; },
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
      workspaceUri: 'safs://dev/project', host: 'dev', focused: true, backendSocketPath: backend.socketPath, backendToken: 'node-test'
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
    assert.equal(run.stdout, 'node-out');
    assert.equal(run.stderr, 'node-err');
    assert.equal(runs, 1);
    const blockedRun = await executeCaptured({ command: executable, args: [
      '--config', config, 'exec', '--id', workspaceId, '--', 'blocked-write'
    ] });
    assert.equal(blockedRun.exitCode, 1);
    assert.equal(blockedRun.stdout, '');
    assert.match(
      blockedRun.stderr,
      /WORKSPACE_BOUNDARY_VIOLATION: outside workspace/
    );
    assert.equal(runs, 1);
    const currentFile = await executeCaptured({ command: executable, args: [
      '--config', config, 'current-file', '--id', workspaceId
    ] });
    assert.equal(currentFile.exitCode, 0, currentFile.stderr);
    assert.deepEqual(JSON.parse(currentFile.stdout), {
      path: '/project/open.ts', relativePath: 'open.ts', size: 12, dirty: true
    });
    assert.equal(currentFileReads, 1);
    const structuredCalls: string[][] = [
      ['read-many', '--input', JSON.stringify({ requests: [{ path: 'a.txt' }] })],
      ['search', '--query', 'TODO'],
      ['delete', '--path', 'a.txt'],
      ['chmod', '--path', 'a.txt', '--mode', '644'],
      ['move', '--input', JSON.stringify({ sourcePath: 'a', targetPath: 'b' })],
      ['upload', '--input', JSON.stringify({
        localPaths: [join(temporary, 'upload.txt')], remoteDirectory: '.'
      })],
      ['download', '--input', JSON.stringify({
        remotePath: 'a.txt', localPath: join(temporary, 'download.txt')
      })]
    ];
    await writeFile(join(temporary, 'upload.txt'), 'upload');
    const edit = await executeCaptured({
      command: executable,
      args: [
        '--config', config, 'edit', '--id', workspaceId,
        '--path', 'a.txt', '--input', '-'
      ],
      stdin: JSON.stringify({ edits: [{ oldText: 'a', newText: 'b' }] })
    });
    assert.equal(edit.exitCode, 0, edit.stderr);
    for (const call of structuredCalls) {
      const result = await executeCaptured({ command: executable, args: [
        '--config', config, call[0], '--id', workspaceId, ...call.slice(1)
      ] });
      assert.equal(result.exitCode, 0, `${call[0]}: ${result.stderr}`);
    }
    const write = await executeCaptured({
      command: executable,
      args: [
        '--config', config, 'write', '--id', workspaceId,
        '--path', 'write.txt', '--file', '-'
      ],
      stdin: 'replacement'
    });
    assert.equal(write.exitCode, 0, write.stderr);
    assert.deepEqual(
      [...new Set(operations)],
      ['read', 'edit', 'search', 'delete', 'chmod', 'move', 'upload', 'download', 'write']
    );
    const batchStarts = activity.filter((event) => event.phase === 'start').length;
    const batch = await executeCaptured({ command: executable, args: [
      '--config', config, '--compact', 'batch', '--id', workspaceId, '--input',
      JSON.stringify({ operations: [
        { command: 'read', arguments: { path: 'a.txt' } },
        { command: 'list', arguments: { path: 'src' } }
      ] })
    ] });
    assert.equal(batch.exitCode, 0, batch.stderr);
    const batchResult = JSON.parse(batch.stdout);
    assert.equal(batchResult.results.length, 2);
    assert.equal(batchResult.results[0].result.content, 'content:a.txt');
    assert.equal('truncated' in batchResult.results[0].result, false);
    assert.equal(
      activity.filter((event) => event.phase === 'start').length,
      batchStarts + 2
    );
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
    for (const content of ['--compact', '--verbose', '--help', '-h']) {
      const result = await executeCaptured({ command: developmentNodeCli(), args: [
        '--config', config, '--compact', 'write', 'note.txt', '--id', 'chosen', '--content', content
      ] });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).content, content);
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(temporary, { recursive: true, force: true });
  }
});
