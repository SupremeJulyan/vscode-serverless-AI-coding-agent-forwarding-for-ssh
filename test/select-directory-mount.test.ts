import assert from 'node:assert/strict';
import test from 'node:test';
import { selectDirectoryMount } from '../src/remote/select-directory-mount';

const dev = { name: 'dev' };
const staging = { name: 'staging' };
const mounts = [dev, staging];

test('directory navigation without SAFS context uses the connection picker', async () => {
  assert.equal(await selectDirectoryMount(mounts, undefined, async () => staging), staging);
  assert.equal(await selectDirectoryMount(mounts, undefined, async () => undefined), undefined);
});

test('directory navigation with SAFS context keeps the requested connection', async () => {
  const pick = async () => assert.fail('opened the picker for an explicit connection');
  assert.equal(await selectDirectoryMount(mounts, 'dev', pick), dev);
  await assert.rejects(selectDirectoryMount(mounts, 'missing', pick), /missing/);
});
