import { createHash } from 'node:crypto';

export interface RemoteTextEdit {
  oldText: string;
  newText: string;
}

export const maxRemoteEditFileBytes = 1024 * 1024;
export const maxRemoteEdits = 100;

export function textSha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function applyRemoteTextEdits(
  content: string, edits: RemoteTextEdit[]
): { content: string; replacements: number } {
  if (edits.length === 0) throw new Error('remote_edit requires at least one edit.');
  if (edits.length > maxRemoteEdits) {
    throw new Error(`remote_edit accepts at most ${maxRemoteEdits} edits.`);
  }
  let updated = content;
  for (const [index, edit] of edits.entries()) {
    if (!edit.oldText) throw new Error(`remote_edit edits[${index}].oldText must not be empty.`);
    const first = updated.indexOf(edit.oldText);
    if (first < 0) throw new Error(`remote_edit edits[${index}] did not match.`);
    if (updated.indexOf(edit.oldText, first + 1) >= 0) {
      throw new Error(`remote_edit edits[${index}] matched more than once; include more context to make it unique.`);
    }
    updated = updated.slice(0, first) + edit.newText
      + updated.slice(first + edit.oldText.length);
  }
  return { content: updated, replacements: edits.length };
}
