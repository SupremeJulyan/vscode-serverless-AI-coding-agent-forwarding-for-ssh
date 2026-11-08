import { Writable } from 'node:stream';
import { Client, FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2';
import { HostConfig } from '../config/config';
import { acquireSsh2Connection, Ssh2ConnectionLease } from './shared-connection';
import { ScpSession } from './scp-session';
import {
  SftpDirectoryEntry, SftpFileStat, SftpFileType, SftpSession, SftpWriteOptions
} from './session';
import { assertSafeRemoteEntryName } from './uri';

function fileType(attributes: Stats): SftpFileType {
  if (attributes.isFile()) return 'file';
  if (attributes.isDirectory()) return 'directory';
  if (attributes.isSymbolicLink()) return 'symbolic-link';
  return 'unknown';
}

function fileStat(attributes: Stats): SftpFileStat {
  return {
    type: fileType(attributes),
    size: attributes.size,
    mtime: attributes.mtime * 1000,
    // ssh2 Stats 无 ctime：用 mtime 近似。此前误用 atime（会随读操作变化，
    // 导致 FileStat.ctime 语义错误）。
    ctime: attributes.mtime * 1000,
    permissions: attributes.mode & 0o7777
  };
}

function abortError(): Error {
  const error = new Error('SFTP operation was cancelled');
  error.name = 'AbortError';
  return error;
}

/** 流式写单个数据块的超时：远端停止确认（网关/抖动）时避免无限挂起。 */
const sftpWriteChunkTimeoutMs = 60_000;

// ssh2's SFTP ReadStream keeps one READ request in flight. A 64 KiB
// high-water mark therefore caps throughput at roughly 64 KiB / RTT. Keep a
// bounded, larger read window so high-latency links can fill the pipe without
// allowing unbounded read-ahead.
const sftpReadHighWaterMark = 1024 * 1024;

/** SSH 认证成功后的 SFTP 通道打开超时。ssh2 的 readyTimeout 只覆盖握手；
 * 某些网关会静默丢弃 subsystem 请求，不设此超时会让连接进度永久等待。 */
const sftpOpenTimeoutMs = 15_000;

function callback<T>(
  invoke: (done: (error: Error | undefined | null, value: T) => void) => void,
  signal?: AbortSignal,
  timeoutMs?: number
): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs !== undefined && timeoutMs > 0) {
      // ssh2 的 SFTP 请求本身没有超时：网关偶发“收到请求但永不回复”
      // （半开/坏包）会让该操作永久挂起。控制类操作加超时保护。
      timer = setTimeout(() => {
        signal?.removeEventListener('abort', aborted);
        reject(new Error(`SFTP 操作超时（${timeoutMs}ms）`));
      }, timeoutMs);
      timer.unref?.();
    }
    const aborted = () => {
      if (timer) clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', aborted, { once: true });
    invoke((error, value) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve(value);
    });
  });
}

/** SFTP 控制类操作（元数据/目录/重命名等）的超时：防止请求石沉大海永久挂起。
 * 文件内容传输（readFile/writeFile/流式读写）不走该超时，避免大文件被误杀。 */
const sftpControlTimeoutMs = 60_000;

export class Ssh2SftpSession implements SftpSession {
  readonly transport = 'sftp' as const;
  private alive = true;
  private readonly disconnected = () => { this.alive = false; };

  constructor(
    readonly hostName: string,
    private readonly client: Client,
    private readonly sftp: SFTPWrapper,
    private readonly releaseConnection: () => void
  ) {
    this.client.on('close', this.disconnected);
    this.client.on('end', this.disconnected);
    this.client.on('error', this.disconnected);
  }

  isAlive(): boolean {
    return this.alive;
  }

  realpath(remotePath: string, signal?: AbortSignal): Promise<string> {
    return callback((done) => this.sftp.realpath(remotePath, done), signal, sftpControlTimeoutMs);
  }

