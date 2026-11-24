import type { RemoteSyncManager } from '../sync/remote-sync';
import type { SyncCoordinator } from '../sync/sync-coordination';

interface LiveMountServices {
  registry?: { rename(from: string, to: string): unknown };
  pool?: { rename(from: string, to: string): unknown };
  syncManager?: Pick<RemoteSyncManager, 'list' | 'renameMount' | 'isReady'>;
  syncCoordinator?: Pick<SyncCoordinator, 'markReady' | 'release'>;
}

export async function renameLiveMounts(renamed: ReadonlyMap<string, string>, { registry, pool, syncManager, syncCoordinator }: LiveMountServices): Promise<void> {
  if (renamed.size === 0) return;
  for (const [from, to] of renamed) {
    registry?.rename(from, to);
    pool?.rename(from, to);
    const tasks = (syncManager?.list() ?? []).filter((task) => task.mountName === from);
    syncManager?.renameMount(from, to);
    for (const task of tasks) {
      if (syncManager?.isReady(to, task.remotePath)) {
        await syncCoordinator?.markReady(to, task.remotePath, task.localDir);
      }
      await syncCoordinator?.release(from, task.remotePath);
    }
  }
}
