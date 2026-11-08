import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  appendBackendCommandLog, appendBackendToolLog, formatBackendCommandLogLine,
  formatBackendToolLogLine, backendLogDirectory, backendLogFilePath
} from '../src/agent/operation-log';

test('writes redacted commands together with their audit hashes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safs-operation-log-'));
  const now = new Date('2026-08-04T08:00:00.000Z');
  const first = await appendBackendCommandLog({
    source: 'backend',
    agentName: 'MyAgent',
    mountName: 'prod',
    remoteCwd: '/srv/project',
    command: 'git status'
  }, directory, now);
  const second = await appendBackendCommandLog({
    source: 'remote_search',
    mountName: 'prod',
    remoteCwd: '/srv/project',
    command: 'grep -rn "line one\nline two" .'
  }, directory, now);

  assert.deepEqual(await readdir(directory), ['backend-2026-08-04.log']);
  assert.equal(first, path.join(directory, 'backend-2026-08-04.log'));
  assert.equal(second, first);
  const content = await readFile(first, 'utf8');
  assert.match(content, /\[backend\].*command="git status" command_bytes=10 command_sha256=[0-9a-f]{64}/);
  assert.match(content, /\[remote_search\].*command="grep -rn \\"line one\\nline two\\" \." command_bytes=30 command_sha256=[0-9a-f]{64}/);
});

test('persists token-bearing commands only after redaction', () => {
  const line = formatBackendCommandLogLine({
    source: 'backend',
    mountName: 'prod',
    remoteCwd: '/srv/project',
    command: 'curl "http://127.0.0.1:1234/backend?token=secret&x=1"'
  }, new Date('2026-08-04T08:00:00.000Z'));
  assert.match(line, /command_sha256=[0-9a-f]{64}/);
  assert.match(line, /command="curl/);
  assert.match(line, /token=<hidden>/);
  assert.ok(!line.includes('secret'));
});

test('defaults the log directory to ~/.safs/backend_logs', () => {
  assert.equal(
    backendLogDirectory('/home/alice'),
    path.join('/home/alice', '.safs', 'backend_logs')
  );
  assert.equal(
    backendLogFilePath('/home/alice/.safs/backend_logs', new Date('2026-08-04T08:00:00.000Z')),
    path.join('/home/alice/.safs/backend_logs', 'backend-2026-08-04.log')
  );
});

test('logs every tool with Agent identity without storing file content', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safs-backend-tool-log-'));
  const now = new Date('2026-08-25T09:00:00.000Z');
  const line = formatBackendToolLogLine({
    toolName: 'remote_write', agentName: 'codex',
    input: { mountName: 'prod', path: 'notes.txt', content: 'top secret content' }
  }, now);
  assert.match(line, /^2026-08-25T09:00:00\.000Z \[tool=remote_write\] \[agent=codex\]/);
  assert.match(line, /"mountName":"prod"/);
  assert.match(line, /"path":"notes.txt"/);
  assert.match(line, /"contentBytes":18/);
  assert.equal(line.includes('top secret content'), false);

  const editLine = formatBackendToolLogLine({
    toolName: 'remote_edit', agentName: 'codex',
    input: {
      path: 'notes.txt', expectedHash: 'a'.repeat(64),
      edits: [{ oldText: 'private source', newText: 'replacement source' }]
    }
  }, now);
  assert.match(editLine, /"editCount":1/);
  assert.match(editLine, /"expectedHash":"a{64}"/);
  assert.equal(editLine.includes('private source'), false);
  assert.equal(editLine.includes('replacement source'), false);

  const file = await appendBackendToolLog({
    toolName: 'remote_list', agentName: 'opencode',
    input: { mountName: 'yx', path: '.' }
  }, directory, now);
  assert.match(await readFile(file, 'utf8'), /\[tool=remote_list\] \[agent=opencode\]/);
});

test('untagged CLI URLs are explicitly logged as unknown Agent', () => {
  assert.match(formatBackendToolLogLine({
    toolName: 'list_remote_workspaces', input: {}
  }), /\[agent=unknown\]/);
});
