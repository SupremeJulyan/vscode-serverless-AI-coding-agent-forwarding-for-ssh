import { randomBytes } from 'node:crypto';

/** Window-local, bounded result retention. Handles never resolve in another workspace. */
export class RemoteOutputStore {
  private entries = new Map<string, { scope: string; expires: number; stdout: Buffer; stderr: Buffer; retentionTruncated: boolean }>();
  constructor(private readonly maxBytes = 32 * 1024 * 1024, private readonly ttlMs = 600_000) {}

  private prune() {
    for (const [id, item] of this.entries) if (item.expires <= Date.now()) this.entries.delete(id);
  }

  clear() { this.entries.clear(); }

  capture(value: unknown, scope: string, budget = 8192): unknown {
    if (!value || typeof value !== 'object') return value;
    const { responseBudget, ...result } = value as Record<string, unknown>;
    budget = Math.max(4, Math.min(65536, typeof responseBudget === 'number' ? responseBudget : budget));
    const stdout = Buffer.from(typeof result.stdout === 'string' ? result.stdout : '');
    const stderr = Buffer.from(typeof result.stderr === 'string' ? result.stderr : '');
    if (stdout.length + stderr.length <= budget) return result;
    this.prune();
    const bytes = stdout.length + stderr.length;
    if (bytes > this.maxBytes) throw new Error('Output exceeds result retention capacity.');
    let retained = [...this.entries.values()].reduce((n, item) => n + item.stdout.length + item.stderr.length, 0);
    for (const [id, item] of this.entries) {
      if (retained + bytes <= this.maxBytes) break;
      retained -= item.stdout.length + item.stderr.length;
      this.entries.delete(id);
    }
    const outputId = randomBytes(16).toString('hex');
    this.entries.set(outputId, { scope, stdout, stderr, retentionTruncated: result.truncated === true, expires: Date.now() + this.ttlMs });
    // Reserve space for stderr so verbose stdout cannot hide the failure diagnostic.
    const errBudget = Math.min(stderr.length, Math.floor(budget / 2));
    const out = this.read(outputId, scope, 'stdout', 0, budget - errBudget);
    const err = this.read(outputId, scope, 'stderr', 0, Math.max(4, errBudget));
    return {
      ...result, stdout: out.content, stderr: err.content, truncated: true,
      ...(typeof result.returnedLineCount === 'number' ? {
        capturedLineCount: result.returnedLineCount,
        returnedLineCount: out.content.split('\n').length - 1
      } : {}),
      outputId, retainedBytes: bytes, retentionTruncated: result.truncated === true,
      stdoutNextOffset: out.nextOffset, stderrNextOffset: err.nextOffset,
      expiresInSeconds: Math.floor(this.ttlMs / 1000)
    };
  }

  read(outputId: string, scope: string, stream: 'stdout' | 'stderr', offset = 0, length = 8192) {
    this.prune();
    const item = this.entries.get(outputId);
    if (!item || item.scope !== scope) throw new Error('Output unavailable or expired; do not automatically rerun the command.');
    const data = item[stream];
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > data.length
        || !Number.isSafeInteger(length) || length < 4 || length > 65536) {
      throw new Error('Invalid output range.');
    }
    if (offset < data.length && (data[offset] & 0xc0) === 0x80) throw new Error('Offset must be a UTF-8 boundary; use nextOffset.');
    let end = Math.min(data.length, offset + length);
    while (end < data.length && end > offset && (data[end] & 0xc0) === 0x80) end--;
    return { content: data.subarray(offset, end).toString(), nextOffset: end,
      totalBytes: data.length, truncated: end < data.length, retentionTruncated: item.retentionTruncated };
  }
}
