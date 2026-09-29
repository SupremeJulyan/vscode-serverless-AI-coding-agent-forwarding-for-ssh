import { trackingRef } from './git-sync-state';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { RemoteGit } from './remote-git';
import { executeCaptured } from './process';
import { redactSensitiveText } from './redact';

const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/**
 * 浅克隆的远端只能打出到边界提交为止的 bundle：bundle 自己仍声称「完整历史」，
 * 但边界提交的父对象并不在里面，本地导入会以
 * 「Could not read <父提交>／Failed to traverse parents of commit <边界提交>／
 * did not send all necessary objects」失败。
 *
 * 中转仓库先声明同样的浅边界，遍历到此为止，导入就能通过；
 * 推送时这些边界会作为 shallow 行发给对端，对端需要已有边界之前的对象。
 */
export async function declareShallowBoundaries(
  repository: string, boundaries: readonly string[] | undefined
): Promise<void> {
  const entries = [...new Set((boundaries ?? []).map(boundary => boundary.trim()).filter(Boolean))];
  if (!entries.length) return;
  for (const entry of entries) if (!objectId.test(entry)) throw new Error('Invalid Git commit ID');
  await writeFile(path.join(repository, 'shallow'), `${entries.join('\n')}\n`);
}

/** 远端的浅克隆边界提交：与远端 `.git/shallow` 一致，按要被中转的 ref 取；完整仓库返回空数组。 */
export async function resolveShallowBoundaries(git: RemoteGit, ref: string): Promise<string[]> {
  // 老版本 Git 不认识这个选项：当作完整仓库（真正的错误随后照常报出）。
  const kind = await git.run(['rev-parse', '--is-shallow-repository']).catch(() => 'false');
  if (kind.trim() !== 'true') return [];
  const output = (await git.run(['rev-list', '--max-parents=0', ref])).trim();
  return output ? output.split('\n').map(line => line.trim()).filter(Boolean) : [];
}

/**
 * 推送失败时的浅克隆说明：中转仓库只有边界往上的历史，
 * 目标仓库若没有边界之前的对象，对端会以 shallow update not allowed 或
 * did not send all necessary objects 拒绝——报错本身看不出这层原因。
 */
export function describeShallowPushFailure(boundaries: readonly string[] | undefined, message: string): string {
  if (!boundaries?.length) return message;
  if (!/shallow|necessary objects|non-fast-forward|fetch first|rejected/i.test(message)) return message;
  const ids = boundaries.map(boundary => boundary.slice(0, 12)).join('、');
  return `${message}（远端仓库是浅克隆，历史在 ${ids} 处被截断；`
    + `目标仓库若没有边界之前的对象就无法完成推送，可先在远端执行 git fetch --unshallow 后重试。）`;
}

export interface PushTarget {
  branch: string;
  destination: string;
  url: string;
  oid: string;
  objectFormat: 'sha1' | 'sha256';
  tracking?: string;
  trackingOid?: string;
  outgoingCommits?: number;
}

export interface SuccessfulPushReceipt {
  key: string;
  oid: string;
  previousOid?: string;
  pushedCommits: number;
  recordedAt: number;
}

/** Hash the destination so persisted receipts never contain credential-bearing Git URLs. */
export function pushReceiptKey(target: Pick<PushTarget, 'url' | 'destination'>): string {
  return createHash('sha256').update(target.url).update('\0').update(target.destination).digest('hex');
}

export function successfulPushReceipt(target: PushTarget): SuccessfulPushReceipt | undefined {
  if (!target.tracking) return undefined;
  return {
    key: pushReceiptKey(target), oid: target.oid,
    previousOid: target.trackingOid,
    pushedCommits: Math.max(1, target.outgoingCommits ?? 1), recordedAt: Date.now()
  };
}

/** 中转必须连网络地址：远端文件系统路径或自定义 helper 不能被本地 Git 当成目标。 */
function isNetworkGitUrl(url: string): boolean {
  if (/[\r\n\0]/.test(url) || url.startsWith('-')) return false;
  if (/^(https?|ssh|git):\/\/[^/]+\/.+/.test(url)) return true;
  return !url.includes('://') && /^(?:[^@\s/:]+@)?[^\s/:]+:.+/.test(url)
    && !/^[A-Za-z]:/.test(url) && !url.includes('::');
}

/**
 * 报错里回显读到的地址：脱敏，并把换行等控制字符写成转义——
 * 否则「带换行的地址」在通知里看起来和正常地址一模一样，没法排查。
 */
export function describeRejectedUrl(url: string): string {
  const escaped = redactSensitiveText(url).replace(
    /[\u0000-\u001f\u007f]/g,
    character => `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`
  );
  return escaped.length > 200 ? `${escaped.slice(0, 200)}…` : escaped;
}

