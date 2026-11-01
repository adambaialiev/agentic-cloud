/**
 * The people waiting at this workplace's door, on the first screen an admin
 * already reads. The workplace detail keeps the durable list and invite-link
 * controls; Home carries only pending requests, and disappears when there is
 * nothing to decide.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceOrgJoinRequest, WorkspaceOrgJoinRequestsAnswer } from '../../../../src/shared/workspace-api.js';
import { useSession } from '../../session/useSession.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { JOIN_REQUEST_POLL_MS } from '../org/useOrgDetail.js';
import { JoinRequestRow } from '../org/JoinRequestRow.js';

export function HomeJoinRequests() {
  const { api } = useSession();
  const { state } = useWorkspace();
  const org = state?.org ?? null;
  const orgId = org?.orgId ?? null;
  // Nothing to decide, and no polling for it, while invites are switched off.
  const admin = org?.role === 'admin' && !state?.invitesClosed;
  const [answer, setAnswer] = useState<{ orgId: string; requests: WorkspaceOrgJoinRequest[] } | null>(null);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    if (!admin || !orgId) return null;
    try {
      const answer = await api.api<WorkspaceOrgJoinRequestsAnswer>('api/org/join-requests', undefined, { org: orgId });
      if (mine !== generation.current) return null;
      setAnswer({ orgId, requests: answer.joinRequests });
      return answer.joinRequests;
    } catch {
      // A failed background read says nothing about whether somebody is
      // waiting. Keep the last truthful list and retry on the next beat.
      return null;
    }
  }, [admin, api, orgId]);

  useEffect(() => {
    if (!admin || !orgId) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (!document.hidden) timer = setTimeout(() => { if (alive) void tick(); }, JOIN_REQUEST_POLL_MS);
    };
    const tick = async () => {
      await refresh();
      if (alive) schedule();
    };
    const onVisibility = () => { if (!document.hidden) void tick(); else clearTimeout(timer); };
    void tick();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      alive = false;
      generation.current += 1;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [admin, orgId, refresh]);

  const requests = answer?.orgId === orgId ? answer.requests : [];
  if (!admin || requests.length === 0 || !orgId) return null;
  const count = requests.length;
  return (
    <section id="homeJoinRequests" aria-labelledby="homeJoinRequestsTitle">
      <h2 className="homehead" id="homeJoinRequestsTitle">Join requests</h2>
      <div className="card homejoincard">
        <div className="homejoinlabel">{count === 1 ? 'Join request' : 'Join requests'}</div>
        {requests.map((request) => (
          <JoinRequestRow key={request.requestId} request={request} orgId={orgId} refresh={refresh} />
        ))}
      </div>
    </section>
  );
}
