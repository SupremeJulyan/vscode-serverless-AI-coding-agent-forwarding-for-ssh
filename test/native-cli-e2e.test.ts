import assert from 'node:assert/strict';
import * as http from 'node:http';
import test from 'node:test';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentMcpServer, AgentToolError } from '../src/agent-mcp';
import { AgentHttpRouter, workspaceIdFor } from '../src/agent-http-router';
import { cliConfigPath, writeCliConnection } from '../src/cli-integration';
import { bundledNativeCli, nativeCliPlatform } from '../src/native-cli';
import { executeCaptured } from '../src/process';

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close(
    (error) => error ? reject(error) : resolve()
  ));
  return address.port;
}

test('native CLI installs its bundled Agent Skill without a router', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'safs-native-skill-'));
  const executable = bundledNativeCli(
    process.cwd(), nativeCliPlatform(process.platform, process.arch)
  );
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
    assert.match(commands, /safs read PATH --workspace ID/);

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

test('native CLI lists and executes through the existing SAFS router', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'safs-native-e2e-'));
  let runs = 0;
  let currentFileReads = 0;
  const operations: string[] = [];
  const activity: Array<{ phase: string; agentName?: string; source?: string }> = [];
  const backend = new AgentMcpServer(0, 'native-test', {
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
      return { stdout: 'native-out', stderr: 'native-err', exitCode: 7 };
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
  const router = new AgentHttpRouter(await freePort(), 'native-router', {
    discover: () => [{
      instanceId: 'native-window', workspaceRoot: '/project',
      workspaceUri: 'safs://dev/project', host: 'dev', focused: true, mcpUrl: backend.url
    } as any]
  });
  await router.start();
  const config = cliConfigPath(temporary);
  const executable = bundledNativeCli(
    process.cwd(), nativeCliPlatform(process.platform, process.arch)
  );
  const extensionVersion = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ).version as string;
  try {
    const cliUrl = new URL(router.url);
    cliUrl.searchParams.set('source', 'cli');
    cliUrl.searchParams.set('agent', 'URL Agent');
    await writeCliConnection(temporary, cliUrl.toString());
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
        instanceId: 'native-window', workspaceUri: 'safs://dev/project', host: 'dev'
      }), workspaceRoot: '/project', host: 'dev', mode: 'workspace'
    }] });
    const workspaceId = JSON.parse(workspaces.stdout).workspaces[0].workspaceId as string;
    const positionalRead = await executeCaptured({ command: executable, args: [
      '--config', config, 'read', 'concise.txt', '--workspace', workspaceId
    ] });
    assert.equal(positionalRead.exitCode, 0, positionalRead.stderr);
    assert.equal(JSON.parse(positionalRead.stdout).content, 'content:concise.txt');
    const run = await executeCaptured({ command: executable, args: [
      '--config', config, 'exec', 'exit 7', '--workspace', workspaceId
    ] });
    assert.equal(run.exitCode, 7);
    assert.equal(run.stdout, 'native-out');
    assert.equal(run.stderr, 'native-err');
    assert.equal(runs, 1);
    const blockedRun = await executeCaptured({ command: executable, args: [
      '--config', config, 'exec', '--workspace', workspaceId, '--', 'blocked-write'
    ] });
    assert.equal(blockedRun.exitCode, 1);
    assert.equal(blockedRun.stdout, '');
    assert.match(
      blockedRun.stderr,
      /WORKSPACE_BOUNDARY_VIOLATION: outside workspace/
    );
    assert.equal(runs, 1);
    const currentFile = await executeCaptured({ command: executable, args: [
      '--config', config, 'current-file', '--workspace', workspaceId
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
        '--config', config, 'edit', '--workspace', workspaceId,
        '--path', 'a.txt', '--input', '-'
      ],
      stdin: JSON.stringify({ edits: [{ oldText: 'a', newText: 'b' }] })
    });
    assert.equal(edit.exitCode, 0, edit.stderr);
    for (const call of structuredCalls) {
      const result = await executeCaptured({ command: executable, args: [
        '--config', config, call[0], '--workspace', workspaceId, ...call.slice(1)
      ] });
      assert.equal(result.exitCode, 0, `${call[0]}: ${result.stderr}`);
    }
    const write = await executeCaptured({
      command: executable,
      args: [
        '--config', config, 'write', '--workspace', workspaceId,
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
      '--config', config, '--compact', 'batch', '--workspace', workspaceId, '--input',
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
      '--config', config, 'list', '--workspace', workspaceId, '--path', 'forbidden'
    ] });
    assert.equal(conciseError.exitCode, 1);
    assert.match(conciseError.stderr, /REMOTE_TOOL_ERROR: denied detail/);
    assert.equal(conciseError.stderr.includes('{"code"'), false);
    const syntaxError = await executeCaptured({ command: executable, args: [
      '--config', config, 'read', '--workspace', workspaceId, '--unknown', 'value'
    ] });
    assert.equal(syntaxError.exitCode, 1);
    assert.match(syntaxError.stderr, /Invalid option for read: --unknown/);
    assert.match(syntaxError.stderr, /Usage: safs read/);
    assert.equal(syntaxError.stderr.includes('Usage: safs upload'), false);
    assert.ok(activity.some((event) => event.phase === 'start'));
    assert.ok(activity.filter((event) => event.phase === 'start').every(
      (event) => event.agentName === 'URL Agent' && event.source === 'cli'
    ));
    const explicitStart = activity.length;
    const namedRead = await executeCaptured({ command: executable, args: [
      '--config', config, 'read', 'named.txt', '--workspace', workspaceId,
      '--agent', 'Explicit Agent'
    ] });
    assert.equal(namedRead.exitCode, 0, namedRead.stderr);
    const namedBatch = await executeCaptured({ command: executable, args: [
      '--config', config, 'batch', '--workspace', workspaceId, '--agent', 'Explicit Agent',
      '--input', JSON.stringify({ operations: [
        { command: 'read', arguments: { path: 'a.txt' } },
        { command: 'list', arguments: { path: 'src' } }
      ] })
    ] });
    assert.equal(namedBatch.exitCode, 0, namedBatch.stderr);
    const namedEvents = activity.slice(explicitStart).filter((event) => event.phase === 'start');
    assert.equal(namedEvents.length, 3);
    assert.ok(namedEvents.every((event) => event.agentName === 'Explicit Agent' && event.source === 'cli'));
  } finally {
    await router.stop();
    await backend.stop();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('native CLI applies the connection-file request timeout', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'safs-native-timeout-'));
  const hanging = http.createServer(() => {});
  await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
  const address = hanging.address();
  assert.ok(address && typeof address !== 'string');
  const executable = bundledNativeCli(
    process.cwd(), nativeCliPlatform(process.platform, process.arch)
  );
  try {
    const config = cliConfigPath(temporary);
    await writeCliConnection(
      temporary, `http://127.0.0.1:${address.port}/mcp?token=secret`, 50
    );
    const started = Date.now();
    const result = await executeCaptured({ command: executable, args: [
      '--config', config, 'workspaces'
    ] });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /request failed:/);
    assert.ok(Date.now() - started < 2_000);
  } finally {
    await new Promise<void>((resolve) => hanging.close(() => resolve()));
    await rm(temporary, { recursive: true, force: true });
  }
});

