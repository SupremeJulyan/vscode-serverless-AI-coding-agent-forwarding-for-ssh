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
    const completed = await Promise.all(wave.map(({ request, length }) => readItem({ ...request, length }, read)));
    for (const item of completed) { remaining -= item.bytes; results.push(item.value); }
  }
  for (; index < requests.length; index++) {
    results.push({ path: requests[index].path, status: 'not_read', reason: 'batch_budget_exhausted' });
  }
  return { results, contentBytes: maxBytes - remaining, maxBytes };
}

export async function readFiles(
  requests: RemoteReadOptions[], read: (input: RemoteReadOptions) => Promise<unknown>
) {
  const completed = await Promise.all(requests.map(request => readItem(request, read)));
  return {
    results: completed.map(item => item.value),
    contentBytes: completed.reduce((total, item) => total + item.bytes, 0)
  };
}

async function readItem(request: RemoteReadOptions, read: (input: RemoteReadOptions) => Promise<unknown>) {
  try {
    const value = await read(request);
    if (!value || typeof value !== 'object' || !('content' in value) || typeof value.content !== 'string') {
      throw new Error('Invalid text read response.');
    }
    const bytes = Buffer.byteLength(value.content);
    if (bytes > (request.length ?? 8192)) throw new Error('Read exceeded the requested byte budget.');
    return { value: { ...value, path: request.path, status: 'ok' }, bytes };
  } catch (error) {
    return { value: { path: request.path, status: 'error',
      message: error instanceof Error ? error.message : String(error) }, bytes: 0 };
  }
}
