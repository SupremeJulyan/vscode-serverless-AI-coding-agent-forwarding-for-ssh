import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureUnixCliPath, globalNodeCli, installNodeCli,
  globalNodeCliSkill, nodeCliConnectionPath, nodeCliPlatform,
  parseNodeCliVersion, removeGlobalNodeCliSkill, removeNodeCli, withoutSafsPathBlock,
  streamableHttpMcpInstallPrompt, streamableHttpMcpUninstallPrompt,
  windowsUserPathRemovePlan, windowsUserPathUpdatePlan
} from '../src/node-cli-install';

test('parses only the stable native CLI version output', () => {
  assert.equal(parseNodeCliVersion('safs 1.8.2\n'), '1.8.2');
  assert.equal(parseNodeCliVersion('safs v2.0.0-beta.1\n'), '2.0.0-beta.1');
  assert.equal(parseNodeCliVersion('warning: version 1.8.0\n'), undefined);
});

test('locates and removes the global SAFS Agent Skill', async () => {
  const home = await mkdtemp(join(tmpdir(), 'safs-native-skill-home-'));
  try {
    const skill = globalNodeCliSkill(home);
    assert.equal(skill, join(home, '.agents', 'skills', 'safs-cli'));
    assert.equal(
      globalNodeCliSkill(home, 'copilot'),
      join(home, '.copilot', 'skills', 'safs-cli')
    );
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, 'SKILL.md'), 'installed');
    assert.equal(await removeGlobalNodeCliSkill(home), skill);
    await assert.rejects(readFile(join(skill, 'SKILL.md')), { code: 'ENOENT' });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('selects native binaries for the current extension environment', () => {
  assert.equal(nodeCliPlatform('linux', 'x64'), 'linux-x64');
  assert.equal(nodeCliPlatform('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(nodeCliPlatform('win32', 'x64'), 'win32-x64');
  assert.equal(nodeCliPlatform('win32', 'arm64'), 'win32-arm64');
  const home = join(tmpdir(), 'safs-native-home');
  assert.equal(globalNodeCli(home, 'linux-x64'), join(home, '.local', 'bin', 'safs'));
  assert.equal(nodeCliConnectionPath(join(home, '.local', 'bin', 'safs')), join(home, '.local', 'bin', '.safs-connection.json'));
  assert.throws(() => nodeCliPlatform('linux', 'ia32'));
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

test('installs the bundled Node CLI and migrates Windows native launchers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safs-node-install-'));
  try {
    const source = join(root, 'cli.js');
    const content = '#!/usr/bin/env node\nconsole.log("safs 2.0.4");\n';
    await writeFile(source, content);
    const installed = await installNodeCli(root, 'linux-x64', '2.0.4', source);
    assert.equal(await readFile(installed, 'utf8'), content);
    await writeFile(source, 'invalid');
    await assert.rejects(installNodeCli(root, 'linux-x64', '2.0.4', source));
    assert.equal(await readFile(installed, 'utf8'), content);
    await writeFile(source, content);
    const winRoot = join(root, 'windows');
    const win = globalNodeCli(winRoot, 'win32-x64');
    await mkdir(join(winRoot, 'AppData', 'Local', 'SAFS', 'bin'), { recursive: true });
    const old = join(winRoot, 'AppData', 'Local', 'SAFS', 'bin', 'safs.exe');
    await writeFile(old, 'old binary');
    assert.equal(await installNodeCli(winRoot, 'win32-x64', '2.0.4', source), win);
    assert.match(await readFile(win, 'utf8'), /node "%~dp0safs-cli.js" %\*/);
    assert.equal(await readFile(join(winRoot, 'AppData', 'Local', 'SAFS', 'bin', 'safs-cli.js'), 'utf8'), content);
    await assert.rejects(readFile(old), { code: 'ENOENT' });
    await removeNodeCli(winRoot, 'win32-x64');
    await assert.rejects(readFile(win), { code: 'ENOENT' });
    await assert.rejects(readFile(join(winRoot, 'AppData', 'Local', 'SAFS', 'bin', 'safs-cli.js')), { code: 'ENOENT' });
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
    const executable = globalNodeCli(home, 'linux-x64');
    await import('node:fs/promises').then(fs => fs.mkdir(join(home, '.local', 'bin'), { recursive: true }));
    await writeFile(executable, 'native');
    await writeFile(nodeCliConnectionPath(executable), '{}');
    const skills = ['agents', 'claude', 'codex', 'copilot'] as const;
    for (const target of skills) {
      const skill = globalNodeCliSkill(home, target);
      await mkdir(skill, { recursive: true });
      await writeFile(join(skill, 'SKILL.md'), 'installed');
    }
    await writeFile(join(home, '.profile'), 'before\n# SAFS CLI PATH BEGIN\nmanaged\n# SAFS CLI PATH END\nafter\n');
    await writeFile(join(home, '.zprofile'), '# SAFS CLI PATH BEGIN\nmanaged\n# SAFS CLI PATH END\nkeep\n');
    await removeNodeCli(home, 'linux-x64');
    await assert.rejects(readFile(executable), { code: 'ENOENT' });
    await assert.rejects(readFile(nodeCliConnectionPath(executable)), { code: 'ENOENT' });
    for (const target of skills) {
      await assert.rejects(
        readFile(join(globalNodeCliSkill(home, target), 'SKILL.md')),
        { code: 'ENOENT' }
      );
    }
    assert.equal(await readFile(join(home, '.profile'), 'utf8'), 'before\nafter\n');
    assert.equal(await readFile(join(home, '.zprofile'), 'utf8'), 'keep\n');
    assert.equal(withoutSafsPathBlock('plain\n'), 'plain\n');
  } finally { await rm(home, { recursive: true, force: true }); }
});
