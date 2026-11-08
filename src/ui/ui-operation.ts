import type { CancellationToken } from 'vscode';

/** Cancel this UI flow without closing a connection shared by other tasks. */
export async function untilCancelled<T>(token: CancellationToken, action: () => Promise<T>): Promise<T | undefined> {
  if (token.isCancellationRequested) return undefined;
  let cancel!: () => void;
  const cancelled = new Promise<undefined>((resolve) => { cancel = () => resolve(undefined); });
  const subscription = token.onCancellationRequested(cancel);
  try {
    if (token.isCancellationRequested) return undefined;
    return await Promise.race([Promise.resolve().then(() => token.isCancellationRequested ? undefined : action()), cancelled]);
  } finally {
    subscription.dispose();
  }
}

export class UiOperationGate {
  private readonly pending = new Map<string, Promise<unknown>>();
  run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const current = this.pending.get(key);
    if (current) return current as Promise<T>;
    const operation = Promise.resolve().then(action).finally(() => { this.pending.delete(key); });
    this.pending.set(key, operation);
    return operation;
  }
}
