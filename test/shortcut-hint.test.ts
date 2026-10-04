import assert from 'node:assert/strict';
import test from 'node:test';
import { remoteConnectionShortcutHint, remoteShortcutKeys } from '../src/shortcut-hint';

test('shows the contributed directory and terminal shortcuts for each platform', () => {
  assert.deepEqual(remoteShortcutKeys('windows'), {
    openFolder: 'Ctrl+Alt+R', openTerminal: 'Ctrl+Alt+T'
  });
  assert.deepEqual(remoteShortcutKeys('macos'), {
    openFolder: 'Cmd+Ctrl+R', openTerminal: 'Cmd+Ctrl+T'
  });
  assert.deepEqual(remoteShortcutKeys('linux'), {
    openFolder: 'Ctrl+Alt+O', openTerminal: 'Ctrl+Alt+X'
  });
  assert.deepEqual(remoteShortcutKeys('wsl'), remoteShortcutKeys('linux'));
});

test('formats the terminal connection shortcut hint for the current platform', () => {
  assert.equal(
    remoteConnectionShortcutHint('linux'),
    '快捷键：打开目录 Ctrl+Alt+O / 终端 Ctrl+Alt+X'
  );
  assert.equal(
    remoteConnectionShortcutHint('windows'),
    '快捷键：打开目录 Ctrl+Alt+R / 终端 Ctrl+Alt+T'
  );
  assert.equal(
    remoteConnectionShortcutHint('macos'),
    '快捷键：打开目录 Cmd+Ctrl+R / 终端 Cmd+Ctrl+T'
  );
});
