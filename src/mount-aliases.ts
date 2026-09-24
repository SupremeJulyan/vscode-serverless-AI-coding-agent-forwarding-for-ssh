import { HostConfig } from './config';
import { legacyMountAuthorityAlias, mountAuthorityAlias } from './sftp/uri';

/**
 * 主机节点的显示名：ASCII 别名优先，否则退回 IP。
 *
 * 别名既用于界面标签（主机节点、配置对话框标题），也参与配置命名：配置名是
 * `主机名(账号)`，主机名就是这里返回的标签（ASCII 别名，否则 IP）。
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
 * 例：别名 `ws1` + 账号 `alice` → `ws1(alice)`；别名是中文（如「测试主机」）时用 IP → `192.0.2.30(carol)`。
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

/**
 * 该主机在历史命名与 URI 转义下可能出现过的所有名字（不含当前名字本身）。
 *
 * 已保存的 `safs://` URI（窗口、标签页、最近打开）里存的就是其中之一：VS Code 会把
 * authority 里的括号编码成 `%28`，或者直接存成我们生成的转义形式（`ws1_alice`），
 * 所以明文和转义两种形态都要收录，解析时才能找回当前配置名。
 */
export function mountAliasCandidates(
  host: HostConfig, aliases?: Record<string, string>
): string[] {
  const current = mountNameFor(host, aliases);
  const plain = [...legacyMountNames(host, aliases), `${host.ip}(${host.user})`]
    .filter((name) => name !== current);
  const escaped = [
    ...plain.map((name) => mountAuthorityAlias(name)),
    // 上一版（非单射）转义形式，已经存进窗口状态的 URI 就是它。
    ...plain.map((name) => legacyMountAuthorityAlias(name))
  ];
  return [...new Set([...plain, ...escaped].filter((name): name is string => Boolean(name)))];
}
