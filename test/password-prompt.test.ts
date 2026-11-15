import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { promptSshPassword } from '../src/security/password-prompt';

const vscode = createRequire(import.meta.url)('vscode');
function mockPanel() {
  let receive: (message: unknown) => void = () => {};
  let closed: () => void = () => {};
  let disposed = false;
  const panel = {
    webview: {
      html: '',
      onDidReceiveMessage: (callback: typeof receive) => { receive = callback; return { dispose() {} }; }
    },
    onDidDispose: (callback: typeof closed) => { closed = callback; return { dispose() {} }; },
    dispose: () => { disposed = true; closed(); }
  };
  vscode.ViewColumn = { Active: -1 };
  vscode.window.createWebviewPanel = () => panel;
  return { panel, send: (message: unknown) => receive(message), close: () => closed(), disposed: () => disposed };
}

test('password form escapes host labels and leaves remember unchecked', async () => {
  const ui = mockPanel();
  const answer = promptSshPassword('<host>');
  assert.ok(ui.panel.webview.html.includes('&lt;host&gt;'));
  assert.ok(ui.panel.webview.html.includes('type="password"'));
  assert.ok(ui.panel.webview.html.includes('id="remember" type="checkbox">'));
  assert.ok(ui.panel.webview.html.includes("default-src 'none'"));
  ui.send({ type: 'submit', password: 'secret', remember: false });
  assert.deepEqual(await answer, { password: 'secret', remember: false });
  assert.equal(ui.disposed(), true);
});

test('password form accepts explicit remember and ignores malformed messages', async () => {
  const ui = mockPanel(); const answer = promptSshPassword('host');
  ui.send({ type: 'submit', password: '', remember: true });
  ui.send({ type: 'submit', password: 'secret', remember: 'true' });
  assert.equal(ui.disposed(), false);
  ui.send({ type: 'submit', password: 'secret', remember: true });
  assert.deepEqual(await answer, { password: 'secret', remember: true });
});

test('closing or cancelling the password form resolves without credentials', async () => {
  for (const action of ['close', 'cancel']) {
    const ui = mockPanel(); const answer = promptSshPassword('host');
    if (action === 'close') ui.close(); else ui.send({ type: 'cancel' });
    assert.equal(await answer, undefined);
  }
});

test('cancelling connection progress closes the password form and resolves its wait', async () => {
  const ui = mockPanel(); const listeners = new Set<() => void>();
  const token = { isCancellationRequested: false, onCancellationRequested(callback: () => void) {
    listeners.add(callback); return { dispose() { listeners.delete(callback); } };
  } };
  const answer = promptSshPassword('host', token);
  token.isCancellationRequested = true;
  for (const listener of listeners) listener();
  assert.equal(await answer, undefined); assert.equal(ui.disposed(), true); assert.equal(listeners.size, 0);
});
