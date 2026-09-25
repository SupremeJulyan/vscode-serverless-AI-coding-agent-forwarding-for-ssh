import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import {
  isTransferPartName, planResume, pruneTransferParts, shouldKeepPart, uploadPartName,
  type ResumeSourceSignature
} from './resume-plan';
import { SftpSession } from './sftp/session';
import { pipeStreams } from './stream-file';

export async function uploadRemoteTree(options: {
  session: SftpSession;
  sources: string[];
  targetDir: string;
  targetFile?: string;
  signal?: AbortSignal;
  verifyFile?: (remote: string) => Promise<void>;
  onProgress?: (state: {
    completed: number; discovered: number; bytes: number; current: string; resumed: boolean;
  }) => void;
  /** 某个文件的残片被保留（可续传）时回调：供调用方决定取消提示的文案。 */
  onKeptPart?: (remote: string, bytes: number) => void;
  log?: (message: string) => void;
}): Promise<{ completed: number; bytes: number }> {
  const { session } = options;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const signal = controller.signal;
  const active = new Set<Promise<void>>();
  const directories = new Map<string, Promise<void>>();
  const destinations = new Set<string>();
  // 本轮传输涉及的目标目录，用于传输成功后的陈旧残片清理。
  const targetDirectories = new Set<string>([options.targetDir]);
  // 明确决定保留的残片（续传起点），清理时必须放过。
  const keptParts = new Set<string>();
  let failure: unknown;
  let completed = 0, discovered = 0, bytes = 0;
  // 每个在传文件续传起点上已有的字节数：bytes 只统计本轮新传的，进度条要的是总数。
  const resumedBase = new Map<string, number>();
  const check = () => { signal.throwIfAborted(); };
  const report = (current: string) => options.onProgress?.({
    completed, discovered, bytes: bytes + (resumedBase.get(current) ?? 0),
    current, resumed: (resumedBase.get(current) ?? 0) > 0
  });
  const missing = (error: unknown) => [2, 'ENOENT'].includes((error as { code: number | string }).code);
  const ensure = (dir: string): Promise<void> => {
    let pending = directories.get(dir);
    if (pending) return pending;
    pending = (async () => {
      check();
      if (dir !== '/' && dir !== '.') await ensure(path.posix.dirname(dir));
      try {
        const entry = await session.stat(dir, signal);
        if (entry.type !== 'directory') throw new Error(`上传目录被非目录或符号链接占用：${dir}`);
      } catch (error) {
        if (!missing(error)) throw error;
        await session.createDirectory(dir, signal);
      }
    })();
    directories.set(dir, pending);
    return pending;
  };
  const fail = (error: unknown) => {
    if (failure === undefined) failure = error;
    abort();
  };
  const upload = async (local: string, remote: string): Promise<void> => {
    check();
    await ensure(path.posix.dirname(remote));
    await options.verifyFile?.(remote);
    let mode = 0o644;
    try {
      const previous = await session.stat(remote, signal);
      if (previous.type !== 'file') throw new Error(`上传目标不是普通文件：${remote}`);
      mode = previous.permissions ?? mode;
    } catch (error) { if (!missing(error)) throw error; }

    // 续传判定：残片名里编进了「本会话 + 本地源 size+mtime」。本地文件在两次尝试
    // 之间被改过，签名就变、名字就对不上，绝无可能把两个版本的字节拼在一起。
    const entry = await lstat(local);
    const signature: ResumeSourceSignature = { size: entry.size, mtimeMs: entry.mtimeMs };
    const temporary = uploadPartName(remote, signature);
    targetDirectories.add(path.posix.dirname(remote));
    let resumeAt = 0;
    // SCP 回退通道（scp -t）不能定位写，直接走全量；不要让它静默覆盖残片。
    if (session.transport === 'sftp') {
      const part = await session.stat(temporary, signal)
        .catch((error: unknown) => (missing(error) ? undefined : Promise.reject(error)));
      const decision = planResume({
        // name 是目标文件的基名，partName 是残片基名；上传残片多一个前导点，
        // 这个差异由 planResume 内部兼容，这里不要自己拼点。
        name: path.posix.basename(remote),
        partName: path.posix.basename(temporary),
        baseline: signature,
        part: part === undefined
          ? undefined
          : { size: part.size, mtimeMs: part.mtime },
        canRange: true
      });
      if (decision.resume) {
        resumeAt = decision.offset;
        options.log?.(`上传续传 ${remote}：已有 ${resumeAt} 字节，从该处继续`);
      } else if (part !== undefined && decision.reason !== 'no-part') {
        // 残片在但不属于当前源（或已不可信）：删掉重来，别留着下一轮再判一次。
        options.log?.(`上传残片不可用（${decision.reason}），重新上传：${remote}`);
        await session.deleteFile(temporary, signal).catch(() => undefined);
      }
    }
    resumedBase.set(remote, resumeAt);

    let written = resumeAt;
    try {
      check();
      const target = await session.writeFileStream(temporary, {
        create: true, overwrite: false, mode: 0o600,
        ...(resumeAt > 0 ? { startOffset: resumeAt } : {})
      }, signal);
      // 本地源从 resumeAt 开始喂：远端残片的前缀已经校验过是它的真前缀。
      await pipeStreams(createReadStream(local, { start: resumeAt }), target, {
        signal,
        onDelta: (delta) => { bytes += delta; written += delta; report(remote); }
      });
      check();
      await options.verifyFile?.(remote);
      await session.replaceFile(temporary, remote, mode, signal);
      completed++;
      report(remote);
    } catch (error) {
      fail(error);
      // 清理使用新的有限信号：传输信号已经 abort。
      // 大残片保留下来当下一次续传的起点；小残片不值得留，直接删。
      if (!shouldKeepPart(written)) {
        await session.deleteFile(temporary, AbortSignal.timeout(10_000)).catch((cleanup) => {
          options.log?.(`上传临时文件清理失败 ${temporary}: ${String(cleanup)}`);
        });
      } else {
        keptParts.add(temporary);
        options.onKeptPart?.(remote, written);
        options.log?.(`保留上传残片 ${written} 字节，下次续传：${temporary}`);
      }
      throw error;
    } finally {
      resumedBase.delete(remote);
    }
  };
  const walk = async (local: string, remote: string): Promise<void> => {
    check();
    const entry = await lstat(local);
    if (entry.isSymbolicLink()) return;
    if (entry.isDirectory()) {
      await ensure(remote);
      report(remote);
      for (const child of await readdir(local)) {
        await walk(path.join(local, child), path.posix.join(remote, child));
      }
    } else if (entry.isFile()) {
      if (destinations.has(remote)) throw new Error(`上传源的目标路径重复：${remote}`);
      destinations.add(remote);
      if (active.size >= (session.transport === 'sftp' ? 4 : 1)) await Promise.race(active);
      check();
      discovered++;
      let task: Promise<void>;
      task = upload(local, remote).catch(fail).finally(() => active.delete(task));
      active.add(task);
    }
  };
  try {
    try {
      for (const source of options.sources) {
        await walk(source, options.targetFile ?? path.posix.join(options.targetDir, path.basename(source)));
      }
    } catch (error) { fail(error); }
    await Promise.all(active);
    if (failure !== undefined) throw failure;
    check();
    for (const directory of targetDirectories) {
      await prunePartsInside(session, directory, keptParts, options.log);
    }
    return { completed, bytes };
  } finally { options.signal?.removeEventListener('abort', abort); }
}

/**
 * 机会清理：删掉本次传输目录里超过保留期的陈旧上传残片。
 *
 * 跨进程（扩展重载）留下的残片因为会话令牌不同，永远无法续传，只会占空间。
 * `keep` 是本轮明确保留的续传起点，必须放过。清理失败绝不影响传输结果——
 * 残片再脏也只是垃圾文件。
 */
async function prunePartsInside(
  session: SftpSession, directory: string, keep: Set<string>, log?: (message: string) => void
): Promise<void> {
  await pruneTransferParts({
    directory,
    join: (dir, name) => path.posix.join(dir, name),
    list: async (dir) => (await session.readDirectory(dir))
      .filter((entry) => entry.type === 'file' && isTransferPartName(entry.name))
      .map((entry) => ({ name: entry.name, type: entry.type, mtimeMs: entry.mtime })),
    remove: async (absolute) => {
      if (keep.has(absolute)) return;
      await session.deleteFile(absolute, AbortSignal.timeout(10_000));
    },
    log
  }).catch(() => undefined);
}
