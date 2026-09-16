import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  TerminalCommandOutputCapture, terminalForwardingCommand
} from '../src/terminal-command-forwarding';

test('builds a marker-wrapped command with a bounded remote cwd', () => {
  const plan = terminalForwardingCommand(
    "printf '%s' \"$USER\"", "/work/a b", '0123456789abcdef01234567'
  );
  assert.match(plan.commandLine, /^\/bin\/sh -c /);
  assert.match(plan.commandLine, /SAFS_AGENT_BEGIN_0123456789abcdef01234567/);
  assert.match(plan.commandLine, /cd --/);
  assert.match(plan.commandLine, /work\/a b/);
  assert.equal(plan.startMarker, '\x1eSAFS_AGENT_BEGIN_0123456789abcdef01234567\x1f');
});

test('executes the wrapper in the current shell and preserves the inner exit code', {
  skip: process.platform === 'win32'
}, () => {
  const plan = terminalForwardingCommand(
    'pwd; printf hello; exit 7', '/tmp', '00112233445566778899aabb'
  );
  const processResult = spawnSync('/bin/bash', ['-c', plan.commandLine], {
    encoding: 'utf8'
  });
  assert.equal(processResult.status, 0);
  const capture = new TerminalCommandOutputCapture(
    plan.startMarker, plan.endMarkerPrefix, 1024
  );
  assert.deepEqual(capture.push(processResult.stdout), {
    exitCode: 7, stdout: '/tmp\nhello', stderr: '', truncated: false
  });
});

test('can probe the live terminal directory without forcing a cwd', {
  skip: process.platform === 'win32'
}, () => {
  const plan = terminalForwardingCommand(
    'pwd -P', undefined, 'ffeeddccbbaa998877665544'
  );
  assert.equal(plan.commandLine.includes('cd --'), false);
  const processResult = spawnSync('/bin/bash', ['-c', plan.commandLine], {
    cwd: '/tmp', encoding: 'utf8'
  });
  const capture = new TerminalCommandOutputCapture(
    plan.startMarker, plan.endMarkerPrefix, 1024
  );
  assert.deepEqual(capture.push(processResult.stdout), {
    exitCode: 0, stdout: '/tmp\n', stderr: '', truncated: false
  });
});

test('reportCwd emits the OSC 633 cwd sequence before the BEGIN marker', {
  skip: process.platform === 'win32'
}, () => {
  const plan = terminalForwardingCommand(
    'printf hello', undefined, 'ddeeff00c0ffee1234567890', true
  );
  assert.match(plan.commandLine, /633;P;Cwd=%s/);
  assert.match(plan.commandLine, /SAFS_AGENT_BEGIN_ddeeff00c0ffee1234567890/);
  assert.equal(plan.commandLine.includes('cd --'), false);
  const processResult = spawnSync('/bin/bash', ['-c', plan.commandLine], {
    cwd: '/tmp', encoding: 'utf8'
  });
  assert.match(processResult.stdout, /\u001b\]633;P;Cwd=\/tmp\u0007/);
  const capture = new TerminalCommandOutputCapture(
    plan.startMarker, plan.endMarkerPrefix, 1024
  );
  assert.deepEqual(capture.push(processResult.stdout), {
    exitCode: 0, stdout: 'hello', stderr: '', truncated: false
  });
});

test('captures split terminal output markers and the exit code', () => {
  const id = '0123456789abcdef01234567';
  const plan = terminalForwardingCommand('echo hello', '/work', id);
  const capture = new TerminalCommandOutputCapture(
    plan.startMarker, plan.endMarkerPrefix, 1024
  );
  assert.equal(capture.push(`prompt$ wrapper\r\n${plan.startMarker.slice(0, 10)}`), undefined);
  assert.equal(capture.push(`${plan.startMarker.slice(10)}hello\r\n${plan.endMarkerPrefix}`), undefined);
  assert.deepEqual(capture.push('7\x1fprompt$ '), {
    exitCode: 7, stdout: 'hello\r\n', stderr: '', truncated: false
  });
});

test('hides split protocol markers while keeping forwarded command output visible', () => {
  const id = '0123456789abcdef01234567';
  const plan = terminalForwardingCommand('printf hello', '/work', id);
  const capture = new TerminalCommandOutputCapture(plan.startMarker, plan.endMarkerPrefix, 1024);
  assert.equal(capture.visibleOutput(`prompt ${plan.startMarker.slice(0, 8)}`), '');
  assert.equal(capture.visibleOutput(`${plan.startMarker.slice(8)}hello${plan.endMarkerPrefix}`), 'prompt hello');
  assert.equal(capture.visibleOutput('0\x1fprompt$ '), 'prompt$ ');
});

test('bounds captured terminal output while continuing to find its end marker', () => {
  const id = 'fedcba9876543210fedcba98';
  const plan = terminalForwardingCommand('yes', '/work', id);
  const capture = new TerminalCommandOutputCapture(plan.startMarker, plan.endMarkerPrefix, 5);
  assert.equal(capture.push(`${plan.startMarker}abcdefghij`), undefined);
  assert.deepEqual(capture.push(`${plan.endMarkerPrefix}0\x1f`), {
    exitCode: 0, stdout: 'abcde', stderr: '', truncated: true
  });
});

test('rejects malformed terminal exit markers', () => {
  const id = 'abcdef0123456789abcdef01';
  const plan = terminalForwardingCommand('true', '/work', id);
  const capture = new TerminalCommandOutputCapture(plan.startMarker, plan.endMarkerPrefix, 10);
  assert.throws(
    () => capture.push(`${plan.startMarker}${plan.endMarkerPrefix}bad\x1f`),
    /invalid command exit code/
  );
});
