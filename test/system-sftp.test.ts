import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Server } from 'ssh2';
import { createPlatformAdapter } from '../src/platform';
import { executeCaptured } from '../src/process';
import { connectSystemSftp } from '../src/sftp/system-sftp';

test('system OpenSSH runs a real SFTP subsystem through a configured proxy without exec or SCP', { timeout: 20000 }, async t => {
  try { execFileSync('ssh', ['-V'], { stdio: 'ignore' }); }
  catch { t.skip('OpenSSH unavailable'); return; }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safs-system-sftp-'));
  const key = generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const clients = new Set<any>();
  let subsystem = false, exec = false, rejectSubsystem = false, allowExec = false;
  let content = Buffer.from('remote content');
  const server = new Server({ hostKeys: [key] }, client => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', ctx => ctx.accept());
    client.on('ready', () => client.on('session', accept => {
      const channel = accept();
      channel.on('exec', (accept, reject, info) => {
        exec = true;
        if (!allowExec) { reject(); return; }
        assert.match(info.command, /requested-command/);
        const stream = accept(); stream.write('executed-once'); stream.exit(7); stream.end();
      });
      channel.on('sftp', (accept, reject) => {
        if (rejectSubsystem) { reject(); return; }
        subsystem = true;
        const sftp = accept();
        sftp.on('REALPATH', id => sftp.name(id, [{ filename: '/home/alice', longname: '', attrs: {} }]));
        const attrs = () => ({ mode: 0o100644, size: content.length, uid: 1000, gid: 1000, atime: 1, mtime: 1 });
        sftp.on('STAT', id => sftp.attrs(id, attrs()));
        sftp.on('LSTAT', id => sftp.attrs(id, attrs()));
        sftp.on('FSTAT', id => sftp.attrs(id, attrs()));
        sftp.on('OPEN', (id, _path, flags) => { if (flags & 16) content = Buffer.alloc(0); sftp.handle(id, Buffer.from('h')); });
        sftp.on('READ', (id, _handle, offset, length) => {
          if (offset >= content.length) sftp.status(id, 1);
          else sftp.data(id, content.subarray(offset, offset + length));
        });
        sftp.on('WRITE', (id, _handle, offset, data) => {
          if (offset + data.length > content.length) content = Buffer.concat([content, Buffer.alloc(offset + data.length - content.length)]);
          data.copy(content, offset); sftp.status(id, 0);
        });
        let listed = false;
        sftp.on('OPENDIR', id => { listed = false; sftp.handle(id, Buffer.from('d')); });
        sftp.on('READDIR', id => {
          if (listed) { sftp.status(id, 1); return; }
          listed = true;
          sftp.name(id, ['good.txt', 'nested', '\\home\\share\\test_app\\build', '../escape', '/absolute'].map(filename => ({
            filename, longname: '', attrs: attrs()
          })));
        });
        sftp.on('CLOSE', id => sftp.status(id, 0));
      });
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const client of clients) client.end();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const port = (server.address() as { port: number }).port;
  const proxy = path.join(directory, 'proxy.cjs');
  await writeFile(proxy, "const socket=require('net').connect(Number(process.argv[2]),'127.0.0.1');process.stdin.pipe(socket).pipe(process.stdout);socket.on('close',()=>process.exit());socket.on('error',()=>process.exit(1));");
  const config = path.join(directory, 'config');
  const quote = (value: string) => '"' + value.replace(/\\/g, '/') + '"';
  // Windows OpenSSH 7.7 cannot launch a quoted ProxyCommand executable path.
  const executable = process.platform === 'win32'
    ? execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${process.execPath}") do @echo %~sI`],
      { encoding: 'utf8', windowsVerbatimArguments: true }).trim()
    : quote(process.execPath);
  await writeFile(config, `Host safs-sftp-test\n HostName unreachable.invalid\n RemoteCommand echo configured-shell\n RequestTTY force\n StdinNull yes\n SessionType none\n ProxyCommand ${executable} ${quote(proxy)} ${port}\n StrictHostKeyChecking no\n UserKnownHostsFile ${process.platform === 'win32' ? 'NUL' : '/dev/null'}\n`);
  const base = createPlatformAdapter(process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux');
  const adapter = { ...base, kind: base.kind, exec: (...args: Parameters<typeof base.exec>) => {
    const plan = base.exec(...args); plan.args.unshift('-F', config); return plan;
  }, terminal: (...args: Parameters<typeof base.terminal>) => {
    const plan = base.terminal(...args); plan.args.unshift('-F', config); return plan;
  } };
  const session = await connectSystemSftp({ name: 'dev', ip: 'safs-sftp-test', user: 'alice', port }, adapter,
    { respectSshConfig: true, reuseSshConnection: false, hostKeyPolicy: 'accept' });
  t.after(() => session.close());
  assert.equal(session.transport, 'sftp');
  assert.equal(await session.realpath('.'), '/home/alice');
  assert.deepEqual((await session.readDirectory('.')).map(entry => entry.name), ['good.txt', 'nested']);
  const upload = Buffer.alloc(256 * 1024, 65);
  await session.writeFile('/file', upload, { create: true, overwrite: true });
  assert.deepEqual(await session.readFile('/file'), upload);
  assert.equal(subsystem, true);
  assert.equal(exec, false);
  await session.close();
  assert.equal(session.isAlive(), false);
  allowExec = true;
  const commandResult = await executeCaptured(adapter.exec({ name: 'dev', ip: 'safs-sftp-test', user: 'alice', port },
    '/', 'requested-command', { respectSshConfig: true, reuseSshConnection: false, hostKeyPolicy: 'accept' }));
  assert.equal(commandResult.exitCode, 7);
  assert.equal(commandResult.stdout, 'executed-once');
  exec = false;
  rejectSubsystem = true;
  await assert.rejects(connectSystemSftp({ name: 'dev', ip: 'safs-sftp-test', user: 'alice', port }, adapter,
    { respectSshConfig: true, reuseSshConnection: false, hostKeyPolicy: 'accept' }), /subsystem request failed/i);
  assert.equal(exec, false);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(connectSystemSftp({ name: 'dev', ip: 'safs-sftp-test', user: 'alice', port }, adapter,
    { respectSshConfig: true }, controller.signal), /cancelled/);
});
