/**
 * A member's whole contribution to the workplace, for their own screen
 * (note #925): `api/org/members/:id/contribution`, read when the screen
 * opens and again on the people lists' own cadence while it is in front of
 * the reader — the same five seconds the cards' tick keeps, so a change
 * merged while somebody is looking lands without a reload. Paused while the
 * tab is hidden; a failed read leaves the last answer where it is.
 */

import { useEffect, useState } from 'react';
import type { WorkspaceMemberContributionAnswer } from '../../../../src/shared/workspace-api.js';
import { useOrgApi } from './useOrgApi.js';
import { PEOPLE_POLL_MS } from './usePeople.js';

export function useMemberContribution(userId: string): WorkspaceMemberContributionAnswer | null {
  const api = useOrgApi();
  // Kept with whose it is, so another member's screen never opens on it.
  const [read, setRead] = useState<{ userId: string; answer: WorkspaceMemberContributionAnswer } | null>(null);
  useEffect(() => {
    if (!userId) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (document.hidden) return;
      timer = setTimeout(() => { void read(); }, PEOPLE_POLL_MS);
    };
    const read = async () => {
      try {
        const next = await api.api<WorkspaceMemberContributionAnswer>(`api/org/members/${encodeURIComponent(userId)}/contribution`);
        if (alive) setRead({ userId, answer: next });
      } catch {
        // The facts card above says what is wrong with the membership; this
        // card keeps its last answer and the next read retries.
      }
      if (alive) schedule();
    };
    const onVisibility = () => { if (!document.hidden) void read(); else clearTimeout(timer); };
    document.addEventListener('visibilitychange', onVisibility);
    void Promise.resolve().then(read);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [api, userId]);
  return read && read.userId === userId ? read.answer : null;
}
