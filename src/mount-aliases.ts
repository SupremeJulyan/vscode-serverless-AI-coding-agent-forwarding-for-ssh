import { HostConfig } from './config';

/**
 * 主机节点的显示名：ASCII 别名优先，否则退回 IP。
 *
 * 别名只用于界面标签（主机节点、配置对话框标题），不参与配置命名：配置名由
 * `IP(账号)` 生成。
 */
export function hierarchicalHostName(
  host: HostConfig, aliases?: Record<string, string>
): string {
  const alias = aliases?.[host.ip];
  return alias && !/[^\x00-\x7f]/.test(alias) ? alias : host.ip;
}

/**
 * 配置名：`主机名(账号)`，主机名取 ASCII 别名，别名是中文（或没配）时用 IP。
 *
 * 例：别名 `ls` + 账号 `zhuyuan` → `ls(zhuyuan)`；别名「工业云」→ `10.38.36.8(yewenlong)`。
 */
export function mountNameFor(
  host: HostConfig, aliases?: Record<string, string>
): string {
  return `${hierarchicalHostName(host, aliases)}(${host.user})`;
}

/**
 * 历史命名规则下该主机可能用过的旧配置名，用于兼容改名之前保存的 `safs://` URI
 * （窗口、标签页、最近打开）。
 *
 * 依次是：`账号_别名`（1.9.4 之前）、`账号_IP`（别名是中文时）、
 * `别名@账号`、`IP@账号`（更早的层级视图命名）。
 */
export function legacyMountNames(
  host: HostConfig, aliases?: Record<string, string>
): string[] {
  const hostLabel = hierarchicalHostName(host, aliases);
  const alias = aliases?.[host.ip];
  return [...new Set([
    `${host.user}_${hostLabel}`,
    `${host.user}_${host.ip}`,
    // 中文别名也直接拼进过配置名（层级视图早期版本），单独列一条。
    ...(alias ? [`${host.user}_${alias}`] : []),
    `${hostLabel}@${host.user}`,
    `${host.ip}@${host.user}`
  ])];
}
