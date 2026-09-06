import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { validateLocalDownloadTarget } from './local-transfer-path';
import { SftpSession } from './sftp/session';
import { assertSafeRemoteEntryName } from './sftp/uri';
import { writeStreamToFile } from './stream-file';

export interface RemoteDirectoryDownloadProgress {
  phase: 'scanning' | 'downloading';
  currentFile?: string;
  discoveredFiles: number;
  discoveredDirectories: number;
  completedFiles: number;
  transferredBytes: number;
}

export interface RemoteDirectoryDownloadResult {
  files: number;
  directories: number;
  transferredBytes: number;
}

/**
 * Discover and download a remote directory in one pass with bounded concurrency.
 * Completed files remain on cancellation/failure; writeStreamToFile removes only
 * the incomplete file. Symbolic links are deliberately not followed.
 */
export async function downloadRemoteDirectoryTree(options: {
  session: SftpSession;
  remoteRoot: string;
  localRoot: string;
  concurrency: number;
  signal?: AbortSignal;
  secureLocalRoot?: string;
  onProgress?: (progress: RemoteDirectoryDownloadProgress) => void;
}): Promise<RemoteDirectoryDownloadResult> {
  const concurrency = Number.isFinite(options.concurrency)
    ? Math.max(1, Math.floor(options.concurrency))
    : 1;
  const controller = new AbortController();
  const externalAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', externalAbort, { once: true });

  let discoveredFiles = 0;
  let discoveredDirectories = 0;
  let completedFiles = 0;
  let transferredBytes = 0;
  let firstError: unknown;
  const active = new Set<Promise<void>>();

  const report = (
    phase: RemoteDirectoryDownloadProgress['phase'], currentFile?: string
  ): void => options.onProgress?.({
    phase, currentFile, discoveredFiles, discoveredDirectories,
    completedFiles, transferredBytes
  });
  const localTarget = async (relative: string): Promise<string> => {
    const target = relative
      ? path.join(options.localRoot, ...relative.split('/'))
      : options.localRoot;
    return options.secureLocalRoot
      ? validateLocalDownloadTarget(options.secureLocalRoot, target)
      : target;
  };
  const recordFailure = (error: unknown): void => {
    // An external cancellation/timeout is classified by the caller. Only retain
    // an independent transfer failure so the original useful error is surfaced.
    if (options.signal?.aborted || firstError !== undefined) return;
    firstError = error;
    controller.abort();
  };
  const waitForCapacity = async (): Promise<void> => {
    if (active.size >= concurrency) await Promise.race(active);
    if (firstError !== undefined) throw firstError;
    if (controller.signal.aborted) throw new Error('目录下载已取消');
  };
  const scheduleFile = async (remoteFile: string, relative: string): Promise<void> => {
    await waitForCapacity();
    discoveredFiles += 1;
    report('scanning', relative);
    let task!: Promise<void>;
    task = (async () => {
      const target = await localTarget(relative);
      const source = await options.session.readFileStream(remoteFile, controller.signal);
      await writeStreamToFile(source, target, {
        signal: controller.signal,
        onDelta: (delta) => {
          transferredBytes += delta;
          report('downloading', relative);
        }
      });
      completedFiles += 1;
      report('downloading', relative);
    })().catch(recordFailure).finally(() => active.delete(task));
    active.add(task);
  };
  const walk = async (remoteDirectory: string, relativeDirectory: string): Promise<void> => {
    if (controller.signal.aborted) throw new Error('目录下载已取消');
    await mkdir(await localTarget(relativeDirectory), { recursive: true });
    const entries = await options.session.readDirectory(remoteDirectory, controller.signal);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (controller.signal.aborted) throw new Error('目录下载已取消');
      assertSafeRemoteEntryName(entry.name);
      if (entry.type === 'symbolic-link') continue;
      const relative = relativeDirectory
        ? path.posix.join(relativeDirectory, entry.name)
        : entry.name;
      const remote = path.posix.join(remoteDirectory, entry.name);
      if (entry.type === 'directory') {
        discoveredDirectories += 1;
        report('scanning', relative);
        await walk(remote, relative);
      } else {
        await scheduleFile(remote, relative);
      }
    }
  };

  try {
    report('scanning');
    try {
      await walk(options.remoteRoot, '');
    } catch (error) {
      recordFailure(error);
    }
    await Promise.all(active);
    if (firstError !== undefined) throw firstError;
    if (controller.signal.aborted) throw new Error('目录下载已取消');
    return {
      files: completedFiles,
      directories: discoveredDirectories,
      transferredBytes
    };
  } finally {
    options.signal?.removeEventListener('abort', externalAbort);
  }
}
