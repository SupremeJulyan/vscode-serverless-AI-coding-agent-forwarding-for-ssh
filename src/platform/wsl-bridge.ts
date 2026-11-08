import * as path from 'node:path';
let bundleRoot: string | undefined;
/** Location of the retained WSL VPN transport helpers; no SSH client script. */
export function setWslBundlePath(resolvedPath: string): void { bundleRoot = resolvedPath; }
export function vpnRelayPoolPath(): string {
  if (!bundleRoot) throw new Error('WSL VPN bundle path not initialised');
  return path.join(bundleRoot, 'vpn-relay-pool.sh');
}
