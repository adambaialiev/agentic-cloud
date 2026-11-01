/** A reusable link is an application door. Only an admin can grant access. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { WorkspaceInviteRedeemAnswer, WorkspaceJoinPreviewAnswer } from '../../../src/shared/workspace-api.js';
import { jsonBody, WorkspaceApiError } from '../api/client.js';
import { ScreenTitle } from '../chrome/ScreenTitle.js';
import { useSession } from '../session/useSession.js';
import { useSeats } from '../workspace/useSeats.js';
import { useWorkspace } from '../workspace/useWorkspace.js';
import { errorMessage } from '../ui/format.js';
import { useWait } from '../ui/wait.js';
import { IconBox, Svg, type IconName } from '../ui/icons.js';
import { chooseOwnWorkplace } from '../onboarding/own-workplace.js';

type JoinView = {
  label: string;
  title: string;
  description: string;
  icon: IconName;
  tone: 'open' | 'running' | 'merged' | 'rejected' | 'quiet';
};
const JOIN_VIEWS: Record<WorkspaceJoinPreviewAnswer['status'], JoinView> = {
  available: { label: 'Invitation ready', title: 'Join this workplace', description: 'Send one request. A workplace admin will review it before anything here is shared with your account.', icon: 'lock', tone: 'open' },
  pending: { label: 'Request sent', title: 'Waiting for approval', description: 'Your request is with the workplace’s admins. This page updates by itself when they decide.', icon: 'clock', tone: 'running' },
  member: { label: 'Approved', title: 'Access approved', description: 'You’re now part of this workplace. Open it to meet the people and agents already here.', icon: 'check', tone: 'merged' },
  rejected: { label: 'Declined', title: 'Request declined', description: 'An admin declined this request. You can ask them about it, or request again while the invite is active.', icon: 'x', tone: 'rejected' },
  used: { label: 'Inactive', title: 'Invite unavailable', description: 'This invite is no longer active. Ask a workplace admin to share the current link.', icon: 'link', tone: 'quiet' },
  removed: { label: 'Access ended', title: 'Membership ended', description: 'Ask a workplace admin for an invite if you’d like to request access again.', icon: 'lock', tone: 'quiet' },
  // Inviting is switched off for the workplace the link is to: on this
  // backend (RouteDeps.invitesClosed) and not marked to have it (note #805).
  closed: { label: 'Not open yet', title: 'Invites are closed for now', description: 'Workplaces are for one person at the moment, and teams are coming. You can still set up a workplace of your own.', icon: 'lock', tone: 'quiet' },
};

function monogram(value: string): string {
  return value.trim().split(/\s+/).slice(0, 2)
    .map((part) => Array.from(part)[0] ?? '').join('').toLocaleUpperCase() || '?';
}

export function InviteRedeemScreen() {
  const { token = '' } = useParams();
  const [search, setSearch] = useSearchParams();
  const requestId = search.get('request');
  const { api, state: session, signOut } = useSession();
  const workspace = useWorkspace();
  const { switchWorkplace } = workspace;
  const seats = useSeats();
  const navigate = useNavigate();
  const [answer, setAnswer] = useState<WorkspaceJoinPreviewAnswer | null>(null);
  const [error, setError] = useState('');
  const [retryable, setRetryable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const action = useRef(false);
  const generation = useRef(0);
  // What to read: the durable request once one is known, the bearer link until
  // then. It is held here rather than taken from the address bar each render
  // because the page WRITES it — and an id adopted from the answer we are
  // already showing must not re-key the reader (note #639). It did: the new
  // `?request=` re-made `read`, the load effect ran again, and the screen it
  // blanked on the way was the one that had just arrived.
  const target = useRef({ token, requestId });
  if (target.current.token !== token) target.current = { token, requestId };

  // Keep the request's address independently of the bearer link, so a reload
  // or a shared tab lands on the request rather than on the invitation.
  const adopt = useCallback((id: string | undefined) => {
    if (!id || id === target.current.requestId) return;
    target.current = { ...target.current, requestId: id };
    setSearch({ request: id }, { replace: true });
  }, [setSearch]);

  const read = useCallback(async (quiet = false) => {
    const mine = ++generation.current;
    if (!quiet) setChecking(true);
    try {
      const pending = target.current.requestId;
      const path = pending ? `api/org/join-requests/${encodeURIComponent(pending)}` : `api/org/invites/${encodeURIComponent(token)}`;
      const next = await api.api<WorkspaceJoinPreviewAnswer>(path);
      if (mine !== generation.current) return;
      setAnswer(next);
      setError('');
      setRetryable(true);
      adopt(next.requestId);
    } catch (err) {
      if (mine !== generation.current) return;
      // A background check that misses leaves the page as it was; the next one retries.
      if (quiet) return;
      setError(errorMessage(err));
      setRetryable(!(err instanceof WorkspaceApiError) || err.status >= 500);
    } finally { if (mine === generation.current) setChecking(false); }
  }, [api, token, adopt]);

  // The reader is reached through a ref so that the page loads once per
  // INVITATION. `read` changes identity whenever the address bar does —
  // `setSearchParams` is re-made on every `location.search` — and keying the
  // load on it turned each of those into a fresh blank screen.
  const latest = useRef(read);
  latest.current = read;
  useEffect(() => {
    setAnswer(null);
    void latest.current();
    return () => { generation.current += 1; };
  }, [token]);

  // A pending request checks itself: every few seconds while the page is in
  // view, and at once when the reader comes back to it. There is no button.
  useEffect(() => {
    if (answer?.status !== 'pending') return;
    const check = () => { if (!document.hidden) void latest.current(true); };
    const timer = window.setInterval(check, 5_000);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    window.addEventListener('online', check);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
      window.removeEventListener('online', check);
    };
  }, [answer?.status]);

  const submit = async () => {
    if (action.current) return;
    action.current = true;
    generation.current += 1;
    setBusy(true);
    setError('');
    try {
      const next = await api.api<WorkspaceInviteRedeemAnswer>(`api/org/invites/${encodeURIComponent(token)}/redeem`, { method: 'POST' });
      setAnswer(next);
      adopt(next.requestId);
      // The workspace read is what carries `joining` (note #726): the join
      // detour and the header's Back read it, so it is re-read now rather
      // than at the next poll.
      void workspace.reload().catch(() => { /* the next read carries it */ });
    } catch (err) { setError(errorMessage(err)); }
    finally { action.current = false; setBusy(false); }
  };

  const openOrganization = async () => {
    if (!answer || action.current) return;
    action.current = true;
    setBusy(true);
    try {
      await api.api('api/org/active', jsonBody({ orgId: answer.orgId }), { org: answer.orgId });
      seats.invalidate();
      // The tab itself moves into the workplace just joined (note #628); a
      // plain re-read would ask as the one it still stands in.
      const loaded = await switchWorkplace(answer.orgId);
      if (!loaded) throw new Error('Your access is approved, but the Workspace could not load. Try again.');
      navigate('/', { replace: true });
    } catch (err) { setError(errorMessage(err)); }
    finally { action.current = false; setBusy(false); }
  };

  const status = answer?.status;
  // Until the first answer there is no state to name, so the card holds its
  // SHAPE rather than standing in for one: the shared wait vocabulary draws
  // nothing at all for a quarter second, then three grey lines. It used to
  // draw a whole state of its own — an icon, "Checking invite", and a
  // sentence — which on any ordinary connection was a card the reader saw
  // only as it left.
  const view: JoinView | null = status ? JOIN_VIEWS[status] : error
    ? { label: retryable ? 'Connection issue' : 'Unavailable', title: retryable ? 'Try the invite again' : 'Invite unavailable', description: retryable ? 'We couldn’t load this invitation. Check your connection and try again.' : 'Ask an admin for a new link, or switch accounts to check another request.', icon: 'alert', tone: retryable ? 'quiet' : 'rejected' }
    : null;
  const wait = useWait(!view);
  const user = session.status === 'signed-in' ? session.session : null;
  const workplaceName = answer?.name ?? '';
  const accountPhoto = workspace.state?.user.profile.photoUrl;
  const accountName = user?.displayName || user?.username || '';
  const accountHandle = user ? (user.username.includes('@') ? user.username : `@${user.username}`) : '';
  return (
    <div className="screen join-screen" id="inviteScreen">
      <ScreenTitle
        titleId="inviteTitle"
        title={workplaceName || view?.title || 'Opening invitation'}
        subId="inviteSub"
        sub={workplaceName ? view?.title ?? '' : 'Workplace invitation'}
      />
      {/* One live region, standing whether or not there is anything in it
          yet: a reader is told the answer when it lands, rather than being
          handed a region that arrives already holding its own news. */}
      <div aria-live="polite" aria-atomic="true" id="inviteState">
        {view ? (
          <div className={`card join-summary ${view.tone}`}>
            <div className="join-summary-head">
              <IconBox name={view.icon} dim={view.tone === 'quiet'} />
              <div className="main">
                <div className={`join-status ${view.tone}`}>{view.label}</div>
                <div className="join-description">{view.description}</div>
                {status === 'pending' ? <p className="join-watching">You can close this page and come back through the same link.</p> : null}
              </div>
            </div>
            {error ? <div className="formfail join-error" role="alert">{error}</div> : null}
            <div className="join-actions">
              {status === 'available' || status === 'rejected' ? <button className="formcommit" type="button" disabled={busy || checking} onClick={() => void submit()}><Svg name="send" size={17} />{busy ? 'Sending…' : status === 'rejected' ? 'Request again' : 'Request to join'}</button> : null}
              {status === 'member' ? <button className="formcommit" type="button" disabled={busy || checking} onClick={() => void openOrganization()}>{busy ? 'Opening…' : 'Open workplace'}<Svg name="chev" size={17} /></button> : null}
              {error && retryable && status !== 'pending' ? <button className="btn ghost" type="button" disabled={busy || checking} onClick={() => void read()}><Svg name="refresh" size={17} />{checking ? 'Checking…' : 'Try again'}</button> : null}
            </div>
          </div>
        ) : wait === 'drawn' ? (
          <div className="card join-summary quiet" id="inviteWait" aria-hidden="true">
            <div className="join-summary-head">
              <div className="main">
                <div className="skel line" style={{ width: '22%' }} />
                <div className="skel line two" style={{ width: '92%' }} />
                <div className="skel line two" style={{ width: '58%' }} />
              </div>
            </div>
          </div>
        ) : null}
      </div>
      {status === 'pending' && workspace.state?.org?.unnamed ? (
        <div className="join-own-workplace">
          <button className="btn ghost" id="joinOwnWorkplace" type="button" disabled={busy} onClick={() => { chooseOwnWorkplace(); navigate('/', { replace: true }); }}>Set up my own workplace instead</button>
        </div>
      ) : null}
      {user ? (
        <>
          <h2>Joining as</h2>
          <div className="card join-account">
            <div className="row">
              {accountPhoto
                ? <img className="avatar" src={accountPhoto} alt="" />
                : <span className="avatar join-account-mark" aria-hidden="true">{monogram(accountName)}</span>}
              <div className="main"><div className="name plain">{accountName}</div><div className="meta">{accountHandle}</div></div>
              <button className="act" type="button" aria-label="Use another account" disabled={busy} onClick={() => { target.current = { token, requestId: null }; setSearch({}, { replace: true }); void signOut(); }}>Switch</button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
