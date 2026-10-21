import assert from 'node:assert/strict';
import test from 'node:test';
import { configUniquenessTextIssues } from '../src/config-uniqueness';
import { parseConfig } from '../src/config';

test('duplicate IPs with different names highlight both IP fields and reject loading', () => {
  const value = { hosts: [
    { name: 'ls', ip: '10.44.9.4', accounts: [{ user: 'zhuyuan' }] },
    { name: 'ls2', ip: '10.44.9.4', accounts: [{ user: 'test_app' }] }
  ] };
  const text = JSON.stringify(value, null, 2);
  const issues = configUniquenessTextIssues(text);
  assert.equal(issues.length, 2);
  for (const issue of issues) assert.equal(text.slice(issue.offset, issue.offset + issue.length), '"10.44.9.4"');
  assert.throws(() => parseConfig(value), /主机 IP.*重复/);
});

test('duplicate users highlight both account fields even with different legacy names or ports', () => {
  const value = { hosts: [{ name: 'ls', ip: '10.44.9.4', accounts: [
    { name: 'old', user: 'zhuyuan', port: 22 },
    { name: 'other', user: 'zhuyuan', port: 2222 }
  ] }] };
  const text = JSON.stringify(value);
  const issues = configUniquenessTextIssues(text);
  assert.equal(issues.length, 2);
  for (const issue of issues) assert.equal(text.slice(issue.offset, issue.offset + issue.length), '"zhuyuan"');
  assert.throws(() => parseConfig(value), /账号.*重复/);
});

test('different hosts may use the same user and resolved edits clear diagnostics', () => {
  const value = { hosts: [
    { name: 'a', ip: '10.44.9.4', accounts: [{ user: 'zhuyuan' }, { user: 'test_app' }] },
    { name: 'b', ip: '10.44.9.5', accounts: [{ user: 'zhuyuan' }] }
  ] };
  assert.deepEqual(configUniquenessTextIssues(JSON.stringify(value)), []);
  assert.equal(parseConfig(value).hosts.length, 3);
  assert.deepEqual(configUniquenessTextIssues('{"hosts":['), []);
});
