import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Client } from 'ssh2';
import { createAskpassCredentials } from '../askpass';
import type { HostConfig } from '../config';
import type { ConnectionOptions, PlatformAdapter } from '../platform';
import { resolveExecutable, windowsCommandInvocation } from '../process';
import { ScpSession } from './scp-session';
import type { SftpSession } from './session';

type ExecCallback = (error: Error | undefined, stream: unknown) => void;

/**
 * Minimal ssh2-Client-compatible facade backed by the system OpenSSH client.
 * ScpSession only relies on exec(), end(), and connection lifecycle events, so
 * this lets its battle-tested SCP protocol and portable metadata commands run
 * over /usr/bin/ssh (or Windows OpenSSH) when ssh2 cannot establish a session.
 */
class SystemSshExecClient extends EventEmitter {
  private alive = true;
  private readonly children = new Set<ReturnType<typeof spawn>>();

  constructor(
    private readonly adapter: PlatformAdapter,
    private readonly host: HostConfig,
    private readonly options: ConnectionOptions
  ) {
    super();
  }

  exec(command: string, callback: ExecCallback): void {
    if (!this.alive) {
      queueMicrotask(() => callback(new Error('System SSH session is closed'), undefined));
      return;
    }
    void this.launch(command, callback);
  }

  private async launch(command: string, callback: ExecCallback): Promise<void> {
    let credentials: Awaited<ReturnType<typeof createAskpassCredentials>> | undefined;
    try {
      if (this.host.password) credentials = await createAskpassCredentials(this.host.password);
      const plan = this.adapter.exec(this.host, '/', command, this.options);
      const executable = await resolveExecutable(plan.command, plan.env);
      const invocation = windowsCommandInvocation(executable, plan.args);
      const child = spawn(invocation.command, invocation.args, {
        cwd: plan.cwd,
        env: { ...process.env, ...plan.env, ...credentials?.env },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
      });
      this.children.add(child);
      const channel = new EventEmitter() as EventEmitter & {
        stdin: typeof child.stdin;
        stderr: typeof child.stderr;
        destroy(): void;
        close(): void;
      };
      channel.stdin = child.stdin;
      channel.stderr = child.stderr;
      channel.destroy = () => child.kill();
      channel.close = () => child.kill();
      // ssh2 channels always have an internal error consumer. Match that
      // behaviour so a late child-process error cannot become an unhandled
      // EventEmitter error while ScpSession is waiting for close.
      channel.on('error', () => undefined);
      child.stdout.on('data', (chunk: Buffer) => channel.emit('data', chunk));
      child.once('error', (error) => channel.emit('error', error));
      child.once('close', (code) => {
        this.children.delete(child);
        channel.emit('close', code ?? undefined);
        void credentials?.cleanup();
      });
      callback(undefined, channel);
    } catch (error) {
      await credentials?.cleanup();
      callback(error instanceof Error ? error : new Error(String(error)), undefined);
    }
  }

  end(): void {
    if (!this.alive) return;
    this.alive = false;
    for (const child of this.children) child.kill();
    this.children.clear();
    this.emit('end');
    this.emit('close');
  }
}

export async function connectSystemScp(
  host: HostConfig,
  adapter: PlatformAdapter,
  options: ConnectionOptions,
  signal?: AbortSignal
): Promise<SftpSession> {
  if (signal?.aborted) throw new Error('System SSH connection was cancelled');
  const facade = new SystemSshExecClient(adapter, host, options);
  const session = new ScpSession(host.name, facade as unknown as Client);
  const aborted = () => void session.close();
  signal?.addEventListener('abort', aborted, { once: true });
  try {
    // Fail before installing the fallback in the pool if OpenSSH cannot
    // authenticate/connect. This also resolves the login home used by '.'.
    await session.statResolved('.', signal);
    return session;
  } catch (error) {
    await session.close();
    throw error;
  } finally {
    signal?.removeEventListener('abort', aborted);
  }
}
