import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { parseConfig } from '../src/config';
import {
  appendSshImportEntries, appendSshImports, discoverSshAliases, resolveSshImportEntry, startSshConfigImport
} from '../src/ssh-config-import';

async function fixture(t: any) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safs-ssh-import-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, root: path.join(directory, 'config'), target: path.join(directory, 'safs.json') };
}

test('scans literal aliases, quoted Include globs and recursive includes without importing wildcard rules', async t => {
  const { directory, root } = await fixture(t);
  await mkdir(path.join(directory, 'config files'));
  const included = path.join(directory, 'config files', 'dev.conf');
  await writeFile(root, 'Host alpha beta *.example !excluded\n User alice\nInclude "config files/*.conf"\nHost=gamma # comment\n');
  await writeFile(included, 'Host "delta"\nInclude config\n');
  const result = await discoverSshAliases(root);
  assert.deepEqual(result.aliases, ['alpha', 'beta', 'delta', 'gamma']);
  assert.ok(result.paths.has(included));
  assert.ok(result.paths.has(path.dirname(included)));
});

test('missing SSH configuration is harmless and remains discoverable after creation', async t => {
  const { root } = await fixture(t);
  const result = await discoverSshAliases(root);
  assert.deepEqual(result.aliases, []);
  assert.ok(result.paths.has(root));
});

test('OpenSSH resolves imported user and port while the alias remains the connection address', async t => {
  try { execFileSync('ssh', ['-V'], { stdio: 'ignore' }); }
  catch { t.skip('OpenSSH is unavailable'); return; }
  const { root } = await fixture(t);
  await writeFile(root, 'Host work\n HostName unreachable.internal\n User bob\n Port 2205\n ProxyJump gateway\n IdentityFile /private/one\n IdentityFile /private/two\n');
  const entry = await resolveSshImportEntry('work', root);
  assert.deepEqual(entry, { alias: 'work', user: 'bob', port: 2205,
    hostname: 'unreachable.internal', identityFile: '/private/one',
    route: JSON.stringify(['gateway', '', '']) });
  const result = appendSshImportEntries('{"hosts":[]}', [entry]);
  const imported = JSON.parse(result.text).hosts[0];
  assert.equal(imported.ip, 'work');
  assert.equal(imported.accounts[0].private_key_path, '/private/one');
});

test('deduplicates SSH aliases against existing SAFS IP accounts without changing credentials', () => {
  const text = JSON.stringify({ hosts: [{ name: 'manual', ip: '10.0.0.2', accounts: [
    { user: 'alice', port: 22, password: 'encrypted-existing', connections: [{ name: 'project', remote_path: '/srv' }] }
  ] }] });
  const route = JSON.stringify(['', '', '']);
  const entry = { alias: 'dev', hostname: '10.0.0.2', user: 'alice', port: 22, route };
  const existing = { ...entry, alias: '10.0.0.2' };
  const result = appendSshImportEntries(text, [entry], [existing]);
  assert.deepEqual(result.added, []);
  assert.equal(result.text, text);
});

test('same endpoint aliases merge, but distinct users, ports and proxy routes remain available', () => {
  const route = JSON.stringify(['', '', '']);
  const first = { alias: 'dev', hostname: '10.0.0.2', user: 'alice', port: 22, route };
  const entries = [first, { ...first, alias: 'same-dev' },
    { ...first, alias: 'other-user', user: 'bob' },
    { ...first, alias: 'other-port', port: 2200 },
    { ...first, alias: 'via-jump', route: JSON.stringify(['gateway', '', '']) }];
  const result = appendSshImportEntries('{"hosts":[]}', entries);
  assert.deepEqual(result.added, ['dev', 'other-user', 'other-port', 'via-jump']);
  assert.equal(JSON.parse(result.text).hosts.length, 4);
});

