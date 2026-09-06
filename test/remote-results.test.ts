import assert from 'node:assert/strict';
import test from 'node:test';
import { pageDirectory, searchResult } from '../src/remote-results';

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
});
