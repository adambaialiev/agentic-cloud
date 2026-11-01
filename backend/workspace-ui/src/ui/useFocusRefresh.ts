/**
 * Re-read a screen's data when its browser window comes back into focus.
 * Mobile browsers chiefly report that as `visibilitychange`; desktop
 * browsers report `focus`, so listen to both and single-flight the pair.
 * Mount/load remains the caller's explicit effect — this hook owns focus.
 */

import { useCallback, useEffect, useRef } from 'react';

export function useFocusRefresh(refresh: () => Promise<unknown>): void {
  const refreshRef = useRef(refresh);
  const inFlight = useRef<Promise<unknown> | null>(null);

  useEffect(() => { refreshRef.current = refresh; }, [refresh]);

  const run = useCallback(() => {
    if (document.hidden || inFlight.current) return;
    const pending = Promise.resolve().then(() => refreshRef.current())
      .catch(() => { /* the screen owns how a failed refresh is shown */ })
      .finally(() => {
        if (inFlight.current === pending) inFlight.current = null;
      });
    inFlight.current = pending;
  }, []);

  useEffect(() => {
    const onVisibility = () => { if (!document.hidden) run(); };
    window.addEventListener('focus', run);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', run);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [run]);
}
