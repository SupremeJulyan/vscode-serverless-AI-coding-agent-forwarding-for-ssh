import assert from 'node:assert/strict';
import test from 'node:test';
import { isSshAuthenticationFailure } from '../src/terminal/terminal-routing';
test('authentication failures stop automatic terminal reconnect', () => {
  assert.equal(isSshAuthenticationFailure('SSH authentication failed: alice'), true);
  assert.equal(isSshAuthenticationFailure('connection reset by peer'), false);
});
