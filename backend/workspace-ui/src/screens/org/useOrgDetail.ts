/**
 * The workplace's own record (`GET api/org`): read on open, re-read
 * after every mutation, and dropped when the active workplace changes.
 * A stale answer — one that arrives after a newer read was asked for —
 * never paints (the legacy `kToken` guard).
 *
 * One fact on that record moves while an admin is looking at it: who is
 * waiting to join. So it gets the same split the People page keeps — the
 * heavy record on open, and `api/org/join-requests` on a tick — because an
 * open screen that still says "0 pending" is how a person's request goes
 * unanswered while somebody sits looking straight at it.
 *
 * `{ cached: true }` opens on what this tab last read of the record
 * (`org-detail-cache.ts`, note #613) and refreshes it underneath, with no
 * "Loading…" drawn over a screen the reader saw a moment ago.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type {
  WorkspaceOrgDetail,
  WorkspaceOrgDetailAnswer,
  WorkspaceOrgJoinRequestsAnswer,
} from '../../../../src/shared/workspace-api.js';
import { WorkspaceApiError } from '../../api/client.js';
import { useSession } from '../../session/useSession.js';
import { errorMessage } from '../../ui/format.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { forgetOrgDetailOf, heldOrgDetail, holdOrgDetail } from './org-detail-cache.js';

/** The applicant's own pending screen polls every 10 seconds; an admin
 *  learns of the request on the same beat, so neither side waits longer
 *  than the other for the same event. */
export const JOIN_REQUEST_POLL_MS = 10_000;

export function useOrgDetail({ cached = false }: { cached?: boolean } = {}): { org: WorkspaceOrgDetail | null; error: string; refresh: () => Promise<WorkspaceOrgDetail | null> } {
  const { api } = useSession();
  const { state } = useWorkspace();
  const [search] = useSearchParams();
  const orgId = search.get('org') || state?.org?.orgId || null;
  // The record, and the workplace it was read for. A cached screen that has
  // moved to another workplace draws that one's held copy until its own read
  // lands — derived here rather than reset from an effect.
  const [record, setRecord] = useState<{ orgId: string | null; org: WorkspaceOrgDetail | null }>(
    () => ({ orgId, org: cached ? heldOrgDetail(orgId) : null }),
  );
  const org = record.orgId === orgId || !cached ? record.org : heldOrgDetail(orgId);
  const [error, setError] = useState('');
  const token = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++token.current;
    try {
      const answer = await api.api<WorkspaceOrgDetailAnswer>('api/org', undefined, { org: orgId });
      if (mine !== token.current) return null;
      if (orgId) holdOrgDetail(orgId, answer.org);
      setRecord({ orgId, org: answer.org });
      setError('');
      return answer.org;
    } catch (err) {
      if (mine === token.current) {
        setError(errorMessage(err));
        // No longer theirs to see: the held copy is a membership they lost,
        // so it goes, and the screen draws the server's sentence instead.
        if (err instanceof WorkspaceApiError && (err.status === 403 || err.status === 404)) {
          if (orgId) forgetOrgDetailOf(orgId);
          setRecord({ orgId, org: null });
        }
      }
      return null;
    }
  }, [api, orgId]);

  useEffect(() => {
    // Off the effect's own tick: the read is asynchronous, the effect only subscribes.
    void Promise.resolve().then(refresh);
    return () => { token.current += 1; };
  }, [refresh, orgId]);

  // Only an admin is shown join requests, and only an admin may read them.
  const watching = Boolean(org && org.role === 'admin' && org.joinRequests);
  useEffect(() => {
    if (!watching) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (document.hidden) return;
      timer = setTimeout(() => { void tick(); }, JOIN_REQUEST_POLL_MS);
    };
    const tick = async () => {
      try {
        const answer = await api.api<WorkspaceOrgJoinRequestsAnswer>(
          'api/org/join-requests', undefined, { org: orgId },
        );
        // Only the waiting list moves; the rest of the record is left exactly
        // as the heavy read left it, so a tick can never paint older facts.
        if (!alive) return;
        setRecord((current) => (current.org ? { ...current, org: { ...current.org, joinRequests: answer.joinRequests } } : current));
        const kept = heldOrgDetail(orgId);
        if (kept && orgId) holdOrgDetail(orgId, { ...kept, joinRequests: answer.joinRequests });
      } catch {
        // A failed tick says nothing on screen; the next one retries.
      }
      if (alive) schedule();
    };
    const onVisibility = () => { if (!document.hidden) void tick(); else clearTimeout(timer); };
    document.addEventListener('visibilitychange', onVisibility);
    schedule();
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [api, orgId, watching]);

  return { org, error, refresh };
}
