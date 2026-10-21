import { execFile } from 'node:child_process';
import { watchFile, unwatchFile } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import { applyEdits, modify } from 'jsonc-parser';
import { HostConfig, parseConfig } from './config';
import { resolveExecutable } from './process';

const execFileAsync = promisify(execFile);
export interface SshImportEntry {
  alias: string; user: string; port: number;
  hostname?: string;
  identityFile?: string;
  /** Ephemeral routing identity; never written into the user's configuration. */
  route?: string;
}

function normalizedAddress(address: string): string {
  const raw = address.replace(/^\[|\]$/g, '');
  const scope = raw.indexOf('%');
  const zone = scope >= 0 ? raw.slice(scope) : '';
  const value = (scope >= 0 ? raw.slice(0, scope) : raw).toLowerCase().replace(/\.$/, '');
  if (isIP(value) === 6) return new URL(`http://[${value}]/`).hostname.replace(/^\[|\]$/g, '') + zone;
  return value + zone;
}

function accountKey(address: string, user: string, port: number): string {
  return JSON.stringify([normalizedAddress(address), user, port]);
}

function endpointKey(entry: SshImportEntry): string | undefined {
  if (!entry.hostname || entry.route === undefined) return undefined;
  return JSON.stringify([normalizedAddress(entry.hostname), entry.port, entry.user, entry.route]);
}

/** Only enumerate literal Host names; OpenSSH evaluates their actual settings. */
function tokens(line: string): string[] {
  const result: string[] = [];
  let value = '', quoted = false, escaped = false;
  for (const character of line) {
    if (escaped) { value += character; escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (!quoted && character === '#') break;
    if (!quoted && /\s/.test(character)) {
      if (value) { result.push(value); value = ''; }
    } else value += character;
  }
  if (value) result.push(value);
  return result;
}

function globExpression(pattern: string): RegExp {
  let expression = '';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === '*') expression += '.*';
    else if (character === '?') expression += '.';
    else if (character === '[' && pattern.indexOf(']', index + 1) >= 0) {
      const end = pattern.indexOf(']', index + 1);
      expression += '[' + pattern.slice(index + 1, end).replace(/^!/, '^') + ']';
      index = end;
    } else expression += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + expression + '$');
}

