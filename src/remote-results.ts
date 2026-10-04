import { createHash } from 'node:crypto';

export function pageDirectory<T extends { name: string; type: string }>(
  entries: T[], path: string, input: { limit?: number; cursor?: string }
) {
  const sorted = entries.map(({ name, type }) => ({ name, type }))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const revision = createHash('sha256').update(JSON.stringify([path, sorted])).digest('hex');
  let offset = 0;
  if (input.cursor) {
    let cursor;
    try { cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString()); }
    catch { throw new Error('Invalid directory cursor; restart listing without cursor.'); }
    if (!cursor || cursor.revision !== revision || !Number.isSafeInteger(cursor.offset)
        || cursor.offset < 0 || cursor.offset > sorted.length) {
      throw new Error('Directory changed or cursor is invalid; restart listing without cursor.');
    }
    offset = cursor.offset;
  }
  const limit = Math.max(1, Math.min(input.limit ?? 100, 10000));
  const page = sorted.slice(offset, offset + limit);
  const next = offset + page.length;
  return {
    entries: page, total: sorted.length, truncated: next < sorted.length,
    ...(next < sorted.length ? {
      nextCursor: Buffer.from(JSON.stringify({ revision, offset: next })).toString('base64url')
    } : {})
  };
}

export function searchResult(result: Record<string, unknown>, mode?: string) {
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  // POSIX find exits 0 for an empty result, unlike grep. Keep one status/exit
  // contract across content and filename searches.
  const exitCode = mode === 'names' && result.exitCode === 0 && !stdout ? 1 : result.exitCode;
  const status = exitCode === 0 ? 'matches' : exitCode === 1 ? 'no_matches' : 'error';
  return {
    ...result, exitCode, status,
    // A truncated final line is not a complete match. This is a returned count, not a total.
    returnedLineCount: stdout.split('\n').length - 1 +
      (stdout && !stdout.endsWith('\n') && !result.truncated ? 1 : 0)
  };
}

export async function listDirectories(
  paths: string[], limit: number,
  list: (input: { path: string; limit: number }) => Promise<unknown>
) {
  let remaining = limit;
  const results = [];
  for (const path of paths) {
    if (!remaining) {
      results.push({ path, status: 'not_listed', reason: 'batch_budget_exhausted' });
      continue;
    }
    try {
      const value = await list({ path, limit: remaining });
      if (!value || typeof value !== 'object' || !Array.isArray((value as any).entries)) {
        throw new Error('Invalid directory response.');
      }
      const result = value as Record<string, unknown> & { entries: unknown[] };
      if (result.entries.length > remaining) throw new Error('Directory exceeded batch entry budget.');
      remaining -= result.entries.length;
      results.push({ ...result, path, status: 'ok' });
    } catch (error) {
      results.push({ path, status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { results, returnedEntries: limit - remaining };
}
