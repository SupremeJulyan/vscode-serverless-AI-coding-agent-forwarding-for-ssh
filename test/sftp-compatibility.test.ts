import assert from 'node:assert/strict';
import test from 'node:test';
import { isRetryableSsh2ConnectionError } from '../src/sftp/client';

test('retries transient ssh2 connection and handshake failures', () => {
  for (const message of [
    'Connection lost before handshake',
    'Timed out while waiting for handshake',
    'read ECONNRESET',
    'socket hang up',
    'Connection unexpectedly closed',
    'kex_exchange_identification: Connection closed by remote host',
    'connect ETIMEDOUT 10.0.0.2:22',
    'Network is unreachable'
  ]) {
    assert.equal(isRetryableSsh2ConnectionError(new Error(message)), true, message);
  }
});

test('does not retry permanent authentication or host-key failures', () => {
  for (const message of [
    'All configured authentication methods failed',
    'Permission denied (publickey,password)',
    'Host key verification failed',
    'Host key did not match configured key'
  ]) {
    assert.equal(isRetryableSsh2ConnectionError(new Error(message)), false, message);
  }
});
