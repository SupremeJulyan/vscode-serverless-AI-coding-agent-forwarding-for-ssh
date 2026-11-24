export async function autoPrepareCli(
  state: { enabled: boolean; disabled: boolean; checked: boolean; skippedNode: boolean },
  markChecked: () => PromiseLike<void>,
  prepare: (interactive: boolean) => void
): Promise<void> {
  if (!state.enabled || state.disabled) return;
  await markChecked();
  prepare(!state.checked && !state.skippedNode);
}

export async function uninstallPreparedCli<T>(
  disableAutoPrepare: () => PromiseLike<void>,
  invalidatePreparation: () => Promise<void>,
  remove: () => Promise<T>
): Promise<T> {
  await disableAutoPrepare();
  await invalidatePreparation();
  return remove();
}
