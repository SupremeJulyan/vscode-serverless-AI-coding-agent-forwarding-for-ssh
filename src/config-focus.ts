/**
 * 「打开配置」要定位的位置：配置里的某个条目（主机/挂载共用一个名字），
 * 或账号的密码字段（密码错误提示里点「打开配置」时直接落到那一行）。
 */
export interface ConfigFocus {
  kind: 'entry' | 'password';
  name: string;
}

/**
 * 命令边界上的参数校验。
 *
 * `safs.openConfig` 的实参形状随入口而变：视图条目右键与标题栏聚焦项是树元素
 * （可能是任意对象，甚至多选时是数组），错误提示与命令面板给的是显式定位目标，
 * 命令面板还可能什么都不给。只接受结构完整的定位目标，其余交给树元素那一套解析。
 */
export function isConfigFocus(value: unknown): value is ConfigFocus {
  if (!value || typeof value !== 'object') return false;
  const focus = value as { kind?: unknown; name?: unknown };
  return (focus.kind === 'entry' || focus.kind === 'password')
    && typeof focus.name === 'string' && focus.name !== '';
}
