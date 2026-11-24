import { isRemotePathInsideRoot } from '../ssh2/uri';

export async function resolveRemoteDirectory(
  session: {
    realpath(path: string): Promise<string>;
    stat(path: string): Promise<{ type: string }>;
  },
  root: string,
  candidate: string
): Promise<string> {
  const resolved = await session.realpath(candidate);
  if (!isRemotePathInsideRoot(root, resolved)) {
    throw new Error(`远程目录必须位于挂载根目录 ${root} 内`);
  }
  if ((await session.stat(resolved)).type !== 'directory') {
    throw new Error(`远程路径不是目录：${resolved}`);
  }
  return resolved;
}