/** A remote filesystem path or custom helper must never become a local push destination. */
export function validatePushUrl(url: string): void {
  if (!isNetworkGitUrl(url)) {
    throw new Error(`本地中转需要 HTTPS / SSH Git 地址；远端文件路径不能作为本地推送地址`
      + `（读到：${describeRejectedUrl(url)}）。可设置 safs.git.pushUrl。`);
  }
}

/** 拉取方向同理：远端仓库的 fetch URL 也不能是它自己的文件路径。 */
export function validateFetchUrl(url: string): void {
  if (!isNetworkGitUrl(url)) {
    throw new Error(`本地中转需要 HTTPS / SSH Git 地址；远端文件路径不能作为本地拉取地址`
      + `（读到：${describeRejectedUrl(url)}）。`);
  }
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
  try {
    validatePushUrl(urls[0]);
  } catch (error) {
    // 报出地址是谁给的，省得对着一条看不出毛病的地址猜来源。
    throw new Error(`${error instanceof Error ? error.message : String(error)}`
      + `来源：${overrideUrl ? 'safs.git.pushUrl' : `远端 remote.${remote}.pushurl / url`}。`);
  }
  const oid = (await git.run(['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  if (!objectId.test(oid)) throw new Error('Invalid Git commit ID');
  // Only update fetch tracking when push and fetch refer to exactly the same destination.
  // A fork/pushUrl override must not make an unrelated upstream appear synchronized.
  let tracking: string | undefined;
  let trackingOid: string | undefined;
  let outgoingCommits: number | undefined;
  if (remote && upstreamRemote === remote && merge === destination) {
    const fetchUrl = (await git.run(['remote', 'get-url', remote])).trim();
    if (fetchUrl === urls[0]) {
      tracking = await trackingRef(git, branch);
      if (tracking) trackingOid = (await git.probe(['rev-parse', '--verify', '--quiet', tracking]))?.trim();
      if (trackingOid) {
        const count = (await git.run(['rev-list', '--count', `${trackingOid}..${oid}`])).trim();
        if (!/^\d+$/.test(count)) throw new Error('Invalid Git outgoing commit count');
        outgoingCommits = Number(count);
      }
    }
  }
  return {
    branch, destination, url: urls[0], oid,
    objectFormat: oid.length === 64 ? 'sha256' : 'sha1',
    tracking, trackingOid, outgoingCommits
  };
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
  /** 远端是浅克隆时的边界提交（`resolveShallowBoundaries`）；中转仓库要先声明同样的边界。 */
  shallowBoundaries?: string[];
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
    // 浅克隆远端的 bundle 只到边界提交为止：先声明边界，导入才不会缺父对象。
    await declareShallowBoundaries(repository, options.shallowBoundaries);
    await local(['-C', repository, 'fetch', '--no-tags', bundle,
      `refs/heads/${target.branch}:refs/heads/safs-push`], signal);
    const imported = (await local(['-C', repository, 'rev-parse', 'refs/heads/safs-push'], signal)).trim();
    if (imported !== target.oid) throw new Error('传输期间远端分支发生变化，请重新推送。');
    options.report?.('正在使用本地 Git 和凭据推送…');
    // Explicit one-branch refspec; never inherit mirror/force/all behavior from the remote repo.
    try {
      await local(['-C', repository, '-c', 'push.followTags=false', 'push', '--porcelain',
        '--', target.url, `${target.oid}:${target.destination}`], signal);
    } catch (error) {
      throw new Error(describeShallowPushFailure(
        options.shallowBoundaries, error instanceof Error ? error.message : String(error)));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Compare-and-swap avoids overwriting a concurrent fetch with an older push receipt. */
export async function recordSuccessfulPush(git: RemoteGit, target: PushTarget): Promise<void> {
  if (!target.tracking) return;
  await git.run(['update-ref', target.tracking, target.oid,
    target.trackingOid ?? '0'.repeat(target.oid.length)]);
}

/**
 * Carry a successful local relay push to another SAFS host that has the same
 * commit checked out but still has the exact pre-push tracking ref. Matching
 * the old ref makes this safe when that host has fetched newer upstream state.
 */
export async function applySuccessfulPushReceipt(
  git: RemoteGit, target: PushTarget, receipt: SuccessfulPushReceipt | undefined
): Promise<'applied' | 'missing-object' | false> {
  if (!receipt || !target.tracking || receipt.key !== pushReceiptKey(target)
    || receipt.previousOid !== target.trackingOid) return false;
  const available = (await git.probe([
    'rev-parse', '--verify', '--quiet', `${receipt.oid}^{commit}`
  ]))?.trim() === receipt.oid;
  if (!available) return 'missing-object';
  await recordSuccessfulPush(git, { ...target, oid: receipt.oid });
  return 'applied';
}