  async statResolved(
    remotePath: string, signal?: AbortSignal
  ): Promise<{ path: string; stat: SftpFileStat }> {
    const path = await this.realpath(remotePath, signal);
    return { path, stat: await this.stat(path, signal) };
  }

  async stat(remotePath: string, signal?: AbortSignal): Promise<SftpFileStat> {
    return fileStat(await callback(
      (done) => this.sftp.lstat(remotePath, done), signal, sftpControlTimeoutMs
    ));
  }

  async readDirectory(
    remotePath: string, signal?: AbortSignal
  ): Promise<SftpDirectoryEntry[]> {
    const entries = await callback<FileEntryWithStats[]>(
      (done) => this.sftp.readdir(remotePath, done),
      signal,
      sftpControlTimeoutMs
    );
    return entries.flatMap((entry) => {
      try {
        assertSafeRemoteEntryName(entry.filename);
      } catch {
        console.warn(
          `[SAFS SFTP] ${this.hostName}: skipped unsafe directory entry ${JSON.stringify(entry.filename)}`
        );
        return [];
      }
      return [{ name: entry.filename, ...fileStat(entry.attrs) }];
    });
  }

  async readDirectoryResolved(
    remotePath: string, signal?: AbortSignal
  ): Promise<{ path: string; entries: SftpDirectoryEntry[] }> {
    const path = await this.realpath(remotePath, signal);
    return { path, entries: await this.readDirectory(path, signal) };
  }

  readFile(remotePath: string, signal?: AbortSignal): Promise<Uint8Array> {
    return callback<Buffer>((done) => this.sftp.readFile(remotePath, done), signal);
  }

