import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { parseConfig } from '../config/config';
import { CredentialStorage, hostPasswordKey } from '../security/host-credentials';
import { decryptPassword, isEncryptedPassword } from './legacy-password';

export const legacyMasterPasswordSecret = 'safs.masterPassword';

export function needsPasswordMigration(version: string | undefined): boolean {
  if (!version) return true;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major < 2 || major === 2 && (minor < 1 || minor === 1 && patch <= 7);
}

interface MigrationOptions {
  storage: CredentialStorage;
  promptMasterPassword(account: string, attempt: number): Promise<string | undefined>;
}

/** Re-scans on each read so imported old configs and interrupted upgrades recover. */
export class SshPasswordMigration {
  private readonly pending = new Map<string, Promise<void>>();
  constructor(private readonly options: MigrationOptions) {}

  run(file: string): Promise<void> {
    const key = path.resolve(file);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const operation = this.migrate(key).finally(() => this.pending.delete(key));
    this.pending.set(key, operation);
    return operation;
  }

  private async migrate(file: string): Promise<void> {
    let original: string;
    try { original = await readFile(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const raw = JSON.parse(original);
    let changed = false;
    // These selectors were accepted by <=2.1.7 but were never wired into its
    // connection code. Keep its effective password/key behavior on upgrade.
    if (Array.isArray(raw?.hosts)) {
      for (const host of raw.hosts) {
        if (!host || typeof host !== 'object') continue;
        const accounts = Array.isArray(host.accounts) ? host.accounts : [host];
        for (const account of accounts) {
          if (account && ['auto', 'agent', 'keyboard-interactive'].includes(account.auth)) {
            account.auth = account.password || !account.private_key_path ? 'password' : 'publickey';
            changed = true;
          }
        }
      }
    }
    // Validate the complete configuration before touching secrets or files.
    const config = parseConfig(raw);
    const staged = new Map<string, string>();
    const stage = (key: string, password: string) => {
      if (staged.has(key) && staged.get(key) !== password) throw new Error('旧配置中同一 SSH 账号存在冲突密码，请先检查配置；原配置保持不变');
      staged.set(key, password);
    };
    const masters: string[] = [];
    const savedMaster = await this.options.storage.get(legacyMasterPasswordSecret);
    if (savedMaster) masters.push(savedMaster);
    for (const host of config.hosts) {
      if (host.password === undefined || host.password === '') continue;
      if (typeof host.password !== 'string') throw new Error('旧版 SSH 密码字段格式无效，原配置保持不变');
      if (host.password.startsWith('enc:') && !isEncryptedPassword(host.password)) throw new Error('不支持的旧版 SSH 密码格式，原配置保持不变');
      const key = hostPasswordKey(host);
      // A successful prior attempt or a newer saved login takes precedence.
      const existing = await this.options.storage.get(key);
      if (existing !== undefined) { stage(key, existing); continue; }
      if (!isEncryptedPassword(host.password)) { stage(key, host.password); continue; }
      let password: string | undefined;
      for (const master of masters) {
        try { password = await decryptPassword(host.password, master); break; } catch { /* Try another old key. */ }
      }
      for (let attempt = 1; password === undefined && attempt <= 3; attempt++) {
        const master = await this.options.promptMasterPassword(`${host.user}@${host.ip}:${host.port ?? 22}`, attempt);
        if (master === undefined) throw new Error('已取消旧版 SSH 密码迁移，原配置和主口令保持不变');
        try { password = await decryptPassword(host.password, master); masters.push(master); }
        catch { if (attempt === 3) throw new Error('旧版 SSH 密码迁移失败：主口令错误或密文损坏，原配置和主口令保持不变'); }
      }
      stage(key, password!);
    }
    // No plaintext or ciphertext is removed until every credential is durable.
    for (const [key, password] of staged) {
      await this.options.storage.store(key, password);
      if (await this.options.storage.get(key) !== password) throw new Error('旧版 SSH 密码安全保存校验失败，原配置保持不变');
    }
    changed ||= Object.prototype.hasOwnProperty.call(raw, 'encrypt_passwords');
    delete raw.encrypt_passwords;
    for (const host of raw.hosts) {
      const accounts = Array.isArray(host.accounts) ? host.accounts : [host];
      for (const account of accounts) {
        if (Object.prototype.hasOwnProperty.call(account, 'password')) {
          changed = true;
          // Older configs may have both credentials; preserve the key path and
          // the old password-first login behavior without mixing auth methods.
          if (!account.auth && account.password) account.auth = 'password';
          delete account.password;
        }
      }
    }
    if (changed) {
      const temporary = `${file}.safs-password-migration-${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        if (await readFile(file, 'utf8') !== original) throw new Error('迁移期间配置被修改，请重试；已保存的密码仍可使用');
        await rename(temporary, file);
      } finally { await rm(temporary, { force: true }); }
    }
    // Cleanup is deliberately last. If it fails, a later run retries cleanup.
    if (savedMaster !== undefined) await this.options.storage.delete(legacyMasterPasswordSecret);
  }
}
