/** Run consecutive independent reads concurrently, retaining mutation barriers and result order. */
export async function orderedBatch<T, R>(
  items: readonly T[], isRead: (item: T) => boolean,
  invoke: (item: T, index: number) => Promise<R>, concurrency = 4
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length;) {
    if (!isRead(items[index])) {
      results.push(await invoke(items[index], index));
      index++;
      continue;
    }
    let end = index + 1;
    while (end < items.length && end - index < concurrency && isRead(items[end])) end++;
    results.push(...await Promise.all(items.slice(index, end).map((item, offset) => invoke(item, index + offset))));
    index = end;
  }
  return results;
}
