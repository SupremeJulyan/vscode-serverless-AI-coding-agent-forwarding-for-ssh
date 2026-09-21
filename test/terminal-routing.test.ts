import assert from 'node:assert/strict';
import test from 'node:test';
import { HostConfig } from '../src/config';
import {
  shouldFallbackToSystemSsh, shouldUseBuiltinSshTerminal
} from '../src/terminal-routing';

const passwordHost: HostConfig = {
  name: 'dev', ip: '10.0.0.2', user: 'alice', password: 'secret'
};

test('direct password terminals use ssh2 on every extension platform', () => {
  for (const kind of ['windows', 'linux', 'macos', 'wsl'] as const) {
    assert.equal(shouldUseBuiltinSshTerminal(kind, passwordHost), true);
  }
});

test('key-based terminals also use ssh2 on all platforms', () => {
  const keyHost: HostConfig = {
    ...passwordHost, private_key_path: '/home/alice/.ssh/id_ed25519'
  };
  for (const kind of ['windows', 'linux', 'macos', 'wsl'] as const) {
    assert.equal(shouldUseBuiltinSshTerminal(kind, keyHost), true);
  }
});

test('key-only terminals (no password) use ssh2 on all platforms', () => {
  const keyOnlyHost: HostConfig = {
    name: 'dev', ip: '10.0.0.2', user: 'alice',
    private_key_path: '/home/alice/.ssh/id_ed25519'
  };
  for (const kind of ['windows', 'linux', 'macos', 'wsl'] as const) {
    assert.equal(shouldUseBuiltinSshTerminal(kind, keyOnlyHost), true);
  }
});

test('WSL VPN relay and explicit fallback keep system SSH', () => {
  assert.equal(shouldUseBuiltinSshTerminal('wsl', { ...passwordHost, vpn: true }), false);
  assert.equal(shouldUseBuiltinSshTerminal('linux', passwordHost, true), false);
  assert.equal(shouldUseBuiltinSshTerminal('linux', {
    ...passwordHost, password: undefined
  }), false);
});

test('falls back to system SSH for ssh2 handshake, reset, and channel failures', () => {
  assert.equal(shouldFallbackToSystemSsh(new Error('Connection lost before handshake')), true);
  assert.equal(shouldFallbackToSystemSsh(new Error('read ECONNRESET')), true);
  assert.equal(shouldFallbackToSystemSsh(new Error('Unable to open shell channel')), true);
  assert.equal(shouldFallbackToSystemSsh(new Error('All configured authentication methods failed')), false);
});
