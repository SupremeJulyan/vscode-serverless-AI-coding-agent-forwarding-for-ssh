import assert from 'node:assert/strict';
import test from 'node:test';
import type { PasswordAnswer } from '../src/security/password-prompt';
import { HostConfig } from '../src/config/config';
import { hostPasswordKey, resolveHostCredential } from '../src/security/host-credentials';

const host: HostConfig = { name: 'dev', ip: 'Example.com', user: 'alice' };
function setup() {
  const values = new Map<string, string>();
  let prompts = 0;
  const storage = {
    get: async (key: string) => values.get(key),
    store: async (key: string, value: string) => { values.set(key, value); },
    delete: async (key: string) => { values.delete(key); }
  };
  const options = {
    promptPassword: async (): Promise<PasswordAnswer | undefined> => { prompts++; return { password: 'entered', remember: true }; },
    promptPrivateKey: async (): Promise<string | undefined> => '/selected/key',
    savePrivateKey: async (_path: string) => {},
    sessionPasswords: new Map<string, string>()
  };
  return { values, storage, options, prompts: () => prompts };
}

test('credential identity survives aliases and distinguishes users and ports', () => {
  assert.equal(hostPasswordKey(host), hostPasswordKey({ ...host, name: 'renamed', ip: 'example.COM', port: 22 }));
  assert.notEqual(hostPasswordKey(host), hostPasswordKey({ ...host, user: 'bob' }));
  assert.notEqual(hostPasswordKey(host), hostPasswordKey({ ...host, port: 2222 }));
});

test('saved password is returned without prompting or putting it in the original config', async () => {
  const s = setup(); s.values.set(hostPasswordKey(host), 'saved');
  assert.equal((await resolveHostCredential(host, s.storage, s.options)).password, 'saved');
  assert.equal(s.prompts(), 0); assert.equal(host.password, undefined);
});

test('missing password prompts once and stores the answer', async () => {
  const s = setup();
  assert.equal((await resolveHostCredential(host, s.storage, s.options)).password, 'entered');
  await resolveHostCredential(host, s.storage, s.options);
  assert.equal(s.prompts(), 1); assert.equal(s.values.get(hostPasswordKey(host)), 'entered');
});

test('private-key authentication does not prompt for a login password', async () => {
  const s = setup();
  assert.equal((await resolveHostCredential({ ...host, private_key_path: '~/.ssh/id_ed25519' }, s.storage, s.options)).password, undefined);
  assert.equal(s.prompts(), 0);
});

test('cancelled input does not save a credential', async () => {
  const s = setup(); s.options.promptPassword = async () => undefined;
  await assert.rejects(resolveHostCredential(host, s.storage, s.options), /已取消/);
  assert.equal(s.values.size, 0);
});

test('unchecked remember keeps the password only in memory for this window session', async () => {
  const s = setup();
  let prompts = 0;
  s.options.promptPassword = async () => { prompts++; return { password: 'temporary', remember: false }; };
  assert.equal((await resolveHostCredential(host, s.storage, s.options)).password, 'temporary');
  assert.equal(s.values.size, 0);
  assert.equal((await resolveHostCredential(host, s.storage, s.options)).password, 'temporary');
  assert.equal(prompts, 1);
  s.options.sessionPasswords.clear();
  await resolveHostCredential(host, s.storage, s.options);
  assert.equal(prompts, 2);
});

test('publickey authentication selects and saves a key only when none is configured', async () => {
  const s = setup(); let saved = '';
  s.values.set(hostPasswordKey(host), 'password-for-another-method');
  s.options.savePrivateKey = async path => { saved = path; };
  const result = await resolveHostCredential({ ...host, auth: 'publickey' }, s.storage, s.options);
  assert.equal(result.private_key_path, '/selected/key');
  assert.equal(result.password, undefined);
  assert.equal(saved, '/selected/key');
  assert.equal(s.prompts(), 0);
});

test('cancelling private key selection never saves a path or asks for a password', async () => {
  const s = setup();
  s.options.promptPrivateKey = async () => undefined;
  await assert.rejects(resolveHostCredential({ ...host, auth: 'publickey' }, s.storage, s.options), /已取消 SSH 私钥选择/);
  assert.equal(s.prompts(), 0);
});
