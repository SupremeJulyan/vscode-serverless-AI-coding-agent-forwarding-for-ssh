export interface PendingSave {
  uri: string;
  content: Buffer;
  permissions?: number;
  busy: boolean;
  message: string;
}

export class SaveConfirmation {
  readonly attempts = new Map<string, PendingSave>();
  constructor(private readonly timeoutMs = 30_000) {}

  async run(
    uri: string, content: Uint8Array, permissions: number | undefined,
    write: (signal: AbortSignal) => Promise<void>, connected: () => boolean,
    confirmedRetry = false
  ): Promise<void> {
    const previous = this.attempts.get(uri);
    if (previous && (!confirmedRetry || previous.busy)) {
      throw new Error('上次保存尚未确认，请重新读取远端文件，核对后再保存');
    }
    if (!connected()) throw new Error('SSH 已断开');
    const attempt: PendingSave = { uri, content: Buffer.from(content), permissions, busy: true, message: '' };
    this.attempts.set(uri, attempt);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let monitor: ReturnType<typeof setInterval> | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      const fail = (message: string) => {
        attempt.message ||= message;
        controller.abort(new Error(message));
        reject(controller.signal.reason);
      };
      timer = setTimeout(() => fail('保存超时，远端内容可能不完整'), this.timeoutMs);
      monitor = setInterval(() => { if (!connected()) fail('连接已断开，保存未确认，远端内容可能不完整'); }, 200);
    });
    const operation = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return write(controller.signal);
    }).finally(() => { attempt.busy = false; });
    try {
      await Promise.race([operation, cancelled]);
      if (this.attempts.get(uri) === attempt) this.attempts.delete(uri);
    } catch (error) {
      attempt.message ||= '保存失败，远端内容可能不完整';
      throw new Error(`${attempt.message}。重连后再次保存将自动核对；若内容不一致，将采用远端版本：${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally { clearTimeout(timer); clearInterval(monitor); }
  }

  async verify(uri: string, read: () => Promise<{ content: Uint8Array; permissions?: number }>): Promise<'matched' | 'remote' | undefined> {
    const attempt = this.attempts.get(uri);
    if (!attempt) return;
    if (attempt.busy) throw new Error('上次写入仍未结束，请稍后核对');
    if (attempt.permissions === undefined) throw new Error('缺少保存前的权限记录，请重新加载远端文件');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const actual = await Promise.race([read(), new Promise<never>((_r, reject) => {
        timer = setTimeout(() => reject(new Error('核对超时，异常标记保留')), this.timeoutMs);
      })]);
      if (!Buffer.from(actual.content).equals(attempt.content) || actual.permissions !== attempt.permissions) {
        if (this.attempts.get(uri) === attempt) this.attempts.delete(uri);
        return 'remote';
      }
      if (this.attempts.get(uri) === attempt) this.attempts.delete(uri);
      return 'matched';
    } finally { clearTimeout(timer); }
  }

  discard(uri: string): void {
    if (this.attempts.get(uri)?.busy) throw new Error('上次写入仍未结束');
    this.attempts.delete(uri);
  }
}
export const saveConfirmation = new SaveConfirmation();
