import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { applyLocalExecutableBits } from './file-mode';
import {
  downloadPartPath, planResume, shouldKeepPart,
  type ResumeReason, type ResumeSourceSignature
} from './resume-plan';

/**
 * 下载侧的续传准备与收尾。
 *
 * 准备阶段一次调用完成「残片定位 → 远端未变校验 → 是否续传」。判定依赖的远端
 * 签名必须是调用方刚刚读到的 stat——远端文件在两次尝试之间被改过，残片对应的
 * 就是另一个版本，此时**必须**从 0 重来（这里返回 offset = 0，并换用新的残片名），
 * 否则产出的文件是两段不同版本拼起来的静默损坏。
 */
export interface DownloadResume {
  /** 残片路径（续传与全量都写它，完成后 rename 到最终目标）。 */
  partPath: string;
  /** 续传起点：0 表示全量重传。 */
  offset: number;
  /** 远端源签名，供落名与后续比对。 */
  signature: ResumeSourceSignature;
  /** 未续传时的原因，便于日志说明「为什么又从头发」。 */
  reason?: ResumeReason;
  /** 本轮新写入的字节数（不含续传起点），由调用方在失败收尾时填。 */
  transferred?: number;
  /** 出错收尾后是否留下了残片（供调用方决定文案/日志）。 */
  kept?: boolean;
}

const MISSING = new Set<number | string>([2, 'ENOENT']);

function isMissing(error: unknown): boolean {
  return MISSING.has((error as { code?: number | string }).code as number | string);
}

export async function prepareDownloadResume(options: {
  remoteName: string;
  remote: ResumeSourceSignature;
  localTarget: string;
  canRange: boolean;
  log?: (message: string) => void;
}): Promise<DownloadResume> {
  const partPath = downloadPartPath(options.localTarget, options.remote);
  if (!options.canRange) {
    return { partPath, offset: 0, signature: options.remote, reason: 'no-range-support' };
  }
  let part: ResumeSourceSignature | undefined;
  try {
    const entry = await stat(partPath);
    if (entry.isFile()) part = { size: entry.size, mtimeMs: entry.mtimeMs };
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const decision = planResume({
    // 残片由本地目标名生成，另存为时也必须用同一个名字校验。
    name: path.basename(options.localTarget),
    partName: path.basename(partPath),
    baseline: options.remote,
    part,
    canRange: options.canRange
  });
  if (decision.resume) {
    options.log?.(`下载续传 ${options.localTarget}：已有 ${decision.offset} 字节，从该处继续`);
    return { partPath, offset: decision.offset, signature: options.remote };
  }
  return { partPath, offset: 0, signature: options.remote, reason: decision.reason };
}

/**
 * 传输失败/取消后的收尾。
 *
 * 与「写失败就删残片」的旧行为相反：够大的残片要留着当下一次续传的起点，
 * 小残片（低于阈值）续传收益抵不上目录里的垃圾文件，直接删。
 *
 * 返回是否保留了残片，供调用方决定「下次可续传」这类文案。
 */
export async function cleanupDownloadPart(options: {
  partPath: string;
  transferred: number;
  remove: (target: string) => Promise<void>;
  log?: (message: string) => void;
}): Promise<boolean> {
  if (shouldKeepPart(options.transferred)) {
    options.log?.(`保留下载残片 ${options.transferred} 字节，下次续传：${options.partPath}`);
    return true;
  }
  await options.remove(options.partPath).catch((error: unknown) => {
    options.log?.(`下载残片清理失败 ${options.partPath}: ${String(error)}`);
  });
  return false;
}

/**
 * 把残片落到最终位置，并按远端源权限补回本地可执行位。
 *
 * 直接 rename 替换目标：落盘失败时保留原文件与完整残片，并向调用方抛错。
 * 权限补不上同理不算失败：内容已经完整落盘。
 */
export async function commitDownloadPart(options: {
  partPath: string;
  target: string;
  renamePart: (from: string, to: string) => Promise<void>;
  /** 远端源权限位：据此给落盘文件补可执行位。缺省（stat 没给出权限）时不动本地权限。 */
  permissions?: number;
  log?: (message: string) => void;
}): Promise<void> {
  try {
    await options.renamePart(options.partPath, options.target);
  } catch (error) {
    options.log?.(`下载落盘失败 ${options.target}: ${String(error)}`);
    throw error;
  }
  await applyLocalExecutableBits(options.target, options.permissions, options.log);
}
