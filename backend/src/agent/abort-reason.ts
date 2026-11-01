export const PROCESS_SHUTDOWN_ABORT_REASON = 'process_shutdown';

export function isProcessShutdownAbort(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && signal.reason === PROCESS_SHUTDOWN_ABORT_REASON;
}
