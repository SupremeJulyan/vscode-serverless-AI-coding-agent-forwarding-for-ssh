import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import { Client, type ConnectConfig } from 'ssh2';
import type { HostConfig } from '../src/config';

class TestEventEmitter<Value> {
  private readonly emitter = new EventEmitter();
  readonly event = (listener: (value: Value) => void) => {
    this.emitter.on('value', listener);
    return { dispose: () => this.emitter.removeListener('value', listener) };
  };
  fire(value: Value): void { this.emitter.emit('value', value); }
  dispose(): void { this.emitter.removeAllListeners(); }
}

Object.assign(require('vscode'), { EventEmitter: TestEventEmitter });
const { Ssh2Terminal } = require('../src/ssh2-terminal') as typeof import('../src/ssh2-terminal');
const filesystem = require('node:fs/promises') as typeof import('node:fs/promises');

const keyHost: HostConfig = {
  name: 'dev', ip: '192.0.2.4', user: 'alice', private_key_path: '~/.ssh/deploy-key'
};

function terminalHarness(context: TestContext, host: HostConfig, password?: string) {
  const configurations: ConnectConfig[] = [];
  let resolveConnected!: (config: ConnectConfig) => void;
  const connected = new Promise<ConnectConfig>((resolve) => { resolveConnected = resolve; });
  context.mock.method(Client.prototype, 'connect', function(this: Client, config: ConnectConfig) {
    configurations.push(config);
    resolveConnected(config);
    return this;
  });
  context.mock.method(Client.prototype, 'end', function(this: Client) { return this; });
  let resolveFailed!: (error: Error) => void;
  const failed = new Promise<Error>((resolve) => { resolveFailed = resolve; });
  const failures: Error[] = [];
  const terminal = new Ssh2Terminal(host, password, undefined, (error) => {
    failures.push(error);
    resolveFailed(error);
  });
  const closed = new Promise<number | undefined>((resolve) => terminal.onDidClose(resolve));
  context.after(() => terminal.close());
  return { terminal, connected, configurations, failed, failures, closed };
}

test('a key-only terminal reads its configured private key before connecting', async (context) => {
  const privateKey = Buffer.from('private-key-fixture');
  const reads: unknown[] = [];
  context.mock.method(filesystem, 'readFile', async (file: unknown) => {
    reads.push(file);
    return privateKey;
  });
  const { terminal, connected } = terminalHarness(context, keyHost);
  terminal.open();
  const config = await connected;
  assert.deepEqual(reads, [path.join(os.homedir(), '.ssh', 'deploy-key')]);
  assert.deepEqual(config.privateKey, privateKey);
  assert.equal(config.username, keyHost.user);
  assert.equal(config.host, keyHost.ip);
  assert.equal(config.password, undefined);
  assert.equal(config.tryKeyboard, undefined);
  assert.equal(typeof config.hostVerifier, 'function');
});

test('a terminal preserves both explicit key and password credentials', async (context) => {
  const privateKey = Buffer.from('private-key-fixture');
  context.mock.method(filesystem, 'readFile', async () => privateKey);
  const { terminal, connected } = terminalHarness(context, keyHost, 'password');
  terminal.open();
  const config = await connected;
  assert.deepEqual(config.privateKey, privateKey);
  assert.equal(config.password, 'password');
  assert.equal(config.tryKeyboard, true);
});

test('a password-only terminal does not read a private key', async (context) => {
  const read = context.mock.method(filesystem, 'readFile', async () => {
    throw new Error('unexpected key read');
  });
  const { terminal, connected } = terminalHarness(
    context, { ...keyHost, private_key_path: undefined }, 'password'
  );
  terminal.open();
  const config = await connected;
  assert.equal(config.privateKey, undefined);
  assert.equal(config.password, 'password');
  assert.equal(config.tryKeyboard, true);
  assert.equal(read.mock.callCount(), 0);
});

test('an unreadable private key reports failure and closes the terminal', { timeout: 2000 }, async (context) => {
  const error = Object.assign(new Error('key file unavailable'), { code: 'ENOENT' });
  context.mock.method(filesystem, 'readFile', async () => { throw error; });
  const { terminal, failed, closed, configurations, failures } = terminalHarness(context, keyHost);
  assert.doesNotThrow(() => terminal.open());
  assert.equal(await failed, error);
  assert.equal(await closed, 1);
  assert.equal(configurations.length, 0);
  assert.equal(failures.length, 1);
});

test('closing a terminal while its key loads never starts a connection', async (context) => {
  let completeRead: (value: Buffer) => void = () => {};
  context.mock.method(filesystem, 'readFile', () => new Promise<Buffer>((resolve) => {
    completeRead = resolve;
  }));
  const { terminal, configurations, failures } = terminalHarness(context, keyHost);
  terminal.open();
  terminal.close();
  completeRead(Buffer.from('private-key-fixture'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(configurations.length, 0);
  assert.equal(failures.length, 0);
});

test('invalid private key connection errors close the terminal without throwing from open', { timeout: 2000 }, async (context) => {
  context.mock.method(filesystem, 'readFile', async () => Buffer.from('invalid-key'));
  const { terminal, failed, closed } = terminalHarness(context, keyHost);
  context.mock.method(Client.prototype, 'connect', () => { throw new Error('invalid private key'); });
  assert.doesNotThrow(() => terminal.open());
  assert.match((await failed).message, /invalid private key/);
  assert.equal(await closed, 1);
});
