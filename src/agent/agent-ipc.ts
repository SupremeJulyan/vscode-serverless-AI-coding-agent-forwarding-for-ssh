import { randomUUID, createHash } from 'node:crypto';
import { connect, createServer, type Server } from 'node:net';
import { chmod, unlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const maxFrameBytes = 64 * 1024 * 1024;
export interface IpcRequestOptions { timeoutMs?: number; }
export interface IpcServerRequest { action: string; payload?: unknown; }

export class IpcRequestError extends Error {
  constructor(message: string, readonly code?: string) { super(message); this.name = 'IpcRequestError'; }
}

export function ipcPath(key: string): string {
  const id = createHash('sha256').update(homedir() + key).digest('hex').slice(0, 24);
  return process.platform === 'win32' ? `\\\\.\\pipe\\safs-${id}` : join(tmpdir(), `safs-${id}.sock`);
}

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > maxFrameBytes) throw new Error('IPC message exceeds the allowed size');
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0); body.copy(frame, 4);
  return frame;
}

class FrameReader {
  private buffered = Buffer.alloc(0);
  push(chunk: Buffer): unknown | undefined {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    if (this.buffered.length < 4) return undefined;
    const size = this.buffered.readUInt32BE(0);
    if (size > maxFrameBytes) throw new Error('IPC message exceeds the allowed size');
    if (this.buffered.length < size + 4) return undefined;
    if (this.buffered.length !== size + 4) throw new Error('Unexpected trailing IPC data');
    return JSON.parse(this.buffered.subarray(4).toString('utf8'));
  }
}

export function createIpcServer(
  handler: (request: IpcServerRequest) => Promise<unknown> | unknown
): Server {
  return createServer((socket) => {
    const reader = new FrameReader();
    let handled = false;
    socket.on('data', (chunk: Buffer) => {
      if (handled) return;
      let message: { id?: unknown; token?: unknown; action?: unknown; payload?: unknown } | undefined;
      try { message = reader.push(chunk) as typeof message; }
      catch (error) {
        handled = true;
        socket.end(encodeFrame({ id: '', ok: false, error: { message: error instanceof Error ? error.message : String(error) } }));
        return;
      }
      if (!message) return;
      handled = true;
      void (async () => {
        try {
          if (typeof message.id !== 'string' || typeof message.token !== 'string' || typeof message.action !== 'string')
            throw new IpcRequestError('Invalid IPC request', 'INVALID_REQUEST');
          const result = await handler({ action: message.action, payload: { token: message.token, value: message.payload } });
          socket.end(encodeFrame({ id: message.id, ok: true, result }));
        } catch (error) {
          const failure = error instanceof IpcRequestError ? error : new IpcRequestError(error instanceof Error ? error.message : String(error));
          if (!socket.destroyed) socket.end(encodeFrame({ id: '', ok: false, error: { message: failure.message, code: failure.code } }));
        }
      })();
    });
    socket.on('error', () => {});
  });
}

export function ipcRequest<T>(socketPath: string, token: string, action: string, payload?: unknown,
  options: IpcRequestOptions = {}): Promise<T> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    const reader = new FrameReader();
    let settled = false;
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true; if (timer) clearTimeout(timer); socket.destroy();
      error ? reject(error) : resolve(value as T);
    };
    const timer = options.timeoutMs && options.timeoutMs > 0
      ? setTimeout(() => finish(new IpcRequestError('Request timed out; remote operations may still be running.', 'TIMEOUT')), options.timeoutMs)
      : undefined;
    socket.once('connect', () => {
      try { socket.write(encodeFrame({ id, token, action, payload })); }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.on('data', (chunk: Buffer) => {
      try {
        const response = reader.push(chunk) as { id?: unknown; ok?: unknown; result?: T; error?: { message?: string; code?: string } } | undefined;
        if (!response) return;
        if (response.id !== id && response.id !== '') throw new Error('IPC response ID mismatch');
        if (response.ok !== true) throw new IpcRequestError(response.error?.message ?? 'IPC request failed', response.error?.code);
        finish(undefined, response.result);
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.once('error', (error) => finish(new IpcRequestError(error.message, (error as NodeJS.ErrnoException).code)));
    socket.once('end', () => { if (!settled) finish(new IpcRequestError('IPC connection closed without a response')); });
  });
}

/** Reclaim Unix sockets left by an exited leader; a live listener is never removed. */
export async function listenIpc(server: Server, socketPath: string): Promise<void> {
  const listen = () => new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { server.off('listening', ready); reject(error); };
    const ready = () => { server.off('error', failed); resolve(); };
    server.once('error', failed); server.once('listening', ready); server.listen(socketPath);
  });
  try { await listen(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || process.platform === 'win32') throw error;
    const stale = await new Promise<boolean>((resolve) => {
      const probe = connect(socketPath);
      probe.once('connect', () => { probe.destroy(); resolve(false); });
      probe.once('error', (e) => resolve((e as NodeJS.ErrnoException).code === 'ECONNREFUSED'));
      probe.setTimeout(1500, () => { probe.destroy(); resolve(false); });
    });
    if (!stale) throw error;
    await unlink(socketPath).catch((e) => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; });
    await listen();
  }
  if (process.platform !== 'win32') await chmod(socketPath, 0o600);
}
