import { createHash, randomBytes } from 'node:crypto';
import * as path from 'node:path';

/**
 * 传输续传的决策层。
 *
 * SFTP 协议本身没有「续传」这个命令，但它提供了续传需要的全部原语：带 offset 的
 * 读/写、不截断打开、stat 给出 size+mtime。所以续传 = 客户端自己算 offset + 自己
 * 判断残片能不能用。这个模块只放两件事：
 *
 * 1. 残片命名：把「归属」编进文件名。残片名里带 session 令牌与源文件的
 *    size+mtime 签名，源文件一旦变化，签名就变、残片名就对不上，残片自动失效。
 *    这样即使残留文件被人手工放进目录，或上一次传输与这一次之间源文件被改过，
 *    也不可能把两个版本的字节拼在一起（静默损坏比重新传危险得多）。
 * 2. 续传决策：唯一允许续传的条件是「同一个源签名 + 残片是它的真前缀」。
 *
 * 判定刻意做成纯函数：读/写两侧各自注入 size+mtime 的读取方式，便于单测覆盖。
 */

/** 低于该大小的残片不留：续传收益抵不上目录里多一个垃圾文件。 */
export const RESUME_MIN_BYTES = 1024 * 1024;

/** 残片保留时长；超过后按机会清理（每次传输开始时顺手清同目录的陈旧残片）。 */
export const RESUME_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const PART_INFIX = '.safs-part';

/** 残片名里的令牌长度（hex 字符数）。生成与解析必须共用它，否则判定永远对不上。 */
const TOKEN_HEX = 16;

/** 进程级会话令牌：同一进程内的多次尝试复用残片，跨进程（扩展重载）不复用。 */
const SESSION_TOKEN = randomBytes(TOKEN_HEX / 2).toString('hex');

/** 源文件签名：size + mtime，任一变化都意味着残片对应的是另一个版本。 */
export interface ResumeSourceSignature {
  size: number;
  mtimeMs: number;
}

export interface ResumeState {
  /** 残片归属的源签名。 */
  baseline: ResumeSourceSignature;
  /** 生成残片名时用的源名。 */
  name: string;
}

export type ResumeReason =
  | 'no-part'
  | 'part-empty'
  | 'part-too-long'
  | 'part-not-smaller'
  | 'source-changed'
  | 'foreign-part'
  | 'below-threshold'
  | 'no-range-support';

export type ResumeDecision =
  | { resume: true; offset: number; token: string }
  | { resume: false; reason: ResumeReason };

function sign(size: number, mtimeMs: number): string {
  return `${size}:${Math.trunc(mtimeMs)}`;
}

/**
 * 残片名：`<源名>.safs-part-<16 位哈希>`，哈希覆盖「会话令牌 + 源名 + 源 size+mtime」。
 *
 * 三种信息编进同一个名字，是为了让残片**自我失效**：源名不同、版本不同、或不是本
 * 进程留下的残片，名字都对不上，不可能被误续。名字里保留源名（而不是纯随机名）
 * 是为了在目录里一眼看出它属于哪个文件。
 */
export function partNameFor(
  name: string, signature: ResumeSourceSignature, token = SESSION_TOKEN
): string {
  const digest = createHash('sha256')
    .update(`${token}\u0000${name}\u0000${sign(signature.size, signature.mtimeMs)}`)
    .digest('hex')
    .slice(0, 16);
  return `${name}${PART_INFIX}-${digest}`;
}

/**
 * 从残片名取「显示用的源名」：去掉 `.safs-part-<hash>` 后缀与上传侧的前导点。
 *
 * 只用于日志与错误信息——**不要**用它反推源名再去做哈希比对：源文件名本身也可能
 * 含 `.safs-part`（如 `a.safs-part-x.bin`），反推是有歧义的。判定统一交给
 * `planResume`，它同时接受两种命名规则。
 */
export function partSourceLabel(partName: string): string {
  const at = partName.lastIndexOf(PART_INFIX);
  const base = at >= 0 ? partName.slice(0, at) : partName;
  return base.startsWith('.') ? base.slice(1) : base;
}

/** 上传残片：远程目标同目录下的隐藏文件。 */
export function uploadPartName(
  remoteFile: string, signature: ResumeSourceSignature
): string {
  const dir = path.posix.dirname(remoteFile);
  const base = path.posix.basename(remoteFile);
  return path.posix.join(dir, `.${partNameFor(base, signature)}`);
}

/** 下载残片：本地目标同目录下的兄弟文件。 */
export function downloadPartPath(
  localTarget: string, signature: ResumeSourceSignature
): string {
  const dir = path.dirname(localTarget);
  const base = path.basename(localTarget);
  return path.join(dir, partNameFor(base, signature));
}

