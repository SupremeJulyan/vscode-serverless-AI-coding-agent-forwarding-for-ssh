import type { PlatformKind } from './platform';

export interface RemoteShortcutKeys {
  openFolder: string;
  openTerminal: string;
}

export function remoteShortcutKeys(platform: PlatformKind): RemoteShortcutKeys {
  if (platform === 'macos') {
    return { openFolder: 'Cmd+Ctrl+R', openTerminal: 'Cmd+Ctrl+T' };
  }
  if (platform === 'linux' || platform === 'wsl') {
    return { openFolder: 'Ctrl+Alt+O', openTerminal: 'Ctrl+Alt+X' };
  }
  return { openFolder: 'Ctrl+Alt+R', openTerminal: 'Ctrl+Alt+T' };
}
