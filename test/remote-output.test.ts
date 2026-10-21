import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteOutputStore } from '../src/remote-output';

test('retained output reconstructs UTF-8 across pages without executing again', () => {
  const store = new RemoteOutputStore();
  const stdout = '中文😀\n'.repeat(50);
  const preview = store.capture({ stdout, stderr: 'failure', exitCode: 2, truncated: false }, 'a', 32) as any;
  assert.equal(preview.exitCode, 2);
  assert.equal(preview.retentionTruncated, false);
  let text = preview.stdout;
  let offset = preview.stdoutNextOffset;
  while (offset < Buffer.byteLength(stdout)) {
    const page = store.read(preview.outputId, 'a', 'stdout', offset, 13);
    text += page.content;
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  }
  assert.equal(text, stdout);
  assert.equal(preview.stderr, 'failure');
  assert.throws(() => store.read(preview.outputId, 'other', 'stdout'));
  store.clear();
  assert.throws(() => store.read(preview.outputId, 'a', 'stdout'));
});

test('output cache evicts oldest results and reports incomplete original capture', () => {
  const store = new RemoteOutputStore(100);
  const a = store.capture({ stdout: 'a'.repeat(60), truncated: true }, 'a', 8) as any;
  assert.equal(a.retentionTruncated, true);
  store.capture({ stdout: 'b'.repeat(60) }, 'a', 8);
  assert.throws(() => store.read(a.outputId, 'a', 'stdout'));
});

test('preview counts do not claim all captured search lines were shown', () => {
  const store = new RemoteOutputStore();
  const preview = store.capture({ stdout: 'line\n'.repeat(100), returnedLineCount: 100, truncated: true }, 'a', 32) as any;
  assert.equal(preview.capturedLineCount, 100);
  assert.equal(preview.returnedLineCount, 6);
  assert.equal(store.read(preview.outputId, 'a', 'stdout').retentionTruncated, true);
});
