import type { ServerHostKeyAlgorithm } from 'ssh2';

/** ssh2 host-key algorithms, modern first with legacy server compatibility last. */
export const serverHostKeyAlgorithms: ServerHostKeyAlgorithm[] = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
  'ssh-rsa',
  'ssh-dss'
];

/** Some gateways whitelist common SSH client identification strings. */
export const defaultSshClientIdent = 'OpenSSH_9.6';
