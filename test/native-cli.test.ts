import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bundledNativeCli, ensureUnixCliPath, globalNativeCli, installNativeCli,
  nativeCliConnectionPath, nativeCliPlatform
} from '../src/native-cli';

test('selects native binaries for desktop platforms and WSL', () => {
  assert.equal(nativeCliPlatform('linux', 'x64'), 'linux-x64');
  assert.equal(nativeCliPlatform('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(nativeCliPlatform('win32', 'x64'), 'win32-x64');
  assert.equal(nativeCliPlatform('win32', 'arm64', true), 'linux-arm64');
  assert.match(bundledNativeCli('root', 'win32-x64'), /safs\.exe$/);
  assert.equal(globalNativeCli('/home/me', 'linux-x64'), '/home/me/.local/bin/safs');
  assert.equal(nativeCliConnectionPath('/home/me/.local/bin/safs'), '/home/me/.local/bin/.safs-connection.json');
  assert.throws(() => nativeCliPlatform('linux', 'ia32'));
});

test('installs an executable copy under extension storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safs-native-cli-'));
  try {
    const source = bundledNativeCli(root, 'linux-x64');
    await import('node:fs/promises').then(fs => fs.mkdir(join(root, 'bin', 'linux-x64'), { recursive: true }));
    await writeFile(source, 'native');
    await chmod(source, 0o644);
    const home = join(root, 'home');
    const installed = await installNativeCli(root, home, 'linux-x64');
    assert.equal(await readFile(installed, 'utf8'), 'native');
    assert.equal(installed, join(home, '.local', 'bin', 'safs'));
    if (process.platform !== 'win32') {
      const { stat } = await import('node:fs/promises');
      assert.equal((await stat(installed)).mode & 0o777, 0o755);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('adds the user CLI directory to the Unix login PATH idempotently', async () => {
  const home = await mkdtemp(join(tmpdir(), 'safs-native-path-'));
  try {
    await writeFile(join(home, '.profile'), 'export LANG=C\n');
    await ensureUnixCliPath(home);
    const first = await readFile(join(home, '.profile'), 'utf8');
    await ensureUnixCliPath(home);
    assert.equal(await readFile(join(home, '.profile'), 'utf8'), first);
    assert.match(first, /export PATH="\$HOME\/\.local\/bin:\$PATH"/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
