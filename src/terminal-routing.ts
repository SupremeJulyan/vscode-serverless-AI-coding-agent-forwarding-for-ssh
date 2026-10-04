import type { HostConfig } from './config';
import type { PlatformKind } from './platform';
import { isTransientTerminalConnectionFailure } from './terminal-diagnostics';

// Channel-level failures mean the server rejects the ssh2 client's pty/shell
// negotiation. Connection-level failures mean the gateway drops ssh2 before
// the session can be used. Both can be served by the system ssh fallback;
// authentication failures intentionally do not match these patterns.
const ssh2FallbackChannelPattern = /pseudo-terminal|open shell|start subsystem|channel open/i;
const ssh2FallbackConnectionPattern = /handshake|ready.?timeout|connection (?:closed|terminated|reset|refused)|socket hang up|channel open failure|unable to connect|network is unreachable|no route to host|timed out/i;

export function shouldFallbackToSystemSsh(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return ssh2FallbackChannelPattern.test(message)
    || ssh2FallbackConnectionPattern.test(message)
    || isTransientTerminalConnectionFailure(message);
}

/**
 * Prefer the in-extension ssh2 terminal when it can connect directly. Its
 * host verifier sees the key on the connection that becomes the terminal, so
 * there is no ssh-keyscan/actual-ssh race on first use or rotating backends.
 */
export function shouldUseBuiltinSshTerminal(
  kind: PlatformKind, host: HostConfig, forceSystemSsh = false
): boolean {
  return !forceSystemSsh
    && (Boolean(host.password) || Boolean(host.private_key_path))
    && !(kind === 'wsl' && host.vpn === true);
}
