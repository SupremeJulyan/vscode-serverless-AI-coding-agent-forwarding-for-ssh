import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  downloadNativeCli, ensureUnixCliPath, globalNativeCli, installNativeCli,
  globalNativeCliSkill, nativeCliConnectionPath, nativeCliPlatform,
  nativeCliAssetName, nativeCliDownloadUrl,
  parseNativeCliVersion, removeGlobalNativeCliSkill, removeNativeCli, withoutSafsPathBlock,
  streamableHttpMcpInstallPrompt, streamableHttpMcpUninstallPrompt,
  windowsUserPathRemovePlan, windowsUserPathUpdatePlan
} from '../src/native-cli';

test('parses only the stable native CLI version output', () => {
  assert.equal(parseNativeCliVersion('safs 1.8.2\n'), '1.8.2');
  assert.equal(parseNativeCliVersion('safs v2.0.0-beta.1\n'), '2.0.0-beta.1');
  assert.equal(parseNativeCliVersion('warning: version 1.8.0\n'), undefined);
});

test('locates and removes the global SAFS Agent Skill', async () => {
  const home = await mkdtemp(join(tmpdir(), 'safs-native-skill-home-'));
  try {
    const skill = globalNativeCliSkill(home);
    assert.equal(skill, join(home, '.agents', 'skills', 'safs-cli'));
    assert.equal(
      globalNativeCliSkill(home, 'copilot'),
      join(home, '.copilot', 'skills', 'safs-cli')
    );
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, 'SKILL.md'), 'installed');
    assert.equal(await removeGlobalNativeCliSkill(home), skill);
    await assert.rejects(readFile(join(skill, 'SKILL.md')), { code: 'ENOENT' });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('selects native binaries for the current extension environment', () => {
  assert.equal(nativeCliPlatform('linux', 'x64'), 'linux-x64');
  assert.equal(nativeCliPlatform('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(nativeCliPlatform('win32', 'x64'), 'win32-x64');
  assert.equal(nativeCliPlatform('win32', 'arm64'), 'win32-arm64');
  assert.equal(nativeCliAssetName('win32-x64'), 'safs-win32-x64.exe');
  assert.equal(nativeCliAssetName('linux-arm64'), 'safs-linux-arm64');
  assert.equal(
    nativeCliDownloadUrl('2.0.2', 'linux-x64'),
    'https://github.com/SupremeJulyan/vscode-serverless-AI-coding-agent-forwarding-for-ssh/releases/download/v2.0.2/safs-linux-x64'
  );
  assert.throws(() => nativeCliDownloadUrl('../main', 'linux-x64'));
  const home = join(tmpdir(), 'safs-native-home');
  assert.equal(globalNativeCli(home, 'linux-x64'), join(home, '.local', 'bin', 'safs'));
  assert.equal(nativeCliConnectionPath(join(home, '.local', 'bin', 'safs')), join(home, '.local', 'bin', '.safs-connection.json'));
  assert.throws(() => nativeCliPlatform('linux', 'ia32'));
});

test('download failures tell the user how to retry the global CLI installation', async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(undefined, {
      status: 404, statusText: 'Not Found'
    });
    await assert.rejects(
      downloadNativeCli('https://example.test/safs-linux-x64'),
      /HTTP 404 Not Found。确定网络正常后，使用命令“SAFS: 安装或更新全局 CLI”重新下载。/
    );
    globalThis.fetch = async () => { throw new Error('network unavailable'); };
    await assert.rejects(
      downloadNativeCli('https://example.test/safs-linux-x64'),
      /network unavailable。确定网络正常后，使用命令“SAFS: 安装或更新全局 CLI”重新下载。/
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
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

test('downloads and installs only the selected platform executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safs-native-cli-'));
  try {
    const home = join(root, 'home');
    const binary = Buffer.alloc(100 * 1024, 0);
    binary.set(Buffer.from('7f454c46', 'hex'));
    binary.set(Buffer.from('safs 2.0.2'), 128);
    const urls: string[] = [];
    const installed = await installNativeCli(
      home, 'linux-x64', '2.0.2', process.platform, async url => {
        urls.push(url);
        return binary;
      }
    );
    assert.deepEqual(await readFile(installed), binary);
    assert.deepEqual(urls, [nativeCliDownloadUrl('2.0.2', 'linux-x64')]);
    assert.equal(installed, join(home, '.local', 'bin', 'safs'));
    if (process.platform !== 'win32') {
      const { stat } = await import('node:fs/promises');
      assert.equal((await stat(installed)).mode & 0o777, 0o755);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects failed downloads and mismatched binaries without replacing the installed CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safs-native-cli-missing-'));
  try {
    const home = join(root, 'home');
    const executable = globalNativeCli(home, 'linux-x64');
    await mkdir(join(home, '.local', 'bin'), { recursive: true });
    await writeFile(executable, 'existing');
    await assert.rejects(installNativeCli(
      home, 'linux-x64', '2.0.2', process.platform,
      async () => { throw new Error('offline'); }
    ), /offline/);
    assert.equal(await readFile(executable, 'utf8'), 'existing');
    const wrong = Buffer.alloc(100 * 1024, 0);
    wrong.set(Buffer.from('7f454c46', 'hex'));
    wrong.set(Buffer.from('safs 9.9.9'), 128);
    await assert.rejects(installNativeCli(
      home, 'linux-x64', '2.0.2', process.platform, async () => wrong
    ), /版本.*不一致/);
    assert.equal(await readFile(executable, 'utf8'), 'existing');
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

test('removes CLI files, every global Skill, and managed Unix PATH entries', async () => {
  const home = await mkdtemp(join(tmpdir(), 'safs-native-remove-'));
  try {
    const executable = globalNativeCli(home, 'linux-x64');
    await import('node:fs/promises').then(fs => fs.mkdir(join(home, '.local', 'bin'), { recursive: true }));
    await writeFile(executable, 'native');
    await writeFile(nativeCliConnectionPath(executable), '{}');
    const skills = ['agents', 'claude', 'codex', 'copilot'] as const;
    for (const target of skills) {
      const skill = globalNativeCliSkill(home, target);
      await mkdir(skill, { recursive: true });
      await writeFile(join(skill, 'SKILL.md'), 'installed');
    }
    await writeFile(join(home, '.profile'), 'before\n# SAFS CLI PATH BEGIN\nmanaged\n# SAFS CLI PATH END\nafter\n');
    await writeFile(join(home, '.zprofile'), '# SAFS CLI PATH BEGIN\nmanaged\n# SAFS CLI PATH END\nkeep\n');
    await removeNativeCli(home, 'linux-x64');
    await assert.rejects(readFile(executable), { code: 'ENOENT' });
    await assert.rejects(readFile(nativeCliConnectionPath(executable)), { code: 'ENOENT' });
    for (const target of skills) {
      await assert.rejects(
        readFile(join(globalNativeCliSkill(home, target), 'SKILL.md')),
        { code: 'ENOENT' }
      );
    }
    assert.equal(await readFile(join(home, '.profile'), 'utf8'), 'before\nafter\n');
    assert.equal(await readFile(join(home, '.zprofile'), 'utf8'), 'keep\n');
    assert.equal(withoutSafsPathBlock('plain\n'), 'plain\n');
  } finally { await rm(home, { recursive: true, force: true }); }
});
