import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cleanTerminalDiagnostic, decodeTerminalDiagnostic, isRemoteDirectoryPermissionDenied,
  isTransientTerminalConnectionFailure,
  nextAutoReconnectAttempt, shouldRecoverTerminalExit,
  terminalReconnectDelayMs
} from '../src/terminal/terminal-diagnostics';

test('classifies remote directory permission failures as non-retryable', () => {
  assert.equal(isRemoteDirectoryPermissionDenied("cd: /home/share/chenle: Permission denied"), true);
  assert.equal(isRemoteDirectoryPermissionDenied('Connection reset by peer'), false);
});


test('terminal diagnostics strip ANSI and retain the most recent bounded output', () => {
  assert.deepEqual(cleanTerminalDiagnostic('\u001b[31mfirst\u001b[0m\r\nsecond', 8), {
    text: 't\nsecond', truncated: true
  });
});

test('terminal diagnostics decode UTF-8 and Windows PowerShell UTF-16LE output', () => {
  assert.equal(decodeTerminalDiagnostic(Buffer.from('plain', 'utf8')), 'plain');
  assert.equal(decodeTerminalDiagnostic(Buffer.concat([
    Buffer.from([0xff, 0xfe]), Buffer.from('错误', 'utf16le')
  ])), '错误');
});

test('SSH exit 0 is recovered when automatic reconnect is enabled', () => {
  assert.equal(shouldRecoverTerminalExit({
    processExit: true,
    exitCode: 0,
    cleanExit: false,
    autoReconnect: true,
    diagnosticText: ''
  }), true);
  assert.equal(shouldRecoverTerminalExit({
    processExit: true,
    exitCode: 0,
    cleanExit: false,
    autoReconnect: false,
    diagnosticText: ''
  }), false);
});

test('terminal recovery excludes user/window closure but auto-recovers clean SSH exits', () => {
  const base = {
    exitCode: 1,
    cleanExit: false,
    autoReconnect: true,
    diagnosticText: 'Connection reset by peer'
  };
  assert.equal(shouldRecoverTerminalExit({ ...base, processExit: false }), false);
  assert.equal(shouldRecoverTerminalExit({
    ...base, processExit: true, cleanExit: true
  }), true);
  assert.equal(shouldRecoverTerminalExit({
    ...base,
    processExit: true,
    exitCode: 0,
    cleanExit: true,
    autoReconnect: false,
    diagnosticText: ''
  }), false);
});

test('an SSH disconnect diagnostic is recoverable even when exit code is 0', () => {
  assert.equal(shouldRecoverTerminalExit({
    processExit: true,
    exitCode: 0,
    cleanExit: false,
    autoReconnect: false,
    diagnosticText: 'client_loop: send disconnect: Broken pipe'
  }), true);
});

test('automatic reconnect attempts accumulate only for short-lived terminals', () => {
  assert.equal(nextAutoReconnectAttempt(0, 5_000, 60_000), 1);
  assert.equal(nextAutoReconnectAttempt(1, 59_999, 60_000), 2);
  assert.equal(nextAutoReconnectAttempt(2, 60_000, 60_000), 1);
  assert.equal(nextAutoReconnectAttempt(2, 10 * 60_000, 60_000), 1);
});

test('classifies retryable network failures without retrying authentication failures', () => {
  assert.equal(isTransientTerminalConnectionFailure('Connection lost before handshake'), true);
  assert.equal(isTransientTerminalConnectionFailure('read ECONNRESET'), true);
  assert.equal(isTransientTerminalConnectionFailure('Connection timed out'), true);
  assert.equal(
    isTransientTerminalConnectionFailure('All configured authentication methods failed'),
    false
  );
});

test('backs off terminal reconnects with a bounded delay', () => {
  assert.equal(terminalReconnectDelayMs(1), 1_000);
  assert.equal(terminalReconnectDelayMs(2), 2_000);
  assert.equal(terminalReconnectDelayMs(3), 4_000);
  assert.equal(terminalReconnectDelayMs(4), 4_000);
});
