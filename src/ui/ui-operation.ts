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

/** Check before and after shared preparation; cancelled callers do not start later steps. */
export async function cancellableStep<T>(token: CancellationToken, action: () => T | PromiseLike<T>): Promise<T> {
  const cancelled = () => {
    if (token.isCancellationRequested) {
      const error = new Error('操作已取消');
      error.name = 'CancellationError';
      throw error;
    }
  };
  cancelled();
  const result = await action();
  cancelled();
  return result;
}

export function isUiCancellation(error: unknown): boolean {
  return error instanceof Error && (error.name === 'CancellationError' || error.name === 'Canceled'
    || /^已取消(?:旧版)? SSH |^操作已取消$/.test(error.message));
}
