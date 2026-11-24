type Confirm = (message: string, options: { modal: true }, button: string) => PromiseLike<string | undefined>;

export async function confirmDelete(confirm: Confirm, message: string, button = '删除'): Promise<boolean> {
  return await confirm(message, { modal: true }, button) === button;
}

export async function deleteSyncHistory(
  path: string,
  syncing: boolean,
  confirm: Confirm,
  actions: {
    stop(): Promise<void>;
    removeHistory(): Promise<void>;
    removePair(): Promise<void>;
    refresh(): void;
  }
): Promise<void> {
  const message = `确定删除历史记录"${path}"吗？` + (syncing
    ? '该目录正在同步，删除后会一并停止同步（本地/远程文件都不会删）。'
    : '删除后会一并忘掉这组「本地 ↔ 远程」配对，下次同步按全新一次处理。');
  if (!await confirmDelete(confirm, message)) return;
  if (syncing) await actions.stop();
  await actions.removeHistory();
  await actions.removePair();
  actions.refresh();
}
