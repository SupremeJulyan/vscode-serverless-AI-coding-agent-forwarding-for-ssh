import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig, setConfigReadPatch } from '../src/config/config';
import { legacyMasterPasswordSecret, needsPasswordMigration, SshPasswordMigration } from '../src/patches/ssh-passwords';
import { hostPasswordKey } from '../src/security/host-credentials';

const cipher = 'enc:v1:U2FsdGVkX1_RZTLqVR-LuD86rvHQDjJRhx0-KZkyntklV7Ec7TAZ-Kb7muQmj9wsDTYXOaENfmy1TcAWpE3m8VTjlqDPjaU-00DgxKPlDE0=';
const endpoint = { name: 'dev', ip: 'example.com', user: 'alice', port: 22 };
async function setup(raw: unknown) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safs-password-patch-'));
  const file = path.join(directory, 'config.json');
  const original = JSON.stringify(raw);
  await writeFile(file, original);
  const secrets = new Map<string, string>();
  const stores: string[] = []; let prompts = 0;
  const storage = {
    get: async (key: string) => secrets.get(key),
    store: async (key: string, value: string) => { secrets.set(key, value); stores.push(key); },
    delete: async (key: string) => { secrets.delete(key); }
  };
  const options = { storage, promptMasterPassword: async (_account: string, _attempt: number): Promise<string | undefined> => { prompts++; return 'master secret'; } };
  return { directory, file, original, secrets, stores, storage, options, prompts: () => prompts,
    read: async () => JSON.parse(await readFile(file, 'utf8')) };
}

test('version gate includes releases through 2.1.7 and unrecorded upgrades', () => {
  for (const version of [undefined, '1.9.0', '2.0.9', '2.1.5', '2.1.6', '2.1.7']) assert.equal(needsPasswordMigration(version), true);
  for (const version of ['2.1.8', '2.2.0', '3.0.0', 'invalid']) assert.equal(needsPasswordMigration(version), false);
});

test('flat plaintext passwords migrate without prompting and preserve mount bindings and key paths', async () => {
  const raw = { encrypt_passwords: false, hosts: [{ ...endpoint, password: 'old', private_key_path: '/key' }], mounts: [{ name: 'repo', host: 'dev', remote_path: '/project' }] };
  const s = await setup(raw); s.secrets.set(legacyMasterPasswordSecret, 'unused master');
  await new SshPasswordMigration(s.options).run(s.file);
  assert.equal(s.secrets.get(hostPasswordKey(endpoint)), 'old');
  assert.equal(s.secrets.has(legacyMasterPasswordSecret), false);
  assert.equal(s.prompts(), 0);
  const saved = await s.read();
  assert.equal('password' in saved.hosts[0], false); assert.equal('encrypt_passwords' in saved, false);
  assert.equal(saved.hosts[0].private_key_path, '/key'); assert.equal(saved.hosts[0].auth, 'password');
  assert.deepEqual(saved.mounts, raw.mounts);
});

test('hierarchical encrypted accounts use the saved master and preserve host/account metadata', async () => {
  const s = await setup({ encrypt_passwords: true, hosts: [{ name: '开发机', ip: endpoint.ip, accounts: [
    { user: 'alice', password: cipher, port: 22, vpn: true },
    { user: 'bob', private_key_path: '/keys/bob', auth: 'publickey', port: 2200 }
  ] }] });
  s.secrets.set(legacyMasterPasswordSecret, 'master secret');
  await new SshPasswordMigration(s.options).run(s.file);
  assert.equal(s.secrets.get(hostPasswordKey(endpoint)), '服务器 password !'); assert.equal(s.prompts(), 0);
  const saved = await s.read();
  assert.equal(saved.hosts[0].name, '开发机'); assert.equal(saved.hosts[0].accounts[0].vpn, true);
  assert.equal(saved.hosts[0].accounts[1].private_key_path, '/keys/bob');
  assert.equal(saved.hosts[0].accounts[1].port, 2200);
  assert.equal(s.secrets.has(legacyMasterPasswordSecret), false);
});

