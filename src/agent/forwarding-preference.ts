export async function saveForwardingPreference<T>(
  current: ReadonlySet<string>,
  mount: string,
  enabled: boolean,
  prepare: () => Promise<T>,
  save: (mounts: string[]) => PromiseLike<void>
): Promise<T | undefined> {
  const next = new Set(current);
  let prepared: T | undefined;
  if (enabled) {
    prepared = await prepare();
    next.add(mount);
  } else {
    next.delete(mount);
  }
  await save([...next]);
  return prepared;
}
