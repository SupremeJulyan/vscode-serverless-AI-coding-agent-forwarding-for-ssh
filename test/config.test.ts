import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ensureConfigFile, expandHome, parseConfig, parseSshLogin, resolveMount, saveConfig,
  removeMountConfig
} from '../src/config';

test('parses and resolves a mount through its host reference', () => {
  const config = parseConfig({
    encrypt_passwords: true,
    hosts: [{ name: 'dev', ip: '10.0.0.2', user: 'alice', vpn: true }],
    mounts: [{ name: 'project', host: 'dev', remote_path: '/srv/project' }]
  });
  const resolved = resolveMount(config, config.mounts[0]);
  assert.equal(resolved.hostConfig.ip, '10.0.0.2');
  assert.equal(resolved.remote_terminal, 'open');
});

test('saves a configuration that can be loaded as JSON', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safs-save-'));
  const configPath = path.join(directory, 'config.json');
  const config = {
    encrypt_passwords: true,
    hosts: [{ name: 'dev', ip: '10.0.0.2', user: 'alice', port: 22, vpn: true }],
    mounts: [{ name: 'project', host: 'dev', remote_path: '/srv/project', remote_terminal: 'open' as const }]
  };

  await saveConfig(configPath, config);
  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(saved, { encrypt_passwords: true, hosts: config.hosts });
  assert.equal(saved.mounts, undefined);
  const reloaded = parseConfig(saved);
  assert.equal(reloaded.mounts.length, 1);
  assert.equal(reloaded.mounts[0].name, 'project');
  assert.equal(reloaded.mounts[0].host, 'dev');
  assert.equal(reloaded.mounts[0].remote_path, '/srv/project');
});

test('ignores legacy local mount paths when parsing SFTP folders', () => {
  const config = parseConfig({
    hosts: [{ name: 'dev', ip: 'host', user: 'alice' }],
    mounts: [{
      name: 'project',
      host: 'dev',
      remote_path: '.',
      local_path: '/fallback',
      local_paths: { macos: '/Users/alice/project' }
    }]
  });

  assert.equal(config.mounts[0].name, 'project');
  assert.equal(config.mounts[0].host, 'dev');
  assert.equal(config.mounts[0].remote_path, '.');
  assert.equal(config.mounts[0].remote_terminal, 'open');
});

test('removes a mount and its host only when no other mount uses that host', () => {
  const config = parseConfig({
    hosts: [
      { name: 'dev', ip: 'host', user: 'alice' },
      { name: 'other', ip: 'other', user: 'bob' }
    ],
    mounts: [
      { name: 'project', host: 'dev', remote_path: '.' },
      { name: 'docs', host: 'dev', remote_path: '/docs' },
      { name: 'other', host: 'other', remote_path: '.' }
    ]
  });

  removeMountConfig(config, 'project');
  assert.deepEqual(config.mounts.map((mount) => mount.name), ['docs', 'other']);
  assert.deepEqual(config.hosts.map((host) => host.name), ['dev', 'other']);

  removeMountConfig(config, 'docs');
  assert.deepEqual(config.hosts.map((host) => host.name), ['other']);
});

test('rejects a missing host reference', () => {
  assert.throws(() => parseConfig({
    hosts: [],
    mounts: [{ name: 'project', host: 'missing', remote_path: '/srv/project' }]
  }), /references missing host/);
});

test('normalizes legacy remote terminal modes to open', () => {
  const config = parseConfig({
    hosts: [{ name: 'dev', ip: 'host', user: 'alice' }],
    mounts: [{ name: 'project', host: 'dev', remote_path: '/srv/project', remote_terminal: 'sometimes' }]
  });
  assert.equal(config.mounts[0].remote_terminal, 'open');
});

test('defaults encrypt_passwords to true when the legacy field is absent', () => {
  const config = parseConfig({
    hosts: [{ name: 'dev', ip: 'host', user: 'alice' }],
    mounts: [{ name: 'project', host: 'dev', remote_path: '/srv/project' }]
  });
  assert.equal(config.encrypt_passwords, true);
  assert.equal(parseConfig({ encrypt_passwords: false, hosts: [], mounts: [] }).encrypt_passwords, false);
});

test('allows a host to be created before its login credentials are added', () => {
  const config = parseConfig({ hosts: [{ name: 'pending', ip: '10.0.0.8' }] });
  assert.equal(config.hosts[0].user, '');
  assert.equal(config.mounts[0].name, 'pending');
});

test('uses the IP as the host name for legacy entries without a name', () => {
  const config = parseConfig({
    hosts: [{ ip: '10.0.0.9', user: 'alice' }]
  });
  assert.equal(config.hosts[0].name, '10.0.0.9');
  assert.equal(config.mounts[0].host, '10.0.0.9');
});

test('preserves hierarchical host display aliases', () => {
  const config = parseConfig({
    host_aliases: { '10.0.0.9': 'build-server' },
    hosts: [{ ip: '10.0.0.9', user: 'alice' }]
  });
  assert.deepEqual(config.host_aliases, { '10.0.0.9': 'build-server' });
});

test('preserves a Windows drive-letter mount path', () => {
  assert.equal(expandHome('x:'), 'X:\\');
  assert.equal(expandHome('x:\\'), 'X:\\');
});

test('parses compact SSH login input', () => {
  assert.deepEqual(parseSshLogin('alice@10.0.0.1'), { user: 'alice', host: '10.0.0.1' });
  assert.deepEqual(parseSshLogin('alice@[2001:db8::1]'), { user: 'alice', host: '2001:db8::1' });
  assert.equal(parseSshLogin('alice'), undefined);
  assert.equal(parseSshLogin('@host'), undefined);
});

test('creates a minimal config template without overwriting an existing config', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safs-'));
  const configPath = path.join(directory, 'nested', 'config.json');

  assert.equal(await ensureConfigFile(configPath), configPath);
  const created = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(created.hosts, []);
  assert.equal(created.encrypt_passwords, true);
  assert.deepEqual(Object.keys(created).sort(), ['encrypt_passwords', 'hosts']);
  const parsed = parseConfig(created);
  assert.deepEqual(parsed.hosts, []);
  assert.deepEqual(parsed.mounts, []);

  await writeFile(configPath, '{"hosts":["keep-me"]}\n');
  await ensureConfigFile(configPath);
  assert.equal(await readFile(configPath, 'utf8'), '{"hosts":["keep-me"]}\n');
});
