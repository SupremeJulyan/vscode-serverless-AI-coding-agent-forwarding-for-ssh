import { dirname } from 'node:path';

export function localWatchPatterns(localPath: string, isFile: boolean | undefined) {
  // The subtree watcher does not report deletion or recreation of its own root.
  const rootEntry = { directory: dirname(localPath), glob: '*' };
  return isFile ? [rootEntry] : [rootEntry, { directory: localPath, glob: '**/*' }];
}
