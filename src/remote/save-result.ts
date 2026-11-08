import { createHash } from 'node:crypto';

export function adoptedRemoteSaveResult(content: Uint8Array, permissions?: number) {
  const bytes = Buffer.from(content);
  const limit = 64 * 1024;
  let text: string;
  let encoding: 'utf8' | 'base64' = 'utf8';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const decoder = new TextDecoder();
    text = decoder.decode(bytes.subarray(0, limit), { stream: bytes.length > limit });
  } catch {
    encoding = 'base64';
    text = bytes.subarray(0, limit).toString('base64');
  }
  const returnedBytes = encoding === 'utf8' ? Buffer.byteLength(text) : Math.min(bytes.length, limit);
  return {
    written: false, remotePreferred: true, bytes: bytes.length,
    hash: createHash('sha256').update(bytes).digest('hex'),
    content: text, encoding, permissions: permissions === undefined ? undefined : permissions & 0o7777,
    truncated: returnedBytes < bytes.length,
    ...(returnedBytes < bytes.length ? { nextOffset: returnedBytes } : {})
  };
}
