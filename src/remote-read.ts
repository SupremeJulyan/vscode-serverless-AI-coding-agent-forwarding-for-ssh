export interface RemoteReadOptions {
  path: string; offset?: number; length?: number; head?: number; tail?: number;
  startLine?: number; lineCount?: number;
}

/** Select original UTF-8 bytes; line lookup is bounded independently of response size. */
export async function readTextRange(
  fileSize: number, read: (offset: number, length: number) => Promise<Uint8Array>,
  input: RemoteReadOptions
) {
  const modes = [input.offset !== undefined, input.head !== undefined,
    input.tail !== undefined, input.startLine !== undefined].filter(Boolean).length;
  if (modes > 1 || (input.lineCount !== undefined && input.startLine === undefined)) {
    throw new Error('Choose offset, head, tail, or startLine; lineCount requires startLine.');
  }
  const length = input.length ?? 8192;
  if (!Number.isSafeInteger(length) || length < 4 || length > 65536) throw new Error('length must be 4..65536 bytes.');
  for (const n of [input.head, input.tail, input.startLine, input.lineCount]) {
    if (n !== undefined && (!Number.isSafeInteger(n) || n < 1)) throw new Error('Line counts must be positive integers.');
  }
  let offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid byte offset.');
  if (input.startLine !== undefined) {
    let line = 1;
    offset = 0;
    while (line < input.startLine && offset < fileSize) {
      if (offset >= 16 * 1024 * 1024) throw new Error('Line lookup exceeded 16 MiB; use search or a byte offset.');
      const chunk = await read(offset, Math.min(65536, fileSize - offset));
      if (!chunk.length) throw new Error('File changed during line lookup.');
      let consumed = 0;
      while (consumed < chunk.length && line < input.startLine) {
        if (chunk[consumed++] === 10) line++;
      }
      offset += consumed;
    }
  }
  if (input.tail !== undefined) offset = Math.max(0, fileSize - length);
  let data = Buffer.from(await read(offset, Math.max(0, Math.min(length, fileSize - offset))));
  if (data.includes(0) || (data.length && data.reduce((n, b) => n + (b < 32 && ![8, 9, 10, 12, 13].includes(b) ? 1 : 0), 0) / data.length > 0.1)) {
    throw new Error('Binary content; use remote_download.');
  }
  let selectionTruncated = false;
  if (input.tail !== undefined) {
    // A suffix window may begin in the middle of a UTF-8 character or line.
    let start = 0;
    if (offset > 0 && (await read(offset - 1, 1))[0] !== 10) {
      const newline = data.indexOf(10);
      if (newline >= 0) start = newline + 1;
      else {
        while (start < data.length && (data[start] & 0xc0) === 0x80) start++;
        selectionTruncated = true;
      }
    }
    const endsWithNewline = data.at(-1) === 10;
    let lines = 0;
    let selectedStart = start;
    for (let i = data.length - (endsWithNewline ? 2 : 1); i >= start; i--) {
      if (data[i] === 10 && ++lines === input.tail) { selectedStart = i + 1; break; }
    }
    const available = data.subarray(start).filter(b => b === 10).length + (data.length > start && !endsWithNewline ? 1 : 0);
    selectionTruncated ||= offset > 0 && available < input.tail;
    offset += selectedStart;
    data = data.subarray(selectedStart);
  } else {
    const lines = input.head ?? (input.startLine !== undefined ? input.lineCount ?? 100 : undefined);
    if (lines !== undefined) {
      let found = 0;
      let end = data.length;
      for (let i = 0; i < data.length; i++) if (data[i] === 10 && ++found === lines) { end = i + 1; break; }
      selectionTruncated = found < lines && offset + data.length < fileSize;
      data = data.subarray(0, end);
    }
  }
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const content = decoder.decode(data, { stream: offset + data.length < fileSize });
  const end = Buffer.byteLength(content);
  if (data.length && !end) throw new Error('Read budget cannot contain a complete UTF-8 character.');
  return { content, offset, bytes: end, nextOffset: offset + end, fileSize,
    truncated: offset + end < fileSize || selectionTruncated,
    ...(input.tail !== undefined ? { omittedBefore: offset > 0, selectionTruncated } : {}),
    ...(input.startLine !== undefined ? { startLine: input.startLine, selectionTruncated } : {}) };
}
