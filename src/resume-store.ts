import { stat } from 'node:fs/promises';
import * as path from 'node:path';
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
    // 传远端源名（下载残片名里的那一段）；命名规则差异由 planResume 内部兼容。
    name: path.posix.basename(options.remoteName),
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
 * 把残片落到最终位置。
 *
 * 先删目标再 rename：Windows 上 rename 不能覆盖已存在的文件。失败的**唯一**后果是
 * 残片被删掉、下一次全量重来（不会影响已存在的目标文件内容），所以不向上抛错——
 * 这跟「rename 失败就算传输失败」是同一件事，而调用方本来就处于失败路径上。
 */
export async function commitDownloadPart(options: {
  partPath: string;
  target: string;
  remove: (target: string) => Promise<void>;
  renamePart: (from: string, to: string) => Promise<void>;
  log?: (message: string) => void;
}): Promise<void> {
  try {
    await options.remove(options.target);
    await options.renamePart(options.partPath, options.target);
  } catch (error) {
    await options.remove(options.partPath).catch(() => undefined);
    options.log?.(`下载落盘失败 ${options.target}: ${String(error)}`);
  }
}
