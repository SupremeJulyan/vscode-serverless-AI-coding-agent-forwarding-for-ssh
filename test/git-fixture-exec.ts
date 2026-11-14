import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

const captured = promisify(execFile);
let windowsShell: string | undefined;

/** Run the remote POSIX shell fixtures through Git for Windows on Windows hosts. */
function gitBash(): string {
  if (windowsShell) return windowsShell;
  const gitExecutables = execFileSync('where.exe', ['git.exe'], { encoding: 'utf8' })
    .trim().split(/\r?\n/);
  const candidates = gitExecutables.flatMap(executable => [
    path.resolve(path.dirname(executable), '..', 'bin', 'bash.exe'),
    path.resolve(path.dirname(executable), '..', 'usr', 'bin', 'bash.exe')
  ]);
  windowsShell = candidates.find(existsSync);
  if (!windowsShell) throw new Error('Git test fixtures require Git for Windows with Git Bash');
  return windowsShell;
}

export function execGitFixture(command: string, args: string[], options: { cwd?: string } = {}) {
  return captured(process.platform === 'win32' && command === '/bin/sh' ? gitBash() : command,
    args, {
      ...options, encoding: 'utf8',
      // Keep fixture working copies consistent and prevent fetch/push from
      // leaving detached Git maintenance writing into directories at teardown.
      env: {
        ...process.env, GIT_CONFIG_COUNT: '3',
        GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false',
        GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0',
        GIT_CONFIG_KEY_2: 'maintenance.auto', GIT_CONFIG_VALUE_2: 'false'
      }
    });
}
