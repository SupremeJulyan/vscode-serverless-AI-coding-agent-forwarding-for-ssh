import assert from 'node:assert/strict';
import test from 'node:test';
import * as vscode from 'vscode';
import { notificationWindow } from '../src/ui/notification-window';

test('non-modal messages are bounded by code points and preserve actions', async t => {
  for (const method of ['showInformationMessage', 'showWarningMessage', 'showErrorMessage'] as const) {
    const stub = t.mock.method(vscode.window, method, async (_message: string, _action: string) => '查看');
    const text = '远'.repeat(30) + '🧪路径';
    assert.equal(await notificationWindow[method](text, '查看'), '查看');
    assert.deepEqual(stub.mock.calls[0].arguments, ['远'.repeat(30) + '🧪…', '查看']);
    stub.mock.restore();
  }
});

test('modal messages keep the full confirmation details', async t => {
  const stub = t.mock.method(vscode.window, 'showWarningMessage', async () => undefined);
  const text = '目录'.repeat(32);
  await notificationWindow.showWarningMessage(text, { modal: true }, '删除');
  assert.deepEqual(stub.mock.calls[0].arguments, [text, { modal: true }, '删除']);
});

test('native progress bounds notification titles and exposes cancellation to the task', async t => {
  const window = vscode.window as unknown as Record<string, unknown>;
  const token = { isCancellationRequested: true };
  const progress = { report() {} };
  t.after(() => { delete window.withProgress; });
  const title = '/remote/' + '长'.repeat(80);
  for (const location of [vscode.ProgressLocation.Notification, vscode.ProgressLocation.Window]) {
    window.withProgress = async (options: vscode.ProgressOptions, task: Function) => {
      assert.equal(options.location, location);
      assert.equal(options.title, location === vscode.ProgressLocation.Notification ? title.slice(0, 31) + '…' : title);
      assert.equal(options.cancellable, true);
      return task(progress, token);
    };
    assert.equal(await notificationWindow.withProgress({ location, title }, async (reporter, cancellation) => {
      assert.equal(reporter, progress);
      return cancellation.isCancellationRequested;
    }), true);
  }
});
