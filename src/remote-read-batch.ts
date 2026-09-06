import { RemoteReadOptions } from './remote-read';

export async function readTextBatch(
  requests: RemoteReadOptions[], maxBytes: number,
  read: (input: RemoteReadOptions) => Promise<unknown>
) {
  let remaining = maxBytes;
  const results = [];
  for (const request of requests) {
    if (remaining < 4) {
      results.push({ path: request.path, status: 'not_read', reason: 'batch_budget_exhausted' });
      continue;
    }
    try {
      const value = await read({ ...request, length: Math.min(request.length ?? 8192, remaining) });
      if (!value || typeof value !== 'object' || typeof (value as any).content !== 'string') {
        throw new Error('Invalid text read response.');
      }
      const result = value as Record<string, unknown> & { content: string };
      const bytes = Buffer.byteLength(result.content);
      if (bytes > remaining) throw new Error('Read exceeded the requested byte budget.');
      remaining -= bytes;
      results.push({ ...result, path: request.path, status: 'ok' });
    } catch (error) {
      results.push({ path: request.path, status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { results, contentBytes: maxBytes - remaining, maxBytes };
}
