import type { HostConfig } from './config';
import type { PlatformKind } from './platform';

/** One source-based routing policy for SFTP, terminals and commands. */
export function selectSshTransport(
  kind: PlatformKind, host: HostConfig, forceSystemSsh = false
): 'ssh2' | 'system' {
  return forceSystemSsh || (kind === 'wsl' && host.vpn === true)
    || host.source === 'ssh-config' ? 'system' : 'ssh2';
}
