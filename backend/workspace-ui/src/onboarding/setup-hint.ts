/**
 * Whether the reader is probably mid-setup, before the workspace read can say
 * for certain — so the first paint can already wear the setup screens' shape
 * (`SetupLoadingSkeleton`) rather than Home's. A `/setup…` address says so
 * outright; a bare `/workspace` asks what this browser saw last time, which
 * the gate writes down whenever it knows. Wrong costs one shape for a moment,
 * never a wrong screen: the read that follows decides.
 */

const SETUP_PENDING_KEY = 'acc.setupPending';

export function rememberSetupPending(pending: boolean): void {
  try {
    if (pending) window.localStorage.setItem(SETUP_PENDING_KEY, '1');
    else window.localStorage.removeItem(SETUP_PENDING_KEY);
  } catch { /* private mode: the address alone still answers */ }
}

export function setupLikely(pathname: string): boolean {
  if (pathname === '/setup' || pathname.startsWith('/setup/')) return true;
  try { return window.localStorage.getItem(SETUP_PENDING_KEY) === '1'; } catch { return false; }
}
