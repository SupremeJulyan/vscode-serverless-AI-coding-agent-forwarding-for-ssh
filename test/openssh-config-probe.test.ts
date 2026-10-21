import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import test from 'node:test';
import { Server } from 'ssh2';
import { parseSshVersion } from '../src/ssh-algorithms';
import { probeConfiguredSshHostKey, requiresConfiguredSshProbe, systemSshUsesConfiguredRoute } from '../src/system-ssh-host-key';

const host = { name: 'route', ip: 'safs-test-route', user: 'alice', port: 22 };

function isLegacyWindowsSsh(): boolean {
  if (process.platform !== 'win32') return false;
  const result = spawnSync('ssh', ['-V'], { encoding: 'utf8' });
  const version = parseSshVersion(result.stderr || result.stdout);
  return !!version && version[0] < 8;
}

test('detects OpenSSH routes and HostName aliases requiring a configured probe', () => {
  assert.equal(requiresConfiguredSshProbe('hostname safs-test-route\nproxyjump none\n', host), false);
  assert.equal(requiresConfiguredSshProbe('proxyjump gateway\n', host), true);
  assert.equal(requiresConfiguredSshProbe('proxycommand ssh -W %h:%p gateway\n', host), true);
  assert.equal(requiresConfiguredSshProbe('hostname internal.example\n', host), true);
});

test('probes configured routes without credentials or target sessions, including none-auth servers', async t => {
  try { execFileSync('ssh', ['-V'], { stdio: 'ignore' }); }
  catch { t.skip('OpenSSH is unavailable'); return; }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safs configured route '));
  const key = generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const authentications: string[] = [];
  let sessions = 0;
  const clients = new Set<any>();
  const server = new Server({ hostKeys: [key] }, client => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', ctx => { authentications.push(ctx.method); ctx.accept(); });
    client.on('ready', () => client.on('session', (_accept, reject) => { sessions++; reject(); }));
  });
  t.after(async () => {
    for (const client of clients) client.end();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const proxy = path.join(directory, 'proxy.cjs');
  await writeFile(proxy, "const socket=require('net').connect(Number(process.argv[2]),'127.0.0.1'); process.stdin.pipe(socket).pipe(process.stdout); socket.on('close',()=>process.exit()); socket.on('error',()=>process.exit(1));");
  const config = path.join(directory, 'config');
  const quote = (value: string) => '"' + value.replace(/\\/g, '/') + '"';
  // Windows OpenSSH 7.7 cannot CreateProcess a quoted executable path.
  const executable = process.platform === 'win32'
    ? execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${process.execPath}") do @echo %~sI`],
      { encoding: 'utf8', windowsVerbatimArguments: true }).trim()
    : quote(process.execPath);
  const proxyCommand = `${executable} ${quote(proxy)} ${port}`;
  await writeFile(config, `Host safs-test-route\n HostName unreachable.invalid\n ProxyCommand ${proxyCommand}\n`);
  const kind = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  const result = await probeConfiguredSshHostKey(host, kind, undefined, config);
  assert.equal(await systemSshUsesConfiguredRoute(host, kind, config), true);
  assert.equal(result.probed, true, result.error);
  assert.equal(result.keys?.length, 1);
  assert.match(result.fingerprints[0], /^SHA256:/);
  assert.ok(authentications.every(method => method === 'none'));
  assert.equal(sessions, 0);

  // Windows 7.7's implicit ProxyJump subprocess cannot locate ssh.exe.
  // ProxyCommand above still exercises the probe on that actual old client.
  if (isLegacyWindowsSsh()) {
    t.diagnostic('Skipping implicit ProxyJump fixture on Windows OpenSSH 7.7; ProxyCommand probe passed');
    return;
  }

  let forwarded = false;
  const jump = new Server({ hostKeys: [key] }, client => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', ctx => ctx.accept());
    client.on('ready', () => client.on('tcpip', (accept, _reject, request) => {
      assert.equal(request.destIP, '127.0.0.1');
      assert.equal(request.destPort, port);
      forwarded = true;
      const stream = accept();
      const socket = connect(port, '127.0.0.1');
      stream.pipe(socket).pipe(stream);
      socket.on('error', () => stream.destroy());
      stream.on('close', () => socket.destroy());
    }));
  });
  await new Promise<void>(resolve => jump.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => jump.close(() => resolve())));
  const jumpPort = (jump.address() as { port: number }).port;
  // OpenSSH builds its implicit jump command without quoting a custom -F path.
  // Keep that fixture path plain; ProxyCommand above covers quoted paths.
  const jumpDirectory = await mkdtemp(path.join(os.tmpdir(), 'safs-jump-'));
  t.after(() => rm(jumpDirectory, { recursive: true, force: true }));
  const jumpConfig = path.join(jumpDirectory, 'config');
  await writeFile(jumpConfig, `Host safs-test-route\n HostName 127.0.0.1\n ProxyJump safs-test-jump\nHost safs-test-jump\n HostName 127.0.0.1\n Port ${jumpPort}\n User alice\n StrictHostKeyChecking no\n UserKnownHostsFile ${process.platform === 'win32' ? 'NUL' : '/dev/null'}\n`);
  const viaJump = await probeConfiguredSshHostKey({ ...host, port }, kind, undefined, jumpConfig);
  assert.equal(await systemSshUsesConfiguredRoute({ ...host, port }, kind, jumpConfig), true);
  assert.equal(viaJump.probed, true, viaJump.error);
  assert.equal(forwarded, true);
  assert.deepEqual(viaJump.fingerprints, result.fingerprints);
  assert.ok(authentications.every(method => method === 'none'));
  assert.equal(sessions, 0);
});

test('OpenSSH applies Include and Match authentication settings, while malformed config remains an error', async t => {
  try { execFileSync('ssh', ['-V'], { stdio: 'ignore' }); }
  catch { t.skip('OpenSSH is unavailable'); return; }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safs-config-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const include = path.join(directory, 'identities');
  const config = path.join(directory, 'config');
  const target = { name: 'dev', ip: '127.0.0.1', user: 'alice', password: 'secret' };
  const kind = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  await writeFile(include, 'Host 127.0.0.1\n IdentityFile /keys/one\n IdentityFile /keys/two\n CertificateFile /keys/user-cert.pub\n');
  // Older Windows OpenSSH interprets drive-letter Include paths as relative.
  // Keep Match/malformed-config coverage there; newer clients also test Include.
  if (!isLegacyWindowsSsh()) {
    await writeFile(config, `Include "${include.replace(/\\/g, '/')}"\n`);
    assert.equal(await systemSshUsesConfiguredRoute(target, kind, config), true);
  }
  await writeFile(config, 'Match host 127.0.0.1\n IdentitiesOnly yes\n');
  assert.equal(await systemSshUsesConfiguredRoute(target, kind, config), true);
  await writeFile(config, 'Host *\n ThisIsNotAnSshDirective yes\n');
  await assert.rejects(systemSshUsesConfiguredRoute(target, kind, config), /无法读取系统 SSH 配置/);
});
