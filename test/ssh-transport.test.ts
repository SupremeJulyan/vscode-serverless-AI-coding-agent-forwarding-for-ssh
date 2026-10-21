import assert from 'node:assert/strict';
import test from 'node:test';
import { selectSshTransport } from '../src/ssh-transport';

const host = { name: 'dev', ip: '10.0.0.2', user: 'alice', password: 'secret' };

test('manual SAFS accounts always select ssh2 regardless of their credentials', () => {
  for (const platform of ['windows', 'linux', 'macos', 'wsl'] as const) {
    for (const account of [
      host,
      { ...host, password: undefined },
      { ...host, password: undefined, private_key_path: '/key' },
      { ...host, private_key_path: '/key' }
    ]) {
      assert.equal(selectSshTransport(platform, account), 'ssh2', platform);
    }
  }
});

test('SSH config imports always select system SSH, including explicit password and key accounts', () => {
  for (const platform of ['windows', 'linux', 'macos', 'wsl'] as const) {
    for (const account of [
      host,
      { ...host, password: undefined },
      { ...host, password: undefined, private_key_path: '/key' },
      { ...host, private_key_path: '/key' }
    ]) {
      assert.equal(selectSshTransport(platform, { ...account, source: 'ssh-config' }), 'system', platform);
    }
  }
});

test('explicit system fallback and WSL VPN routing remain available', () => {
  for (const platform of ['windows', 'linux', 'macos', 'wsl'] as const) {
    assert.equal(selectSshTransport(platform, host, true), 'system');
  }
  assert.equal(selectSshTransport('wsl', { ...host, vpn: true }), 'system');
  assert.equal(selectSshTransport('linux', { ...host, vpn: true }), 'ssh2');
});
