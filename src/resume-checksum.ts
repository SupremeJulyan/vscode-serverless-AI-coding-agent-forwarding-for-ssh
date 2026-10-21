import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { SftpSession } from './sftp/session';

const HASH_CHUNK_BYTES = 1024 * 1024;

async function sha256LocalPrefix(
  filePath: string, length: number, signal?: AbortSignal
): Promise<string> {
  const hash = createHash('sha256');
  if (length === 0) return hash.digest('hex');
  const stream = createReadStream(filePath, { start: 0, end: length - 1 });
  const abort = () => stream.destroy(new Error('断点续传 SHA-256 校验已取消'));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

async function sha256RemotePrefix(
  session: SftpSession, remotePath: string, length: number, signal?: AbortSignal
): Promise<string> {
  const hash = createHash('sha256');
  for (let offset = 0; offset < length;) {
    signal?.throwIfAborted();
    const wanted = Math.min(HASH_CHUNK_BYTES, length - offset);
    const chunk = await session.readFileRange(remotePath, offset, wanted, signal);
    if (chunk.byteLength !== wanted) {
      throw new Error(
        `断点续传 SHA-256 校验读取不足：${remotePath}，需要 ${wanted} 字节，实际 ${chunk.byteLength} 字节`
      );
    }
    hash.update(chunk);
    offset += chunk.byteLength;
  }
  return hash.digest('hex');
}

/** 比较本地文件与远端文件的前 length 字节；只在真正续传时调用。 */
export async function sameResumePrefix(options: {
  session: SftpSession;
  localPath: string;
  remotePath: string;
  length: number;
  signal?: AbortSignal;
}): Promise<boolean> {
  const [local, remote] = await Promise.all([
    sha256LocalPrefix(options.localPath, options.length, options.signal),
    sha256RemotePrefix(
      options.session, options.remotePath, options.length, options.signal
    )
  ]);
  return local === remote;
}
