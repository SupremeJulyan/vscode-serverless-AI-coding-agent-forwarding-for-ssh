import assert from 'node:assert/strict';
import test from 'node:test';
import { applyRemoteTextEdits, textSha256 } from '../src/remote-edit';

test('applies multiple exact remote edits transactionally and in order', () => {
  assert.deepEqual(applyRemoteTextEdits('one\ntwo\nthree\n', [
    { oldText: 'two', newText: 'second' },
    { oldText: 'second\nthree', newText: '2\n3' }
  ]), { content: 'one\n2\n3\n', replacements: 2 });
});

test('rejects missing, ambiguous, empty, or excessive remote edits', () => {
  assert.throws(() => applyRemoteTextEdits('same same', [
    { oldText: 'missing', newText: 'x' }
  ]), /did not match/);
  assert.throws(() => applyRemoteTextEdits('same same', [
    { oldText: 'same', newText: 'x' }
  ]), /matched more than once/);
  assert.throws(() => applyRemoteTextEdits('aaa', [
    { oldText: 'aa', newText: 'x' }
  ]), /matched more than once/);
  assert.throws(() => applyRemoteTextEdits('text', []), /at least one edit/);
  assert.throws(() => applyRemoteTextEdits('text', [
    { oldText: '', newText: 'x' }
  ]), /must not be empty/);
  assert.throws(() => applyRemoteTextEdits('text', Array.from(
    { length: 101 }, () => ({ oldText: 'x', newText: 'y' })
  )), /at most 100 edits/);
});

test('computes stable SHA-256 hashes for optimistic concurrency checks', () => {
  assert.equal(
    textSha256('hello'),
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
  );
});
