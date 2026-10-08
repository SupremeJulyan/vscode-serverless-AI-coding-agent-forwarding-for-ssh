import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { configUniquenessIssues } from './config-uniqueness';

export interface HostConfig {
  name: string;
  ip: string;
  user: string;
  port?: number;
  vpn?: boolean;
  private_key_path?: string;
  password?: string;
}

export interface MountConfig {
  name: string;
  host: string;
  remote_path: string;
  remote_terminal?: 'open';
}

export interface BridgeConfig {
  encrypt_passwords?: boolean;
  hosts: HostConfig[];
  mounts: MountConfig[];
  host_aliases?: Record<string, string>;
}

export function deriveMounts(hosts: HostConfig[]): MountConfig[] {
  return hosts.map((host) => ({
    name: host.name,
    host: host.name,
    remote_path: '.',
    remote_terminal: 'open' as const
  }));
}

export function removeMountConfig(config: BridgeConfig, mountName: string): MountConfig {
  const index = config.mounts.findIndex((candidate) => candidate.name === mountName);
  if (index < 0) throw new Error(`Mount '${mountName}' no longer exists`);
  const [removed] = config.mounts.splice(index, 1);
  if (!config.mounts.some((mount) => mount.host === removed.host)) {
    config.hosts = config.hosts.filter((host) => host.name !== removed.host);
  }
  return removed;
}

export interface ResolvedMount extends MountConfig {
  hostConfig: HostConfig;
}

export interface SshLogin {
  user: string;
  host: string;
}

const configTemplate = {
  encrypt_passwords: true,
  hosts: []
};

const emptyConfig = `${JSON.stringify(configTemplate, null, 2)}\n`;

export function expandHome(value: string): string {
  if (/^[a-zA-Z]:[\\/]?$/.test(value)) {
    return `${value.slice(0, 2).toUpperCase()}\\`;
  }
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function parseSshLogin(value: string): SshLogin | undefined {
  const match = /^([^@\s]+)@(?:\[([^\]]+)\]|([^@\s]+))$/.exec(value.trim());
  if (!match) return undefined;
  return { user: match[1], host: match[2] ?? match[3] };
}

export function parseConfig(value: unknown): BridgeConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Config root must be an object');
  }
  const object = value as Record<string, unknown>;
  if (!Array.isArray(object.hosts)) {
    throw new Error('Config must contain a hosts array');
  }
  const uniquenessIssues = configUniquenessIssues(value);
  if (uniquenessIssues.length) throw new Error(`config.json：${uniquenessIssues[0].message}`);

  if (object.hosts.some(item => item && typeof item === 'object' && 'accounts' in item)) {
    const flatHosts: Record<string, unknown>[] = [];
    const mounts: MountConfig[] = [];
    const accountLocations = new Map<string, string>();
    const aliases = { ...(parseHostAliases(object.host_aliases) ?? {}) };
    for (const [index, item] of object.hosts.entries()) {
      if (item && typeof item === 'object' && !Array.isArray(item) && !('accounts' in item)) {
        const legacy = parseConfig({ hosts: [item],
          ...(Array.isArray(object.mounts) ? { mounts: object.mounts.filter(mount => mount?.host === item.name) } : {}) });
        flatHosts.push(...legacy.hosts.map(host => ({ ...host })));
        mounts.push(...legacy.mounts);
        continue;
      }
      if (!item || typeof item !== 'object' || !Array.isArray(item.accounts)) {
        throw new Error(`hosts[${index}] must contain an accounts array`);
      }
      const ip = requireString(item.ip, `hosts[${index}].ip`);
      const label = requireString(item.name, `hosts[${index}].name`);
      if (label !== ip) aliases[ip] = label;
      const accounts = item.accounts.length ? item.accounts : [{ name: ip, user: '' }];
      for (const [accountIndex, account] of accounts.entries()) {
        if (!account || typeof account !== 'object' || Array.isArray(account)) throw new Error('Invalid account');
        const user = typeof account.user === 'string' ? account.user : '';
        const name = typeof account.name === 'string' && account.name ? account.name : user ? `${/[^\x00-\x7f]/.test(label) ? ip : label}(${user})` : ip;
        const location = `hosts[${index}].accounts[${accountIndex}]`;
        const previous = accountLocations.get(name);
        if (previous) {
          throw new Error(`config.json：${location} 与 ${previous} 的连接标识 '${name}' 冲突（主机 '${label}'，账号 '${user}'）；请修改 hosts 中的主机 name 或删除重复账号。`);
        }
        accountLocations.set(name, location);
        flatHosts.push({ ...account, name, ip, user });
        const connections = account.connections ?? [{ name, remote_path: '.' }];
        if (!Array.isArray(connections)) throw new Error('Invalid account connections');
        for (const connection of connections) {
          if (!connection || typeof connection !== 'object' || Array.isArray(connection)) throw new Error(`Invalid connection for account '${name}'`);
          mounts.push({
          name: requireString(connection.name, 'connection.name'), host: name,
          remote_path: requireString(connection.remote_path, 'connection.remote_path'), remote_terminal: 'open'
          });
        }
      }
    }
    return parseConfig({ ...object, hosts: flatHosts, mounts, host_aliases: aliases });
  }

  const generatedNames = new Map<string, number>();
  const hosts = object.hosts.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`hosts[${index}] must be an object`);
    }
    const host = item as Record<string, unknown>;
    const ip = requireString(host.ip, `hosts[${index}].ip`);
    const explicitName = typeof host.name === 'string' && host.name.trim().length > 0;
    const baseName = explicitName
      ? requireString(host.name, `hosts[${index}].name`)
      : ip;
    const generatedCount = generatedNames.get(baseName) ?? 0;
    generatedNames.set(baseName, generatedCount + 1);
    const name = explicitName || generatedCount === 0
      ? baseName
      : `${baseName}#${generatedCount + 1}`;
    // The host can be created from the Remote Folders '+' action before its
    // login credentials are filled in from the hierarchical view.
    const user = typeof host.user === 'string' ? host.user : '';
    return { name, ip, user, port: host.port, vpn: host.vpn, private_key_path: host.private_key_path, password: host.password } as HostConfig;
  });

  const hostNames = new Set<string>();
  for (const host of hosts) {
    if (hostNames.has(host.name)) {
      throw new Error(`Duplicate host name '${host.name}'`);
    }
    hostNames.add(host.name);
  }

  // 旧配置兼容：如果 mounts 数组存在则使用，否则从 hosts 派生
  const mounts: MountConfig[] = Array.isArray(object.mounts)
    ? object.mounts.map((item, index) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw new Error(`mounts[${index}] must be an object`);
        }
        const mount = item as Record<string, unknown>;
        return {
          name: requireString(mount.name, `mounts[${index}].name`),
          host: requireString(mount.host, `mounts[${index}].host`),
          remote_path: requireString(mount.remote_path, `mounts[${index}].remote_path`),
          remote_terminal: 'open'
        } as MountConfig;
      })
    : deriveMounts(hosts);

  const names = new Set(hosts.map((host) => host.name));
  for (const mount of mounts) {
    if (!names.has(mount.host)) {
      throw new Error(`Mount '${mount.name}' references missing host '${mount.host}'`);
    }
  }
  const hostAliases = parseHostAliases(object.host_aliases);
  return {
    encrypt_passwords: object.encrypt_passwords === false ? false : true,
    hosts,
    mounts,
    ...(hostAliases ? { host_aliases: hostAliases } : {})
  };
}