test('normalizes IPv6 endpoint addresses and preserves distinct routes despite matching display names', () => {
  const route = JSON.stringify(['', '', '']);
  const existing = { alias: '2001:db8::1', hostname: '2001:db8::1', user: 'alice', port: 22, route };
  const text = JSON.stringify({ hosts: [{ name: 'dev', ip: existing.alias, accounts: [{ user: 'alice' }] }] });
  assert.equal(appendSshImportEntries(text, [{ ...existing, alias: 'ipv6-dev', hostname: '2001:0db8:0:0:0:0:0:1' }], [existing]).text, text);
  const result = appendSshImportEntries(text, [{ ...existing, alias: 'dev', hostname: '10.0.0.2' }], [existing]);
  assert.deepEqual(result.added, ['dev']);
  const raw = JSON.parse(result.text);
  assert.equal(raw.hosts[0].name, 'dev');
  assert.equal(raw.hosts[1].name, 'dev [SSH]');
  assert.equal(raw.hosts[1].ip, 'dev');
  parseConfig(raw);
});

test('cross-file deduplication uses OpenSSH settings and SAFS account overrides', async t => {
  try { execFileSync('ssh', ['-V'], { stdio: 'ignore' }); }
  catch { t.skip('OpenSSH is unavailable'); return; }
  const { root, target } = await fixture(t);
  const original = JSON.stringify({ hosts: [{ name: 'manual', ip: '10.0.0.2', accounts: [{ user: 'alice', port: 22, password: 'keep' }] }] });
  await writeFile(target, original);
  await writeFile(root, 'Host dev\n HostName 10.0.0.2\n User alice\n Port 22\n');
  const resolveExisting = (host: any) => resolveSshImportEntry(host.ip, root, host);
  let entry = await resolveSshImportEntry('dev', root);
  assert.deepEqual(await appendSshImports(target, [entry], () => true, resolveExisting), []);
  assert.equal(await readFile(target, 'utf8'), original);
  await writeFile(root, 'Host dev\n HostName 10.0.0.2\n User alice\n Port 22\n ProxyJump gateway\n');
  entry = await resolveSshImportEntry('dev', root);
  assert.deepEqual(await appendSshImports(target, [entry], () => true, resolveExisting), ['dev']);
  assert.equal(JSON.parse(await readFile(target, 'utf8')).hosts[0].accounts[0].password, 'keep');
  await writeFile(target, original);
  await writeFile(root, 'Host dev\n HostName 10.0.0.2\nHost *\n User alice\n Port 2200\n');
  entry = await resolveSshImportEntry('dev', root);
  assert.equal(entry.port, 2200);
  assert.deepEqual(await appendSshImports(target, [entry], () => true, resolveExisting), ['dev']);
  assert.equal(JSON.parse(await readFile(target, 'utf8')).hosts[0].accounts[0].port, 22);
});

test('append preserves manual credentials and fields, deduplicates accounts and adds new users', () => {
  const raw = { encrypt_passwords: true, custom: { keep: 'unchanged' }, hosts: [
    { name: 'Production', ip: 'prod', extra: 'keep', accounts: [
      { user: 'alice', port: 2222, password: 'encrypted-test-value', private_key_path: '/old/key', connections: [
        { name: 'manual-project', remote_path: '/srv/project' }
      ] }
    ] }
  ] };
  const existing = JSON.stringify(raw, null, 2);
  const entries = [
    { alias: 'prod', user: 'alice', port: 22 },
    { alias: 'prod', user: 'bob', port: 2200 },
    { alias: 'new-alias', user: 'alice', port: 22 }
  ];
  const result = appendSshImportEntries(existing, entries);
  const saved = JSON.parse(result.text);
  assert.deepEqual(result.added, ['prod', 'new-alias']);
  assert.deepEqual(saved.hosts[0].accounts[0], raw.hosts[0].accounts[0]);
  assert.deepEqual(saved.custom, raw.custom);
  assert.equal(saved.hosts[0].extra, 'keep');
  assert.deepEqual(saved.hosts[0].accounts[1], { user: 'bob', port: 2200, source: 'ssh-config' });
  assert.equal(saved.hosts[1].ip, 'new-alias');
  assert.equal(appendSshImportEntries(result.text, entries).text, result.text);
  parseConfig(saved);
});

test('physical host labels never replace an imported alias route', () => {
  const text = JSON.stringify({ hosts: [{ name: 'route', ip: '10.0.0.2', accounts: [{ user: 'alice' }] }] });
  const result = appendSshImportEntries(text, [{ alias: 'route', user: 'bob', port: 22 }]);
  assert.equal(JSON.parse(result.text).hosts[1].ip, 'route');
});

