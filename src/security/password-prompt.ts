import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

export interface PasswordAnswer { password: string; remember: boolean }

/** A password input and a real opt-in checkbox in the same form. */
export function promptSshPassword(label: string): Promise<PasswordAnswer | undefined> {
  const panel = vscode.window.createWebviewPanel('safs.sshPassword', 'SSH 登录', vscode.ViewColumn.Active, {
    enableScripts: true, localResourceRoots: []
  });
  const nonce = randomBytes(24).toString('hex');
  const escaped = label.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
  panel.webview.html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 24px; }
form { max-width: 420px; } label { display: block; margin: 16px 0 8px; }
input[type=password] { box-sizing: border-box; width: 100%; padding: 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
button { padding: 7px 16px; margin: 12px 8px 0 0; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; }
#error { color: var(--vscode-errorForeground); } p { overflow-wrap: anywhere; }
</style></head><body><form id="login"><h2>SSH 登录</h2><p>${escaped}</p>
<label for="password">密码</label><input id="password" type="password" autocomplete="off" autofocus required>
<label><input id="remember" type="checkbox">记住密码</label>
<p id="error" role="alert"></p><button type="submit">连接</button><button id="cancel" type="button">取消</button>
</form><script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const password = document.getElementById('password');
document.getElementById('login').addEventListener('submit', event => {
  event.preventDefault();
  if (!password.value) { document.getElementById('error').textContent = '请输入 SSH 密码'; return; }
  vscode.postMessage({ type: 'submit', password: password.value, remember: document.getElementById('remember').checked });
  password.value = '';
});
document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
document.addEventListener('keydown', event => { if (event.key === 'Escape') vscode.postMessage({ type: 'cancel' }); });
password.focus();
</script></body></html>`;
  return new Promise(resolve => {
    let finished = false;
    const subscriptions: vscode.Disposable[] = [];
    const finish = (answer?: PasswordAnswer) => {
      if (finished) return;
      finished = true;
      subscriptions.forEach(subscription => subscription.dispose());
      panel.dispose();
      resolve(answer);
    };
    subscriptions.push(panel.onDidDispose(() => finish()), panel.webview.onDidReceiveMessage(message => {
      if (message?.type === 'cancel') finish();
      if (message?.type === 'submit' && typeof message.password === 'string' && message.password.length > 0 && typeof message.remember === 'boolean') {
        finish({ password: message.password, remember: message.remember });
      }
    }));
  });
}
