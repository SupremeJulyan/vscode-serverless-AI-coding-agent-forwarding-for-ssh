import assert from 'node:assert/strict';
import test from 'node:test';
import { needsOpenSshAuthentication, selectSshTransport } from '../src/ssh-transport';

const host = { name: 'dev', ip: '10.0.0.2', user: 'alice', password: 'secret' };
const defaults = 'identityfile ~/.ssh/id_rsa\nidentityfile ~/.ssh/id_ed25519\nidentitiesonly no\nidentityagent SSH_AUTH_SOCK\npreferredauthentications publickey,password\n';

test('SFTP, terminal and command routing share explicit credentials and OpenSSH configuration policy', () => {
  for (const platform of ['windows', 'linux', 'macos', 'wsl'] as const) {
    assert.equal(selectSshTransport(platform, host), 'ssh2');
    assert.equal(selectSshTransport(platform, host, true), 'system');
    assert.equal(selectSshTransport(platform, { ...host, password: undefined }), 'system');
    assert.equal(selectSshTransport(platform, { ...host, password: undefined, private_key_path: '/key' }), 'ssh2');
  }
  assert.equal(selectSshTransport('wsl', { ...host, vpn: true }), 'system');
});

test('ordinary defaults do not route password connections away from ssh2', () => {
  assert.equal(needsOpenSshAuthentication(defaults, defaults, host, true), false);
  assert.equal(needsOpenSshAuthentication(defaults, defaults, { ...host, password: undefined, private_key_path: '/key' }), false);
});

test('SSH agent and default identity logins automatically use OpenSSH', () => {
  assert.equal(needsOpenSshAuthentication(defaults, defaults, { ...host, password: undefined }), true);
  assert.equal(needsOpenSshAuthentication(defaults, defaults, { ...host, password: undefined, private_key_path: '/key' }, true), true);
});

test('custom keys, certificates, agents, authentication and algorithms use OpenSSH', () => {
  for (const option of [
    'identityfile /keys/first\nidentityfile /keys/second',
    'certificatefile /keys/user-cert.pub', 'identityagent /run/custom-agent.sock',
    'identitiesonly yes', 'preferredauthentications gssapi-with-mic,publickey',
    'pubkeyauthentication no', 'passwordauthentication no', 'gssapiauthentication yes',
    'pkcs11provider /usr/lib/token.so', 'securitykeyprovider /usr/lib/fido.so',
    'kexalgorithms curve25519-sha256', 'bindinterface tun0', 'addressfamily inet6',
    'forwardagent yes', 'localforward 8080 localhost:8080', 'serveraliveinterval 30'
  ]) {
    assert.equal(needsOpenSshAuthentication(defaults + option + '\n', defaults, host), true, option);
  }
});
