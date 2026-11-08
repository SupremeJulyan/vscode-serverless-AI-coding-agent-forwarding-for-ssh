import type { RemoteGit } from './remote-git';
import type { LocalGitRunner } from './local-git-push';

const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** Bounded candidates include cached tips and recent fetched history; shallow operations use full bundles. */
export async function relayBundleExclusions(
  local: LocalGitRunner, repository: string, shallow: boolean, signal?: AbortSignal
): Promise<string[]> {
  if (shallow) return [];
  const output = await local(['-C', repository, 'rev-list', '--max-count=64', '--all'], signal);
  return [...new Set(output.trim().split('\n').filter(oid => objectId.test(oid)))];
}

/** Exclude only immutable commits present at both ends; no common commit means a full bundle. */
export async function createRemoteGitBundle(
  git: RemoteGit, destination: string, ref: string, candidates: readonly string[] = []
): Promise<void> {
  const unique = [...new Set(candidates)].slice(0, 64);
  if (unique.some(oid => !objectId.test(oid))) throw new Error('Invalid Git bundle prerequisite');
  const probes = await git.batch(unique.map(oid => ['rev-parse', '--verify', '--quiet', `${oid}^{commit}`]));
  const exclusions = unique.filter((oid, index) => {
    const probe = probes[index];
    if (probe.exitCode === 1) return false;
    if (probe.exitCode !== 0 || probe.stdout.trim() !== oid) {
      throw new Error(probe.stderr.trim() || 'Cannot verify Git bundle prerequisite');
    }
    return true;
  });
  await git.run(['bundle', 'create', destination, ref, ...(exclusions.length ? ['--not', ...exclusions] : [])]);
}
