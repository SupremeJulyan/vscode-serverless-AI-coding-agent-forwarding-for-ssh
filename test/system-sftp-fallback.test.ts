import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('remote folders fall back from ssh2 to the system OpenSSH SCP session', async () => {
  const extension = await readFile(new URL('../src/extension.ts', import.meta.url), 'utf8');
  assert.match(extension, /session = await connectSftp\(/);
  assert.match(extension, /session = await connectSystemScp\(/);
  assert.match(extension, /ssh2 连接失败，静默回退系统 SSH\/SCP/);
});

test('system fallback reuses ScpSession semantics over a system ssh facade', async () => {
  const source = await readFile(new URL('../src/sftp/system-session.ts', import.meta.url), 'utf8');
  assert.match(source, /class SystemSshExecClient extends EventEmitter/);
  assert.match(source, /new ScpSession\(host\.name, facade as unknown as Client\)/);
  assert.match(source, /createAskpassCredentials\(this\.host\.password\)/);
  assert.match(source, /this\.adapter\.exec\(this\.host, '\/', command, this\.options\)/);
});
