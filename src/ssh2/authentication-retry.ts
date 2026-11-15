import { HostConfig } from '../config/config';
import { isAuthenticationFailure } from '../config/authentication';

export class PrivateKeyError extends Error {}
export type CredentialRetry = (host: HostConfig, error: unknown, attempt: number, retry: boolean) => Promise<HostConfig | undefined>;

/** One attempt is one SSH authentication exchange; there are at most three. */
export async function withAuthenticationRetries<T>(
  host: HostConfig, connect: (host: HostConfig) => Promise<T>, rejected?: CredentialRetry
): Promise<T> {
  let current = host;
  for (let attempt = 1; ; attempt++) {
    try { return await connect(current); }
    catch (error) {
      if (!(error instanceof PrivateKeyError) && !isAuthenticationFailure(error)) throw error;
      if (!rejected) throw error;
      const next = await rejected(current, error, attempt, attempt < 3);
      if (attempt >= 3) throw new Error('SSH 认证失败，已尝试 3 次。请检查账号、密码或私钥后手动重新连接。');
      if (!next) throw new Error('已取消 SSH 认证');
      current = next;
    }
  }
}
