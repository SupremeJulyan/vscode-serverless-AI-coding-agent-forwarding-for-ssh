import assert from 'node:assert/strict';
import test from 'node:test';
import { remoteShortcutKeys } from '../src/shortcut-hint';

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
