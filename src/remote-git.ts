import { operationMetric } from './operation-metric';
import { shellQuote } from './shell-quote';
import { randomBytes } from 'node:crypto';

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
  private readonly runner: GitRunner;
  constructor(runner: GitRunner, log?: (message: string) => void) {
    this.runner = async command => {
      const started = performance.now();
      try {
        const result = await runner(command);
        operationMetric(log, 'git.remote.command', started,
          Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr));
        return result;
      } catch (error) {
        operationMetric(log, 'git.remote.command', started);
        throw error;
      }
    };
  }
  /** Frame read-only command results in one SSH exec, preserving each exit status and NUL data. */
  async batch(commands: string[][]): Promise<GitResult[]> {
    if (!commands.length) return [];
    const marker = `SAFS_GIT_${randomBytes(16).toString('hex')}`;
    const script = commands.map(args =>
      `${gitCommand(args)}; printf '\\000${marker}:%s\\000' "$?"`
    ).join('\n');
    const result = await this.runner(script);
    if (result.truncated) throw new Error('Git output exceeded the capture limit; result was not used.');
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Git batch transport failed');
    const pattern = new RegExp(`\\x00${marker}:(\\d+)\\x00`, 'g');
    const values: GitResult[] = [];
    let offset = 0;
    for (const match of result.stdout.matchAll(pattern)) {
      values.push({ stdout: result.stdout.slice(offset, match.index), stderr: result.stderr,
        exitCode: Number(match[1]) });
      offset = match.index! + match[0].length;
    }
    if (values.length !== commands.length || offset !== result.stdout.length) {
      throw new Error('Incomplete Git batch response');
    }
    return values;
  }
  async configMany(keys: string[]): Promise<Array<string | undefined>> {
    return (await this.batch(keys.map(key => ['config', '--get', key]))).map(result => {
      if (result.exitCode === 1) return undefined;
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Cannot read Git configuration');
      return result.stdout.replace(/\r?\n$/, '');
    });
  }
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
  /** 允许"不存在"的探测（`rev-parse --verify --quiet`）：退出码 1 返回 undefined，其它错误照抛。 */
  async probe(args: string[]): Promise<string | undefined> {
    const result = await this.runner(gitCommand(args));
    if (result.truncated) throw new Error('Git output exceeded the capture limit; result was not used.');
    if (result.exitCode === 1) return undefined;
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `Git failed (${result.exitCode})`);
    return result.stdout;
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
    // Nearly every repository has HEAD. Try the normal operation immediately so
    // cancelling staging costs one remote round trip instead of probing first.
    try {
      await this.run(['reset', 'HEAD', '--', ...paths]);
      return;
    } catch (resetError) {
      let head: string | undefined;
      try { head = await this.probe(['rev-parse', '--verify', '--quiet', 'HEAD']); }
      catch { throw resetError; }
      if (head) throw resetError;
    }
    // Before the first commit there is no HEAD to restore from. Remove only index entries.
    await this.run(['rm', '--cached', '-f', '--', ...paths]);
  }
  async discard(changes: GitChange[]): Promise<void> {
    const tracked = new Set<string>();
    const untracked = new Set<string>();
    for (const change of changes) {
      const paths = change.originalPath ? [change.path, change.originalPath] : [change.path];
      for (const path of paths) (change.index === '?' ? untracked : tracked).add(path);
    }
    // Worktree changes are restored from the index so partially staged content stays intact.
    if (tracked.size) await this.run(['restore', '--worktree', '--', ...tracked]);
    // `restore` cannot remove untracked files. Git clean keeps literal pathspec handling and
    // removes only the explicitly selected, non-ignored files reported by status.
    if (untracked.size) await this.run(['clean', '-f', '--', ...untracked]);
  }
  async commit(message: string): Promise<void> {
    if (!message.trim()) throw new Error('请输入提交说明。');
    await this.run(['-c', 'core.editor=true', 'commit', '-m', message]);
  }
}
