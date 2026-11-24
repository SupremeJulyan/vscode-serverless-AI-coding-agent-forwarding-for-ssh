import { stat } from 'node:fs/promises';

export async function showRepeatSyncPrompt(
  localDir: string, running: boolean,
  showMessage: (message: string, options: { modal: true }, ...buttons: string[]) => PromiseLike<string | undefined>
): Promise<'open' | 'resync' | 'stop' | 'cancel'> {
  const exists = (await stat(localDir).catch(() => undefined)) !== undefined;
  const buttons = running
    ? ['打开副本', '重新同步', '停止同步']
    : exists ? ['打开副本', '重新同步', '取消'] : ['重新同步', '取消'];
  const choice = await showMessage(
    running
      ? `SAFS：该目录的双向同步已开启（本地副本：${localDir}）。`
      : `SAFS：该目录已在历史列表中，同步过一次了（本地副本：${localDir}）。`,
    { modal: true },
    ...buttons
  );
  if (choice === '打开副本') return 'open';
  if (choice === '重新同步') return 'resync';
  return choice === '停止同步' ? 'stop' : 'cancel';
}

export async function handleRepeatSync(
  choice: Promise<'open' | 'resync' | 'stop' | 'cancel'>,
  actions: {
    open(): Promise<boolean>;
    missingMirror(): void;
    stop(): Promise<void>;
    resync(): Promise<void>;
  }
): Promise<void> {
  const action = await choice;
  if (action === 'open') {
    if (!await actions.open()) actions.missingMirror();
  } else if (action === 'stop' || action === 'resync') {
    await actions.stop();
    if (action === 'resync') await actions.resync();
  }
}
