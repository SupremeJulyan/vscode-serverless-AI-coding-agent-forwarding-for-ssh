import { trackingRef } from './git-sync-state';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { RemoteGit } from './remote-git';
import { LocalGitRunner, declareShallowBoundaries, validateFetchUrl } from './local-git-push';

export interface PullTarget {
  /** 远端当前分支：合并目标，也是中转包携带的分支名。 */
  branch: string;
  /** 远端配置的 remote 名，用于在远端更新 `refs/remotes/<remote>/<branch>`。 */
  remote: string;
  tracking: string;
  /** 上游分支的完整 ref，本地按它取新提交。 */
  upstream: string;
  /** 本地 Git 要连接的地址（远端仓库的 fetch URL）。 */
  url: string;
  /** 远端分支当前提交，传输前后都按它校验。 */
  oid: string;
  objectFormat: 'sha1' | 'sha256';
}

/**
 * 解析拉取目标：与 `git pull` 一致，当前分支必须有上游
 * （`branch.<name>.remote` + `branch.<name>.merge`），否则宁可不做。
 */
export async function resolvePullTarget(git: RemoteGit): Promise<PullTarget> {
  const ref = (await git.run(['symbolic-ref', '--quiet', 'HEAD'])).trim();
  if (!ref.startsWith('refs/heads/')) throw new Error('请先切换到要拉取的分支。');
  const branch = ref.slice('refs/heads/'.length);
  const remote = await git.config(`branch.${branch}.remote`);
  const merge = await git.config(`branch.${branch}.merge`);
  if (!remote || remote === '.' || !merge?.startsWith('refs/heads/')) {
    throw new Error('当前分支没有上游分支：请在远端终端执行 git branch --set-upstream-to=<远程>/<分支>。');
  }
  await git.run(['check-ref-format', merge]);
  let urls: string[];
  try {
    urls = (await git.run(['remote', 'get-url', '--all', remote])).trim().split('\n').filter(Boolean);
  } catch {
    throw new Error(`远端仓库 ${remote} 不存在：请检查当前分支的上游配置。`);
  }
  if (urls.length !== 1) throw new Error('仓库配置了多个 fetch URL，无法确定本地中转地址。');
  try {
    validateFetchUrl(urls[0]);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}`
      + `来源：远端 remote.${remote}.url。`);
  }
  const oid = (await git.run(['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) throw new Error('Invalid Git commit ID');
  const tracking = await trackingRef(git, branch);
  if (!tracking) throw new Error('上游没有对应的 fetch refspec，请检查远端仓库配置。');
  return { branch, remote, tracking, upstream: merge, url: urls[0], oid, objectFormat: oid.length === 64 ? 'sha256' : 'sha1' };
}

/** 本地凭据缺失时的提示：中转拉取的取新提交发生在本地，这是最常见的失败。 */
export function describeFetchFailure(url: string, message: string): string {
  if (/could not read Username|terminal prompts disabled|Authentication failed|Permission denied \(publickey\)/i.test(message)) {
    return `本地 Git 无法认证 ${url}：请先在本地配置凭据（credential helper），或改用本地可达的 SSH 地址`
      + `（如 git@host:path，或用 url.<base>.insteadOf 重写）。原始错误：${message}`;
  }
  return message;
}

export interface LocalPullOptions {
  storagePath: string;
  target: PullTarget;
  local: LocalGitRunner;
  /** 远端是浅克隆时的边界提交（`resolveShallowBoundaries`）；中转仓库要先声明同样的边界。 */
  shallowBoundaries?: string[];
  /** 远端生成当前分支的完整 bundle 并传到本地；调用方负责远端临时文件的清理。 */
  downloadBundle: (destination: string) => Promise<void>;
  /** 把增量 bundle 传回远端，在远端 fetch 后 --ff-only 合并到当前分支，并校验提交 ID。 */
  deliverBundle: (source: string, expected: string) => Promise<void>;
  signal?: AbortSignal;
  report?: (message: string) => void;
}

export interface LocalPullResult { status: 'up-to-date' | 'merged' | 'fetched'; oid: string; upstreamOid?: string }

/**
 * 经本地 Git 拉取：远端不出网、没有凭据也能更新。
 *
 * 顺序刻意是先本地取上游、再下载远端历史：远端提交 ID 在 resolvePullTarget
 * 里已经拿到，已是最新时连 bundle 都不用传。
 */
export async function pullThroughLocalGit(options: LocalPullOptions): Promise<LocalPullResult> {
  const { target, local, signal } = options;
  await local(['--version'], signal); // Fail before creating a potentially large remote bundle.
  await mkdir(options.storagePath, { recursive: true });
  const directory = await mkdtemp(path.join(options.storagePath, 'pull-'));
  try {
    const repository = path.join(directory, 'relay.git');
    const base = path.join(directory, 'remote.bundle');
    const delta = path.join(directory, 'delta.bundle');
    await local(['init', '--bare', `--object-format=${target.objectFormat}`, repository], signal);
    options.report?.('正在用本地 Git 和凭据获取上游提交…');
    try {
      await local(['-C', repository, 'fetch', '--progress', '--no-tags', target.url,
        `${target.upstream}:refs/heads/safs-pull`], signal, options.report);
    } catch (error) {
      throw new Error(describeFetchFailure(target.url, error instanceof Error ? error.message : String(error)));
    }
    const fetched = (await local(['-C', repository, 'rev-parse', 'refs/heads/safs-pull'], signal)).trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(fetched)) throw new Error('Invalid Git commit ID');
    if (fetched === target.oid) {
      options.report?.('已是最新提交，无需拉取。');
      return { status: 'up-to-date', oid: fetched, upstreamOid: fetched };
    }
    options.report?.('正在通过 SAFS 下载远端提交历史…');
    await options.downloadBundle(base);
    signal?.throwIfAborted();
    // 本地先拿到远端已有的对象，才能只把「远端还没有的部分」传回去。
    // 浅克隆的远端 bundle 只到边界提交为止：声明同样的边界，导入才不会缺父对象。
    await declareShallowBoundaries(repository, options.shallowBoundaries);
    await local(['-C', repository, 'fetch', '--no-tags', base,
      `refs/heads/${target.branch}:refs/heads/safs-base`], signal);
    const imported = (await local(['-C', repository, 'rev-parse', 'refs/heads/safs-base'], signal)).trim();
    if (imported !== target.oid) throw new Error('传输期间远端分支发生变化，请重新拉取。');
    // 快进判定在本地做：分叉时不必先把增量传回远端再失败。
    // incoming = 上游有、远端没有的提交；outgoing = 远端有、上游没有的提交。
    // incoming > 0 且 outgoing = 0 时 base 是 pull 的祖先，可快进。
    const count = async (range: string) => Number((await local([
      '-C', repository, 'rev-list', '--count', range], signal)).trim());
    const incoming = await count('refs/heads/safs-base..refs/heads/safs-pull');
    const outgoing = await count('refs/heads/safs-pull..refs/heads/safs-base');
    if (!Number.isFinite(incoming) || !Number.isFinite(outgoing)) {
      throw new Error('无法比较远端分支与上游分支。');
    }
    if (incoming === 0) {
      // 上游提交都已在远端分支里（远端更靠前，或上游被回退）：与 git pull --ff-only 一样什么都不做。
      options.report?.('远端分支已包含上游的全部提交，无需合并。');
      return { status: 'up-to-date', oid: target.oid, upstreamOid: fetched };
    }
    if (outgoing > 0) {
      throw new Error('远端分支与上游已分叉，无法快进合并；请在远端终端手动处理。');
    }
    await local(['-C', repository, 'bundle', 'create', delta, 'refs/heads/safs-pull',
      '--not', 'refs/heads/safs-base'], signal);
    signal?.throwIfAborted();
    options.report?.('正在把上游提交传回远端…');
    await options.deliverBundle(delta, fetched);
    return { status: 'merged', oid: fetched, upstreamOid: fetched };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export interface FetchTarget {
  /** 远端当前分支（决定默认的跟踪 ref 名）。 */
  branch: string;
  remote: string;
  /** 上游分支的完整 ref。 */
  upstream: string;
  /** 远端要更新的远程跟踪 ref。 */
  tracking: string;
  url: string;
  /** 远端跟踪 ref 当前指向；不存在时 undefined（首次提取发全量包）。 */
  base?: string;
  objectFormat: 'sha1' | 'sha256';
}

/** 提取只更新当前分支的远程跟踪 ref，不动工作区；同样要求当前分支有上游。 */
export async function resolveFetchTarget(git: RemoteGit): Promise<FetchTarget> {
  const pull = await resolvePullTarget(git);
  const tracking = pull.tracking;
  await git.run(['check-ref-format', tracking]);
  const value = (await git.probe(['rev-parse', '--verify', '--quiet', `${tracking}^{commit}`]))?.trim();
  if (value && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error('Invalid Git commit ID');
  return {
    branch: pull.branch, remote: pull.remote, upstream: pull.upstream, tracking,
    url: pull.url, base: value || undefined, objectFormat: pull.objectFormat
  };
}

export interface LocalFetchOptions {
  storagePath: string;
  target: FetchTarget;
  local: LocalGitRunner;
  /** 远端是浅克隆时的边界提交（`resolveShallowBoundaries`）；中转仓库要先声明同样的边界。 */
  shallowBoundaries?: string[];
  /** 远端把当前跟踪 ref 打成 bundle 传回本地；base 不存在时不会调用。 */
  downloadBundle: (destination: string) => Promise<void>;
  /** 把增量 bundle 传回远端并更新跟踪 ref；调用方负责校验它已指向 expected。 */
  deliverBundle: (source: string, expected: string) => Promise<void>;
  /** 远端已有全部所需对象时（上游被回退到远端已有的提交）只更新跟踪 ref。 */
  updateRef: (oid: string) => Promise<void>;
  signal?: AbortSignal;
  report?: (message: string) => void;
}

/**
 * 经本地 Git 提取上游更新：远端不出网、没有凭据也能更新远程跟踪 ref。
 *
 * 与拉取共用同一套机制，区别是不做合并：允许上游被回退（跟踪 ref 用 `+` 强制更新），
 * 工作区与当前分支完全不动。
 */
export async function fetchThroughLocalGit(options: LocalFetchOptions): Promise<LocalPullResult> {
  const { target, local, signal } = options;
  await local(['--version'], signal);
  await mkdir(options.storagePath, { recursive: true });
  const directory = await mkdtemp(path.join(options.storagePath, 'fetch-'));
  try {
    const repository = path.join(directory, 'relay.git');
    const base = path.join(directory, 'remote.bundle');
    const delta = path.join(directory, 'delta.bundle');
    await local(['init', '--bare', `--object-format=${target.objectFormat}`, repository], signal);
    options.report?.('正在用本地 Git 和凭据获取上游提交…');
    try {
      await local(['-C', repository, 'fetch', '--progress', '--no-tags', target.url,
        `${target.upstream}:refs/heads/safs-pull`], signal, options.report);
    } catch (error) {
      throw new Error(describeFetchFailure(target.url, error instanceof Error ? error.message : String(error)));
    }
    const fetched = (await local(['-C', repository, 'rev-parse', 'refs/heads/safs-pull'], signal)).trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(fetched)) throw new Error('Invalid Git commit ID');
    if (fetched === target.base) {
      options.report?.('远程跟踪引用已是最新。');
      return { status: 'up-to-date', oid: fetched };
    }
    if (target.base) {
      options.report?.('正在通过 SAFS 下载远端跟踪引用…');
      await options.downloadBundle(base);
      signal?.throwIfAborted();
      // 本地先拿到远端已有的对象，才能只把「远端还没有的部分」传回去。
      // 浅克隆的远端 bundle 只到边界提交为止：声明同样的边界，导入才不会缺父对象。
      await declareShallowBoundaries(repository, options.shallowBoundaries);
      await local(['-C', repository, 'fetch', '--no-tags', base,
        `${target.tracking}:refs/heads/safs-base`], signal);
      const imported = (await local(['-C', repository, 'rev-parse', 'refs/heads/safs-base'], signal)).trim();
      if (imported !== target.base) throw new Error('传输期间远端跟踪引用发生变化，请重新提取。');
      // 上游被回退到远端已有的提交时没有任何对象要传，而且 bundle 也不允许为空：
      // 这种情况只把跟踪 ref 指过去。（`safs-base..safs-pull` 为空即 pull ⊆ base。）
      const incoming = Number((await local(['-C', repository, 'rev-list', '--count',
        'refs/heads/safs-base..refs/heads/safs-pull'], signal)).trim());
      if (!Number.isFinite(incoming)) throw new Error('无法比较远端跟踪引用与上游分支。');
      if (incoming === 0) {
        options.report?.('上游提交远端都已具备，只更新跟踪引用。');
        await options.updateRef(fetched);
        return { status: 'fetched', oid: fetched };
      }
      await local(['-C', repository, 'bundle', 'create', delta,
        'refs/heads/safs-pull', '--not', 'refs/heads/safs-base'], signal);
    } else {
      // 远端还没有这条跟踪 ref：没有可用的前置提交，只能发全量包。
      await local(['-C', repository, 'bundle', 'create', delta, 'refs/heads/safs-pull'], signal);
    }
    signal?.throwIfAborted();
    options.report?.('正在把上游提交传回远端…');
    await options.deliverBundle(delta, fetched);
    return { status: 'fetched', oid: fetched };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
