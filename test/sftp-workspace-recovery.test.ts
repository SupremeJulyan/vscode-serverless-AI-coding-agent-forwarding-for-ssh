import assert from 'node:assert/strict';
import { EventEmitter as NodeEventEmitter } from 'node:events';
import test from 'node:test';
import type * as vscode from 'vscode';
import { SftpConnectionPool, isConnectionError } from '../src/ssh2/connection-pool';
import { remoteUri } from '../src/ssh2/uri';

const api = require('vscode');
class TestEventEmitter<Value> {
  private readonly emitter = new NodeEventEmitter();
  readonly event = (listener: (value: Value) => void) => {
    this.emitter.on('value', listener);
    return { dispose: () => this.emitter.removeListener('value', listener) };
  };
  fire(value: Value): void { this.emitter.emit('value', value); }
  dispose(): void { this.emitter.removeAllListeners(); }
}
Object.assign(api, {
  EventEmitter: TestEventEmitter,
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
  Disposable: class { constructor(private action: () => void) {} dispose() { this.action(); } },
  FileSystemError: class extends Error {
    code: string;
    constructor(message: string, code: string) { super(message); this.code = code; }
    static Unavailable(message: string) { return new this(message, 'Unavailable'); }
    static NoPermissions(message: string) { return new this(message, 'NoPermissions'); }
  }
});

const { SftpFileSystemProvider, RemoteFolderRegistry } = require('../src/ssh2/filesystem-provider') as typeof import('../src/ssh2/filesystem-provider');

test('an offline workspace restores its mapping and refreshes Explorer when online', async context => {
  let online = false;
  const registry = new RemoteFolderRegistry();
  const folder = { mountName: 'dev', hostName: 'dev', remoteRoot: '/', workspaceRoot: '/stage' };
  const session = {
    realpath: async (value: string) => value,
    stat: async () => {
      if (!online) throw Object.assign(new Error('network is unreachable'), { code: 'ENETUNREACH' });
      return { type: 'directory', size: 0, mtime: 10, ctime: 10 };
    }
  };
  const provider = new SftpFileSystemProvider(
    { get: async () => session } as unknown as SftpConnectionPool,
    registry, 0, 60_000, undefined, async () => {
      if (!online) throw new Error('network is unreachable');
      registry.set(folder);
      return folder;
    }
  );
  context.after(() => provider.dispose());
  const uri = {
    scheme: 'safs', path: '/stage', toString: () => remoteUri('dev', '/stage'),
    with: () => ({ toString: () => remoteUri('dev', '/') })
  } as unknown as vscode.Uri;
  const changes: number[] = [];
  provider.onDidChangeFile(events => changes.push(...events.map(event => event.type)));
  const watch = provider.watch(uri, { recursive: false, excludes: [] });
  context.after(() => watch.dispose());
  await assert.rejects(provider.stat(uri), /network is unreachable/);
  online = true;
  await (provider as any).pollWatches();
  assert.equal(registry.get('dev'), folder);
  assert.deepEqual(changes, [api.FileChangeType.Changed]);
  online = false;
  changes.length = 0;
  await (provider as any).pollWatches();
  assert.deepEqual(changes, [], 'a network outage is not a directory deletion');
  online = true;
  await (provider as any).pollWatches();
  assert.deepEqual(changes, [api.FileChangeType.Changed]);
});

test('network failures recover while authentication and cancellation do not', () => {
  for (const message of [
    'System SFTP closed (255): Connection reset', 'No response from server',
    'SFTP operation timed out', 'Network is unreachable'
  ]) assert.equal(isConnectionError(new Error(message)), true, message);
  for (const message of [
    'System SFTP closed (255): Permission denied', 'Host key verification failed',
    'System SFTP connection was cancelled'
  ]) assert.equal(isConnectionError(new Error(message)), false, message);
});