  readFileRange(
    remotePath: string, offset: number, length: number, signal?: AbortSignal
  ): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const chunks: Buffer[] = [];
      // createReadStream 的 start/end 走底层 read 范围，避免整文件下载。
      const stream = this.sftp.createReadStream(remotePath, {
        start: offset, end: offset + length - 1
      });
      const aborted = () => {
        stream.destroy();
        reject(abortError());
      };
      signal?.addEventListener('abort', aborted, { once: true });
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.once('error', (error: Error) => {
        signal?.removeEventListener('abort', aborted);
        reject(error);
      });
      stream.once('end', () => {
        signal?.removeEventListener('abort', aborted);
        resolve(Buffer.concat(chunks));
      });
    });
  }

  readFileStream(
    remotePath: string, signal?: AbortSignal, start = 0
  ): Promise<NodeJS.ReadableStream> {
    return new Promise<NodeJS.ReadableStream>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      if (!Number.isSafeInteger(start) || start < 0) {
        reject(new Error(`无效的读取起始偏移: ${start}`));
        return;
      }
      // Keep the SSH2 SFTP read-ahead bounded, but large enough to avoid
      // making throughput proportional to a 64 KiB packet divided by RTT.
      // start > 0 即续传：SFTP 的 READ 报文自带 offset，剩下的量由服务端算。
      const stream = this.sftp.createReadStream(remotePath, {
        highWaterMark: sftpReadHighWaterMark,
        ...(start > 0 ? { start } : {})
      });
      const aborted = () => {
        stream.destroy();
        reject(abortError());
      };
      signal?.addEventListener('abort', aborted, { once: true });
      stream.once('error', (error: Error) => {
        signal?.removeEventListener('abort', aborted);
        reject(error);
      });
      stream.once('open', () => {
        signal?.removeEventListener('abort', aborted);
        resolve(stream);
      });
    });
  }

  async writeFile(
    remotePath: string,
    content: Uint8Array,
    options: SftpWriteOptions,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted();
    // Numeric SFTP flags allow WRITE|TRUNC without CREATE for existing files.
    const flags = 0x02 | 0x10 | (options.create ? 0x08 : 0) | (!options.overwrite ? 0x20 : 0);
    const handle = await callback<Buffer>(done => this.sftp.open(
      remotePath, flags, { mode: options.mode ?? 0o600 }, done
    ), undefined, sftpControlTimeoutMs);
    try {
      signal?.throwIfAborted();
      const chunkBytes = 256 * 1024;
      const concurrency = 4;
      const buffer = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
      for (let start = 0; start < buffer.length; start += chunkBytes * concurrency) {
        signal?.throwIfAborted();
        const pending: Promise<void>[] = [];
        for (let offset = start; offset < Math.min(buffer.length, start + chunkBytes * concurrency); offset += chunkBytes) {
          const length = Math.min(chunkBytes, buffer.length - offset);
          pending.push(callback<void>(done => this.sftp.write(handle, buffer, offset, length, offset, done),
            undefined, sftpWriteChunkTimeoutMs));
        }
        // Drain this bounded window before closing the handle, including on errors.
        const results = await Promise.allSettled(pending);
        const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failed) throw failed.reason;
      }

    } finally {
      await callback<void>(done => this.sftp.close(handle, done), undefined, sftpControlTimeoutMs);
    }
  }

  async replaceFile(
    sourcePath: string, targetPath: string, mode?: number, signal?: AbortSignal
  ): Promise<void> {
    if (mode !== undefined) {
      await this.chmod(sourcePath, mode, signal);
    }
    try {
      await callback<void>(
        (done) => this.sftp.ext_openssh_rename(sourcePath, targetPath, done),
        signal, sftpControlTimeoutMs
      );
    } catch (error) {
      if ((error as { code?: number }).code !== 8
        && !/Server does not support this extended request/i.test(String(error))) throw error;
      // Standard rename may refuse an existing target. Preserve it on failure;
      // never unlink the old file before the replacement has succeeded.
      await this.rename(sourcePath, targetPath, false, signal);
    }
  }

  writeFileStream(
    remotePath: string,
    options: SftpWriteOptions,
    signal?: AbortSignal
  ): Promise<NodeJS.WritableStream> {
    const startOffset = options.startOffset ?? 0;
    if (!Number.isSafeInteger(startOffset) || startOffset < 0) {
      return Promise.reject(new Error(`无效的续传起始偏移: ${startOffset}`));
    }
    // 续传（startOffset > 0）：残片已存在，用 'r+' 定位写，绝不截断已有前缀——
    // 'r+' 在文件不存在时失败，正好挡住「以为在续传其实残片没了」的情况。
    const flag = startOffset > 0
      ? 'r+'
      : (options.create ? (options.overwrite ? 'w' : 'wx') : 'r+');
    // 注：写位置由每条 WRITE 报文自带的 offset 决定，与 open 标志无关。'a' 语义
    // （服务端忽略 offset、永远追加）会把续传起点又推回文件末尾，所以这里不用 'a'。
    const sftp = this.sftp;
    return new Promise<NodeJS.WritableStream>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      // 句柄式分块写：ssh2 的 createWriteStream 在大文件/网关下存在写位置与背压
      // 缺陷（首个块后不再排空，上传卡在开头几百字节）。这里用
      // open → 逐块 write(显式偏移) → close 流式写：写回调驱动背压，
      // 与整写 writeFile 走同一底层语义；每个块带超时防无限挂起。
      sftp.open(remotePath, flag, (openError, handle) => {
        if (openError) {
          reject(openError);
          return;
        }
        let position = startOffset;
        let handleOpen = true;
        let pendingTimer: NodeJS.Timeout | undefined;
        const writable = new Writable({
          highWaterMark: 64 * 1024,
          write(chunk: Buffer, _encoding, callback) {
            pendingTimer = setTimeout(() => {
              pendingTimer = undefined;
              callback(new Error('远程写入超时'));
            }, sftpWriteChunkTimeoutMs);
            sftp.write(handle, chunk, 0, chunk.length, position, (writeError) => {
              if (pendingTimer) {
                clearTimeout(pendingTimer);
                pendingTimer = undefined;
              }
              if (writeError) {
                callback(writeError);
                return;
              }
              position += chunk.length;
              callback();
            });
          },
          final(callback) {
            handleOpen = false;
            sftp.close(handle, (closeError) => callback(closeError ?? undefined));
          },
          destroy(error, callback) {
            if (pendingTimer) {
              clearTimeout(pendingTimer);
              pendingTimer = undefined;
            }
            if (handleOpen) {
              handleOpen = false;
              sftp.close(handle, () => callback(error));
            } else {
              callback(error);
            }
          }
        });
        const aborted = () => writable.destroy(abortError());
        signal?.addEventListener('abort', aborted, { once: true });
        writable.once('finish', () => signal?.removeEventListener('abort', aborted));
        writable.once('error', () => signal?.removeEventListener('abort', aborted));
        resolve(writable);
      });
    });
  }

  async chmod(remotePath: string, mode: number, signal?: AbortSignal): Promise<void> {
    await callback<void>(
      (done) => this.sftp.chmod(remotePath, mode, done), signal, sftpControlTimeoutMs
    );
  }

  async createDirectory(remotePath: string, signal?: AbortSignal): Promise<void> {
    await callback<void>((done) => this.sftp.mkdir(remotePath, done), signal, sftpControlTimeoutMs);
  }

  async deleteFile(remotePath: string, signal?: AbortSignal): Promise<void> {
    await callback<void>((done) => this.sftp.unlink(remotePath, done), signal, sftpControlTimeoutMs);
  }

  async deleteDirectory(remotePath: string, signal?: AbortSignal): Promise<void> {
    await callback<void>((done) => this.sftp.rmdir(remotePath, done), signal, sftpControlTimeoutMs);
  }

  async rename(
    sourcePath: string,
    targetPath: string,
    overwrite: boolean,
    signal?: AbortSignal
  ): Promise<void> {
    if (overwrite) {
      // SFTP v3 SSH_FXP_RENAME does not mandate overwrite behaviour — some
      // servers reject when the target already exists.  Delete the target
      // first so the rename always succeeds.
      try {
        const stat = await this.stat(targetPath, signal);
        if (stat.type === 'directory') {
          await this.deleteDirectory(targetPath, signal);
        } else {
          await this.deleteFile(targetPath, signal);
        }
      } catch (error) {
        const code = (error as { code?: number | string }).code;
        if (code !== 2 && code !== 'ENOENT') throw error;
      }
    }
    await callback<void>(
      (done) => this.sftp.rename(sourcePath, targetPath, done), signal, sftpControlTimeoutMs
    );
  }

  async close(): Promise<void> {
    this.alive = false;
    this.client.removeListener('close', this.disconnected);
    this.client.removeListener('end', this.disconnected);
    this.client.removeListener('error', this.disconnected);
    this.sftp.end();
    this.releaseConnection();
  }
}

