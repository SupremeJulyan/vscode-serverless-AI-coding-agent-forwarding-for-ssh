import { shellQuote } from './shell-quote';

export interface TerminalCommandCaptureResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/** Build a shell-neutral wrapper that preserves the terminal's current user and environment. */
export function terminalForwardingCommand(
  command: string, remoteCwd: string | undefined, executionId: string,
  reportCwd = false
): { commandLine: string; startMarker: string; endMarkerPrefix: string } {
  if (!/^[a-f0-9]{24}$/u.test(executionId)) {
    throw new Error('Invalid terminal forwarding execution id');
  }
  const startMarker = `\x1eSAFS_AGENT_BEGIN_${executionId}\x1f`;
  const endMarkerPrefix = `\x1eSAFS_AGENT_END_${executionId}:`;
  const inner = remoteCwd === undefined
    ? command
    : `cd -- ${shellQuote(remoteCwd)} && ${command}`;
  // reportCwd emits the OSC 633 cwd sequence before the BEGIN marker so the
  // built-in PTY's RemoteCwdOscTracker keeps the workspace in sync even for a
  // sudo/su 子 Shell, whose own shell integration is not available.
  const cwdReport = reportCwd
    ? ["printf '\\033]633;P;Cwd=%s\\007' \"$PWD\""]
    : [];
  const outer = [
    ...cwdReport,
    `printf '\\036SAFS_AGENT_BEGIN_${executionId}\\037'`,
    `/bin/sh -c ${shellQuote(inner)}`,
    '__safs_agent_status=$?',
    `printf '\\036SAFS_AGENT_END_${executionId}:%s\\037' "$__safs_agent_status"`
  ].join('; ');
  return {
    commandLine: `/bin/sh -c ${shellQuote(outer)}`,
    startMarker,
    endMarkerPrefix
  };
}

/** Incrementally extracts output between private control-character markers. */
export class TerminalCommandOutputCapture {
  private pending = '';
  private started = false;
  private awaitingExitCode = false;
  private finished = false;
  private readonly chunks: Buffer[] = [];
  private capturedBytes = 0;
  private truncated = false;

  constructor(
    private readonly startMarker: string,
    private readonly endMarkerPrefix: string,
    private readonly maxOutputBytes: number
  ) {}

  push(data: string): TerminalCommandCaptureResult | undefined {
    if (this.finished || !data) return undefined;
    this.pending += data;
    if (!this.started) {
      const start = this.pending.indexOf(this.startMarker);
      if (start < 0) {
        this.pending = this.tail(this.pending, this.startMarker.length - 1);
        return undefined;
      }
      this.started = true;
      this.pending = this.pending.slice(start + this.startMarker.length);
    }

    if (this.awaitingExitCode) return this.finishExitCode();

    const end = this.pending.indexOf(this.endMarkerPrefix);
    if (end < 0) {
      const retained = Math.min(this.pending.length, this.endMarkerPrefix.length - 1);
      this.append(this.pending.slice(0, this.pending.length - retained));
      this.pending = this.tail(this.pending, retained);
      return undefined;
    }
    this.append(this.pending.slice(0, end));
    this.pending = this.pending.slice(end + this.endMarkerPrefix.length);
    this.awaitingExitCode = true;
    return this.finishExitCode();
  }

  private finishExitCode(): TerminalCommandCaptureResult | undefined {
    const terminator = this.pending.indexOf('\x1f');
    if (terminator < 0) return undefined;
    const status = this.pending.slice(0, terminator);
    if (!/^\d{1,3}$/u.test(status) || Number(status) > 255) {
      throw new Error('Remote terminal returned an invalid command exit code');
    }
    this.finished = true;
    return {
      exitCode: Number(status),
      stdout: Buffer.concat(this.chunks).toString('utf8'),
      stderr: '',
      truncated: this.truncated
    };
  }

  private append(value: string): void {
    if (!value) return;
    const bytes = Buffer.from(value, 'utf8');
    const remaining = Math.max(0, this.maxOutputBytes - this.capturedBytes);
    if (remaining > 0) {
      const captured = bytes.subarray(0, remaining);
      this.chunks.push(captured);
      this.capturedBytes += captured.byteLength;
    }
    if (bytes.byteLength > remaining) this.truncated = true;
  }

  private tail(value: string, length: number): string {
    return length > 0 ? value.slice(-length) : '';
  }
}
