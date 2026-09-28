import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { RemoteGit } from './remote-git';
import { executeCaptured } from './process';

export interface PushTarget {
  branch: string;
  destination: string;
  url: string;
  oid: string;
  objectFormat: 'sha1' | 'sha256';
}

/** A remote filesystem path or custom helper must never become a local push destination. */
export function validatePushUrl(url: string): void {
  if (/[\r\n\0]/.test(url) || url.startsWith('-')) throw new Error('无效的 Git 推送地址。');
  if (/^(https?|ssh|git):\/\/[^/]+\/.+/.test(url)) return;
  if (!url.includes('://') && /^(?:[^@\s/:]+@)?[^\s/:]+:.+/.test(url)
      && !/^[A-Za-z]:/.test(url) && !url.includes('::')) return;
  throw new Error('本地中转需要 HTTPS / SSH Git 地址；远端文件路径不能作为本地推送地址。可设置 safs.git.pushUrl。');
}

export async function resolvePushTarget(git: RemoteGit, overrideUrl?: string): Promise<PushTarget> {
  const ref = (await git.run(['symbolic-ref', '--quiet', 'HEAD'])).trim();
  if (!ref.startsWith('refs/heads/')) throw new Error('请先切换到要推送的分支。');
  const branch = ref.slice('refs/heads/'.length);
  const upstreamRemote = await git.config(`branch.${branch}.remote`);
  let remote = await git.config(`branch.${branch}.pushRemote`)
    ?? await git.config('remote.pushDefault') ?? upstreamRemote;
  if (!remote) {
    const remotes = (await git.run(['remote'])).trim().split('\n').filter(Boolean);
    remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : undefined;
  }
  if ((!remote || remote === '.') && !overrideUrl) throw new Error('请配置远端仓库的 origin，或设置 safs.git.pushUrl。');
  const merge = upstreamRemote === remote ? await git.config(`branch.${branch}.merge`) : undefined;
  const destination = merge ?? ref;
  if (!destination.startsWith('refs/heads/')) throw new Error('推送目标必须是分支。');
  await git.run(['check-ref-format', destination]);
  const urls = overrideUrl ? [overrideUrl] : (await git.run(['remote', 'get-url', '--push', '--all', remote!])).trim().split('\n');
  if (urls.length !== 1) throw new Error('仓库有多个 push URL，请用 safs.git.pushUrl 指定本次推送地址。');
  validatePushUrl(urls[0]);
  const oid = (await git.run(['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) throw new Error('Invalid Git commit ID');
  return { branch, destination, url: urls[0], oid, objectFormat: oid.length === 64 ? 'sha256' : 'sha1' };
}

export type LocalGitRunner = (args: string[], signal?: AbortSignal) => Promise<string>;

/** Run where the extension host lives, preserving its credential helper and SSH agent. */
export function localGitRunner(executable = 'git'): LocalGitRunner {
  return async (args, signal) => {
    signal?.throwIfAborted();
    const result = await executeCaptured({
      command: executable, args,
      env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }
    }, signal);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `Local Git failed (${result.exitCode})`);
    if (result.truncated) throw new Error('Local Git output exceeded the capture limit.');
    return result.stdout;
  };
}

export interface LocalPushOptions {
  storagePath: string;
  target: PushTarget;
  local: LocalGitRunner;
  /** Creates and transfers a full branch bundle using the existing SAFS transport. */
  downloadBundle: (destination: string) => Promise<void>;
  signal?: AbortSignal;
  report?: (message: string) => void;
}

/** Isolated per operation, so concurrent windows cannot overwrite each other's refs. */
export async function pushThroughLocalGit(options: LocalPushOptions): Promise<void> {
  const { target, local, signal } = options;
  await local(['--version'], signal); // Fail before creating a potentially large remote bundle.
  await mkdir(options.storagePath, { recursive: true });
  const directory = await mkdtemp(path.join(options.storagePath, 'push-'));
  try {
    const repository = path.join(directory, 'relay.git');
    const bundle = path.join(directory, 'commits.bundle');
    options.report?.('正在通过 SAFS 下载提交历史…');
    await options.downloadBundle(bundle);
    signal?.throwIfAborted();
    await local(['init', '--bare', `--object-format=${target.objectFormat}`, repository], signal);
    await local(['-C', repository, 'fetch', '--no-tags', bundle,
      `refs/heads/${target.branch}:refs/heads/safs-push`], signal);
    const imported = (await local(['-C', repository, 'rev-parse', 'refs/heads/safs-push'], signal)).trim();
    if (imported !== target.oid) throw new Error('传输期间远端分支发生变化，请重新推送。');
    options.report?.('正在使用本地 Git 和凭据推送…');
    // Explicit one-branch refspec; never inherit mirror/force/all behavior from the remote repo.
    await local(['-C', repository, '-c', 'push.followTags=false', 'push', '--porcelain',
      '--', target.url, `${target.oid}:${target.destination}`], signal);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
