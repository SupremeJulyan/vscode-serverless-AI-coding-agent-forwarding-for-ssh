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
import { createPlatformAdapter } from '../src/platform';
import { executeCaptured } from '../src/process';
import { setKnownHostsFilePath } from '../src/host-key';
import { probeConfiguredSshHostKey, requiresConfiguredSshProbe, verifySystemSshHostKey } from '../src/system-ssh-host-key';

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
  assert.equal(result.probed, true, result.error);
  assert.equal(result.keys?.length, 1);
  assert.match(result.fingerprints[0], /^SHA256:/);
  assert.ok(authentications.every(method => method === 'none'));
  assert.equal(sessions, 0);

  await writeFile(config, `Match host safs-test-route\n ProxyCommand ${proxyCommand}\n`);
  const viaMatch = await probeConfiguredSshHostKey(host, kind, undefined, config);
  assert.equal(viaMatch.probed, true, viaMatch.error);
  assert.deepEqual(viaMatch.fingerprints, result.fingerprints);

  // OpenSSH lowercases HostKeyAlias before writing known_hosts. Repeated
  // sequential connections must recognize that entry even for mixed-case aliases.
  for (const identityPort of [22, 2222]) {
    const mixedCaseHost = { ...host, ip: 'SAFS-Test-Route', port: identityPort };
    setKnownHostsFilePath(path.join(directory, `trusted-keys-${identityPort}`));
    let confirmations = 0;
    const confirm = async () => { confirmations++; return 'accept' as const; };
    for (let attempt = 0; attempt < 2; attempt++) {
      const verified = await verifySystemSshHostKey(
        'prompt', mixedCaseHost, kind, undefined,
        () => probeConfiguredSshHostKey(mixedCaseHost, kind, undefined, config),
        { firstConnection: confirm, changed: confirm }
      );
      assert.equal(verified.ok, true, verified.reason);
    }
    assert.equal(confirmations, 1, 'sequential connections must reuse the saved trust');
  }

  // Windows 7.7's implicit ProxyJump subprocess cannot locate ssh.exe.
  // ProxyCommand above still exercises the probe on that actual old client.
  if (isLegacyWindowsSsh()) {
    t.diagnostic('Skipping implicit ProxyJump fixture on Windows OpenSSH 7.7; ProxyCommand probe passed');
    return;
  }

  const include = path.join(directory, 'included-config');
  await writeFile(include, `Host safs-test-route\n HostName unreachable.invalid\n ProxyCommand ${proxyCommand}\n`);
  await writeFile(config, `Include ${quote(include)}\n`);
  const viaInclude = await probeConfiguredSshHostKey(host, kind, undefined, config);
  assert.equal(viaInclude.probed, true, viaInclude.error);
  assert.deepEqual(viaInclude.fingerprints, result.fingerprints);

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
  assert.equal(viaJump.probed, true, viaJump.error);
  assert.equal(forwarded, true);
  assert.deepEqual(viaJump.fingerprints, result.fingerprints);
  assert.ok(authentications.every(method => method === 'none'));
  assert.equal(sessions, 0);
});

test('malformed OpenSSH config fails host-key probing instead of bypassing verification', async t => {
  try { execFileSync('ssh', ['-V'], { stdio: 'ignore' }); }
  catch { t.skip('OpenSSH is unavailable'); return; }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safs-config-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = path.join(directory, 'config');
  const target = { name: 'dev', ip: '127.0.0.1', user: 'alice', source: 'ssh-config' as const };
  const kind = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  await writeFile(config, 'Host *\n ThisIsNotAnSshDirective yes\n');
  const result = await probeConfiguredSshHostKey(target, kind, undefined, config);
  assert.equal(result.probed, false);
  assert.match(result.error ?? '', /ThisIsNotAnSshDirective|Bad configuration option/i);
});

test('imported aliases reach rotating backends with one actual connection per command and no SAFS probes', { timeout: 20000 }, async t => {
  try { execFileSync('ssh', ['-V'], { stdio: 'ignore' }); }
  catch { t.skip('OpenSSH is unavailable'); return; }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safs-native-alias-'));
  const clients = new Set<any>();
  const visits: number[] = [];
  const servers = [0, 1].map(index => {
    const key = generateKeyPairSync('rsa', { modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
    return new Server({ hostKeys: [key] }, client => {
      visits.push(index);
      clients.add(client);
      client.on('error', () => {});
      client.on('close', () => clients.delete(client));
      client.on('authentication', ctx => ctx.accept());
      client.on('ready', () => client.on('session', accept => {
        accept().on('exec', accept => {
          const stream = accept();
          stream.write(`backend-${index}`);
          stream.exit(0);
          stream.end();
        });
      }));
    });
  });
  t.after(async () => {
    for (const client of clients) client.end();
    for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  for (const server of servers) await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const ports = servers.map(server => (server.address() as { port: number }).port);
  const counter = path.join(directory, 'counter');
  const proxy = path.join(directory, 'proxy.cjs');
  const config = path.join(directory, 'config');
  await writeFile(counter, '0');
  await writeFile(proxy, `const fs=require('fs');const file=process.argv[2];const n=Number(fs.readFileSync(file,'utf8'));fs.writeFileSync(file,String(n+1));const ports=${JSON.stringify(ports)};const s=require('net').connect(ports[n%2],'127.0.0.1');process.stdin.pipe(s).pipe(process.stdout);s.on('close',()=>process.exit());s.on('error',()=>process.exit(1));`);
  const quote = (value: string) => '"' + value.replace(/\\/g, '/') + '"';
  const executable = process.platform === 'win32'
    ? execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${process.execPath}") do @echo %~sI`],
      { encoding: 'utf8', windowsVerbatimArguments: true }).trim() : quote(process.execPath);
  const nullFile = process.platform === 'win32' ? 'NUL' : '/dev/null';
  await writeFile(config, `Host cluster\n HostName unreachable.invalid\n User alice\n ProxyCommand ${executable} ${quote(proxy)} ${quote(counter)}\n StrictHostKeyChecking no\n UserKnownHostsFile ${nullFile}\n GlobalKnownHostsFile ${nullFile}\n`);
  const imported = { name: 'cluster', ip: 'cluster', user: 'stale', source: 'ssh-config' as const };
  const adapter = createPlatformAdapter(process.platform === 'win32' ? 'windows' : 'macos');
  for (let index = 0; index < 4; index++) {
    const verified = await verifySystemSshHostKey('prompt', imported, adapter.kind, undefined,
      async () => { throw new Error('imported aliases must not pre-probe'); });
    assert.equal(verified.ok, true);
    const plan = adapter.exec(imported, '/', 'hostname');
    plan.args.unshift('-F', config);
    const result = await executeCaptured(plan);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, `backend-${index % 2}`);
  }
  assert.deepEqual(visits, [0, 1, 0, 1]);
});