test('concurrent windows append safely and repeated imports do not rewrite the file', async t => {
  const { target } = await fixture(t);
  const first = { alias: 'alpha', user: 'alice', port: 22 };
  const second = { alias: 'beta', user: 'bob', port: 22 };
  await Promise.all([appendSshImports(target, [first]), appendSshImports(target, [second])]);
  const text = await readFile(target, 'utf8');
  assert.deepEqual(JSON.parse(text).hosts.map((host: any) => host.ip).sort(), ['alpha', 'beta']);
  const previous = await stat(target);
  assert.deepEqual(await appendSshImports(target, [first, second]), []);
  assert.equal((await stat(target)).mtimeMs, previous.mtimeMs);
  if (process.platform !== 'win32') assert.equal(previous.mode & 0o777, 0o600);
});

test('invalid or unsaved target configurations are left intact', async t => {
  const { target } = await fixture(t);
  const entry = { alias: 'alpha', user: 'alice', port: 22 };
  await writeFile(target, '{bad config');
  await assert.rejects(appendSshImports(target, [entry]), /SAFS 配置无效/);
  assert.equal(await readFile(target, 'utf8'), '{bad config');
  await writeFile(target, '{"hosts":[]}');
  assert.deepEqual(await appendSshImports(target, [entry], () => false), []);
  assert.equal(await readFile(target, 'utf8'), '{"hosts":[]}');
});

test('Windows import retries temporary replacement locks and preserves concurrent edits', async t => {
  const { target } = await fixture(t);
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const originalRename = fsPromises.rename;
  const entry = { alias: 'alpha', user: 'alice', port: 22 };
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
  try {
    let attempts = 0;
    t.mock.method(fsPromises, 'rename', async (...args: Parameters<typeof originalRename>) => {
      if (++attempts <= 2) throw Object.assign(new Error('file temporarily open'), {
        code: attempts === 1 ? 'EPERM' : 'EACCES'
      });
      return originalRename(...args);
    });
    await appendSshImports(target, [entry]);
    assert.equal(attempts, 3);
    assert.equal(JSON.parse(await readFile(target, 'utf8')).hosts[0].ip, 'alpha');
    t.mock.restoreAll();

    const edited = '{"hosts":[],"encrypt_passwords":false}';
    t.mock.method(fsPromises, 'rename', async () => {
      await writeFile(target, edited);
      throw Object.assign(new Error('concurrent edit'), { code: 'EBUSY' });
    });
    await assert.rejects(appendSshImports(target, [{ ...entry, alias: 'beta' }]), /配置在导入期间发生变化/);
    assert.equal(await readFile(target, 'utf8'), edited);
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
    t.mock.restoreAll();
  }
});

test('Windows import gives up on persistent replacement errors without changing the target', async t => {
  const { target } = await fixture(t);
  const previous = '{"hosts":[]}';
  await writeFile(target, previous);
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
  let attempts = 0;
  try {
    t.mock.method(fsPromises, 'rename', async () => {
      attempts++;
      throw Object.assign(new Error('access denied'), { code: 'EPERM' });
    });
    await assert.rejects(appendSshImports(target, [{ alias: 'alpha', user: 'alice', port: 22 }]), { code: 'EPERM' });
    assert.equal(attempts, 6);
    assert.equal(await readFile(target, 'utf8'), previous);
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
    t.mock.restoreAll();
  }
});