test('mixed flat and hierarchical accounts migrate together with separate port and user identities', async () => {
  const s = await setup({ hosts: [
    { ...endpoint, password: 'flat' },
    { name: 'other', ip: 'other.example', accounts: [{ user: 'alice', password: 'a' }, { user: 'bob', port: 2222, password: 'b' }] }
  ] });
  await new SshPasswordMigration(s.options).run(s.file);
  assert.equal(s.secrets.get(hostPasswordKey(endpoint)), 'flat');
  assert.equal(s.secrets.get(hostPasswordKey({ ...endpoint, ip: 'other.example' })), 'a');
  assert.equal(s.secrets.get(hostPasswordKey({ ...endpoint, ip: 'other.example', user: 'bob', port: 2222 })), 'b');
});

test('missing or wrong saved master prompts once and is never stored again', async () => {
  for (const previous of [undefined, 'wrong']) {
    const s = await setup({ hosts: [{ ...endpoint, password: cipher }] });
    if (previous) s.secrets.set(legacyMasterPasswordSecret, previous);
    await new SshPasswordMigration(s.options).run(s.file);
    assert.equal(s.prompts(), 1); assert.equal(s.stores.includes(legacyMasterPasswordSecret), false);
    assert.equal(s.secrets.has(legacyMasterPasswordSecret), false);
  }
});

test('cancelled migration preserves all config bytes and the saved master without storing partial credentials', async () => {
  const s = await setup({ hosts: [{ ...endpoint, password: 'first' }, { name: 'other', ip: 'other', user: 'bob', password: cipher }] });
  s.secrets.set(legacyMasterPasswordSecret, 'wrong');
  s.options.promptMasterPassword = async () => undefined;
  await assert.rejects(new SshPasswordMigration(s.options).run(s.file), /已取消/);
  assert.equal(await readFile(s.file, 'utf8'), s.original); assert.equal(s.secrets.get(legacyMasterPasswordSecret), 'wrong');
  assert.equal(s.stores.length, 0);
});

test('corrupt ciphertext stops after three prompts and keeps the master and original config', async () => {
  const s = await setup({ hosts: [{ ...endpoint, password: 'enc:v1:broken' }] });
  s.secrets.set(legacyMasterPasswordSecret, 'master secret');
  await assert.rejects(new SshPasswordMigration(s.options).run(s.file), /密文损坏/);
  assert.equal(s.prompts(), 3); assert.equal(s.stores.length, 0);
  assert.equal(await readFile(s.file, 'utf8'), s.original);
  assert.equal(s.secrets.has(legacyMasterPasswordSecret), true);
});

test('partial secure-storage failure leaves config and master intact and retry completes', async () => {
  const s = await setup({ hosts: [{ ...endpoint, password: 'first' }, { name: 'other', ip: 'other', user: 'bob', password: 'second' }] });
  s.secrets.set(legacyMasterPasswordSecret, 'master');
  const store = s.storage.store;
  s.storage.store = async (key, value) => { if (value === 'second') throw new Error('locked'); await store(key, value); };
  const patch = new SshPasswordMigration(s.options);
  await assert.rejects(patch.run(s.file), /locked/);
  assert.equal(await readFile(s.file, 'utf8'), s.original); assert.equal(s.secrets.has(legacyMasterPasswordSecret), true);
  s.storage.store = store; await patch.run(s.file);
  assert.equal(s.secrets.has(legacyMasterPasswordSecret), false);
  assert.equal((await s.read()).hosts.some((host: any) => 'password' in host), false);
});

test('read-back verification failure never removes the source passwords', async () => {
  const s = await setup({ hosts: [{ ...endpoint, password: 'old' }] });
  s.storage.store = async () => {};
  await assert.rejects(new SshPasswordMigration(s.options).run(s.file), /校验失败/);
  assert.equal(await readFile(s.file, 'utf8'), s.original);
});

test('newer saved passwords take precedence over imported legacy ciphertext', async () => {
  const s = await setup({ hosts: [{ ...endpoint, password: 'enc:v1:unreadable' }] });
  s.secrets.set(hostPasswordKey(endpoint), 'newer');
  await new SshPasswordMigration(s.options).run(s.file);
  assert.equal(s.prompts(), 0); assert.equal(s.secrets.get(hostPasswordKey(endpoint)), 'newer');
});

