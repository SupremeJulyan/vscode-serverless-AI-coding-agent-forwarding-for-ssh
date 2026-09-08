'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtemp, mkdir, readFile, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { cleanup, removeWindowsUserPath, withoutSafsPathBlock } = require('./uninstall');

test('removes only the SAFS-managed Unix profile block', () => {
  const profile = 'export LANG=C\n# SAFS CLI PATH BEGIN\nexport PATH="$HOME/.local/bin:$PATH"\n# SAFS CLI PATH END\nexport EDITOR=vim\n';
  assert.equal(withoutSafsPathBlock(profile), 'export LANG=C\nexport EDITOR=vim\n');
});

test('Windows PATH cleanup passes the directory through the environment', () => {
  const directory = String.raw`C:\Users\Test User\AppData\Local\SAFS\bin`;
  let call;
  removeWindowsUserPath(directory, (...args) => { call = args; });
  assert.equal(call[0], 'powershell.exe');
  assert.equal(call[1].length, 4);
  assert.equal(call[2].env.SAFS_CLI_BIN_DIRECTORY, directory);
  assert.ok(!call[1].includes(directory));
});

test('Unix cleanup removes CLI files and managed profile entries', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'safs-uninstall-'));
  const bin = path.join(home, '.local', 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'safs'), 'binary');
  await writeFile(path.join(bin, '.safs-connection.json'), '{}');
  await writeFile(path.join(home, '.profile'), '# SAFS CLI PATH BEGIN\nmanaged\n# SAFS CLI PATH END\nkeep\n');
  await cleanup({ platform: 'linux', home });
  assert.equal(await readFile(path.join(home, '.profile'), 'utf8'), 'keep\n');
  await assert.rejects(readFile(path.join(bin, 'safs')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(bin, '.safs-connection.json')), { code: 'ENOENT' });
});
