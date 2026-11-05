/**
 * The workplace's site estimates (note #993), read on demand from
 * `api/sites/costs` — never from the state read, because pricing them is a
 * walk of the cloud account. One answer per workplace is kept in memory, so
 * the Sites screen and a site's own screen open on the figures already read
 * and quietly refresh them.
 */

import { useEffect, useState } from 'react';
import type { WorkspaceSiteCostsAnswer } from '../../../../src/shared/workspace-api.js';
import { useSession } from '../../session/useSession.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';

const lastAnswer = new Map<string, WorkspaceSiteCostsAnswer>();

export interface SiteCostsRead {
  answer: WorkspaceSiteCostsAnswer | null;
  /** The read failed and nothing was read before it. */
  failed: boolean;
  loading: boolean;
}

export function useSiteCosts(): SiteCostsRead {
  const { api } = useSession();
  const { state } = useWorkspace();
  const key = state?.org?.orgId ?? '';
  const ready = Boolean(state);
  // The latest read's outcome, tagged with the workplace it was for; set only
  // when a read settles, so a switch of workplace never shows another's.
  const [read, setRead] = useState<{ key: string; answer: WorkspaceSiteCostsAnswer | null; failed: boolean } | null>(null);
  useEffect(() => {
    if (!ready) return undefined;
    let alive = true;
    void api.api<WorkspaceSiteCostsAnswer>('api/sites/costs')
      .then((answer) => {
        lastAnswer.set(key, answer);
        if (alive) setRead({ key, answer, failed: false });
      })
      .catch(() => { if (alive) setRead({ key, answer: null, failed: true }); });
    return () => { alive = false; };
  }, [api, key, ready]);
  const settled = read?.key === key ? read : null;
  const answer = settled?.answer ?? lastAnswer.get(key) ?? null;
  return { answer, failed: Boolean(settled?.failed) && !answer, loading: !settled && !answer };
}