test('native CLI bypasses proxy variables for loopback', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'safs-native-no-proxy-'));
  let proxyHits = 0;
  const proxy = http.createServer((_request, response) => {
    proxyHits += 1;
    response.statusCode = 502;
    response.end('loopback request was intercepted');
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyAddress = proxy.address();
  assert.ok(proxyAddress && typeof proxyAddress !== 'string');
  const router = new AgentHttpRouter(await freePort(), 'no-proxy-router', {
    discover: () => []
  });
  await router.start();
  const executable = bundledNativeCli(
    process.cwd(), nativeCliPlatform(process.platform, process.arch)
  );
  const config = cliConfigPath(temporary);
  const proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;
  const proxyEnvironment = {
    ALL_PROXY: proxyUrl,
    all_proxy: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    HTTP_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    NO_PROXY: '',
    no_proxy: ''
  };
  try {
    await writeCliConnection(temporary, router.url);
    const workspaces = await executeCaptured({
      command: executable,
      args: ['--config', config, 'workspaces'],
      env: proxyEnvironment
    });
    assert.equal(workspaces.exitCode, 0, workspaces.stderr);
    assert.deepEqual(JSON.parse(workspaces.stdout), { workspaces: [] });

    assert.equal(proxyHits, 0);
  } finally {
    await router.stop();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await rm(temporary, { recursive: true, force: true });
  }
});
