import { useEffect } from 'react';
import { WorkspaceApiError } from '../../api/client.js';
/** The workplace's messaging machine sleeps when nobody is writing, and the
 * first open wakes it. That is a state to wait through, not an error: the
 * poll asks again by itself, so the screen says so quietly. */
export const isOpening = (err: unknown) => err instanceof WorkspaceApiError && err.code === 'opening';
/** Single-flight reads; stop while hidden and catch up on return. */
export function useMessagePoll(read: (alive: () => boolean) => Promise<void>, interval = 3000) {
  useEffect(() => {
    let alive = true, busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!alive || busy || document.hidden) return;
      busy = true;
      try { await read(() => alive); }
      finally { busy = false; if (alive && !document.hidden) timer = setTimeout(() => { void tick(); }, interval); }
    };
    const visibility = () => { clearTimeout(timer); if (!document.hidden) void tick(); };
    void tick(); document.addEventListener('visibilitychange', visibility);
    return () => { alive = false; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [read, interval]);
}
