import type { Prompt } from 'ssh2';

export function keyboardInteractivePasswordReplies(
  prompts: Prompt[], password: string
): string[] | undefined {
  if (prompts.length === 0 || prompts.some((item) => item.echo || !/password/i.test(item.prompt))) {
    return undefined;
  }
  return prompts.map(() => password);
}

const authenticationFailurePatterns = [
  /permission denied/i,
  /authentication (?:failed|failure)/i,
  /access is denied/i,
  /logon failure/i,
  /user name or password is incorrect/i,
  /incorrect password/i,
  /密码错误/,
  /认证失败/
];

export function isAuthenticationFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return authenticationFailurePatterns.some((pattern) => pattern.test(message));
}

const networkFailurePatterns = [
  /connection reset by peer/i,
  /connection (?:refused|closed|timed out)/i,
  /connection unexpectedly closed/i,
  /no route to host/i,
  /network is unreachable/i,
  /operation timed out/i,
  /could not connect/i,
  /kex_exchange_identification.*closed/i
];

export function isNetworkFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return networkFailurePatterns.some((pattern) => pattern.test(message));
}

/** 匹配配置原文中的 `"name": "<hostName>"` 字段（按 JSON 转义后的名字精确匹配）。 */
function nameFieldMatch(content: string, hostName: string): RegExpExecArray | null {
  // 名字来自命令参数/树节点，扩展边界上可能是任意值：不是非空字符串就当作没命中，
  // 不要让 JSON.stringify(undefined) 的返回值再往下走。
  if (typeof hostName !== 'string' || hostName === '') return null;
  const escapedName = JSON.stringify(hostName);
  const namePattern = new RegExp(
    `"name"\\s*:\\s*${escapedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
  );
  return namePattern.exec(content);
}

/**
 * 配置文件原文中某个条目 `"name"` 字段的偏移，用于「打开配置」定位到对应行。
 *
 * 主机名（账号）与挂载名一致，且保存配置时会省略 `mounts`（挂载由 hosts 推导），
 * 所以一次全文匹配即可命中唯一的那条记录。
 */
export function configEntryOffset(content: string, hostName: string): number | undefined {
  const match = nameFieldMatch(content, hostName);
  if (!match) return undefined;
  // 手工维护的配置可能同时有 mounts 数组：优先落在 hosts 里的那条记录上。
  const hostsStart = content.search(/"hosts"\s*:/);
  if (hostsStart < 0 || match.index >= hostsStart) return match.index;
  const afterHosts = new RegExp(
    `"name"\\s*:\\s*${JSON.stringify(hostName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'
  );
  afterHosts.lastIndex = hostsStart;
  const preferred = afterHosts.exec(content);
  return preferred ? preferred.index : match.index;
}

export function passwordValueOffset(content: string, hostName: string): number | undefined {
  const nameMatch = nameFieldMatch(content, hostName);
  if (!nameMatch) return undefined;
  const remainder = content.slice(nameMatch.index + nameMatch[0].length);
  // 只在同一条记录里找：下一条记录的 "name" 就是边界，否则会跳到别人的密码行上。
  const nextEntry = /"name"\s*:/.exec(remainder);
  const record = nextEntry ? remainder.slice(0, nextEntry.index) : remainder;
  const passwordMatch = /"password"\s*:\s*"/.exec(record);
  if (!passwordMatch) return undefined;
  return nameMatch.index + nameMatch[0].length + passwordMatch.index + passwordMatch[0].length;
}
