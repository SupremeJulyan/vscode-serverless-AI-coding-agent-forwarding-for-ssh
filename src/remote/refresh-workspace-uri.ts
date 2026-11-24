import { remoteFileSystemScheme, sameWorkspaceUriLocation } from '../ssh2/uri';

interface WorkspaceUri {
  scheme: string;
  authority: string;
  path: string;
}

export async function refreshWorkspaceUri<U extends WorkspaceUri, F extends { uri: U }>(
  folders: readonly F[],
  resolve: (folder: F) => U | undefined,
  reopen: (folder: F, uri: U, options: { forceReuseWindow: true }) => PromiseLike<unknown>
): Promise<void> {
  for (const folder of folders) {
    if (folder.uri.scheme !== remoteFileSystemScheme) continue;
    const desired = resolve(folder);
    if (!desired || sameWorkspaceUriLocation(desired, folder.uri)) continue;
    await reopen(folder, desired, { forceReuseWindow: true });
    return;
  }
}
