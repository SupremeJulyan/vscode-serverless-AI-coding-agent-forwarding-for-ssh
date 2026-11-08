import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseConfig, saveConfig, loadConfig } from '../src/config/config';
import { SudoPasswordMiddleware } from '../src/ssh/sudo';

test('manual config ignores legacy SSH-config source markers', async () => {
  const host = { name: 'manual', ip: 'same-as-ssh-alias', user: 'alice', password: 'secret' };
  const legacy = parseConfig({ hosts: [{ ...host, source: 'ssh-config' }] });
  assert.equal(legacy.hosts[0].ip, 'same-as-ssh-alias');
  assert.equal('source' in legacy.hosts[0], false);
});

test('sudo middleware handles split/ANSI prompts and only accepts explicit user Enter', async () => {
  let hints = 0; const sent: string[] = [];
  const middleware = new SudoPasswordMiddleware('alice', async () => 'secret', () => hints++);
  middleware.feedOutput('\x1b[31m[su'); middleware.feedOutput('do] password for alice:\x1b[0m ');
  assert.equal(hints, 1);
  await middleware.feedInput('\r', data => sent.push(data)); assert.deepEqual(sent, ['secret\n']);
  middleware.feedOutput('[sudo] password for bob: '); await middleware.feedInput('\r', data => sent.push(data));
  assert.equal(sent.at(-1), '\r');
  middleware.feedOutput('[sudo] alice 的密码：'); await middleware.feedInput('x', data => sent.push(data));
  await middleware.feedInput('\r', data => sent.push(data)); assert.deepEqual(sent.slice(-2), ['x', '\r']);
});

test('native authentication and proxy options survive hierarchical config saving', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safs-profile-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const account = { user: 'alice', auth: 'agent', agent_socket: '/tmp/agent', proxy_command: 'proxy arg', jump_host: 'jump', socks_proxy: 'localhost:1080', http_proxy: 'localhost:8080' };
  const config = parseConfig({ hosts: [{ name: 'dev', ip: '10.0.0.1', accounts: [account] }] });
  const file = path.join(directory, 'config.json'); await saveConfig(file, config);
  const restored = await loadConfig(file);
  for (const [key, value] of Object.entries(account)) assert.equal((restored.hosts[0] as any)[key], value);
});

test('sudo password lookup is cancelled when output changes before the lookup completes', async () => {
  let complete!: (password: string) => void; const sent: string[] = [];
  const middleware = new SudoPasswordMiddleware('alice', () => new Promise(resolve => { complete = resolve; }), () => {});
  middleware.feedOutput('[sudo] password for alice: ');
  const input = middleware.feedInput('\r', data => sent.push(data));
  middleware.feedOutput('prompt expired\n'); complete('secret'); await input;
  assert.deepEqual(sent, []);
  middleware.feedOutput('[sudo: authenticate] Password: ');
  const next = middleware.feedInput('\r', data => sent.push(data)); complete('secret'); await next;
  assert.deepEqual(sent, ['secret\n']);
});
