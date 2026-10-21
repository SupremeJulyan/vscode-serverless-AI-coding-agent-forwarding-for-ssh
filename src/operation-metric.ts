/** Diagnostic metrics contain only phase names and numbers, never tool inputs, URLs, or credentials. */
export function operationMetric(
  log: ((message: string) => void) | undefined, phase: string,
  started: number, bytes?: number
): void {
  try {
    log?.(`[Performance] ${JSON.stringify({ phase,
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
      ...(bytes === undefined ? {} : { bytes }) })}`);
  } catch { /* Diagnostics must not affect an operation. */ }
}
