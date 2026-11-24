export function renameDirectoryHistory(
  history: Record<string, string[]>, names: ReadonlyMap<string, string>, limit: number
): Record<string, string[]> | undefined {
  const next = { ...history };
  let changed = false;
  for (const [from, to] of names) {
    if (!Object.hasOwn(next, from)) continue;
    next[to] = [...new Set([...(next[to] ?? []), ...next[from]])].slice(0, limit);
    delete next[from];
    changed = true;
  }
  return changed ? next : undefined;
}

export function renameEnabledMounts(enabled: string[], names: ReadonlyMap<string, string>): string[] {
  return [...new Set(enabled.map(name => names.get(name) ?? name))];
}

export function renameMountEntries<T extends { mountName: string }>(
  entries: T[], names: ReadonlyMap<string, string>
): T[] {
  return entries.map(entry => ({ ...entry, mountName: names.get(entry.mountName) ?? entry.mountName }));
}
