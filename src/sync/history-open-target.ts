interface HistorySyncState {
  activeLocalDirectory(): string | undefined;
  isReady(directory: string): Promise<boolean | undefined> | undefined;
  isStopped(): Promise<boolean | undefined> | undefined;
}

export async function historyOpenTarget(state: HistorySyncState): Promise<
  { kind: 'remote' | 'pending' } | { kind: 'local'; directory: string }
> {
  const directory = state.activeLocalDirectory();
  if (directory === undefined) return { kind: 'remote' };

  const ready = await state.isReady(directory);
  const stopped = await state.isStopped();
  if (stopped || state.activeLocalDirectory() !== directory) return { kind: 'remote' };
  return ready ? { kind: 'local', directory } : { kind: 'pending' };
}
