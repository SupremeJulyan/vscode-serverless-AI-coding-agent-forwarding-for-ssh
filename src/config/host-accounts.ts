import { BridgeConfig } from './config';

/**
 * 「添加账号」（主机节点上的 ＋）要落到配置里的哪一条。
 *
 * 主机节点按 IP 分组，它的 ＋ 是**追加账号**：只有还没填账号的主机才复用那条记录
 * （填进去），否则一律返回 `-1` 表示新增——绝不覆盖同 IP 下已有的账号。
 * 指定主机名时（账号节点、旧视图的主机项）按名字定位到具体那条配置。
 */
export function accountTargetIndex(
  config: BridgeConfig, requested: { ip?: string; name?: string }
): number {
  if (requested.ip !== undefined) {
    return config.hosts.findIndex(
      (host) => host.ip === requested.ip && !host.user.trim()
    );
  }
  if (requested.name !== undefined) {
    return config.hosts.findIndex((host) => host.name === requested.name);
  }
  return -1;
}
