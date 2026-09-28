import { shellQuote } from './shell-quote';

export interface GitResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated?: boolean;
}
export type GitRunner = (command: string) => Promise<GitResult>;
export interface GitChange { index: string; working: string; path: string; originalPath?: string }

/** Porcelain -z preserves whitespace, newlines, Unicode and literal pathspec characters. */
export function parseGitStatus(output: string): GitChange[] {
  const records = output.split('\0');
  const changes: GitChange[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.length < 4 || record[2] !== ' ') throw new Error('Invalid Git status output');
    const change: GitChange = { index: record[0], working: record[1], path: record.slice(3) };
    if (/[RC]/.test(change.index + change.working)) {
      change.originalPath = records[++i];
      if (!change.originalPath) throw new Error('Incomplete Git rename status');
    }
    changes.push(change);
  }
  return changes;
}
export function isGitConflict(change: GitChange): boolean {
  return ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(change.index + change.working);
}
export function gitCommand(args: string[]): string {
  return `GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 git --no-pager --literal-pathspecs ${args.map(shellQuote).join(' ')}`;
}

export class RemoteGit {
  constructor(private readonly runner: GitRunner) {}
  async run(args: string[]): Promise<string> {
    const result = await this.runner(gitCommand(args));
    if (result.truncated) throw new Error('Git output exceeded the capture limit; result was not used.');
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `Git failed (${result.exitCode})`);
    return result.stdout;
  }
  async config(key: string): Promise<string | undefined> {
    const result = await this.runner(gitCommand(['config', '--get', key]));
    if (result.exitCode === 1 && !result.truncated) return undefined;
    if (result.exitCode !== 0 || result.truncated) throw new Error(result.stderr.trim() || 'Cannot read Git configuration');
    return result.stdout.replace(/\r?\n$/, '');
  }
  async status(): Promise<GitChange[]> {
    return parseGitStatus(await this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all']));
  }
  async stage(changes: GitChange[]): Promise<void> {
    const paths = changes.flatMap(c => c.originalPath ? [c.path, c.originalPath] : [c.path]);
    if (paths.length) await this.run(['add', '--', ...new Set(paths)]);
  }
  async unstage(changes: GitChange[]): Promise<void> {
    const paths = [...new Set(changes.flatMap(c => c.originalPath ? [c.path, c.originalPath] : [c.path]))];
    if (!paths.length) return;
    const probe = await this.runner(gitCommand(['rev-parse', '--verify', '--quiet', 'HEAD']));
    if (probe.truncated || (probe.exitCode !== 0 && probe.exitCode !== 1)) {
      throw new Error(probe.stderr.trim() || 'Cannot determine Git HEAD');
    }
    const head = probe.exitCode === 0;
    // Before the first commit there is no HEAD to restore from. Remove only index entries.
    await this.run(head ? ['reset', 'HEAD', '--', ...paths] : ['rm', '--cached', '-f', '--', ...paths]);
  }
  async commit(message: string): Promise<void> {
    if (!message.trim()) throw new Error('请输入提交说明。');
    await this.run(['-c', 'core.editor=true', 'commit', '-m', message]);
  }
}
