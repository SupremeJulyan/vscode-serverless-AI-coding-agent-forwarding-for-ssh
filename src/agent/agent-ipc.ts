import * as http from 'node:http';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export function ipcPath(key: string): string {
  const id = createHash('sha256')
    .update(homedir() + key)
    .digest('hex')
    .slice(0, 24);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\safs-${id}`
    : join(tmpdir(), `safs-${id}.sock`);
}
export function ipcUrl(socket: string): string {
  return `http://localhost/mcp?socket=${encodeURIComponent(socket)}`;
}
export function ipcFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input);
  const socketPath = url.searchParams.get('socket');
  if (!socketPath) return Promise.reject(new Error('Missing IPC endpoint; reload SAFS windows'));
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        agent: false,
        socketPath,
        path: url.pathname + url.search,
        method: init.method ?? 'GET',
        headers: init.headers as http.OutgoingHttpHeaders,
        signal: init.signal ?? undefined
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (value !== undefined)
              for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
          }
          const status = response.statusCode ?? 500;
          resolve(
            new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), {
              status,
              headers
            })
          );
        });
      }
    );
    request.on('error', reject);
    request.end(init.body);
  });
}

/** Reclaim sockets left by an exited leader; a live listener is never removed. */
export async function listenIpc(server: http.Server, socketPath: string): Promise<void> {
  const { connect } = await import('node:net');
  const { unlink, chmod } = await import('node:fs/promises');
  const listen = () =>
    new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => {
        server.off('listening', ready);
        reject(error);
      };
      const ready = () => {
        server.off('error', failed);
        resolve();
      };
      server.once('error', failed);
      server.once('listening', ready);
      server.listen(socketPath);
    });
  try {
    await listen();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || process.platform === 'win32')
      throw error;
    const stale = await new Promise<boolean>((resolve) => {
      const probe = connect(socketPath);
      probe.once('connect', () => {
        probe.destroy();
        resolve(false);
      });
      probe.once('error', (e) => resolve((e as NodeJS.ErrnoException).code === 'ECONNREFUSED'));
      probe.setTimeout(1500, () => {
        probe.destroy();
        resolve(false);
      });
    });
    if (!stale) throw error;
    await unlink(socketPath).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
    await listen();
  }
  if (process.platform !== 'win32') await chmod(socketPath, 0o600);
}
