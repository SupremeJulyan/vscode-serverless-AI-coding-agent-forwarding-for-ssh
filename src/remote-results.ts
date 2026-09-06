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

export function searchResult(result: Record<string, unknown>) {
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const status = result.exitCode === 0 ? 'matches' : result.exitCode === 1 ? 'no_matches' : 'error';
  return {
    ...result, status,
    // A truncated final line is not a complete match. This is a returned count, not a total.
    returnedLineCount: stdout.split('\n').length - 1 +
      (stdout && !stdout.endsWith('\n') && !result.truncated ? 1 : 0)
  };
}
