import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client, ConnectConfig } from 'ssh2';
import * as vscode from 'vscode';
import { expandHome, HostConfig } from '../config/config';
import { hostVerifierFor } from '../security/host-key';
import { keyboardInteractivePasswordReplies } from '../config/authentication';
import { defaultSshClientIdent, serverHostKeyAlgorithms } from './algorithms';
import { detectPlatform } from '../platform/platform';
import { acquireWslVpnRelay } from './vpn-relay';
import { CredentialRetry, PrivateKeyError, withAuthenticationRetries } from './authentication-retry';

interface SharedConnection {
  client: Client;
  ready: Promise<void>;
  dead: boolean;
  refs: number;
  key: string;
  rejectReady(error: Error): void;
  releaseResources(): Promise<void>;
}

export interface Ssh2ConnectionLease {
  readonly client: Client;
  release(): void;
}

const connections = new Map<string, SharedConnection>();
const creating = new Map<string, Promise<SharedConnection>>();

let credentialRetry: CredentialRetry | undefined;
export function setSshCredentialRetry(retry: CredentialRetry | undefined): void { credentialRetry = retry; }

export function ssh2ConnectionKey(host: HostConfig, password?: string): string {
  const credential = createHash('sha256').update(password ?? '').digest('hex');
  return JSON.stringify([
    host.ip.toLowerCase(), host.port ?? 22, host.user,
    host.private_key_path ? expandHome(host.private_key_path) : '', credential
  ]);
}

async function readPrivateKey(host: HostConfig): Promise<Buffer | undefined> {
  if (!host.private_key_path || host.auth === 'password') return undefined;
  try { return await readFile(expandHome(host.private_key_path)); }
  catch { throw new PrivateKeyError('无法读取 SSH 私钥文件，请重新选择。'); }
}

async function configFor(
  host: HostConfig, password?: string, log?: (message: string) => void,
  connectTarget?: { host: string; port: number }
): Promise<ConnectConfig> {
  const privateKey = await readPrivateKey(host);
  return {
    host: connectTarget?.host ?? host.ip,
    port: connectTarget?.port ?? host.port ?? 22,
    username: host.user,
    ...(password && host.auth !== 'publickey' ? { password, tryKeyboard: true } : {}),
    ...(privateKey ? { privateKey } : {}),
    ident: vscode.workspace.getConfiguration('safs')
      .get<string>('sshClientIdent', defaultSshClientIdent),
    readyTimeout: 30_000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
    algorithms: { serverHostKey: serverHostKeyAlgorithms },
    hostVerifier: hostVerifierFor(host, log)
  };
}

async function createConnection(
  host: HostConfig, password: string | undefined, log?: (message: string) => void
): Promise<SharedConnection> {
  const useRelay = detectPlatform() === 'wsl' && !!host.vpn;
  const relay = useRelay ? await acquireWslVpnRelay(host) : undefined;
  let relayReleased = false;
  const releaseResources = async () => {
    if (relayReleased) return;
    relayReleased = true;
    await relay?.release();
  };
  let client: Client | undefined;
  try {
    const config = await configFor(
      host, password, log,
      relay ? { host: relay.host, port: relay.port } : undefined
    );
    client = new Client();
    let rejectReady!: (error: Error) => void;
    const connection: SharedConnection = {
      client,
      key: ssh2ConnectionKey(host, password),
      refs: 0,
      dead: false,
      ready: new Promise<void>((resolve, reject) => {
        rejectReady = reject;
        client!.once('ready', resolve);
      }),
      rejectReady: (error) => rejectReady(error),
      releaseResources
    };
    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      const replies = password ? keyboardInteractivePasswordReplies(prompts, password) : undefined;
      finish(replies ?? []);
    });
    const invalidate = (error?: Error) => {
      connection.dead = true;
      if (error) connection.rejectReady(error);
      if (connections.get(connection.key) === connection) connections.delete(connection.key);
    };
    client.on('error', invalidate);
    client.on('close', () => {
      invalidate();
      void releaseResources();
    });
    try { client.connect(config); }
    catch (error) {
      if (config.privateKey && /private.?key|key.*format|encrypted.*key|passphrase/i.test(String(error))) {
        throw new PrivateKeyError('SSH 私钥格式不支持或需要口令，请重新选择可用私钥。');
      }
      throw error;
    }
    await connection.ready;
    return connection;
  } catch (error) {
    client?.end();
    await releaseResources();
    throw error;
  }
}

async function createAuthenticatedConnection(host: HostConfig, password: string | undefined, log?: (message: string) => void): Promise<SharedConnection> {
  return withAuthenticationRetries({ ...host, password }, async current => {
    const connection = await createConnection(current, current.password, log);
    Object.assign(host, current);
    return connection;
  }, credentialRetry);
}

export async function acquireSsh2Connection(
  host: HostConfig,
  password: string | undefined = host.password,
  log?: (message: string) => void,
  independent = false
): Promise<Ssh2ConnectionLease> {
  const key = ssh2ConnectionKey(host, password);
  let connection = independent ? await createAuthenticatedConnection(host, password, log) : connections.get(key);
  if (!connection || connection.dead) {
    let pending = creating.get(key);
    if (!pending) {
      pending = createAuthenticatedConnection(host, password, log).then((created) => {
        if (!created.dead) connections.set(created.key, created);
        return created;
      }).finally(() => creating.delete(key));
      creating.set(key, pending);
    }
    connection = await pending;
  } else {
    await connection.ready;
  }
  if (connection.dead) throw new Error('SSH 连接已关闭');
  connection.refs++;
  let released = false;
  return {
    client: connection.client,
    release: () => {
      if (released) return;
      released = true;
      connection!.refs--;
      if (connection!.refs === 0) {
        connection!.dead = true;
        if (connections.get(connection!.key) === connection) connections.delete(connection!.key);
        connection!.client.end();
        void connection!.releaseResources();
      }
    }
  };
}

export function closeSharedSsh2Connections(): void {
  for (const connection of connections.values()) {
    connection.dead = true;
    connection.client.end();
    void connection.releaseResources();
  }
  connections.clear();
  creating.clear();
}
