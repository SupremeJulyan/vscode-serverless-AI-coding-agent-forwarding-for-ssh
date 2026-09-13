import assert from 'node:assert/strict';
import test from 'node:test';
import { proxyEnvironmentWarning } from '../src/proxy-environment';

test('detects proxy environments that do not bypass every loopback host', () => {
  assert.deepEqual(proxyEnvironmentWarning({
    HTTPS_PROXY: 'http://proxy.example:8080',
    NO_PROXY: 'localhost,127.0.0.1'
  }), {
    proxyVariables: ['HTTPS_PROXY'],
    missingLoopbackHosts: ['::1']
  });
  assert.deepEqual(proxyEnvironmentWarning({
    all_proxy: 'socks5://proxy.example:1080',
    no_proxy: 'localhost:9848,127.0.0.1:9848,[::1]:9848'
  }), undefined);
});

test('ignores empty proxy variables and wildcard NO_PROXY', () => {
  assert.equal(proxyEnvironmentWarning({ HTTP_PROXY: '  ' }), undefined);
  assert.equal(proxyEnvironmentWarning({ HTTP_PROXY: 'http://proxy', NO_PROXY: '*' }), undefined);
});
