import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { SftpSession } from './sftp/session';
import { pipeStreams } from './stream-file';

export async function uploadRemoteTree(options: {
  session: SftpSession;
  sources: string[];
  targetDir: string;
  targetFile?: string;
  signal?: AbortSignal;
  verifyFile?: (remote: string) => Promise<void>;
  onProgress?: (state: { completed: number; discovered: number; bytes: number; current: string }) => void;
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
    let mode = 0o644;
    try {
      const previous = await session.stat(remote, signal);
      if (previous.type !== 'file') throw new Error(`上传目标不是普通文件：${remote}`);
      mode = previous.permissions ?? mode;
    } catch (error) { if (!missing(error)) throw error; }
    const temporary = path.posix.join(path.posix.dirname(remote), `.safs-upload-${randomUUID()}.part`);
    try {
      check();
      const target = await session.writeFileStream(temporary, {
        create: true, overwrite: false, mode: 0o600
      }, signal);
      // Attach both stream error handlers immediately after creating the local source.
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
      // Cleanup uses a fresh bounded signal: the transfer signal is already aborted.
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
    return { completed, bytes };
  } finally { options.signal?.removeEventListener('abort', abort); }
}
