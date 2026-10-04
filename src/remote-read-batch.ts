import { RemoteReadOptions } from './remote-read';

export async function readTextBatch(
  requests: RemoteReadOptions[], maxBytes: number,
  read: (input: RemoteReadOptions) => Promise<unknown>
) {
  let remaining = maxBytes;
  const results = [];
  let index = 0;
  while (index < requests.length && remaining >= 4) {
    const wave: Array<{ request: RemoteReadOptions; length: number }> = [];
    let reserved = 0;
    while (index < requests.length && wave.length < 4 && remaining - reserved >= 4) {
      const request = requests[index];
      const fairShare = Math.max(4, Math.min(8192,
        Math.floor((remaining - reserved) / (requests.length - index))));
      const length = Math.min(request.length ?? fairShare, remaining - reserved);
      // Invalid lengths still reach the reader's validation; reserve at least four bytes.
      reserved += Math.max(4, length);
      wave.push({ request, length });
      index++;
    }
    const completed = await Promise.all(wave.map(async ({ request, length }) => {
      try {
        const value = await read({ ...request, length });
        if (!value || typeof value !== 'object' || typeof (value as any).content !== 'string') {
          throw new Error('Invalid text read response.');
        }
        const result = value as Record<string, unknown> & { content: string };
        const bytes = Buffer.byteLength(result.content);
        if (bytes > length) throw new Error('Read exceeded the requested byte budget.');
        return { value: { ...result, path: request.path, status: 'ok' }, bytes };
      } catch (error) {
        return { value: { path: request.path, status: 'error',
          message: error instanceof Error ? error.message : String(error) }, bytes: 0 };
      }
    }));
    for (const item of completed) { remaining -= item.bytes; results.push(item.value); }
  }
  for (; index < requests.length; index++) {
    results.push({ path: requests[index].path, status: 'not_read', reason: 'batch_budget_exhausted' });
  }
  return { results, contentBytes: maxBytes - remaining, maxBytes };
}
