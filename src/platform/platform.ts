import * as os from 'node:os';
export type PlatformKind = 'windows' | 'macos' | 'linux' | 'wsl';

export function agentHttpRouterPort(platform: PlatformKind, configuredPort = 0): number {
  if (!configuredPort || configuredPort === 9848 || configuredPort === 9849) return platform === 'wsl' ? 9849 : 9848;
  return configuredPort;
}

export function platformExtensionStateKey(name: string, platform: PlatformKind): string {
  return `safs.${name}.${platform}`;
}

export interface CommandPlan {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  stdoutMarker?: string;
}

export function detectPlatform(platform = process.platform, release = os.release()): PlatformKind {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux' && /microsoft|wsl/i.test(release)) return 'wsl';
  if (platform === 'linux') return 'linux';
  throw new Error(`Unsupported platform: ${platform}`);
}


export function createPlatformAdapter(kind = detectPlatform()): { readonly kind: PlatformKind } { return { kind }; }
