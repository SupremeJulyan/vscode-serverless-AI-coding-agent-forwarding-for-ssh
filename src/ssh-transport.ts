import type { HostConfig } from './config';
import type { PlatformKind } from './platform';

/** One routing policy for SFTP, terminals and commands; OpenSSH owns its config. */
export function selectSshTransport(
  kind: PlatformKind, host: HostConfig, configuredSystemSsh = false
): 'ssh2' | 'system' {
  return configuredSystemSsh || (kind === 'wsl' && host.vpn === true)
    || (!host.password && !host.private_key_path) ? 'system' : 'ssh2';
}

function values(config: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const line of config.split(/\r?\n/)) {
    const match = /^(\S+)\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1].toLowerCase();
    result.set(key, [...result.get(key) ?? [], match[2]]);
  }
  return result;
}

/** Compare effective configuration with OpenSSH's own defaults, not version-specific guesses. */
export function needsOpenSshAuthentication(
  configured: string, defaults: string, host: HostConfig, agentAvailable = false
): boolean {
  if (!host.password && !host.private_key_path) return true;
  if (!host.password && agentAvailable) return true;
  const actual = values(configured);
  const baseline = values(defaults);
  const options = [
    'identityfile', 'certificatefile', 'identityagent', 'identitiesonly',
    'preferredauthentications', 'pubkeyauthentication', 'passwordauthentication',
    'kbdinteractiveauthentication', 'gssapiauthentication', 'gssapidelegatecredentials',
    'hostbasedauthentication', 'pkcs11provider', 'securitykeyprovider',
    'pubkeyacceptedalgorithms', 'pubkeyacceptedkeytypes',
    'hostkeyalgorithms', 'kexalgorithms', 'ciphers', 'macs',
    'bindaddress', 'bindinterface', 'addressfamily', 'compression',
    'forwardagent', 'forwardx11', 'forwardx11trusted',
    'localforward', 'remoteforward', 'dynamicforward',
    'tcpkeepalive', 'serveraliveinterval', 'serveralivecountmax', 'rekeylimit'
  ];
  return options.some(key => JSON.stringify(actual.get(key)) !== JSON.stringify(baseline.get(key)));
}