test('concurrent reads share one migration and a second run is idempotent', async () => {
  const s = await setup({ hosts: [{ ...endpoint, password: cipher }] });
  const patch = new SshPasswordMigration(s.options);
  await Promise.all([patch.run(s.file), patch.run(s.file), patch.run(s.file)]);
  const first = await readFile(s.file, 'utf8'); const count = s.stores.length;
  await patch.run(s.file);
  assert.equal(s.prompts(), 1); assert.equal(s.stores.length, count); assert.equal(await readFile(s.file, 'utf8'), first);
});

test('concurrent edits are preserved and a retry migrates the edited configuration', async () => {
  const s = await setup({ hosts: [{ ...endpoint, password: 'old' }] });
  const edited = JSON.stringify({ hosts: [{ ...endpoint, password: 'old', vpn: true }] });
  const store = s.storage.store;
  s.storage.store = async (key, value) => { await store(key, value); await writeFile(s.file, edited); };
  const patch = new SshPasswordMigration(s.options);
  await assert.rejects(patch.run(s.file), /配置被修改/);
  assert.equal(await readFile(s.file, 'utf8'), edited);
  assert.equal((await readdir(s.directory)).some(name => name.endsWith('.tmp')), false);
  s.storage.store = store; await patch.run(s.file); assert.equal((await s.read()).hosts[0].vpn, true);
});

test('master cleanup failure retries after successful config migration', async () => {
  const s = await setup({ hosts: [{ ...endpoint, password: 'old' }] });
  s.secrets.set(legacyMasterPasswordSecret, 'master');
  const remove = s.storage.delete;
  s.storage.delete = async () => { throw new Error('delete failed'); };
  const patch = new SshPasswordMigration(s.options);
  await assert.rejects(patch.run(s.file), /delete failed/);
  assert.equal('password' in (await s.read()).hosts[0], false);
  assert.equal(s.secrets.get(hostPasswordKey(endpoint)), 'old');
  s.storage.delete = remove; await patch.run(s.file);
  assert.equal(s.secrets.has(legacyMasterPasswordSecret), false);
});

test('config reads run the patch before flattening and never create a backup containing passwords', async t => {
  const s = await setup({ hosts: [{ ...endpoint, password: 'old' }], mounts: [{ name: 'repo', host: 'dev', remote_path: '/project' }] });
  const patch = new SshPasswordMigration(s.options);
  setConfigReadPatch(file => patch.run(file)); t.after(() => setConfigReadPatch(undefined));
  const loaded = await loadConfig(s.file);
  assert.equal(loaded.hosts[0].password, undefined); assert.equal(loaded.mounts[0].remote_path, '/project');
  const backup = JSON.parse(await readFile(s.file + '.legacy.bak', 'utf8'));
  assert.equal('password' in backup.hosts[0], false);
});

test('missing configuration is harmless and malformed configuration never deletes the master', async () => {
  const s = await setup({ hosts: [] }); s.secrets.set(legacyMasterPasswordSecret, 'master');
  await new SshPasswordMigration(s.options).run(path.join(s.directory, 'missing.json'));
  assert.equal(s.secrets.has(legacyMasterPasswordSecret), true);
  await writeFile(s.file, '{invalid');
  await assert.rejects(new SshPasswordMigration(s.options).run(s.file));
  assert.equal(s.secrets.has(legacyMasterPasswordSecret), true);
});

test('legacy auto, agent and interactive selectors retain their effective password/key authentication', async () => {
  const s = await setup({ hosts: [{ name: 'dev', ip: endpoint.ip, accounts: [
    { user: 'alice', auth: 'auto', password: 'old' },
    { user: 'bob', auth: 'agent', private_key_path: '/keys/bob' },
    { user: 'carol', auth: 'keyboard-interactive', password: 'other' }
  ] }] });
  await new SshPasswordMigration(s.options).run(s.file);
  const accounts = (await s.read()).hosts[0].accounts;
  assert.deepEqual(accounts.map((account: any) => account.auth), ['password', 'publickey', 'password']);
  assert.equal(accounts[1].private_key_path, '/keys/bob');
  assert.equal(accounts.some((account: any) => 'password' in account), false);
});
