import { findNodeAtLocation, getNodeValue, parseTree, ParseError } from 'jsonc-parser';

export interface ConfigUniquenessIssue {
  path: (string | number)[];
  message: string;
}

/** Legacy flat entries represent accounts; uniqueness applies to host groups. */
export function configUniquenessIssues(value: unknown): ConfigUniquenessIssue[] {
  const issues: ConfigUniquenessIssue[] = [];
  const hosts = (value as { hosts?: unknown[] } | null)?.hosts;
  if (!Array.isArray(hosts)) return issues;
  const ips = new Map<string, number>();
  hosts.forEach((host, hostIndex) => {
    if (!host || typeof host !== 'object') return;
    const { ip, accounts } = host as { ip?: unknown; accounts?: unknown };
    if (!Array.isArray(accounts)) return;
    if (typeof ip === 'string') {
      const previous = ips.get(ip);
      if (previous !== undefined) {
        const message = `主机 IP '${ip}' 重复：hosts[${previous}] 与 hosts[${hostIndex}]；请合并到一个主机节点。`;
        for (const index of [previous, hostIndex]) issues.push({ path: ['hosts', index, 'ip'], message });
      } else ips.set(ip, hostIndex);
    }
    const users = new Map<string, number>();
    accounts.forEach((account, accountIndex) => {
      const user = (account as { user?: unknown } | null)?.user;
      if (typeof user !== 'string') return;
      const previous = users.get(user);
      if (previous !== undefined) {
        const message = `主机 '${ip}' 下账号 '${user}' 重复：accounts[${previous}] 与 accounts[${accountIndex}]；请删除重复账号。`;
        for (const index of [previous, accountIndex]) issues.push({ path: ['hosts', hostIndex, 'accounts', index, 'user'], message });
      } else users.set(user, accountIndex);
    });
  });
  return issues;
}

export function configUniquenessTextIssues(text: string): { offset: number; length: number; message: string }[] {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors);
  if (!root || errors.length) return [];
  return configUniquenessIssues(getNodeValue(root)).flatMap(issue => {
    const node = findNodeAtLocation(root, issue.path);
    return node ? [{ offset: node.offset, length: node.length, message: issue.message }] : [];
  });
}
