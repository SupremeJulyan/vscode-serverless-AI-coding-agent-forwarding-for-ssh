import assert from 'node:assert/strict';
import test from 'node:test';
import { applyRemoteTextEdits } from '../src/remote/remote-edit';

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
