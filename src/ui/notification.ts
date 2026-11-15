/** Keep optional notification actions outside the command's operation gate. */
export function handleNotification<T>(
  notification: PromiseLike<T | undefined>,
  selected: (value: T) => unknown | PromiseLike<unknown>,
  failed: (error: unknown) => void
): void {
  void Promise.resolve(notification).then(value => value === undefined ? undefined : selected(value)).catch(failed);
}
