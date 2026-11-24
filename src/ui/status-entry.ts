interface StatusEntryInput {
  sync?: { remotePath: string; localDir: string };
  gitAvailable: boolean;
  gitTooltip?: string;
  transport(): 'scp' | 'sftp' | undefined;
  describeHost(): string | undefined;
}

export function describeStatusEntry(input: StatusEntryInput): { text: string; tooltip?: string } | undefined {
  if (input.sync) {
    const { remotePath, localDir } = input.sync;
    return { text: '$(sync) SAFS SYNC', tooltip: `双向同步已开启：${remotePath} ↔ ${localDir}` };
  }
  if (input.gitAvailable) return { text: '$(git-branch) SAFS Git', tooltip: input.gitTooltip };
  const transport = input.transport();
  if (!transport) return undefined;
  const host = input.describeHost();
  return {
    text: `$(remote) SAFS ${transport.toUpperCase()}`,
    tooltip: `传输通道：${transport.toUpperCase()}（ssh2）${host ? '\n' + host : ''}`
  };
}
