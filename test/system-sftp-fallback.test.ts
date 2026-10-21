import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('remote folders use system SFTP and fall back to SCP when the subsystem is unavailable', async () => {
  const extension = await readFile(new URL('../src/extension.ts', import.meta.url), 'utf8');
  assert.match(extension, /session = await connectSftp\(/);
  assert.match(extension, /return await connectSystemSftp\(/);
  assert.match(extension, /return connectSystemScp\(/);
  assert.match(extension, /SFTP 子系统不可用，回退 SCP/);
});

test('system fallback reuses ScpSession semantics over a system ssh facade', async () => {
  const source = await readFile(new URL('../src/sftp/system-session.ts', import.meta.url), 'utf8');
  assert.match(source, /class SystemSshExecClient extends EventEmitter/);
  assert.match(source, /new ScpSession\(host\.name, facade as unknown as Client\)/);
  assert.match(source, /createAskpassCredentials\(this\.host\.password\)/);
  assert.match(source, /this\.adapter\.exec\(this\.host, '\/', command, this\.options\)/);
});
