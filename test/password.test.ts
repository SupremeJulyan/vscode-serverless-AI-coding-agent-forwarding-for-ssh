import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptPassword, isEncryptedPassword } from '../src/patches/legacy-password';

// A password encrypted by the previous release, retained for migration compatibility.
const legacy = 'enc:v1:U2FsdGVkX1_RZTLqVR-LuD86rvHQDjJRhx0-KZkyntklV7Ec7TAZ-Kb7muQmj9wsDTYXOaENfmy1TcAWpE3m8VTjlqDPjaU-00DgxKPlDE0=';

test('decrypts passwords written by previous releases', async () => {
  assert.equal(isEncryptedPassword(legacy), true);
  assert.equal(await decryptPassword(legacy, 'master secret'), '服务器 password !');
});

test('rejects an incorrect legacy master password', async () => {
  await assert.rejects(() => decryptPassword(legacy, 'incorrect'), /主口令错误/);
});

test('rejects corrupted legacy ciphertext', async () => {
  const corrupted = legacy.slice(0, -5) + 'AAAA=';
  await assert.rejects(() => decryptPassword(corrupted, 'master secret'), /密文已损坏/);
});
