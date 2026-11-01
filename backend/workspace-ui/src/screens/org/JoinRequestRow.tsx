import { useRef, useState } from 'react';
import type { WorkspaceOrgJoinRequest } from '../../../../src/shared/workspace-api.js';
import { jsonBody } from '../../api/client.js';
import { useBanner } from '../../chrome/useBanner.js';
import { useSession } from '../../session/useSession.js';
import { absolute, errorMessage } from '../../ui/format.js';
import { Svg } from '../../ui/icons.js';
import { relative } from '../../ui/time.js';

export function JoinRequestRow({ request, orgId, refresh }: {
  request: WorkspaceOrgJoinRequest;
  orgId: string;
  refresh: () => Promise<unknown>;
}) {
  const { api } = useSession();
  const banner = useBanner();
  const [decision, setDecision] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const busy = decision !== null;
  const initials = request.name.trim().split(/\s+/).slice(0, 2).map((part) => Array.from(part)[0] ?? '').join('').toLocaleUpperCase() || '?';
  const identity = request.username
    ? (request.username.includes('@') ? request.username : `@${request.username}`)
    : 'Workspace account';
  const decide = async (decision: 'approve' | 'reject') => {
    if (inFlight.current) return;
    inFlight.current = true;
    setDecision(decision);
    setError('');
    try {
      await api.api(`api/org/join-requests/${encodeURIComponent(request.requestId)}/decision`, jsonBody({ decision }), { org: orgId });
      banner.show(decision === 'approve' ? `${request.name} approved as a member.` : `${request.name}'s request declined.`, true);
    } catch (err) { setError(errorMessage(err)); banner.show(errorMessage(err)); }
    finally { await refresh(); inFlight.current = false; setDecision(null); }
  };
  return (
    <div className="orgjoin-request" aria-busy={busy}>
      <div className="crow">
        <span className="avatar join-person-mark" aria-hidden="true">{initials}</span>
        <div className="main">
          {/* The name and when they asked share the first line, the way a
              mail row does; the address has the second to itself, so it is
              read whole rather than cut short by the time. */}
          <div className="orgjoin-who">
            <span className="name plain">{request.name}</span>
            <time className="orgjoin-when" dateTime={request.requestedAt} title={`Requested ${absolute(request.requestedAt)}`}>{relative(request.requestedAt) || 'just now'}</time>
          </div>
          <div className="cline"><span className="ctext">{identity}</span></div>
        </div>
      </div>
      <div className="orgjoin-decisions">
        <button className="btn join-decline" type="button" disabled={busy} aria-label={`Decline ${request.name}`} onClick={() => void decide('reject')}>{decision === 'reject' ? 'Declining…' : 'Decline'}</button>
        <button className="formcommit join-approve" type="button" disabled={busy} aria-label={`Approve ${request.name}`} onClick={() => void decide('approve')}><Svg name="tick" size={17} />{decision === 'approve' ? 'Approving…' : 'Approve'}</button>
      </div>
      {error ? <p className="formfail orgjoin-inline-error" role="alert">{error}</p> : null}
    </div>
  );
}
