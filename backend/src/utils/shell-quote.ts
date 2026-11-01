/**
 * Wrap a value in single quotes for POSIX `sh` so it survives as exactly ONE
 * argument, whatever it contains: spaces, newlines, `$`, backticks, globs.
 *
 * Inside single quotes nothing is special and nothing can be escaped, so an
 * embedded quote has to leave the quoted run and come back — `'` becomes
 * `'"'"'` (close, a double-quoted quote, reopen). The value is always fully
 * wrapped, so an empty string stays a real empty argument instead of
 * disappearing from the command line.
 *
 * POSIX shells only. PowerShell doubles its quotes instead, which is why
 * `tool-executor.ts` keeps separate helpers for its Windows paths.
 */
export function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
