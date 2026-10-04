import assert from 'node:assert/strict';
import test from 'node:test';
import { CommandOutputMarkerStripper } from '../src/command-output-marker';

function collect(stripper: CommandOutputMarkerStripper, chunks: string[]): string {
  const output: Buffer[] = [];
  for (const chunk of chunks) output.push(...stripper.push(Buffer.from(chunk)));
  output.push(...stripper.finish());
  return Buffer.concat(output).toString();
}

test('strips repeated MOTD text before a split command marker', () => {
  const marker = '__SAFS_COMMAND_OUTPUT_012345__';
  assert.equal(collect(new CommandOutputMarkerStripper(marker), [
    'account information\nMOTD\naccount information\n__SAFS_COMMAND_',
    'OUTPUT_012345__\nreal output\n'
  ]), 'real output\n');
});

test('accepts CRLF after the marker and preserves later marker-like output', () => {
  const marker = '__SAFS_COMMAND_OUTPUT_abcdef__';
  assert.equal(collect(new CommandOutputMarkerStripper(marker), [
    `banner\r\n${marker}\r`,
    `\n${marker}\nresult`
  ]), `${marker}\nresult`);
});

test('preserves diagnostics when the remote command marker never appears', () => {
  const failure = 'ssh: connect to host failed\n';
  assert.equal(
    collect(new CommandOutputMarkerStripper('__missing__'), [failure]),
    failure
  );
});

test('returns no output when the command writes nothing after its marker', () => {
  const marker = '__SAFS_COMMAND_OUTPUT_empty__';
  assert.equal(collect(new CommandOutputMarkerStripper(marker), [`banner\n${marker}\n`]), '');
});
