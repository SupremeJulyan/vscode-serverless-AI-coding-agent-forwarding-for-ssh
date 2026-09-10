import assert from 'node:assert/strict';
import * as http from 'node:http';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentMcpServer } from '../src/agent-mcp';
import { AgentHttpRouter } from '../src/agent-http-router';
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

test('native CLI binds and executes through the existing SAFS router', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'safs-native-e2e-'));
  let runs = 0;
  let currentFileReads = 0;
  const operations: string[] = [];
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
    run: async () => {
      runs += 1;
      return { stdout: 'native-out', stderr: 'native-err', exitCode: 7 };
    }
  } as any);
  await backend.start();
  const router = new AgentHttpRouter(await freePort(), 'native-router', {
    discover: () => [{
      instanceId: 'native-window', workspaceRoot: '/project', host: 'dev',
      agentCwd: temporary, focused: true, mcpUrl: backend.url
    } as any]
  });
  await router.start();
  const config = cliConfigPath(temporary);
  const executable = bundledNativeCli(
    process.cwd(), nativeCliPlatform(process.platform, process.arch)
  );
  try {
    await writeCliConnection(temporary, router.url);
    const help = await executeCaptured({ command: executable, args: ['edit', '--help'] });
    assert.equal(help.exitCode, 0, help.stderr);
    assert.match(help.stdout, /^Usage: safs edit /);
    assert.equal(help.stdout.includes('Usage: safs upload'), false);
    const workspaces = await executeCaptured({ command: executable, args: [
      '--config', config, 'workspaces'
    ] });
    assert.equal(workspaces.exitCode, 0, workspaces.stderr);
    assert.deepEqual(JSON.parse(workspaces.stdout), { workspaces: [{
      workspaceId: 'native-window', workspaceRoot: '/project', host: 'dev'
    }] });
    const bind = await executeCaptured({ command: executable, args: [
      '--config', config, 'bind', '--cwd', temporary
    ] });
    assert.equal(bind.exitCode, 0, bind.stderr);
    const bindingId = JSON.parse(bind.stdout).bindingId;
    const run = await executeCaptured({ command: executable, args: [
      '--config', config, 'exec', '--binding', bindingId, '--', 'exit 7'
    ] });
    assert.equal(run.exitCode, 7);
    assert.equal(run.stdout, 'native-out');
    assert.equal(run.stderr, 'native-err');
    assert.equal(runs, 1);
    const currentFile = await executeCaptured({ command: executable, args: [
      '--config', config, 'current-file', '--binding', bindingId
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
        '--config', config, 'edit', '--binding', bindingId,
        '--path', 'a.txt', '--input', '-'
      ],
      stdin: JSON.stringify({ edits: [{ oldText: 'a', newText: 'b' }] })
    });
    assert.equal(edit.exitCode, 0, edit.stderr);
    for (const call of structuredCalls) {
      const result = await executeCaptured({ command: executable, args: [
        '--config', config, call[0], '--binding', bindingId, ...call.slice(1)
      ] });
      assert.equal(result.exitCode, 0, `${call[0]}: ${result.stderr}`);
    }
    const write = await executeCaptured({
      command: executable,
      args: [
        '--config', config, 'write', '--binding', bindingId,
        '--path', 'write.txt', '--file', '-'
      ],
      stdin: 'replacement'
    });
    assert.equal(write.exitCode, 0, write.stderr);
    assert.deepEqual(
      [...new Set(operations)],
      ['edit', 'read', 'search', 'delete', 'chmod', 'move', 'upload', 'download', 'write']
    );
    const batch = await executeCaptured({ command: executable, args: [
      '--config', config, '--compact', 'batch', '--binding', bindingId, '--input',
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
    const conciseError = await executeCaptured({ command: executable, args: [
      '--config', config, 'list', '--binding', bindingId, '--path', 'forbidden'
    ] });
    assert.equal(conciseError.exitCode, 1);
    assert.match(conciseError.stderr, /REMOTE_TOOL_ERROR: denied detail/);
    assert.equal(conciseError.stderr.includes('{"code"'), false);
    const syntaxError = await executeCaptured({ command: executable, args: [
      '--config', config, 'read', '--binding', bindingId, '--unknown', 'value'
    ] });
    assert.equal(syntaxError.exitCode, 1);
    assert.match(syntaxError.stderr, /Invalid option for read: --unknown/);
    assert.match(syntaxError.stderr, /Usage: safs read/);
    assert.equal(syntaxError.stderr.includes('Usage: safs upload'), false);
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

test('native CLI and stdio MCP bridge bypass proxy variables for loopback', async () => {
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

    const initialize = await executeCaptured({
      command: executable,
      args: [
        '--config', config, 'mcp-bridge', '--agent', 'proxy-test', '--platform', 'mac'
      ],
      env: proxyEnvironment,
      stdin: [
        {
          jsonrpc: '2.0', id: 1, method: 'initialize', params: {
            protocolVersion: '2025-03-26', capabilities: {},
            clientInfo: { name: 'proxy-test', version: '1.0.0' }
          }
        },
        { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
      ].map((message) => JSON.stringify(message)).join('\n') + '\n'
    });
    assert.equal(initialize.exitCode, 0, initialize.stderr);
    const responses = initialize.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(responses.length, 2);
    assert.equal(responses[0].id, 1);
    assert.equal(responses[0].result.serverInfo.name, 'safs-http-router');
    assert.equal(responses[1].id, 2);
    assert.ok(responses[1].result.tools.some((tool: { name: string }) =>
      tool.name === 'get_remote_workspace'
    ));
    assert.equal(proxyHits, 0);
  } finally {
    await router.stop();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await rm(temporary, { recursive: true, force: true });
  }
});
