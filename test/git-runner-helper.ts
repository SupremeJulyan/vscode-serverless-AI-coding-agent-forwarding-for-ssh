import type { GitRunner } from '../src/remote-git';

/** Let existing command-level fixtures also emulate framed multi-command SSH execution. */
export function mockGitBatch(runner: GitRunner): GitRunner {
  return async command => {
    const marker = /SAFS_GIT_[0-9a-f]{32}/.exec(command)?.[0];
    if (!marker) return runner(command);
    let stdout = '', stderr = '';
    for (const line of command.split('\n')) {
      const result = await runner(line.slice(0, line.lastIndexOf('; printf ')));
      if (result.truncated) return result;
      stdout += `${result.stdout}\0${marker}:${result.exitCode}\0`;
      stderr += result.stderr;
    }
    return { exitCode: 0, stdout, stderr };
  };
}
