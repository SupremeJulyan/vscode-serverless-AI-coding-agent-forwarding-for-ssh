import { createHash } from 'node:crypto';
import { HostConfig } from '../config/config';
import type { PasswordAnswer } from './password-prompt';

export interface CredentialStorage {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

/** Display-name changes must not change the credential identity. */
export function hostPasswordKey(host: HostConfig): string {
  const identity = JSON.stringify([host.ip.toLowerCase(), host.port ?? 22, host.user]);
  return 'safs.sshPassword.' + createHash('sha256').update(identity).digest('hex');
}

export async function resolveHostCredential(
  host: HostConfig, storage: CredentialStorage,
  options: {
    promptPassword(): Promise<PasswordAnswer | undefined>;
    promptPrivateKey(): Promise<string | undefined>;
    savePrivateKey(path: string): Promise<void>;
    sessionPasswords: Map<string, string>;
  }
): Promise<HostConfig> {
  const key = hostPasswordKey(host);
  const method = host.auth ?? (host.private_key_path ? 'publickey' : 'password');
  if (method === 'publickey') {
    const path = host.private_key_path ?? await options.promptPrivateKey();
    if (!path) throw new Error('已取消 SSH 私钥选择');
    if (!host.private_key_path) await options.savePrivateKey(path);
    const resolved = { ...host, private_key_path: path };
    delete resolved.password;
    return resolved;
  }
  const password = await storage.get(key);
  if (password !== undefined) return { ...host, password };
  const sessionPassword = options.sessionPasswords.get(key);
  if (sessionPassword !== undefined) return { ...host, password: sessionPassword };
  const entered = await options.promptPassword();
  if (!entered) throw new Error('已取消 SSH 密码输入');
  if (entered.remember) await storage.store(key, entered.password);
  else options.sessionPasswords.set(key, entered.password);
  return { ...host, password: entered.password };
}
