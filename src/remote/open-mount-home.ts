interface MountHome {
  defaultRemotePath?: string;
  remoteRoot: string;
}

export async function openMountHome<T extends MountHome>(
  connect: () => PromiseLike<T | undefined>,
  open: (folder: T, path: string, newWindow: true) => PromiseLike<unknown>
): Promise<void> {
  const folder = await connect();
  if (!folder) return;
  await open(folder, folder.defaultRemotePath ?? folder.remoteRoot, true);
}