/** Errors meaning the SFTP subsystem is unusable: the server rejects it or
 * a gateway MOTD/`garbage corrupts the version handshake. These trigger the
 * exec/SCP fallback. */
const sftpUnusablePattern =
  /Unable to start subsystem|packet length|wrong packet|bad packet|exchange encryption keys|Expected VERSION packet|Unknown packet type|Malformed VERSION/i;

/** Transient ssh2 connection/handshake errors worth retrying with a fresh
 * client. Authentication and host-key failures deliberately do not match. */
const retryableConnectionPattern =
  /packet length|wrong packet|bad packet|exchange encryption keys|connection lost before handshake|timed out while waiting for handshake|ready.?timeout|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENETUNREACH|EHOSTUNREACH)\b|socket hang up|connection (?:reset|closed|terminated)(?: by remote| remotely)?|connection unexpectedly closed|broken pipe|kex_exchange_identification.*closed|no route to host|network is unreachable/i;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRetryableSsh2ConnectionError(error: unknown): boolean {
  return retryableConnectionPattern.test(errorMessage(error));
}

async function connectSftpSsh2(
  host: HostConfig,
  signal?: AbortSignal,
  onSftpFallback?: (reason: string) => void
): Promise<SftpSession> {
  if (signal?.aborted) throw abortError();
  // Gateways and load balancers can intermittently drop the first SSH
  // handshake (especially after an idle period). Retry transient failures with
  // a fresh ssh2 Client; keep authentication and host-key failures visible.
  let attempt = 0;
  while (true) {
    try {
      const lease = await acquireSsh2Connection(host, host.password);
      try {
        return await attemptConnect(host, lease, signal, onSftpFallback);
      } catch (error) {
        lease.release();
        throw error;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      // Gateways that reset the first connection often need a short window to
      // release the failed backend. Three immediate retries are frequently
      // all served by that same unhealthy slot, so use a bounded backoff.
      if (!isRetryableSsh2ConnectionError(error) || attempt >= 4) {
        throw error;
      }
      attempt++;
      await new Promise((resolve) => setTimeout(resolve, 700 * attempt));
    }
  }
}

/** Connect with the explicit SAFS endpoint and ssh2; no OpenSSH config lookup. */
export async function connectSftp(
  host: HostConfig,
  signal?: AbortSignal,
  onSftpFallback?: (reason: string) => void
): Promise<SftpSession> {
  return connectSftpSsh2(
    host,
    signal,
    onSftpFallback
  );
}

function attemptConnect(
  host: HostConfig,
  lease: Ssh2ConnectionLease,
  signal?: AbortSignal,
  onSftpFallback?: (reason: string) => void
): Promise<SftpSession> {
  const client = lease.client;
  return new Promise<SftpSession>((resolve, reject) => {
    let settled = false;
    let fallbackResolved = false;
    let sftpOpenTimer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (sftpOpenTimer) clearTimeout(sftpOpenTimer);
      sftpOpenTimer = undefined;
      signal?.removeEventListener('abort', abort);
      client.removeListener('error', failed);
    };
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      lease.release();
      reject(error);
    };
    const failed = (error: Error) => finishError(error);
    const abort = () => finishError(abortError());
    const ready = () => {
      sftpOpenTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        fallbackResolved = true;
        cleanup();
        const reason = `SSH 已认证，但服务器未响应 SFTP 子系统请求（${sftpOpenTimeoutMs}ms 超时）`;
        onSftpFallback?.(reason);
        resolve(new ScpSession(host.name, client, lease.release));
      }, sftpOpenTimeoutMs);
      sftpOpenTimer.unref?.();
      client.sftp((error, sftp) => {
        if (sftpOpenTimer) clearTimeout(sftpOpenTimer);
        sftpOpenTimer = undefined;
        if (error) {
          // 握手失败时附上通道首字节 hex（由构建期补丁暂存在 client 上），
          // 便于识别网关 banner 的实际格式并精确匹配。
          const probe = (client as unknown as { _safsMotdProbe?: Buffer })._safsMotdProbe;
          const probeDetail = probe && probe.length
            ? `；通道首 64 字节 hex=${probe.subarray(0, 64).toString('hex')}`
            : '';
          // Server has no usable SFTP subsystem: either it rejects the
          // subsystem request (NSG gateways without sftp-server) or a gateway
          // MOTD banner corrupts the SFTP version handshake ("Packet length
          // … exceeds max length"). Fall back to an exec/SCP session on the
          // same connection, reusing the authenticated ssh2 connection.
          if (sftpUnusablePattern.test(error.message)) {
            if (settled) {
              sftp?.end();
              if (!fallbackResolved) lease.release();
              return;
            }
            settled = true;
            fallbackResolved = true;
            cleanup();
            onSftpFallback?.(`${error.message}${probeDetail}`);
            resolve(new ScpSession(host.name, client, lease.release));
            return;
          }
          finishError(error);
          return;
        }
        if (settled) {
          sftp.end();
          if (!fallbackResolved) lease.release();
          return;
        }
        settled = true;
        cleanup();
        resolve(new Ssh2SftpSession(host.name, client, sftp, lease.release));
      });
    };
    signal?.addEventListener('abort', abort, { once: true });
    client.once('error', failed);
    // The shared connection lease is already authenticated. ssh2 emits ready
    // only once, so request the file channel directly instead of reconnecting.
    ready();
  });
}
