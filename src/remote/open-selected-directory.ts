export async function openSelectedDirectory<T>(
  action: '打开' | '切换',
  select: (placeholder: string, action: '打开' | '切换') => Promise<T | undefined>,
  remember: (target: T) => Promise<void>,
  open: (target: T, newWindow?: true) => PromiseLike<unknown>
): Promise<void> {
  const target = await select(`选择要${action}的远程连接`, action);
  if (!target) return;
  await remember(target);
  if (action === '打开') await open(target, true);
  else await open(target);
}
