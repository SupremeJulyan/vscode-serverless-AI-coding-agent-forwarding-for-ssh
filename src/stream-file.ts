import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';

export interface StreamPipeOptions {
  /** 每约 1MB 汇报一次增量字节（用于进度条）。 */
  onDelta?: (delta: number) => void;
  /** 取消信号：中止管道并销毁两端。 */
  signal?: AbortSignal;
}

/**
 * 把可读流分块写入可写流（边下边写，内存 O(chunk)）。
 *
 * - 任一端的 error 或 signal.abort 都会销毁对端并抛错（幂等，只 settle 一次）。
 * - onDelta 每约 1MB 汇报一次增量字节，供调用方驱动进度条。
 */
export async function pipeStreams(
  source: NodeJS.ReadableStream,
  target: NodeJS.WritableStream,
  options: StreamPipeOptions = {}
): Promise<void> {
  let received = 0;
  let lastReport = 0;
  let lastEmitAt = 0;
  // 时间节流（约 150ms）：慢速链接、小文件也能持续上报进度，而非按字节量
  // 等到 1MB 才发第一条；finish 时 flush 尾部。
  const emitIntervalMs = 150;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => options.signal?.removeEventListener('abort', aborted);
    const destroyBoth = () => {
      const destroyableSource = source as NodeJS.ReadableStream & { destroy?: () => void };
      destroyableSource.destroy?.();
      const destroyableTarget = target as NodeJS.WritableStream & { destroy?: () => void };
      destroyableTarget.destroy?.();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      destroyBoth();
      reject(error);
    };
    const aborted = () => fail(new Error('传输已取消'));
    options.signal?.addEventListener('abort', aborted, { once: true });
    source.on('data', (chunk: Buffer) => {
      received += chunk.length;
      const now = Date.now();
      if (now - lastEmitAt >= emitIntervalMs) {
        options.onDelta?.(received - lastReport);
        lastReport = received;
        lastEmitAt = now;
      }
    });
    source.once('error', (error: Error) => fail(error));
    target.once('error', (error: Error) => fail(error));
    if (options.signal?.aborted) {
      aborted();
      return;
    }
    // pipeline() is deliberately used instead of manually wiring `pipe` and
    // `finish`: it applies backpressure across both streams and tears down
    // the producer immediately if the destination fails. This matters for
    // multi-gigabyte SFTP transfers, where an unbounded read-ahead otherwise
    // grows the extension host until it hits the memory limit.
    void pipeline(source as NodeJS.ReadableStream, target as NodeJS.WritableStream)
      .then(() => {
        if (settled) return;
        settled = true;
        cleanup();
        if (received > lastReport) options.onDelta?.(received - lastReport);
        resolve();
      })
      .catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
  });
}

export interface WriteStreamOptions {
  /** 每约 1MB 汇报一次增量字节（用于进度条）。 */
  onDelta?: (delta: number) => void;
  /** 取消信号：中止写入并删除半成品文件（resume 时保留，见下）。 */
  signal?: AbortSignal;
  /**
   * 断点续传：目标已存在这么多字节且确认是本源的真前缀，从该偏移继续写入。
   *
   * 置位后行为有两处区别：
   * - 文件以追加方式打开（`flags: 'a'`），已有内容不被截断；
   * - 失败/取消时**保留**半成品而不是删除——它就是下一次续传的起点。
   *
   * `offset` 只用于说明调用方已核对过起点；实际写入位置由 `'a'` 决定（文件末尾），
   * 所以调用方必须传入与文件当前长度一致的偏移。
   */
  resume?: { offset: number };
}

/**
 * 等写入流彻底关闭（fd 已释放）。
 *
 * destroy 之后 'close' 必然会来；超时只是兜底，避免极端情况下把整个传输挂住。
 */
async function streamClosed(stream: NodeJS.WritableStream & { closed?: boolean }): Promise<void> {
  if (stream.closed === true) return;
  await new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const done = (): void => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(done, 2000);
    timer.unref();
    stream.once('close', done);
  });
}

/**
 * 把可读流分块写入本地文件（边下边写，内存 O(chunk)，不整文件驻留内存）。
 *
 * - 失败或取消（signal.abort）时删除半成品文件并抛错，避免残留截断文件；
 *   续传（resume）时相反：保留半成品，它就是下一次的起点。
 * - onDelta 每约 1MB 汇报一次增量字节，供调用方驱动进度条。
 */
export async function writeStreamToFile(
  source: NodeJS.ReadableStream,
  target: string,
  options: WriteStreamOptions = {}
): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  // 续传用 'a' 而不是 'r+'：目标是我们自己在上一轮留下的残片，追加语义既不会
  // 截断已收到的字节，也不需要额外一次 open 存在性探测。
  const destination = createWriteStream(target, { flags: options.resume ? 'a' : 'w' });
  try {
    await pipeStreams(source, destination, options);
  } catch (error) {
    // createWriteStream 的 open 是异步的：取消/失败时它可能还没落盘，此刻 rm 只会拿到
    // ENOENT（被 force 吞掉），open 随后才把 0 字节半成品建出来，而且再也没人清它
    // （实测取消 40 次残留 39 个）。所以先销毁并等写入流真正 close（fd 释放、文件已创建），
    // 再删除；删除本身对 Windows 上瞬时的 EBUSY/EPERM 退避重试几次。
    destination.destroy();
    await streamClosed(destination);
    if (options.resume) return Promise.reject(error);
    await rm(target, { force: true, maxRetries: 5, retryDelay: 50 });
    throw error;
  }
}
