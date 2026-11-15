import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseConfig, saveConfig, loadConfig } from '../src/config/config';

test('manual config ignores legacy SSH-config source markers', async () => {
  const host = { name: 'manual', ip: 'same-as-ssh-alias', user: 'alice', password: 'secret' };
  const legacy = parseConfig({ hosts: [{ ...host, source: 'ssh-config' }] });
  assert.equal(legacy.hosts[0].ip, 'same-as-ssh-alias');
  assert.equal('source' in legacy.hosts[0], false);
});

test('unsupported connection options are discarded when saving hierarchical config', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safs-profile-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const account = { user: 'alice', auth: 'agent', agent_socket: '/tmp/agent', proxy_command: 'proxy arg', jump_host: 'jump', socks_proxy: 'localhost:1080', http_proxy: 'localhost:8080' };
  const config = parseConfig({ hosts: [{ name: 'dev', ip: '10.0.0.1', accounts: [account] }] });
  const file = path.join(directory, 'config.json'); await saveConfig(file, config);
  const restored = await loadConfig(file);
  assert.equal(restored.hosts[0].user, account.user);
  for (const key of ['auth', 'agent_socket', 'proxy_command', 'jump_host', 'socks_proxy', 'http_proxy']) {
    assert.equal(key in config.hosts[0], false);
    assert.equal(key in restored.hosts[0], false);
  }
});
