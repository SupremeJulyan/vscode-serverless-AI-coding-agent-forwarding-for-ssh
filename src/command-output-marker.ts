/**
 * Drops gateway/login-shell text emitted before a remote command starts.
 *
 * The marker is printed by the command wrapper itself, so everything before it
 * is transport or shell startup noise. If the marker never arrives (for
 * example, SSH fails before starting the shell), finish() returns the original
 * output so diagnostics are not lost.
 */
export class CommandOutputMarkerStripper {
  private pending = Buffer.alloc(0);
  private done = false;
  private readonly marker: Buffer;

  constructor(marker: string) {
    this.marker = Buffer.from(marker);
  }

  push(chunk: Buffer): Buffer[] {
    if (this.done) return [chunk];
    this.pending = Buffer.concat([this.pending, chunk]);
    const markerIndex = this.pending.indexOf(this.marker);
    if (markerIndex < 0) return [];

    const afterMarker = markerIndex + this.marker.length;
    // printf writes a trailing LF. Wait when the marker ends at this chunk so
    // a split marker/newline boundary cannot leak an empty line to the result.
    if (afterMarker === this.pending.length) return [];

    let payloadStart = afterMarker;
    if (this.pending[payloadStart] === 0x0d) {
      if (payloadStart + 1 === this.pending.length) return [];
      payloadStart += this.pending[payloadStart + 1] === 0x0a ? 2 : 1;
    } else if (this.pending[payloadStart] === 0x0a) {
      payloadStart += 1;
    }

    this.done = true;
    const payload = this.pending.subarray(payloadStart);
    this.pending = Buffer.alloc(0);
    return payload.length ? [payload] : [];
  }

  finish(): Buffer[] {
    if (this.done || !this.pending.length) return [];
    const output = this.pending;
    this.pending = Buffer.alloc(0);
    return [output];
  }
}
