import type { BridgeConfig, HostConfig } from './config';

function identity(host: HostConfig): string {
  return JSON.stringify([host.ip.toLowerCase(), host.port ?? 22, host.user]);
}
function connection(host: HostConfig): string {
  return JSON.stringify([identity(host), host.vpn ?? false,
    host.auth ?? (host.private_key_path ? 'publickey' : 'password'), host.private_key_path ?? '']);
}

export function configChanges(previous: BridgeConfig | undefined, next: BridgeConfig) {
  const renamed = new Map<string, string>();
  const invalidated: HostConfig[] = [];
  for (const before of previous?.hosts ?? []) {
    const after = next.hosts.find(host => identity(host) === identity(before))
      ?? next.hosts.find(host => host.name === before.name);
    // Selecting the first key writes its path during the very handshake that
    // requested it. Do not revoke that handshake as an external config edit.
    const completingKey = after && before.auth === 'publickey' && !before.private_key_path
      && !!after.private_key_path && connection({ ...before, private_key_path: after.private_key_path }) === connection(after);
    if (!after || connection(before) !== connection(after) && !completingKey) invalidated.push(before);
    if (after && identity(before) === identity(after) && before.name !== after.name) renamed.set(before.name, after.name);
  }
  return { renamed, invalidated };
}

/** Serialize saves and external file events; never replace a good snapshot on read/apply failure. */
export class ConfigLiveReload {
  private current?: BridgeConfig;
  private queue: Promise<void> = Promise.resolve();
  private revision = 0;
  constructor(
    initial: BridgeConfig | undefined,
    private readonly read: () => Promise<BridgeConfig>,
    private readonly apply: (previous: BridgeConfig | undefined, next: BridgeConfig) => Promise<void>
  ) { this.current = initial && structuredClone(initial); }

  refresh(): Promise<void> {
    const revision = ++this.revision;
    const operation = this.queue.catch(() => undefined).then(async () => {
      if (revision !== this.revision) return;
      const next = await this.read();
      if (revision !== this.revision || JSON.stringify(next) === JSON.stringify(this.current)) return;
      await this.apply(this.current, next);
      this.current = structuredClone(next);
    });
    this.queue = operation;
    return operation;
  }
}