test('automatic importer discovers new Include files and stops watching on disposal', { timeout: 10_000 }, async t => {
  const { directory, root, target } = await fixture(t);
  const includes = path.join(directory, 'includes');
  await mkdir(includes);
  await writeFile(root, 'Include includes/*.conf\nHost alpha\n');
  const errors: string[] = [];
  const importer = startSshConfigImport({ root, target,
    resolve: async alias => ({ alias, user: 'alice', port: 22 }),
    changed: async () => {}, log: message => errors.push(message)
  });
  t.after(() => importer.dispose());
  const waitForAlias = async (alias: string) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const raw = await readFile(target, 'utf8').catch(() => '{"hosts":[]}');
      if (JSON.parse(raw).hosts.some((host: any) => host.ip === alias)) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail('alias was not imported: ' + alias + '; ' + errors.join('; '));
  };
  await waitForAlias('alpha');
  await writeFile(path.join(includes, 'new.conf'), 'Host beta\n');
  await waitForAlias('beta');
  importer.dispose();
  const previous = await readFile(target, 'utf8');
  await writeFile(root, 'Host gamma\n');
  importer.refresh();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await readFile(target, 'utf8'), previous);
});

test('automatic import resumes after an unsaved SAFS configuration is saved', { timeout: 5000 }, async t => {
  const { root, target } = await fixture(t);
  await writeFile(root, 'Host delayed\n');
  await writeFile(target, '{"hosts":[]}');
  let dirty = true;
  let inspected!: () => void;
  let changed = () => {};
  const firstInspection = new Promise<void>(resolve => { inspected = resolve; });
  const importer = startSshConfigImport({ root, target,
    canWrite: () => !dirty,
    resolve: async alias => { inspected(); return { alias, user: 'alice', port: 22 }; },
    changed: async () => changed(), log: () => {}
  });
  t.after(() => importer.dispose());
  await firstInspection;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await readFile(target, 'utf8'), '{"hosts":[]}');
  dirty = false;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('deferred import did not resume')), 3000);
    changed = () => { clearTimeout(timer); resolve(); };
    importer.resume();
  });
  assert.equal(JSON.parse(await readFile(target, 'utf8')).hosts[0].ip, 'delayed');
});

test('import provenance survives config saving without marking manual accounts', async t => {
  const { target } = await fixture(t);
  const { saveConfig, loadConfig } = await import('../src/config');
  const original = JSON.stringify({ hosts: [{ name: 'dev', ip: 'dev', accounts: [{ user: 'manual' }] }] });
  const result = appendSshImportEntries(original, [{ alias: 'dev', user: 'imported', port: 22 }]);
  const config = parseConfig(JSON.parse(result.text));
  assert.equal(config.hosts.find(host => host.user === 'manual')?.source, undefined);
  assert.equal(config.hosts.find(host => host.user === 'imported')?.source, 'ssh-config');
  await saveConfig(target, config);
  const restored = await loadConfig(target);
  assert.equal(restored.hosts.find(host => host.user === 'imported')?.source, 'ssh-config');
  assert.equal(restored.hosts.find(host => host.user === 'manual')?.source, undefined);
});

test('import fills an empty account placeholder instead of keeping a second empty account', () => {
  const original = JSON.stringify({ hosts: [{ name: 'dev', ip: 'dev', accounts: [{ user: '', port: 2200 }] }] });
  const result = appendSshImportEntries(original, [{ alias: 'dev', user: 'alice', port: 22 }]);
  const config = parseConfig(JSON.parse(result.text));
  assert.deepEqual(config.hosts.map(host => host.user), ['alice']);
  assert.equal(config.hosts[0].source, 'ssh-config');
});

test('manual refresh reimports a removed account without changes to SSH configuration', { timeout: 5000 }, async t => {
  const { root, target } = await fixture(t);
  await writeFile(root, 'Host dev\n');
  let changed = () => {};
  const importer = startSshConfigImport({ root, target,
    resolve: async alias => ({ alias, user: 'alice', port: 22 }),
    changed: async () => changed(), log: () => {}
  });
  t.after(() => importer.dispose());
  const waitForImport = (trigger: () => void) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('refresh did not import')), 2000);
    changed = () => { clearTimeout(timer); resolve(); };
    trigger();
  });
  await waitForImport(() => {});
  await writeFile(target, JSON.stringify({ hosts: [{ name: 'dev', ip: 'dev', accounts: [{ user: '' }] }] }));
  await waitForImport(() => importer.refresh());
  const restored = parseConfig(JSON.parse(await readFile(target, 'utf8')));
  assert.deepEqual(restored.hosts.map(host => host.user), ['alice']);
  assert.equal(await readFile(root, 'utf8'), 'Host dev\n');
});
