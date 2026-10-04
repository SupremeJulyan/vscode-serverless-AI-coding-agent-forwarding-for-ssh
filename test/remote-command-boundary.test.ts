import assert from 'node:assert/strict';
import test from 'node:test';
import { remoteCommandBoundaryViolation } from '../src/remote-command-boundary';

const root = '/A/B';

test('rejects common remote shell writes outside the selected workspace', () => {
  assert.deepEqual(remoteCommandBoundaryViolation('npm test', root, '/A'), {
    kind: 'working-directory', target: '/A'
  });
  for (const command of [
    "printf '%s' content > /A/created.txt",
    "cat <<'EOF' > ../created.txt\ncontent\nEOF",
    "printf x | tee '/A/created file.txt'",
    'touch ../created.txt',
    'mkdir -p /A/generated',
    'cp ./source /A/copied',
    'mv /A/existing ./existing',
    'chmod 644 /A/existing',
    'dd if=/dev/zero of=/A/image.bin',
    'cd /A && touch created.txt',
    'true & touch /A/created.txt',
    'printf x > "$OUTPUT_PATH"'
  ]) {
    assert.ok(
      remoteCommandBoundaryViolation(command, root, root),
      `expected an outside-workspace violation: ${command}`
    );
  }
});

test('allows commands and explicit write targets that stay inside the workspace', () => {
  for (const command of [
    'npm test',
    'cat /A/shared-read-only.txt',
    'grep rm /A/shared-read-only.txt',
    'echo touch /A/shared-read-only.txt',
    'echo cd /A',
    'touch /A/B/created.txt',
    'mkdir -p ./generated',
    'rm -rf ./dist',
    'cp /A/shared-read-only.txt ./copy.txt',
    'cd /A/B/sub && printf x > ../result.txt',
    'grep TODO /A/shared-read-only.txt > ./report.txt',
    'printf error >&2',
    'printf ignored > /dev/null'
  ]) {
    assert.equal(
      remoteCommandBoundaryViolation(command, root, root),
      undefined,
      `expected an in-workspace command: ${command}`
    );
  }
});
