import { applyLocalExecutableBits } from './file-mode';

/** Atomically replace the destination after the complete transfer has succeeded. */
export async function commitDownloadPart(options: {
  partPath: string;
  target: string;
  renamePart: (from: string, to: string) => Promise<void>;
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
