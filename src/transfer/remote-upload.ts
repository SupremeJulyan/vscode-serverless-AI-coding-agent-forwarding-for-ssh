import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { grantExecutableBits } from './file-mode';
import { SftpSession } from '../ssh2/session';
import { pipeStreams } from './stream-file';
import { remoteTransferTempPath } from './temp-path';

/** 新文件的远端默认权限：与补可执行位之前的行为一致，读写范围不因这次修复改变。 */
const DEFAULT_UPLOAD_MODE = 0o644;

export async function uploadRemoteTree(options: {
  session: SftpSession;
  sources: string[];
  targetDir: string;
  targetFile?: string;
  signal?: AbortSignal;
  verifyFile?: (remote: string) => Promise<void>;
  onProgress?: (state: {
    completed: number; discovered: number; bytes: number; current: string;
  }) => void;
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
  let failure: unknown;
  let completed = 0, discovered = 0, bytes = 0;
  const check = () => { signal.throwIfAborted(); };
  const report = (current: string) => options.onProgress?.({ completed, discovered, bytes, current });
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
    // 读取本地源元数据，后续推导远端权限时复用。
    const entry = await lstat(local);
    // 权限：目标已存在则沿用远端权限，新文件用远端默认 0644。两种情况下都补上本地源的
    // 可执行位——上传通道本身不保留权限位，不补的话 0755 的脚本落到远端就不可执行
    // （`./run.sh` 直接 Permission denied），在 git 仓库里还会被报成一整批
    // `mode change 100755 => 100644`。补在「沿用远端权限」之后，所以重复上传一个
    // 之前丢过权限位的文件也能自愈。
    let mode = DEFAULT_UPLOAD_MODE;
    try {
      const previous = await session.stat(remote, signal);
      if (previous.type !== 'file') throw new Error(`上传目标不是普通文件：${remote}`);
      mode = previous.permissions ?? mode;
    } catch (error) { if (!missing(error)) throw error; }
    mode = grantExecutableBits(mode, entry.mode);

    const temporary = remoteTransferTempPath(remote);
    try {
      check();
      const target = await session.writeFileStream(temporary, {
        create: true, overwrite: false, mode: 0o600
      }, signal);
      await pipeStreams(createReadStream(local), target, {
        signal,
        onDelta: (delta) => { bytes += delta; report(remote); }
      });
      check();
      await options.verifyFile?.(remote);
      await session.replaceFile(temporary, remote, mode, signal);
      completed++;
      report(remote);
    } catch (error) {
      fail(error);
      await session.deleteFile(temporary, AbortSignal.timeout(10_000)).catch((cleanup) => {
        options.log?.(`上传临时文件清理失败 ${temporary}: ${String(cleanup)}`);
      });
      throw error;
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
      if (active.size >= 4) await Promise.race(active);
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
    return { completed, bytes };
  } finally { options.signal?.removeEventListener('abort', abort); }
}