export async function discoverSshAliases(root: string): Promise<{ aliases: string[]; paths: Set<string> }> {
  const aliases = new Set<string>();
  const paths = new Set<string>([root]);
  const visited = new Set<string>();
  const sshDirectory = path.dirname(root);
  async function expand(pattern: string): Promise<string[]> {
    let missingEnvironment = false;
    pattern = pattern.replace(/\$\{([^}]+)\}/g, (_match, name: string) => {
      if (process.env[name] === undefined) missingEnvironment = true;
      return process.env[name] ?? '';
    });
    if (missingEnvironment) return [];
    if (pattern.startsWith('~/')) pattern = path.join(os.homedir(), pattern.slice(2));
    if (pattern.startsWith('~')) return [];
    const absolute = path.resolve(sshDirectory, pattern);
    const parsed = path.parse(absolute);
    let parents = [parsed.root];
    for (const part of absolute.slice(parsed.root.length).split(path.sep)) {
      const next: string[] = [];
      for (const parent of parents) {
        if (!/[*?\[]/.test(part)) { next.push(path.join(parent, part)); continue; }
        paths.add(parent);
        let names: string[];
        try { names = await readdir(parent); }
        catch (error) {
          if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
          throw error;
        }
        const expression = globExpression(part);
        next.push(...names.sort().filter(name => (!name.startsWith('.') || part.startsWith('.')) && expression.test(name)).map(name => path.join(parent, name)));
      }
      parents = next;
    }
    return parents;
  }
  async function visit(file: string, depth: number): Promise<void> {
    file = path.resolve(file);
    paths.add(file);
    if (visited.has(file)) return;
    if (depth > 16 || visited.size >= 512) throw new Error('SSH Include 配置过深或文件过多');
    visited.add(file);
    let text: string;
    try { text = await readFile(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const line of text.split(/\r?\n/)) {
      const [directive, ...arguments_] = tokens(line.replace(/^(\s*[A-Za-z]+)\s*=\s*/, '$1 '));
      if (directive?.toLowerCase() === 'host') {
        for (const alias of arguments_) {
          if (alias && !/^[-!]/.test(alias) && !/[\s*?\[\]]/.test(alias)) aliases.add(alias);
        }
      } else if (directive?.toLowerCase() === 'include') {
        for (const pattern of arguments_) for (const included of await expand(pattern)) await visit(included, depth + 1);
      }
    }
  }
  await visit(root, 0);
  return { aliases: [...aliases], paths };
}

export async function resolveSshImportEntry(
  alias: string, configFile?: string, overrides?: Pick<HostConfig, 'user' | 'port'>
): Promise<SshImportEntry> {
  const ssh = await resolveExecutable('ssh');
  const targetArgs = [
    ...(overrides ? ['-l', overrides.user, '-p', String(overrides.port ?? 22),
      ...(isIP(alias) ? ['-o', `HostName=${alias}`] : [])] : []), '--', alias
  ];
  const [{ stdout }, { stdout: defaults }] = await Promise.all([
    execFileAsync(ssh, ['-G', ...(configFile ? ['-F', configFile] : []), ...targetArgs],
      { timeout: 5000, windowsHide: true }),
    execFileAsync(ssh, [
      '-G', '-F', process.platform === 'win32' ? 'NUL' : '/dev/null', ...targetArgs
    ], { timeout: 5000, windowsHide: true })
  ]);
  const value = (name: string) => new RegExp('^' + name + '\\s+(.+)$', 'm').exec(stdout)?.[1].trim();
  const values = (text: string, name: string) => [...text.matchAll(
    new RegExp('^' + name + '\\s+(.+)$', 'gm')
  )].map(match => match[1].trim());
  const user = value('user');
  const port = Number(value('port'));
  if (!user || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`SSH 配置 ${alias} 的账号或端口无效`);
  const hostname = value('hostname');
  if (!hostname) throw new Error(`SSH 配置 ${alias} 的目标主机无效`);
  const jump = value('proxyjump');
  const command = value('proxycommand');
  const proxyJump = jump && jump !== 'none' ? jump : '';
  const proxyCommand = command && command !== 'none' ? command : '';
  const configuredIdentities = values(stdout, 'identityfile');
  const defaultIdentities = values(defaults, 'identityfile');
  const identityFile = JSON.stringify(configuredIdentities) === JSON.stringify(defaultIdentities)
    ? undefined : configuredIdentities.find(candidate => candidate.toLowerCase() !== 'none');
  // %n and other alias-dependent tokens may deliberately select a different route.
  const aliasScoped = /%(?![hpr])[A-Za-z]/.test((proxyCommand + proxyJump).replace(/%%/g, '')) ? alias : '';
  return {
    alias, user, port, hostname,
    ...(identityFile ? { identityFile } : {}),
    route: JSON.stringify([proxyJump, proxyCommand, aliasScoped])
  };
}

export function appendSshImportEntries(
  text: string, entries: SshImportEntry[], resolvedExisting: SshImportEntry[] = []
): { text: string; added: string[] } {
  try { parseConfig(JSON.parse(text)); }
  catch { throw new Error('SAFS 配置无效，自动导入未修改现有文件'); }
  const added: string[] = [];
  const endpoints = new Map<string, SshImportEntry>();
  for (const entry of [...entries, ...resolvedExisting]) endpoints.set(accountKey(entry.alias, entry.user, entry.port), entry);
  for (const entry of entries) {
    const raw = JSON.parse(text);
    const parsed = parseConfig(raw);
    const matching = parsed.hosts.filter(host => normalizedAddress(host.ip) === normalizedAddress(entry.alias));
    // Existing accounts win, including credentials, ports and manual overrides.
    if (matching.some(host => host.user === entry.user)) continue;
    const target = endpointKey(entry);
    if (target && parsed.hosts.some(host => {
      if (host.vpn) return false;
      const resolved = endpoints.get(accountKey(host.ip, host.user, host.port ?? 22));
      return resolved && endpointKey(resolved) === target;
    })) continue;
    const index = raw.hosts.findIndex((host: { ip?: string; name?: string; accounts?: unknown[] }) =>
      Array.isArray(host.accounts) && host.ip?.toLowerCase() === entry.alias.toLowerCase());
    const account = {
      user: entry.user, port: entry.port, source: 'ssh-config',
      ...(entry.identityFile ? { private_key_path: entry.identityFile } : {})
    };
    const placeholder = index < 0 ? -1 : raw.hosts[index].accounts.findIndex(
      (candidate: { user?: string }) => !candidate.user?.trim());
    const location = index < 0 ? ['hosts', -1] : ['hosts', index, 'accounts', placeholder];
    let label = entry.alias;
    let suffix = 1;
    if (index < 0) {
      while (raw.hosts.some((host: { name?: string }) => host.name === label)
        || parsed.hosts.some(host => host.name === `${label}(${entry.user})`)) {
        label = `${entry.alias} [SSH${suffix === 1 ? '' : ' ' + suffix}]`;
        suffix++;
      }
    }
    const value = index < 0 ? { name: label, ip: entry.alias, accounts: [account] } : account;
    const next = applyEdits(text, modify(text, location, value, {
      isArrayInsertion: placeholder < 0, formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' }
    }));
    try { parseConfig(JSON.parse(next)); } catch { continue; }
    text = next;
    added.push(entry.alias);
  }
  return { text, added };
}

/** Cross-window importer lock; re-read the target immediately before appending. */
export async function appendSshImports(
  file: string, entries: SshImportEntry[], canWrite = () => true,
  resolveExisting: (host: HostConfig) => Promise<SshImportEntry> = host => resolveSshImportEntry(host.ip, undefined, host)
): Promise<string[]> {
  if (!entries.length || !canWrite()) return [];
  const resolvedExisting: SshImportEntry[] = [];
  const inspected = new Set<string>();
  const inspectExisting = async (text: string | undefined) => {
    if (text === undefined || !entries.some(entry => endpointKey(entry))) return;
    let hosts: HostConfig[];
    try { hosts = parseConfig(JSON.parse(text)).hosts; }
    catch { throw new Error('SAFS 配置无效，自动导入未修改现有文件'); }
    for (const host of hosts) {
      if (host.vpn || !entries.some(entry => entry.user === host.user && entry.port === (host.port ?? 22))) continue;
      const key = accountKey(host.ip, host.user, host.port ?? 22);
      if (inspected.has(key)) continue;
      inspected.add(key);
      try { resolvedExisting.push(await resolveExisting(host)); }
      catch { /* An unknown route must never cause two distinct connections to be merged. */ }
    }
  };
  const readTarget = () => readFile(file, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  });
  // Resolve outside the write lock; re-check any accounts added meanwhile after locking.
  await inspectExisting(await readTarget());
  await mkdir(path.dirname(file), { recursive: true });
  const lock = `${file}.ssh-import.lock`;
  let acquired = false;
  for (let attempt = 0; attempt < 40 && !acquired; attempt++) {
    try { await mkdir(lock, { mode: 0o700 }); acquired = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await stat(lock).catch(statError => {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
        return undefined;
      });
      if (!existing) continue;
      if (Date.now() - existing.mtimeMs > 120_000) await rm(lock, { recursive: true, force: true });
      else await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  if (!acquired) throw new Error('另一个 SAFS 窗口正在导入 SSH 配置，请稍后重试');
  let temporary: string | undefined;
  try {
    const previous = await readFile(file, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return undefined;
    });
    await inspectExisting(previous);
    const result = appendSshImportEntries(previous ?? '{"encrypt_passwords":true,"hosts":[]}', entries, resolvedExisting);
    if (!result.added.length) return [];
    temporary = await mkdtemp(path.join(path.dirname(file), '.ssh-import-'));
    const payload = path.join(temporary, 'config.json');
    await writeFile(payload, result.text, { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      // Windows readers and scanners can briefly prevent atomic replacement.
      // Recheck edits and disposal before every retry; never delete the target
      // or replace it with a stale snapshot just to work around a sharing lock.
      if (await readTarget() !== previous) throw new Error('SAFS 配置在导入期间发生变化，本轮未写入');
      if (!canWrite()) return [];
      try {
        await rename(payload, file);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== 'win32' || attempt >= 5
          || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw error;
        await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
    return result.added;
  } finally {
    try { if (temporary) await rm(temporary, { recursive: true, force: true }); }
    finally { await rm(lock, { recursive: true, force: true }); }
  }
}

export function startSshConfigImport(options: {
  root: string; target: string; log(message: string): void;
  changed(): Promise<void>; canWrite?(): boolean;
  resolve?(alias: string): Promise<SshImportEntry>;
}): { dispose(): void; refresh(): void; resume(): void } {
  const watched = new Map<string, () => void>();
  let disposed = false, running = false, pending = false, deferred = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void scan(), 250);
    timer.unref?.();
  };
  const watch = (paths: Set<string>) => {
    for (const [file, listener] of watched) if (!paths.has(file)) { unwatchFile(file, listener); watched.delete(file); }
    for (const file of paths) if (!watched.has(file)) {
      const listener = () => schedule();
      watchFile(file, { persistent: false, interval: 1500 }, listener);
      watched.set(file, listener);
    }
  };
  async function scan(): Promise<void> {
    if (disposed) return;
    if (running) { pending = true; return; }
    running = true;
    try {
      const discovered = await discoverSshAliases(options.root);
      watch(discovered.paths);
      const entries: SshImportEntry[] = [];
      for (const alias of discovered.aliases) {
        if (disposed) return;
        try { entries.push(await (options.resolve ?? resolveSshImportEntry)(alias)); }
        catch (error) { options.log(`跳过 SSH 配置 ${alias}：${error instanceof Error ? error.message : String(error)}`); }
      }
      if (disposed) return;
      if (options.canWrite?.() === false) { deferred = true; return; }
      deferred = false;
      const added = await appendSshImports(options.target, entries, () => !disposed && options.canWrite?.() !== false);
      if (options.canWrite?.() === false) deferred = true;
      if (added.length) {
        options.log(`已追加 ${added.length} 个 SSH 账号：${added.join('、')}`);
        await options.changed();
      }
    } catch (error) {
      deferred = true;
      options.log(`自动导入 SSH 配置失败：${error instanceof Error ? error.message : String(error)}`);
    }
    finally { running = false; if (pending && !disposed) { pending = false; schedule(); } }
  }
  watch(new Set([options.root]));
  void scan();
  return { refresh: schedule, resume() { if (deferred) schedule(); }, dispose() {
    disposed = true;
    if (timer) clearTimeout(timer);
    for (const [file, listener] of watched) unwatchFile(file, listener);
    watched.clear();
  } };
}

/** Remove literal aliases only; wildcard defaults and other aliases remain intact. */
export function removeSshAliasBlocks(text: string, alias: string): string {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const directive = (line: string) => tokens(line.replace(/^(\s*[A-Za-z]+)\s*=\s*/, '$1 '));
  for (let index = lines.length - 1; index >= 0; index--) {
    const [key, ...names] = directive(lines[index]);
    if (key?.toLowerCase() !== 'host' || !names.some(name => name.toLowerCase() === alias.toLowerCase())) continue;
    const remaining = names.filter(name => name.toLowerCase() !== alias.toLowerCase());
    if (remaining.some(name => !name.startsWith('!'))) {
      const comment = lines[index].match(/\s+#.*?(?=\r?\n|$)/)?.[0] ?? '';
      const eol = lines[index].endsWith('\r\n') ? '\r\n' : lines[index].endsWith('\n') ? '\n' : '';
      lines[index] = (lines[index].match(/^\s*/)?.[0] ?? '') + 'Host ' + remaining.map(name => JSON.stringify(name)).join(' ') + comment + eol;
      continue;
    }
    let end = index + 1;
    while (end < lines.length && !['host', 'match'].includes(directive(lines[end])[0]?.toLowerCase())) end++;
    // Include may define unrelated aliases. Do not remove their entry point.
    if (lines.slice(index + 1, end).some(line => directive(line)[0]?.toLowerCase() === 'include')) {
      throw new Error('该 Host 条目包含 Include，请在 SSH 配置中手动删除，避免影响其他主机。');
    }
    lines.splice(index, end - index);
  }
  return lines.join('');
}

export async function deleteSshConfigAliases(root: string, aliases: string[], canWrite: (file: string) => boolean = () => true): Promise<string[]> {
  const discovered = await discoverSshAliases(root);
  const changes: { file: string; original: string; next: string }[] = [];
  for (const file of discovered.paths) {
    let original: string;
    try { if (!(await stat(file)).isFile()) continue; original = await readFile(file, 'utf8'); }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue; throw error; }
    const next = aliases.reduce((text, alias) => removeSshAliasBlocks(text, alias), original);
    if (next !== original) {
      if (!canWrite(file)) throw new Error(`SSH 配置有未保存的修改：${file}`);
      changes.push({ file, original, next });
    }
  }
  for (const { file, original } of changes) {
    if (await readFile(file, 'utf8') !== original || !canWrite(file)) throw new Error(`SSH 配置已变化，请重试：${file}`);
  }
  const backups: string[] = [];
  for (const { file, original, next } of changes) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'safs-ssh-config-backup-'));
    const backup = path.join(directory, path.basename(file));
    await writeFile(backup, original, { mode: 0o600, flag: 'wx' });
    backups.push(backup);
    await writeFile(file, next, 'utf8');
  }
  return backups;
}
