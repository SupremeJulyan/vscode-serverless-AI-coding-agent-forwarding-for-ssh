export async function selectDirectoryMount<T extends { name: string }>(
  mounts: readonly T[],
  requestedMount: string | undefined,
  pick: () => Promise<T | undefined>
): Promise<T | undefined> {
  if (requestedMount === undefined) return pick();
  const mount = mounts.find(candidate => candidate.name === requestedMount);
  if (!mount) throw new Error(`远程目录配置不存在：${requestedMount}`);
  return mount;
}
