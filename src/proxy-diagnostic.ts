import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { promisify } from 'node:util';

const run = promisify(execFile);
export interface LoopbackProbe {
  host: string;
  reachable: boolean;
  proxyUsed?: boolean;
  unavailable?: boolean;
}

/** Probe an ephemeral loopback-only endpoint; never return curl diagnostics or proxy credentials. */
export async function testLoopbackProxy(environment: NodeJS.ProcessEnv = process.env): Promise<LoopbackProbe[]> {
  // curl deliberately ignores uppercase HTTP_PROXY. Model Agent clients that honor it too.
  const env = { ...environment, http_proxy: environment.http_proxy || environment.HTTP_PROXY };
  return Promise.all(['localhost', '127.0.0.1', '::1'].map(async (host): Promise<LoopbackProbe> => {
    const token = randomBytes(24).toString('hex');
    const server = createServer((request, response) => {
      response.setHeader('Connection', 'close');
      response.end(request.url === `/${token}` ? token : '');
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, host, resolve);
      });
    } catch {
      return { host, reachable: false, unavailable: true };
    }
    try {
      const address = server.address();
      if (!address || typeof address === 'string') return { host, reachable: false, unavailable: true };
      const url = `http://${host === '::1' ? '[::1]' : host}:${address.port}/${token}`;
      let stdout = '';
      try {
        ({ stdout } = await run(process.platform === 'win32' ? 'curl.exe' : 'curl', [
          '--disable', '--silent', '--max-time', '5', '--connect-timeout', '3',
          '--max-filesize', '1024', '--write-out', '\n%{proxy_used}', url
        ], { env, timeout: 6500, maxBuffer: 4096, windowsHide: true }));
      } catch (error) {
        const failure = error as { code?: string; stdout?: string };
        if (failure.code === 'ENOENT') throw new Error('本机代理测试需要 curl，请安装 curl 后重试。');
        stdout = typeof failure.stdout === 'string' ? failure.stdout : '';
      }
      const [body, proxy] = stdout.trimEnd().split('\n');
      return { host, reachable: body === token,
        proxyUsed: proxy === '1' ? true : proxy === '0' ? false : undefined };
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }));
}
