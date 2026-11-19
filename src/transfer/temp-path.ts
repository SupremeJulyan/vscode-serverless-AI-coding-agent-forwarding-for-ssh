import { randomBytes } from 'node:crypto';
import * as path from 'node:path';

/** Unique local staging file. A failed or cancelled transfer is discarded, never resumed. */
export function localTransferTempPath(target: string): string {
  return `${target}.safs-transfer-${randomBytes(8).toString('hex')}.safs-part`;
}

/** Unique remote staging file. It is renamed over the destination only after full success. */
export function remoteTransferTempPath(target: string): string {
  const directory = path.posix.dirname(target);
  const name = path.posix.basename(target);
  return path.posix.join(directory, `.${name}.safs-transfer-${randomBytes(8).toString('hex')}.tmp`);
}
