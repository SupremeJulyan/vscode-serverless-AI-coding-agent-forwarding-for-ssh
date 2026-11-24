import * as vscode from 'vscode';

const displayLimit = 32;

function shorten(text: string): string {
  const characters = [...text];
  if (characters.length <= displayLimit) return text;
  return characters.slice(0, displayLimit - 1).join('') + '…';
}

type MessageMethod = typeof vscode.window.showInformationMessage;

function messageMethod(
  name: 'showInformationMessage' | 'showWarningMessage' | 'showErrorMessage'
): MessageMethod {
  const show = (message: string, ...args: unknown[]) => {
    const options = args[0] as vscode.MessageOptions | undefined;
    const call = vscode.window[name] as (message: string, ...args: unknown[]) => Thenable<unknown>;
    return call.apply(vscode.window, [options?.modal ? message : shorten(message), ...args]);
  };
  return show as MessageMethod;
}

export const notificationWindow = {
  showInformationMessage: messageMethod('showInformationMessage'),
  showWarningMessage: messageMethod('showWarningMessage'),
  showErrorMessage: messageMethod('showErrorMessage'),
  withProgress<T>(
    options: vscode.ProgressOptions,
    task: (progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) => Thenable<T>
  ): Thenable<T> {
    return vscode.window.withProgress({
      ...options,
      title: options.location === vscode.ProgressLocation.Notification && options.title !== undefined
        ? shorten(options.title) : options.title,
      cancellable: true
    }, task);
  }
};