test('slow Explorer stat requests and overlapping watch ticks share one remote operation', async context => {
  const registry = new RemoteFolderRegistry();
  registry.set({ mountName: 'dev', hostName: 'dev', remoteRoot: '/', workspaceRoot: '/stage' });
  let stats = 0;
  let complete!: () => void;
  const waiting = new Promise<void>(resolve => { complete = resolve; });
  const session = {
    realpath: async (value: string) => value,
    stat: async () => { stats++; await waiting; return { type: 'directory', size: 0, mtime: 10, ctime: 10 }; }
  };
  const provider = new SftpFileSystemProvider({ get: async () => session } as unknown as SftpConnectionPool, registry, 0, 60_000);
  context.after(() => provider.dispose());
  const uri = { scheme: 'safs', path: '/stage', toString: () => remoteUri('dev', '/stage'),
    with: () => ({ toString: () => remoteUri('dev', '/') }) } as unknown as vscode.Uri;
  provider.watch(uri, { recursive: false, excludes: [] });
  const firstPoll = (provider as any).pollWatches();
  const reads = [provider.stat(uri), provider.stat(uri)];
  await new Promise(resolve => setImmediate(resolve));
  for (let tick = 0; tick < 10; tick++) await (provider as any).pollWatches();
  assert.equal(stats, 1);
  complete();
  await Promise.all([firstPoll, ...reads]);
});

test('concurrent directory requests coalesce and failed requests can be retried', async context => {
  const registry = new RemoteFolderRegistry();
  registry.set({ mountName: 'dev', hostName: 'dev', remoteRoot: '/', workspaceRoot: '/stage' });
  let lists = 0;
  let complete!: () => void;
  const waiting = new Promise<void>(resolve => { complete = resolve; });
  let fail = true;
  const session = { readDirectoryResolved: async () => {
    lists++; await waiting;
    if (fail) throw new Error('temporary failure');
    return { path: '/', entries: [] };
  } };
  const provider = new SftpFileSystemProvider({ get: async () => session } as unknown as SftpConnectionPool, registry, 0, 60_000);
  context.after(() => provider.dispose());
  const uri = { scheme: 'safs', path: '/stage', toString: () => remoteUri('dev', '/stage') } as unknown as vscode.Uri;
  const first = provider.readDirectory(uri), second = provider.readDirectory(uri);
  const failed = Promise.allSettled([first, second]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lists, 1);
  complete();
  assert.ok((await failed).every(result => result.status === 'rejected'));
  fail = false;
  assert.deepEqual(await provider.readDirectory(uri), []);
  assert.equal(lists, 2);
});

test('the first watch snapshot does not restart an Explorer directory load', async context => {
  const registry = new RemoteFolderRegistry();
  registry.set({ mountName: 'dev', hostName: 'dev', remoteRoot: '/', workspaceRoot: '/stage' });
  let complete!: () => void;
  const waiting = new Promise<void>(resolve => { complete = resolve; });
  let lists = 0;
  const session = {
    realpath: async (value: string) => value,
    stat: async () => ({ type: 'directory', size: 0, mtime: 10, ctime: 10 }),
    readDirectoryResolved: async () => { lists++; await waiting; return { path: '/', entries: [] }; }
  };
  const provider = new SftpFileSystemProvider({ get: async () => session } as unknown as SftpConnectionPool, registry, 30_000, 60_000);
  context.after(() => provider.dispose());
  const uri = { scheme: 'safs', path: '/stage', toString: () => remoteUri('dev', '/stage'),
    with: () => ({ toString: () => remoteUri('dev', '/') }) } as unknown as vscode.Uri;
  provider.watch(uri, { recursive: false, excludes: [] });
  const refreshed: Promise<unknown>[] = [];
  provider.onDidChangeFile(() => { refreshed.push(provider.readDirectory(uri)); });
  const original = provider.readDirectory(uri);
  await (provider as any).pollWatches();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lists, 1, 'the initial watch event must reuse the pending directory request');
  complete();
  await Promise.all([original, ...refreshed]);
});
