interface TerminalDirectoryActions<T> {
  probe(): Promise<string>;
  publish(cwd: string): Promise<void>;
  resolve(cwd: string): Promise<T>;
  remember(target: T): Promise<void>;
  open(target: T, options: { forceReuseWindow: true }): PromiseLike<unknown>;
}

export async function openTerminalDirectory<T>(actions: TerminalDirectoryActions<T>): Promise<void> {
  const cwd = await actions.probe();
  await actions.publish(cwd);
  const target = await actions.resolve(cwd);
  await actions.remember(target);
  await actions.open(target, { forceReuseWindow: true });
}

export async function startTerminalForwarding(
  prepare: (() => Promise<void>) | undefined,
  enable: () => Promise<void>
): Promise<void> {
  if (prepare) await prepare();
  await enable();
}
