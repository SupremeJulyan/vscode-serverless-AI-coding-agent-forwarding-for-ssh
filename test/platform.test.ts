import assert from 'node:assert/strict';
import test from 'node:test';
import { detectPlatform, createPlatformAdapter, platformExtensionStateKey } from '../src/platform/platform';

test('detects each extension host platform without selecting SSH transports', () => {
  assert.equal(detectPlatform('linux', 'microsoft-standard-WSL2'), 'wsl');
  assert.equal(detectPlatform('linux', 'generic'), 'linux');
  assert.equal(detectPlatform('win32'), 'windows');
  assert.equal(detectPlatform('darwin'), 'macos');
  assert.deepEqual(createPlatformAdapter('wsl'), { kind: 'wsl' });
  assert.notEqual(platformExtensionStateKey('token', 'wsl'), platformExtensionStateKey('token', 'windows'));
});
