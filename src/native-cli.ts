import * as path from 'node:path';
import { chmod, copyFile, mkdir } from 'node:fs/promises';

export type NativeCliPlatform =
  | 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64'
  | 'win32-x64' | 'win32-arm64';

export function nativeCliPlatform(
  host: NodeJS.Platform, arch: string, agentInWsl = false
): NativeCliPlatform {
  const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : undefined;
  if (!cpu) throw new Error(`SAFS CLI 不支持 CPU 架构：${arch}`);
  const os = agentInWsl || host === 'linux' ? 'linux'
    : host === 'darwin' ? 'darwin' : host === 'win32' ? 'win32' : undefined;
  if (!os) throw new Error(`SAFS CLI 不支持操作系统：${host}`);
  return `${os}-${cpu}` as NativeCliPlatform;
}

export function bundledNativeCli(extensionRoot: string, platform: NativeCliPlatform): string {
  return path.join(extensionRoot, 'bin', platform, platform.startsWith('win32-') ? 'safs.exe' : 'safs');
}

/** Copy out of the immutable extension bundle and return a stable absolute path. */
export async function installNativeCli(
  extensionRoot: string, storageRoot: string, platform: NativeCliPlatform
): Promise<string> {
  const source = bundledNativeCli(extensionRoot, platform);
  const destinationDirectory = path.join(storageRoot, 'bin', platform);
  const destination = path.join(destinationDirectory, platform.startsWith('win32-') ? 'safs.exe' : 'safs');
  await mkdir(destinationDirectory, { recursive: true });
  await copyFile(source, destination);
  if (!platform.startsWith('win32-')) await chmod(destination, 0o755);
  return destination;
}
