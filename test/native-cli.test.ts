import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bundledNativeCli, ensureUnixCliPath, globalNativeCli, installNativeCli,
  nativeCliConnectionPath, nativeCliPlatform, nativeCliUninstallPrompt, nativeCliUsagePrompt,
  parseNativeCliVersion, removeNativeCli, withoutSafsPathBlock,
  streamableHttpMcpInstallPrompt, streamableHttpMcpUninstallPrompt,
  windowsUserPathRemovePlan, windowsUserPathUpdatePlan
} from '../src/native-cli';

test('parses only the stable native CLI version output', () => {
  assert.equal(parseNativeCliVersion('safs 1.8.2\n'), '1.8.2');
  assert.equal(parseNativeCliVersion('safs v2.0.0-beta.1\n'), '2.0.0-beta.1');
  assert.equal(parseNativeCliVersion('warning: version 1.8.0\n'), undefined);
});

test('builds global CLI guidance for remote-only Agent operations', () => {
  const prompt = nativeCliUsagePrompt();
  assert.match(prompt, /user-level global persistent instructions/);
  assert.match(prompt, /not in the current conversation or project instructions/);
  assert.match(prompt, /do not append a duplicate block/);
  assert.equal(prompt.match(/<!-- SAFS CLI BEGIN -->/gu)?.length, 2);
  assert.equal(prompt.match(/<!-- SAFS CLI END -->/gu)?.length, 2);
  assert.match(prompt, /`safs bind --agent/);
  assert.match(prompt, /reuse the returned `--binding`/);
  assert.match(prompt, /`safs --help`/);
  assert.match(prompt, /Use structured SAFS commands for every remote file operation/);
  assert.match(prompt, /never use local filesystem tools or `safs exec`/);
  assert.equal(prompt.includes('workspaceRoot'), false);
  assert.equal(prompt.includes('token='), false);
  assert.doesNotMatch(prompt, /[\u3400-\u9fff]/u);
});

test('builds a scoped prompt for removing persistent CLI rules', () => {
  const prompt = nativeCliUninstallPrompt();
  assert.match(prompt, /user-level global persistent instructions/);
  assert.match(prompt, /Remove only that SAFS block/);
  assert.match(prompt, /preserve every unrelated instruction/);
  assert.doesNotMatch(prompt, /[\u3400-\u9fff]/u);
});

test('selects native binaries for the current extension environment', () => {
  assert.equal(nativeCliPlatform('linux', 'x64'), 'linux-x64');
  assert.equal(nativeCliPlatform('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(nativeCliPlatform('win32', 'x64'), 'win32-x64');
  assert.equal(nativeCliPlatform('win32', 'arm64'), 'win32-arm64');
  assert.match(bundledNativeCli('root', 'win32-x64'), /safs\.exe$/);
  assert.equal(globalNativeCli('/home/me', 'linux-x64'), '/home/me/.local/bin/safs');
  assert.equal(nativeCliConnectionPath('/home/me/.local/bin/safs'), '/home/me/.local/bin/.safs-connection.json');
  assert.throws(() => nativeCliPlatform('linux', 'ia32'));
});

test('builds a concise Streamable HTTP MCP installation prompt', () => {
  const prompt = streamableHttpMcpInstallPrompt(
    'http://127.0.0.1:9848/mcp?token=secret'
  );
  assert.match(prompt, /Streamable HTTP/);
  assert.match(prompt, /http:\/\/127\.0\.0\.1:9848\/mcp\?token=secret/);
  assert.match(prompt, /restart the Agent/);
  assert.doesNotMatch(prompt, /proxy|CLI mode/i);
  assert.equal(prompt.split('\n').length, 2);
  assert.doesNotMatch(prompt, /[\u3400-\u9fff]/u);
});

test('builds an English MCP uninstall prompt without operational rules', () => {
  const prompt = streamableHttpMcpUninstallPrompt();
  assert.match(prompt, /Uninstall the user-level MCP server named "safs"/);
  assert.match(prompt, /Remove only that MCP entry/);
  assert.equal(prompt.split('\n').length, 2);
  assert.equal(prompt.includes('safs exec'), false);
  assert.doesNotMatch(prompt, /[\u3400-\u9fff]/u);
});

test('passes the Windows user PATH directory through the environment', () => {
  const directory = String.raw`C:\Users\Test User\AppData\Local\SAFS\bin`;
  const plan = windowsUserPathUpdatePlan(directory);
  assert.equal(plan.command, 'powershell.exe');
  assert.deepEqual(plan.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.equal(plan.args.length, 4);
  assert.equal(plan.env?.SAFS_CLI_BIN_DIRECTORY, directory);
  assert.ok(!plan.args.some(argument => argument === directory));
  assert.match(plan.args[3], /\$env:SAFS_CLI_BIN_DIRECTORY/);
});

test('builds a Windows user PATH removal without embedding the directory', () => {
  const directory = String.raw`C:\Users\Test User\AppData\Local\SAFS\bin`;
  const plan = windowsUserPathRemovePlan(directory);
  assert.equal(plan.command, 'powershell.exe');
  assert.equal(plan.env?.SAFS_CLI_BIN_DIRECTORY, directory);
  assert.ok(!plan.args.some(argument => argument === directory));
  assert.match(plan.args[3], /SetEnvironmentVariable\('Path'/);
});

test('installs only the selected platform executable from the extension bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safs-native-cli-'));
  try {
    const extensionRoot = join(root, 'extension');
    const home = join(root, 'home');
    const binary = Buffer.alloc(100 * 1024, 0);
    binary.set(Buffer.from('7f454c46', 'hex'));
    const source = bundledNativeCli(extensionRoot, 'linux-x64');
    await mkdir(join(extensionRoot, 'bin', 'linux-x64'), { recursive: true });
    await writeFile(source, binary);
    const installed = await installNativeCli(
      extensionRoot, home, 'linux-x64', process.platform
    );
    assert.deepEqual(await readFile(installed), binary);
    assert.deepEqual(await readFile(source), binary);
    assert.equal(installed, join(home, '.local', 'bin', 'safs'));
    if (process.platform !== 'win32') {
      const { stat } = await import('node:fs/promises');
      assert.equal((await stat(installed)).mode & 0o777, 0o755);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('fails clearly when the extension bundle is missing its platform CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safs-native-cli-missing-'));
  try {
    await assert.rejects(
      installNativeCli(join(root, 'extension'), join(root, 'home'), 'linux-x64'),
      /插件包内缺少 linux-x64 SAFS CLI/
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('adds the user CLI directory to the Unix login PATH idempotently', async () => {
  const home = await mkdtemp(join(tmpdir(), 'safs-native-path-'));
  try {
    await writeFile(join(home, '.profile'), 'export LANG=C\n');
    await ensureUnixCliPath(home);
    const first = await readFile(join(home, '.profile'), 'utf8');
    const firstZsh = await readFile(join(home, '.zprofile'), 'utf8');
    await ensureUnixCliPath(home);
    assert.equal(await readFile(join(home, '.profile'), 'utf8'), first);
    assert.equal(await readFile(join(home, '.zprofile'), 'utf8'), firstZsh);
    assert.match(first, /export PATH="\$HOME\/\.local\/bin:\$PATH"/);
    assert.match(firstZsh, /export PATH="\$HOME\/\.local\/bin:\$PATH"/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('removes CLI files and managed Unix PATH entries', async () => {
  const home = await mkdtemp(join(tmpdir(), 'safs-native-remove-'));
  try {
    const executable = globalNativeCli(home, 'linux-x64');
    await import('node:fs/promises').then(fs => fs.mkdir(join(home, '.local', 'bin'), { recursive: true }));
    await writeFile(executable, 'native');
    await writeFile(nativeCliConnectionPath(executable), '{}');
    await writeFile(join(home, '.profile'), 'before\n# SAFS CLI PATH BEGIN\nmanaged\n# SAFS CLI PATH END\nafter\n');
    await writeFile(join(home, '.zprofile'), '# SAFS CLI PATH BEGIN\nmanaged\n# SAFS CLI PATH END\nkeep\n');
    await removeNativeCli(home, 'linux-x64');
    await assert.rejects(readFile(executable), { code: 'ENOENT' });
    await assert.rejects(readFile(nativeCliConnectionPath(executable)), { code: 'ENOENT' });
    assert.equal(await readFile(join(home, '.profile'), 'utf8'), 'before\nafter\n');
    assert.equal(await readFile(join(home, '.zprofile'), 'utf8'), 'keep\n');
    assert.equal(withoutSafsPathBlock('plain\n'), 'plain\n');
  } finally { await rm(home, { recursive: true, force: true }); }
});
