import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePortableStatLine } from '../src/sftp/scp-session';

test('portable SCP stat parses locale-independent raw mode types', () => {
  assert.equal(parsePortableStatLine('41ed|4096|755|1720000000')?.type, 'directory');
  assert.equal(parsePortableStatLine('81a4|12|644|1720000000')?.type, 'file');
  assert.equal(parsePortableStatLine('a1ff|7|777|1720000000')?.type, 'symbolic-link');
});

test('portable SCP stat rejects unknown or malformed modes so callers can fall back', () => {
  assert.equal(parsePortableStatLine('目录|4096|755|1720000000'), undefined);
  assert.equal(parsePortableStatLine('c1ff|0|777|1720000000'), undefined);
  assert.equal(parsePortableStatLine('41ed|bad|755|1720000000'), undefined);
});
