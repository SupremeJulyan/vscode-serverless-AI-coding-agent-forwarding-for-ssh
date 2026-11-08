import { shellQuote } from '../shared/shell-quote';

export function ssh2RemoteCommand(
  remoteCwd: string, command: string, outputMarker?: string
): string {
  const markedCommand = outputMarker
    ? `command printf '%s\\n' ${shellQuote(outputMarker)}; ${command}`
    : command;
  return `cd -- ${shellQuote(remoteCwd)} && exec "\${SHELL:-/bin/sh}" -lc ${shellQuote(markedCommand)}`;
}