function parseHostAliases(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('host_aliases must be an object');
  }
  const aliases: Record<string, string> = {};
  for (const [ip, alias] of Object.entries(value)) {
    if (typeof alias !== 'string' || alias.trim().length === 0) {
      throw new Error(`host_aliases[${ip}] must be a non-empty string`);
    }
    aliases[ip] = alias.trim();
  }
  return Object.keys(aliases).length > 0 ? aliases : undefined;
}

export async function loadConfig(configPath: string): Promise<BridgeConfig> {
  const content = await fs.readFile(expandHome(configPath), 'utf8');
  const raw = JSON.parse(content) as Record<string, unknown>;
  const config = parseConfig(raw);
  if (Array.isArray(raw.hosts) && raw.hosts.some(host => !host || typeof host !== 'object' || !('accounts' in host))) {
    const backup = `${expandHome(configPath)}.legacy.bak`;
    await fs.copyFile(expandHome(configPath), backup, 1).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    await fs.chmod(backup, 0o600);
    await saveConfig(configPath, config, true);
  }
  return config;
}

export async function ensureConfigFile(configPath: string): Promise<string> {
  const resolvedPath = expandHome(configPath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  try {
    // 初始配置文件可能含主机密码，创建时即收紧为仅当前用户可读写。
    await fs.writeFile(resolvedPath, emptyConfig, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw error;
    }
  }
  return resolvedPath;
}

export async function saveConfig(configPath: string, config: BridgeConfig, preserveLegacyNames = false): Promise<void> {
  const resolvedPath = expandHome(configPath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(resolvedPath),
    `.config-${process.pid}-${Date.now()}.json`
  );
  try {
    const groups = new Map<string, { name: string; ip: string; accounts: Record<string, unknown>[] }>();
    for (const host of config.hosts) {
      let group = groups.get(host.ip);
      if (!group) {
        group = { name: config.host_aliases?.[host.ip] ?? host.ip, ip: host.ip, accounts: [] };
        groups.set(host.ip, group);
      }
      const { ip: _ip, name: _name, ...account } = host;
      const connections = config.mounts.filter(mount => mount.host === host.name);
      group.accounts.push({
        ...account,
        ...(preserveLegacyNames ? { name: host.name } : {}),
        ...(connections.length === 1 && connections[0].name === host.name && connections[0].remote_path === '.'
          ? {} : { connections: connections.map(({ name, remote_path }) => ({ name, remote_path })) })
      });
    }
    const saved = { encrypt_passwords: config.encrypt_passwords !== false, hosts: [...groups.values()] };
    // Validate the serialized identifiers before replacing the existing file.
    parseConfig(saved);
    await fs.writeFile(temporaryPath, `${JSON.stringify(saved, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporaryPath, resolvedPath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

export function resolveMount(config: BridgeConfig, mount: MountConfig): ResolvedMount {
  const hostConfig = config.hosts.find((host) => host.name === mount.host);
  if (!hostConfig) {
    throw new Error(`Mount '${mount.name}' references missing host '${mount.host}'`);
  }
  return { ...mount, hostConfig };
}
