import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Client, SFTPWrapper } from 'ssh2';
import { createAskpassCredentials } from '../askpass';
import type { HostConfig } from '../config';
import type { ConnectionOptions, PlatformAdapter } from '../platform';
import { resolveExecutable, windowsCommandInvocation } from '../process';
import { Ssh2SftpSession } from './client';
import type { SftpSession } from './session';

// Reuse ssh2's packet codec, while OpenSSH owns authentication and transport.
const { SFTP } = require('ssh2/lib/protocol/SFTP');

export async function connectSystemSftp(
  host: HostConfig, adapter: PlatformAdapter, options: ConnectionOptions, signal?: AbortSignal
): Promise<SftpSession> {
  if (signal?.aborted) throw new Error('System SFTP connection was cancelled');
  const credentials = host.password ? await createAskpassCredentials(host.password) : undefined;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const plan = adapter.terminal(host, undefined, options);
    if (adapter.kind === 'wsl') {
      plan.env = { ...plan.env, WSL_VPN_SSH_SUBSYSTEM: 'sftp' };
    } else {
      plan.args.unshift('-T', '-s', '-o', 'IgnoreUnknown=RemoteCommand,SessionType,StdinNull,ForkAfterAuthentication', '-o', 'RemoteCommand=none', '-o', 'RequestTTY=no',
        '-o', 'StdinNull=no', '-o', 'ForkAfterAuthentication=no', '-o', 'ClearAllForwardings=yes',
        '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
        '-o', 'ControlMaster=no', '-o', 'ControlPath=none');
      plan.args.push('sftp');
    }
    const executable = await resolveExecutable(plan.command, plan.env);
    const invocation = windowsCommandInvocation(executable, plan.args);
    if (signal?.aborted) throw new Error('System SFTP connection was cancelled');
    const process_ = child = spawn(invocation.command, invocation.args, {
      cwd: plan.cwd, env: { ...process.env, ...plan.env, ...credentials?.env },
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
    });
    const client = new EventEmitter() as EventEmitter & { end(): void };
    client.on('error', () => undefined);
    client.end = () => { process_.kill(); };
    const window = 2 ** 30;
    const outgoing = { id: 0, state: 'open', window, packetSize: 65536 };
    let sftp: any;
    const protocol = {
      channelData: (_id: number, data: Buffer) => {
        outgoing.window = process_.stdin!.write(data) ? window : 0;
      },
      channelClose: () => process_.kill(),
      channelEOF: () => process_.stdin!.end()
    };
    sftp = new SFTP({ _protocol: protocol }, { type: 'session', incoming: {}, outgoing }, {});
    process_.stdin!.on('drain', () => {
      outgoing.window = window;
      sftp._chunkcb?.call(sftp);
    });
    let stderr = '';
    process_.stderr!.on('data', data => { stderr = (stderr + data.toString()).slice(-8192); });
    process_.stdout!.on('data', data => { sftp.push(data); });
    process_.stdin!.on('error', error => sftp.emit('error', error));
    process_.once('error', error => { sftp.emit('error', error); client.emit('error', error); });
    process_.once('close', code => {
      sftp.emit('error', new Error(`System SFTP closed (${code}): ${stderr.trim()}`));
      sftp.push(null);
      client.emit('close');
      void credentials?.cleanup();
    });
    sftp.on('error', (error: Error) => { client.emit('error', error); process_.kill(); });
    const session = new Ssh2SftpSession(host.name, client as unknown as Client, sftp as SFTPWrapper);
    const abort = () => { sftp.emit('error', new Error('System SFTP connection was cancelled')); process_.kill(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { process_.kill(); reject(new Error('System SFTP handshake timed out')); }, 30000);
        const failed = (error: Error) => { clearTimeout(timer); sftp.removeListener('ready', ready); reject(error); };
        const ready = () => { clearTimeout(timer); sftp.removeListener('error', failed); resolve(); };
        sftp.once('error', failed);
        sftp.once('ready', ready);
        if (signal?.aborted) abort();
        else sftp._init();
      });
      await session.statResolved('.', signal);
      return session;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  } catch (error) {
    child?.kill();
    await credentials?.cleanup();
    throw error;
  }
}
