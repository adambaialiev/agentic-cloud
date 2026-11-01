/**
 * Inviting a person (`/workplace/invite?org=`): the page the workplace
 * menu's "Invite to this workplace" opens. It holds ONE thing — the workplace's invite link, ready to
 * copy — because that is the whole of what an admin came to do.
 *
 * The link is the workplace's one live link, so opening this page twice
 * hands out the same link twice. Only when there is none does arriving here
 * make one, once: a page that opened on an empty plate and a second button
 * would be the old two taps with a navigation in between. After a revoke the
 * page does NOT mint again — the admin just said they want no link — and
 * offers the door instead.
 *
 * The one-link rule is the ROUTE's, not this page's (`POST api/org/invites`
 * hands back the live link rather than minting beside it), so two tabs
 * arriving at once cannot make two.
 *
 * Every link, and the people waiting behind them, stay on the workplace
 * screen; this page never lists, it only hands over. The link is drawn by
 * the workplace screen's own `InviteLinkRow`, so an invite link looks and
 * works the same wherever it is met.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { WorkspaceOrgInvite, WorkspaceOrgInviteCreatedAnswer } from '../../../../src/shared/workspace-api.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { errorMessage } from '../../ui/format.js';
import { toFor } from '../../routes.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { InviteLinkRow } from './InviteLinkRow.js';
import { useOrgApi, useOrgId } from './useOrgApi.js';
import { useOrgDetail } from './useOrgDetail.js';

/** The link to hand over: the most recently made one. No link expires, so
 *  every live one works equally — newest is simply the one an admin who made
 *  one a minute ago is expecting to see. */
function newest(invites: readonly WorkspaceOrgInvite[]): WorkspaceOrgInvite | null {
  return invites.reduce<WorkspaceOrgInvite | null>((best, invite) => (
    invite.link && (!best || invite.createdAt > best.createdAt) ? invite : best
  ), null);
}

export function InviteScreen() {
  const api = useOrgApi();
  const { state } = useWorkspace();
  const navigate = useNavigate();
  const { org, error, refresh } = useOrgDetail();
  /** The workplace this page already made (or declined to make) a link for. */
  const settledFor = useRef('');
  const [made, setMade] = useState<WorkspaceOrgInvite | null>(null);
  const [making, setMaking] = useState(false);
  const [failed, setFailed] = useState('');

  const orgId = useOrgId() ?? '';
  /** Invites switched off on this backend: the page says so and mints nothing. */
  const closed = Boolean(state?.invitesClosed);
  const invites = org?.invites ?? null;
  const invite = invites ? newest(made && !invites.some((row) => row.token === made.token) ? [...invites, made] : invites) : null;
  const others = invites ? invites.filter((row) => row.token !== invite?.token).length : 0;

  const make = async () => {
    setMaking(true);
    setFailed('');
    try {
      const answer = await api.api<WorkspaceOrgInviteCreatedAnswer>('api/org/invites', { method: 'POST' });
      setMade(answer.invite);
    } catch (err) { setFailed(errorMessage(err)); }
    finally { setMaking(false); }
  };

  useEffect(() => {
    if (closed || !orgId || !org || !invites || settledFor.current === orgId) return;
    settledFor.current = orgId;
    // Off the effect's own tick, as every read here is.
    if (invites.length === 0) void Promise.resolve().then(make);
    // `make` is this render's; the ref is what keeps the mint to one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, invites, closed]);

  const mark = org ?? state?.org ?? null;
  return (
    <div className="screen" id="screenInvite">
      <ScreenTitle
        titleId="inviteTitle"
        title="Invite to this workplace"
        subId="inviteSub"
        sub={mark?.name ?? ''}
      />
      {closed
        ? <div className="inviteplate"><div className="empty" id="inviteClosed">Inviting people to a workplace is switched off for now. Workplaces are for one person at the moment; teams are coming.</div></div>
        : !org
        ? <div className="inviteplate">{error ? <div className="empty">{error}</div> : <InviteSkeleton />}</div>
        : !invites
          ? <div className="inviteplate"><div className="empty" id="inviteRefused">Only an admin can invite people.</div></div>
          : invite
            ? (
              <>
                <div className="card" id="inviteLinkCard">
                  <InviteLinkRow invite={invite} orgId={orgId} onChanged={async () => { setMade(null); await refresh(); }} />
                </div>
                <p className="formhint" id="inviteHint">Works until you revoke it. You approve everyone who asks to join.</p>
                {others > 0
                  ? <div className="inviteactions"><button className="btn bare" id="inviteAllLinks" type="button" onClick={() => navigate(toFor({ kind: 'organization', orgId })!)}>All {others + 1} invite links</button></div>
                  : null}
              </>
            )
            : making
              ? <div className="inviteplate"><InviteSkeleton /></div>
              : (
                <>
                  <div className="plates">
                    <button className="addrow" id="inviteMakeBtn" type="button" onClick={() => { void make(); }}>
                      <span>Create invite link</span>
                    </button>
                  </div>
                  {failed ? <p className="formfail" id="inviteFailed" role="alert">{failed}</p> : null}
                </>
              )}
    </div>
  );
}

/** Holds the plate's shape while the link is read or made. */
function InviteSkeleton() {
  return (
    <div aria-hidden="true" id="inviteSkeleton">
      <div className="skel line" style={{ width: '22%' }} />
      <div className="skel line two" style={{ width: '92%' }} />
      <div className="skel line two" style={{ width: '58%' }} />
    </div>
  );
}
