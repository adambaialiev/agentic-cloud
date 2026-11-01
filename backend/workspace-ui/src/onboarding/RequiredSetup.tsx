/**
 * What still stands in front of the Workspace, and the setup addresses.
 *
 * This was the prerequisite gate for an incomplete workplace: sign in one
 * subscription, then watch the founding team arrive ("Your team is
 * arriving", Continue). Since note #726 (the owner, 2026-10-11) there is no
 * such gate: a new account lands on Home — the Chief of Staff's chat — at
 * once, says what it is working on, is asked for its Claude or ChatGPT plan
 * inside that chat, and the team is brought in for that work. The server
 * answers `setupRequired: false` for every workplace.
 *
 * Two things remain. The deletion lock (2026-09-22): an admin asked to
 * delete the workplace, and until it is kept or gone the Workspace shows
 * only that screen, with the account's own places reachable behind it. And
 * the join detour: a person WAITING on another workplace's admin is not here
 * to use the spare workplace their account came with, so any address they
 * open shows them their request instead — unless they said they want a
 * workplace of their own too.
 *
 * Every setup address (`/setup`, `/setup/subscription…`, `/setup/team`) is
 * kept for links made before, and lands on Home (`SetupDone`), or wherever
 * the gate was standing in front of when such a link was made.
 */

import { useEffect, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { SetupLoadingSkeleton } from './SetupLoadingSkeleton.js';
import { ownWorkplaceChosen } from './own-workplace.js';
import { rememberSetupPending } from './setup-hint.js';
import { useWorkspace } from '../workspace/useWorkspace.js';
import { WorkplaceDeleting } from './WorkplaceDeleting.js';

/**
 * The account's own places, reachable behind the deletion lock: settings,
 * mail, the workplace picker (the way out) and an invite (the way in to
 * another). None of them belongs to the workplace being deleted.
 */
function accountPlace(pathname: string): boolean {
  return pathname === '/profile' || pathname === '/workplaces' || pathname === '/mail'
    || pathname.startsWith('/mail/') || pathname.startsWith('/invite/');
}

/**
 * Where the reader was going when the gate stood in the way — a note someone
 * linked them to, say — carried in the history entry's state by the gate
 * that used to stand here, and spent by `SetupDone`.
 */
export interface SetupDetour { afterSetup?: string }

function afterSetupOf(state: unknown): string | undefined {
  const value = (state as SetupDetour | null)?.afterSetup;
  return typeof value === 'string' && value.startsWith('/') ? value : undefined;
}

/** A setup address: where the reader was going, else Home. It waits for the
 *  state read, so the shape under it is the one Home draws. */
export function SetupDone() {
  const { state } = useWorkspace();
  const location = useLocation();
  if (!state) return <SetupLoadingSkeleton />;
  return <Navigate to={afterSetupOf(location.state) ?? '/'} replace />;
}

export function RequiredSetup({ children }: { children: ReactNode }) {
  const { state } = useWorkspace();
  const { pathname } = useLocation();
  const org = state?.org;
  // Nothing is pending any more; written down so a browser that remembers
  // the old gate's first paint stops drawing it.
  useEffect(() => { if (state) rememberSetupPending(false); }, [state]);
  // An admin asked to delete this workplace (2026-09-22): the lock stands in
  // front of everything it holds until it is kept or gone.
  if (org?.deletion) {
    if (accountPlace(pathname)) return children;
    return <WorkplaceDeleting key={org.orgId} orgId={org.orgId} name={org.name} deletion={org.deletion} />;
  }
  // A person WAITING on another workplace's admin is not here to found this
  // one: the unnamed workplace their account came with is a by-product. In a
  // private copy (note #808) there is no such workplace — they have none
  // until the request is decided — so the request is all there is to show.
  const joining = state?.joining;
  if (joining && (org?.unnamed || !org) && !ownWorkplaceChosen()
    && pathname !== '/profile' && pathname !== '/workplaces' && !pathname.startsWith('/invite/')) {
    return <Navigate to={`/invite/${encodeURIComponent(joining.inviteToken)}?request=${encodeURIComponent(joining.requestId)}`} replace />;
  }
  return children;
}
