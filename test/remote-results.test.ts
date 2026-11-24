import assert from 'node:assert/strict';
import test from 'node:test';
import { listDirectories, pageDirectory, searchResult } from '../src/remote/remote-results';

test('directory pages are stable, complete and reject stale or cross-path cursors', () => {
  const entries = ['c', 'a', 'b'].map(name => ({ name, type: 'file' }));
  const first = pageDirectory(entries, '/a', { limit: 2 });
  assert.deepEqual(first.entries.map(e => e.name), ['a', 'b']);
  const last = pageDirectory(entries.reverse(), '/a', { cursor: first.nextCursor });
  assert.deepEqual(last.entries.map(e => e.name), ['c']);
  assert.equal(last.truncated, false);
  assert.throws(() => pageDirectory(entries.slice(1), '/a', { cursor: first.nextCursor }));
  assert.throws(() => pageDirectory(entries, '/b', { cursor: first.nextCursor }));
  assert.throws(() => pageDirectory(entries, '/a', { cursor: 'broken' }));
});

test('search distinguishes failure from no matches and counts only complete captured lines', () => {
  assert.equal(searchResult({ exitCode: 1, stdout: '' }).status, 'no_matches');
  assert.equal(searchResult({ exitCode: 2, stdout: '', stderr: 'invalid regex' }).status, 'error');
  assert.equal(searchResult({ exitCode: 0, stdout: 'a\nb', truncated: true }).returnedLineCount, 1);
  assert.equal(searchResult({ exitCode: 0, stdout: 'a\nb', truncated: false }).returnedLineCount, 2);
  assert.deepEqual(
    (({ status, exitCode }) => ({ status, exitCode }))(
      searchResult({ exitCode: 0, stdout: '' }, 'names')
    ),
    { status: 'no_matches', exitCode: 1 }
  );
});

test('directory batches start concurrently and give each path its own page limit', async () => {
  const started: string[] = [];
  let finishFirst!: () => void;
  const releaseFirst = new Promise<void>(resolve => { finishFirst = resolve; });
  const pending = listDirectories(['/a', 'missing', '/b'].map(path => ({ path, limit: 2 })), async ({ path, limit }) => {
    started.push(path);
    if (path === '/a') await releaseFirst;
    if (path === 'missing') throw new Error('missing');
    return pageDirectory(['a', 'b', 'c'].map(name => ({ name, type: 'file' })), path, { limit });
  });
  finishFirst();
  assert.deepEqual(started, ['/a', 'missing', '/b']);
  const result = await pending;
  assert.deepEqual(result.results.map(r => [r.path, r.status]), [
    ['/a', 'ok'], ['missing', 'error'], ['/b', 'ok']
  ]);
  assert.equal(result.returnedEntries, 4);
  for (const item of result.results.filter(r => r.status === 'ok')) {
    assert.equal(item.entries.length, 2);
    assert.ok(item.nextCursor);
  }
});
