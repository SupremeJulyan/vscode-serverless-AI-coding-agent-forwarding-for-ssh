interface SyncMirrorSteps {
  clearReady(): Promise<void> | undefined;
  clearStop(): Promise<void> | undefined;
  start(): Promise<boolean>;
  recordHistory(): Promise<void>;
  recordPair(): Promise<void>;
  refresh(): void;
}

export async function startAndRecordSyncMirror(steps: SyncMirrorSteps): Promise<boolean> {
  await steps.clearReady();
  await steps.clearStop();
  if (!await steps.start()) return false;
  await steps.recordHistory();
  await steps.recordPair();
  steps.refresh();
  return true;
}

export async function startUploadedMirror<T>(
  upload: () => Promise<boolean>,
  scan: () => Promise<T>,
  start: (baseline: T) => Promise<boolean>
): Promise<boolean> {
  if (!await upload()) return false;
  return start(await scan());
}

export async function startDownloadMirror(
  confirmTarget: () => Promise<boolean | undefined>,
  start: (resetLocal: boolean) => Promise<boolean>
): Promise<boolean> {
  const resetLocal = await confirmTarget();
  if (resetLocal === undefined) return false;
  return start(resetLocal);
}