/**
 * 判断残片是否仍属于当前源，并给出续传起点。
 *
 * 判定完全依据调用方读到的 stat：本模块不接触文件系统，两侧（本地/远程）各自
 * 注入自己的 size+mtime。
 *
 * 归属只看**名字**：残片名由「会话令牌 + 源名 + 源 size+mtime」哈希而来，源一变
 * 名字就对不上。残片自身的 size 只用来当续传起点——残片天生是没传完的，size
 * 必然小于源，这一点绝不能拿来当「是不是同一个版本」的依据。
 */
export function planResume(options: {
  name: string;
  partName: string;
  token?: string;
  baseline?: ResumeSourceSignature;
  part?: ResumeSourceSignature;
  canRange: boolean;
}): ResumeDecision {
  if (!options.canRange) return { resume: false, reason: 'no-range-support' };
  // 没有基线签名就没有可续的残片（调用方必须给出源文件的 size+mtime）。
  if (options.baseline === undefined) return { resume: false, reason: 'no-part' };
  if (options.part === undefined) return { resume: false, reason: 'no-part' };
  // 两个参数都是「文件名」：name 是源文件基名，partName 是残片基名。传成完整路径
  // （例如把 `/dest/.a.safs-part-x` 当成 name）会让下面的等式永远不成立，静默退化成
  // 全量重传——所以这里直接挡掉，让调用方在开发期就发现。
  if (options.name.includes('/') || options.name.includes('\\')
    || options.partName.includes('/') || options.partName.includes('\\')) {
    throw new Error(`续传判定需要文件名而不是路径: name=${options.name} partName=${options.partName}`);
  }
  // 残片名必须**恰好**等于本命名规则下算出来的名字：源名、源 size+mtime、会话令牌
  // 三者任一不同，哈希就不同。注意不能「从残片名反推源名再比哈希」——源文件名本身
  // 可能含 `.safs-part`，反推有歧义；也不能只比哈希不比名字。
  const expected = [
    partNameFor(options.name, options.baseline, options.token),
    `.${partNameFor(options.name, options.baseline, options.token)}`
  ];
  if (!expected.includes(options.partName)) return { resume: false, reason: 'foreign-part' };
  // 残片自身的 size 就是续传起点（残片天生没传完，必然小于源）。但它的 mtime 不能
  // 与源相同：源文件若被改成同样大小、同样 mtime 的内容，哈希对得上而字节已经变了，
  // 这时续传就是把两个版本拼起来。残片被写过，mtime 必然新于源创建时间。
  if (options.part.mtimeMs === options.baseline.mtimeMs) {
    return { resume: false, reason: 'source-changed' };
  }
  const offset = options.part.size;
  if (offset === 0) return { resume: false, reason: 'part-empty' };
  if (offset > options.baseline.size) {
    // 残片比源还长：它绝不是当前源的前缀（文件被截短过，或残片属于另一个源）。
    return { resume: false, reason: 'part-too-long' };
  }
  if (offset === options.baseline.size) {
    // 长度相同但没被 rename 掉：可疑（内容未必对），从 0 重来最安全。
    return { resume: false, reason: 'part-not-smaller' };
  }
  if (offset < RESUME_MIN_BYTES) return { resume: false, reason: 'below-threshold' };
  return { resume: true, offset, token: options.token ?? SESSION_TOKEN };
}

/** 解析残片名里的令牌；不是残片或名字不合规时返回 undefined。 */
export function partToken(partName: string): string | undefined {
  return new RegExp(`${PART_INFIX.replace('.', '\\.')}-([0-9a-f]{${TOKEN_HEX}})$`)
    .exec(partName)?.[1];
}

/** 该文件名是否是我们管理的传输残片（用于机会清理）。 */
export function isTransferPartName(name: string): boolean {
  return partToken(name) !== undefined;
}

/** 机会清理：删掉同目录下超过保留期、且不属于当前传输的残片。 */
export async function pruneTransferParts(options: {
  directory: string;
  list: (directory: string) => Promise<Array<{ name: string; type: string; mtimeMs: number }>>;
  remove: (absolutePath: string) => Promise<void>;
  keep?: string;
  join: (directory: string, name: string) => string;
  now?: number;
  log?: (message: string) => void;
}): Promise<number> {
  const now = options.now ?? Date.now();
  let removed = 0;
  let entries: Array<{ name: string; type: string; mtimeMs: number }>;
  try {
    entries = await options.list(options.directory);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.type !== 'file' || !isTransferPartName(entry.name)) continue;
    const absolute = options.join(options.directory, entry.name);
    if (options.keep !== undefined && absolute === options.keep) continue;
    if (now - entry.mtimeMs < RESUME_RETENTION_MS) continue;
    try {
      await options.remove(absolute);
      removed += 1;
    } catch (error) {
      options.log?.(`清理陈旧传输残片失败 ${absolute}: ${String(error)}`);
    }
  }
  return removed;
}

/** 是否值得为这次失败保留残片（太小的残片直接删掉，不留垃圾）。 */
export function shouldKeepPart(bytesWritten: number): boolean {
  return Number.isFinite(bytesWritten) && bytesWritten >= RESUME_MIN_BYTES;
}
