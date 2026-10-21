import { chmod, stat } from 'node:fs/promises';

/**
 * 传输两侧的权限位处理（上传 本地→远端、下载 远端→本地）。
 *
 * 两个方向都要经过一个「按本端默认权限新建文件」的中间步骤（上传先写 0600 残片再
 * chmod，下载按 umask 写残片再 rename），默认谁都不搬运源文件的可执行位：0755 的
 * 脚本传过去/传回来都变成 0644，`./run.sh` 直接 Permission denied；在 git 仓库里
 * 还会被报成一整批 `mode change 100755 => 100644`。
 *
 * 这里只搬运可执行位，不整份复制 mode，因为完整复制在两个方向上都会骗人：
 * Windows（以及少数挂载）上 `lstat().mode` 是合成值，普通文件恒为 0666，复制过去
 * 等于把对端文件改成全局可写；反过来把 0600 复制到共享目录/共享机器，协作者会突然
 * 读不到文件。可执行位没有这种歧义——git 只记录它，丢了就是脚本直接跑不起来。
 */

/** 取出 mode 里的三类可执行位（属主/组/其他）。 */
export function executableBits(mode: number): number {
  return (mode & 0o100 ? 0o100 : 0) | (mode & 0o010 ? 0o010 : 0) | (mode & 0o001 ? 0o001 : 0);
}

/**
 * 把源文件的可执行位并进目标权限，且只并目标已经可读的类别。
 *
 * 目标权限可能比默认更严（例如覆盖一个 0600 的文件，或本地 umask 是 077），
 * 无条件按源补位会造出 0711 这种「可执行但不可读」的组合——那个位没有任何可用语义。
 */
export function grantExecutableBits(target: number, source: number): number {
  return target | (executableBits(source) & ((target & 0o444) >> 2));
}

/**
 * 按源权限给刚下载落盘的本地文件补回可执行位。
 *
 * 只补可执行位：本地读写范围保持 umask 的结果，不把远端的 0600/0666 搬到本地。
 * 补不上不算传输失败（Windows 没有可执行位、本地挂载只读都会走到这里）——文件内容
 * 已经完整落盘，没理由因为一个权限位报错，但要在日志里留下痕迹。
 */
export async function applyLocalExecutableBits(
  target: string, sourcePermissions?: number, log?: (message: string) => void
): Promise<void> {
  if (sourcePermissions === undefined) return;
  try {
    const current = await stat(target);
    const mode = grantExecutableBits(current.mode & 0o777, sourcePermissions);
    if (mode === (current.mode & 0o777)) return;
    await chmod(target, mode);
  } catch (error) {
    log?.(`补可执行位失败 ${target}: ${String(error)}`);
  }
}
