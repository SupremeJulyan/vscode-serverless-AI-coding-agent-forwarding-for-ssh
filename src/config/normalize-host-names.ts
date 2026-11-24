import type { BridgeConfig } from './config';
import { mountNameFor } from './mount-aliases';

export function normalizeHostNames(config: BridgeConfig): Map<string, string> {
  const renamed = new Map<string, string>();
  /** 本轮已经发出去的名字：即使与某条记录自己的旧名相同也要加后缀，否则写出重名配置。 */
  const claimed = new Set<string>();

  for (const host of config.hosts) {
    // 配置名是 `主机名(账号)`：主机名取配置的别名（支持中文），没配时退回 IP；
    // 和界面上的主机节点 + 账号节点一一对应。
    const baseName = host.user.trim() ? mountNameFor(host, config.host_aliases) : host.ip;
    let nextName = baseName;
    let suffix = 2;
    while (claimed.has(nextName)) {
      nextName = `${baseName}#${suffix}`;
      suffix += 1;
    }
    claimed.add(nextName);
    if (host.name !== nextName) renamed.set(host.name, nextName);
    host.name = nextName;
  }
  return renamed;
}
