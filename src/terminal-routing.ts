import type { HostConfig } from './config';
import type { PlatformKind } from './platform';
import { isTransientTerminalConnectionFailure } from './terminal-diagnostics';
import { selectSshTransport } from './ssh-transport';

// Channel-level failures mean the server rejects the ssh2 client's pty/shell
// negotiation. Connection-level failures mean the gateway drops ssh2 before
// the session can be used. Both can be served by the system ssh fallback;
// authentication failures intentionally do not match these patterns.
const ssh2FallbackChannelPattern = /pseudo-terminal|open shell|start subsystem|channel open/i;
const ssh2FallbackConnectionPattern = /handshake|ready.?timeout|connection (?:closed|terminated|reset|refused)|socket hang up|channel open failure|unable to connect|network is unreachable|no route to host|timed out/i;

export function shouldFallbackToSystemSsh(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/host.?key|host denied|fingerprint|主机密钥|abort|cancel/i.test(message)) return false;
  return ssh2FallbackChannelPattern.test(message)
    || ssh2FallbackConnectionPattern.test(message)
    || /authentication methods failed|permission denied|authentication failed|userauth|private.?key|passphrase/i.test(message)
    || isTransientTerminalConnectionFailure(message);
}

export function isSshAuthenticationFailure(message: string): boolean {
  return /permission denied\s*\([^\r\n)]*(?:publickey|password|keyboard-interactive)|authentication (?:methods failed|failed)|no supported authentication methods|agent refused operation|sign_and_send_pubkey.*signing failed|认证失败/i.test(message);
}

/**
 * Prefer the in-extension ssh2 terminal when it can connect directly. Its
 * host verifier sees the key on the connection that becomes the terminal, so
 * there is no ssh-keyscan/actual-ssh race on first use or rotating backends.
 */
export function shouldUseBuiltinSshTerminal(
  kind: PlatformKind, host: HostConfig, forceSystemSsh = false
): boolean {
  return selectSshTransport(kind, host, forceSystemSsh) === 'ssh2';
}
