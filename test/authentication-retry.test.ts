import assert from 'node:assert/strict';
import test from 'node:test';
import { HostConfig } from '../src/config/config';
import { PrivateKeyError, withAuthenticationRetries } from '../src/ssh2/authentication-retry';

const host: HostConfig = { name: 'dev', ip: 'example.com', user: 'alice', auth: 'password', password: 'old' };

for (const auth of ['password', 'publickey'] as const) {
  test(`${auth} authentication stops after three failed attempts`, async () => {
    let attempts = 0; const failures: Array<[number, boolean]> = [];
    await assert.rejects(withAuthenticationRetries({ ...host, auth }, async () => {
      attempts++; throw new Error('All configured authentication methods failed');
    }, async (current, _error, attempt, retry) => {
      failures.push([attempt, retry]); return { ...current, password: 'new' };
    }), /已尝试 3 次/);
    assert.equal(attempts, 3);
    assert.deepEqual(failures, [[1, true], [2, true], [3, false]]);
  });
}

test('a corrected password succeeds on the second attempt without a third prompt', async () => {
  const passwords: Array<string | undefined> = [];
  const result = await withAuthenticationRetries(host, async current => {
    passwords.push(current.password);
    if (current.password === 'old') throw new Error('Authentication failed');
    return 'connected';
  }, async current => ({ ...current, password: 'correct' }));
  assert.equal(result, 'connected'); assert.deepEqual(passwords, ['old', 'correct']);
});

test('invalid private keys can be reselected and the new path reaches the connection', async () => {
  const paths: Array<string | undefined> = [];
  await withAuthenticationRetries({ ...host, auth: 'publickey', private_key_path: '/bad' }, async current => {
    paths.push(current.private_key_path);
    if (current.private_key_path === '/bad') throw new PrivateKeyError('Unreadable key');
  }, async current => ({ ...current, private_key_path: '/good' }));
  assert.deepEqual(paths, ['/bad', '/good']);
});

test('network errors never trigger credential prompts', async () => {
  let attempts = 0; let prompts = 0;
  await assert.rejects(withAuthenticationRetries(host, async () => {
    attempts++; throw new Error('ECONNREFUSED');
  }, async current => { prompts++; return current; }), /ECONNREFUSED/);
  assert.equal(attempts, 1); assert.equal(prompts, 0);
});

test('cancelling credential entry stops after the first failure', async () => {
  let attempts = 0;
  await assert.rejects(withAuthenticationRetries(host, async () => {
    attempts++; throw new Error('Authentication failed');
  }, async () => undefined), /已取消 SSH 认证/);
  assert.equal(attempts, 1);
});
