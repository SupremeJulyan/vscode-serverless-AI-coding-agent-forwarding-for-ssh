import type { RemoteGit } from './remote-git';

export interface GitSyncState {
  branch: string;
  head?: string;
  upstream?: string;
  upstreamOid?: string;
  ahead?: number;
  behind?: number;
  /** The upstream OID is known from a local relay push but is not present on this host yet. */
  observedUpstream?: boolean;
  kind: 'tracked' | 'unborn' | 'detached' | 'no-upstream' | 'missing-upstream' | 'unknown';
}

export interface ObservedPushState {
  oid: string;
  previousOid?: string;
  pushedCommits: number;
}

export function applyObservedPushState(
  state: GitSyncState, observed: ObservedPushState | undefined
): GitSyncState {
  if (!observed || state.kind !== 'tracked' || state.upstreamOid !== observed.previousOid
    || state.head === observed.oid) return state;
  return {
    ...state, upstreamOid: observed.oid,
    behind: Math.max(1, observed.pushedCommits || 1), observedUpstream: true
  };
}

/** Resolve the configured fetch refspec, including upstreams with a different branch name. */
export async function trackingRef(git: RemoteGit, branch: string): Promise<string | undefined> {
  const result = await git.run(['for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`]);
  return result.trim() || undefined;
}

export async function readGitSyncState(git: RemoteGit): Promise<GitSyncState> {
  const branch = (await git.probe(['symbolic-ref', '--short', '--quiet', 'HEAD']))?.trim();
  const head = (await git.probe(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']))?.trim();
  if (!head) return { branch: branch || 'HEAD', kind: 'unborn' };
  if (!branch) return { branch: 'HEAD', head, kind: 'detached' };
  const upstream = await trackingRef(git, branch);
  if (!upstream) return { branch, head, kind: 'no-upstream' };
  const upstreamOid = (await git.probe(['rev-parse', '--verify', '--quiet', `${upstream}^{commit}`]))?.trim();
  if (!upstreamOid) return { branch, head, upstream, kind: 'missing-upstream' };
  // Compare immutable object IDs so an external fetch cannot mix two snapshots.
  const counts = (await git.run(['rev-list', '--left-right', '--count', `${head}...${upstreamOid}`])).trim().split(/\s+/);
  if (counts.length !== 2 || counts.some(count => !/^\d+$/.test(count))) throw new Error('Invalid Git ahead/behind counts');
  return { branch, head, upstream, upstreamOid, ahead: Number(counts[0]), behind: Number(counts[1]), kind: 'tracked' };
}

export function syncStateLabel(state: GitSyncState): string {
  switch (state.kind) {
    case 'unborn': return '尚无提交';
    case 'detached': return '游离 HEAD · 推送状态未知';
    case 'no-upstream': return '已提交 · 未配置上游';
    case 'missing-upstream': return '上游尚未提取或已删除';
    case 'unknown': return '同步状态读取失败';
    case 'tracked': {
      const labels: string[] = [];
      if (state.ahead) labels.push(`已提交待推送 ↑${state.ahead}`);
      if (state.behind) labels.push(`待拉取 ↓${state.behind}`);
      return labels.length ? labels.join(' · ') : '已推送 · 与上游同步';
    }
  }
}
export function syncStateTooltip(state: GitSyncState): string {
  return `${state.branch}：${syncStateLabel(state)}\n`
    + (state.upstream ? `比较目标：${state.upstream}\n` : '')
    + '相对于最近一次提取/推送记录的上游状态；点击“提取”检查服务器的新提交。';
}
