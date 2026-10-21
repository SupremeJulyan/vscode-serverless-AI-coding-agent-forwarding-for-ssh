import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { Server } from 'ssh2';
import test from 'node:test';
import { executeSsh2Command, Ssh2ConnectionError, Ssh2Terminal, closeSsh2ExecSessions } from '../src/ssh2-terminal';

test('terminal key setup failures stay quiet while automatic fallback is available', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safs-terminal-key-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const retrying of [true, false]) {
    const output: string[] = [];
    let failure: Error | undefined;
    const terminal = new Ssh2Terminal({ name: 'dev', ip: '127.0.0.1', user: 'alice',
      private_key_path: path.join(directory, 'missing-key') }, '', '/', error => {
      failure = error;
      return retrying;
    });
    terminal.onDidWrite(text => output.push(text));
    const closed = new Promise<void>(resolve => terminal.onDidClose(() => resolve()));
    terminal.open();
    await closed;
    assert.match(failure?.message ?? '', /ENOENT/);
    assert.equal(output.join('').includes('ENOENT'), !retrying);
    terminal.close();
  }
});

test('private-key authentication works and remote command failure is not a connection failure', { timeout: 10_000 }, async t => {
  const vscode = createRequire(import.meta.url)('vscode');
  t.mock.method(vscode.workspace, 'getConfiguration', () => ({
    get: (name: string, fallback: unknown) => name === 'hostKeyChangedAction' ? 'accept' : fallback
  }));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safs-key-auth-'));
  const key = generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const privateKey = path.join(directory, 'key');
  await writeFile(privateKey, key);
  let commands = 0;
  let usedPublicKey = false;
  const server = new Server({ hostKeys: [key] }, client => {
    client.on('error', () => {});
    client.on('authentication', ctx => {
      if (ctx.method === 'publickey') { usedPublicKey = true; ctx.accept(); }
      else ctx.reject(['publickey']);
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('exec', acceptExec => {
        commands++;
        const channel = acceptExec();
        channel.stderr.write('remote command failed');
        channel.exit(7);
        channel.end();
      });
    }));
  });
  t.after(async () => {
    closeSsh2ExecSessions();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const result = await executeSsh2Command({ name: 'dev', ip: '127.0.0.1', user: 'alice',
    port: (server.address() as { port: number }).port, private_key_path: privateKey }, undefined, '/', 'exit 7');
  assert.equal(usedPublicKey, true);
  assert.equal(result.exitCode, 7);
  assert.equal(commands, 1);
});

test('command setup failures are distinguished from dispatched commands and cancellation', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safs-command-key-'));
  t.after(async () => { closeSsh2ExecSessions(); await rm(directory, { recursive: true, force: true }); });
  const host = { name: 'dev', ip: '127.0.0.1', user: 'alice', private_key_path: path.join(directory, 'missing') };
  await assert.rejects(executeSsh2Command(host, undefined, '/', 'must-not-be-dispatched'), error => {
    assert.ok(error instanceof Ssh2ConnectionError);
    assert.match(error.message, /ENOENT/);
    return true;
  });
  await assert.rejects(executeSsh2Command(host, undefined, '/', 'must-not-be-dispatched', AbortSignal.abort()), error => {
    assert.equal(error instanceof Ssh2ConnectionError, false);
    return true;
  });
});
