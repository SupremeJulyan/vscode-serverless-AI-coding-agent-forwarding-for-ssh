import { symlink } from 'node:fs/promises';
import type { TestContext } from 'node:test';

/** Windows file symlinks require Developer Mode or an elevated process. */
export async function symlinkOrSkip(
  context: TestContext, target: string, link: string, type?: 'dir' | 'file' | 'junction'
): Promise<boolean> {
  try {
    await symlink(target, link, type);
    return true;
  } catch (error) {
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    context.skip('Windows symlink permission unavailable; enable Developer Mode or run elevated');
    return false;
  }
}
