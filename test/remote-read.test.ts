import assert from 'node:assert/strict';
import test from 'node:test';
import { readTextRange, RemoteReadOptions } from '../src/remote-read';
const read = (text: string, options: Partial<RemoteReadOptions>) => {
  const bytes = Buffer.from(text);
  return readTextRange(bytes.length, async (offset, length) => bytes.subarray(offset, offset + length), { path: 'x', ...options });
};
test('line and suffix selection preserve original bytes', async () => {
  assert.equal((await read('一\n二\n三\n', { head: 2 })).content, '一\n二\n');
  assert.equal((await read('一\n二\n三\n', { tail: 2 })).content, '二\n三\n');
  assert.equal((await read('a\nb\nc', { startLine: 2, lineCount: 1 })).content, 'b\n');
  assert.equal((await read('a\nb\nc', { tail: 2 })).content, 'b\nc');
  assert.equal((await read('a\nb\nc', { tail: 3, length: 4 })).selectionTruncated, true);
  await assert.rejects(read('abc', { head: 1, tail: 1 }));
});
test('byte continuation does not split UTF-8 or accept binary data', async () => {
  const first = await read('中文abc', { length: 4 });
  assert.equal(first.content, '中');
  assert.equal((await read('中文abc', { offset: first.nextOffset })).content, '文abc');
  await assert.rejects(read('a\0b', {}));
});

test('UTF-8 BOM is preserved and invalid bytes are never silently dropped', async () => {
  assert.equal((await read('\ufeffhello', {})).content, '\ufeffhello');
  await assert.rejects(readTextRange(20, async () => Buffer.from([65, 255, 255, 255]), { path: 'x', length: 4 }));
  const suffix = await read('abc\ndef\n', { tail: 1, length: 4 });
  assert.equal(suffix.content, 'def\n');
  assert.equal(suffix.selectionTruncated, false);
});
