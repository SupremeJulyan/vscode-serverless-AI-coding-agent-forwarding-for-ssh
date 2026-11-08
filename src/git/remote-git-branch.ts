import type { RemoteGit } from './remote-git';

export interface GitBranch {
  ref: string;
  name: string;
  current: boolean;
  kind: 'local' | 'remote';
  localName?: string;
}

const branchFormat = '%(refname)%00%(refname:short)%00%(HEAD)%00';

export function parseBranches(output: string): GitBranch[] {
  const branches: GitBranch[] = [];
  for (const record of output.split('\n').filter(Boolean)) {
    const [ref, name, head, trailing] = record.split('\0');
    if (trailing !== '') throw new Error('Invalid Git branch output');
    if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/remotes/')) {
      throw new Error('Invalid Git branch reference');
    }
    if (!name || /[\r\n\0]/.test(name)) throw new Error('Invalid Git branch name');
    const kind = ref.startsWith('refs/heads/') ? 'local' : 'remote';
    if (kind === 'remote' && name.endsWith('/HEAD')) continue;
    branches.push({
      ref, name, current: head === '*', kind,
      ...(kind === 'remote' ? { localName: name.slice(name.indexOf('/') + 1) } : {})
    });
  }
  return branches;
}

export async function listBranches(git: RemoteGit): Promise<GitBranch[]> {
  return parseBranches(await git.run([
    'for-each-ref', `--format=${branchFormat}`, 'refs/heads', 'refs/remotes'
  ])).sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1;
    if (left.kind !== right.kind) return left.kind === 'local' ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

export async function switchBranch(git: RemoteGit, branch: GitBranch): Promise<void> {
  if (branch.current) return;
  if (branch.kind === 'local') {
    await git.run(['switch', branch.name]);
    return;
  }
  if (!branch.localName) throw new Error('无法确定本地分支名。');
  await git.run(['check-ref-format', '--branch', branch.localName]);
  const existing = await git.probe([
    'show-ref', '--verify', '--quiet', `refs/heads/${branch.localName}`
  ]);
  if (existing !== undefined) {
    throw new Error(`本地分支 ${branch.localName} 已存在，请刷新后重新选择。`);
  }
  await git.run(['switch', '--track', '-c', branch.localName, branch.name]);
}

export async function createBranch(git: RemoteGit, name: string): Promise<void> {
  const branch = name.trim();
  if (!branch || branch !== name) throw new Error('分支名不能为空或带首尾空格。');
  await git.run(['check-ref-format', '--branch', branch]);
  // `switch -c` is atomic with respect to an existing branch and keeps the
  // current index/worktree. No fetch, checkout force, or reset is involved.
  await git.run(['switch', '-c', branch]);
}
