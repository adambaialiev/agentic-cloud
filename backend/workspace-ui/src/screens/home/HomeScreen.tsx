/**
 * Home is the Chief of Staff's conversation (2026-10-10, the owner: "let's
 * create a special chat screen for workspace agent. Let this screen be the
 * home"; renamed Chief of Staff by note #715). The person opens the
 * Workspace and is talking to the one agent that runs their fleet. Its face
 * and its name in the header open the Workplace window over the conversation
 * (`HomeSheet`, in the agents picker's shell), holding what the overview's
 * workplace tab held; the rooms are tabs of the agents picker by the message
 * box, in every conversation (the owner, 2026-10-11). The workplace switch
 * and the reader's own picture stand at the far edge of the header.
 *
 * The window is a browser entry of this same address (`home-sheet.ts`):
 * Escape, Close, the dim and the browser's Back each close it with its exit,
 * and Back never leaves Home while it is open. Home holds that because Back
 * is the browser's, and this screen is what answers the `popstate`.
 *
 * What a room's shelves open — a proposal, a note, writing a note — opens
 * inside the picker, as a page of its own (note #722, `AgentSwitch`): the
 * conversation stays where it is under it.
 *
 * Two things keep their old shape. A brand-new account still lands on the
 * create form once, and a personal account, which has no workplace and so no
 * Chief of Staff, keeps the one-column overview it always had.
 *
 * Home is ALWAYS the conversation when it is opened. The old Home wrote its
 * half, room and shelf into its own address (note #524), so a tab open on it
 * carried `?half=rooms&room=…`; those three words are dropped from `/` in
 * place and the conversation opens. The overview's own old address opens
 * Home with the window it names (`App.tsx`, `overviewSheet`).
 *
 * The conversation is the one the hidden `/recap` address drew
 * (`RecapChatScreen`), asked to be Home. Its machine is built the first time
 * a message is sent — a workplace that never writes to it pays for no
 * machine (note #656).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { toFor } from '../../routes.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { SetupLoadingSkeleton } from '../../onboarding/SetupLoadingSkeleton.js';
import { setupLikely } from '../../onboarding/setup-hint.js';
import { HomeLoadingSkeleton } from './HomeLoadingSkeleton.js';
import { carriesHomeShown, HOME_CONTENT_PARAM, HOME_HALF_PARAM, HOME_ROOM_PARAM } from './home-address.js';
import { HomeSheet } from './HomeSheet.js';
import { currentSheetStack, pushSheetLevel, settleSheetEntry, type HomeSheetStack } from './home-sheet.js';
import { OverviewScreen } from './OverviewScreen.js';
import { PRIVATE_COPY, SIGNUP_CLOSED } from '../../../../src/shared/private-copy.js';
import { useSession } from '../../session/useSession.js';
import { Conversation } from './RecapChatScreen.js';

export function HomeScreen() {
  const { status, error, reload, state, agents, claimOnce } = useWorkspace();
  const location = useLocation();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  // A brand-new account — one that may found a workplace, has none and
  // has no agents — lands on the create form once (legacy
  // `maybeOpenFounderDoor`), not on an empty Home.
  const founder = Boolean(state && state.canCreateOrg && !state.org && (agents ?? []).length === 0);
  useEffect(() => {
    if (!founder || !claimOnce('founder-door')) return;
    navigate(toFor({ kind: 'organizations' })!, { state: { create: true } });
  }, [founder, claimOnce, navigate]);
  if (status === 'loading') {
    // Before the read says whether the setup gate stands, hold the shape
    // this browser last saw (setup-hint.ts).
    return setupLikely('/') ? <SetupLoadingSkeleton /> : <HomeLoadingSkeleton stage="workplace" />;
  }
  if (status === 'error') {
    return (
      <div className="screen" id="screenHome">
        <div className="card authpanel" role="alert" id="homeError">
          <h2>Your workspace could not be read</h2>
          <div className="authsub">{error}</div>
          <button className="btn primary" type="button" onClick={() => { void reload(); }}>Try again</button>
        </div>
      </div>
    );
  }
  const org = state?.org;
  // A private copy's account in no workplace and unable to found one (note
  // #808): declined, or removed. Nothing here is theirs to use, so Home says
  // how people get in rather than drawing an empty Workspace.
  // Our own platform with sign-up closed (note #823) is the same: an account
  // in no workplace waits on its request, it does not found one.
  if (!org && (PRIVATE_COPY || SIGNUP_CLOSED) && state && !state.canCreateOrg) return <NoWorkplaceYet />;
  if (!org) return <OverviewScreen />;
  if (carriesHomeShown(search)) {
    const kept = new URLSearchParams(search);
    for (const word of [HOME_HALF_PARAM, HOME_ROOM_PARAM, HOME_CONTENT_PARAM]) kept.delete(word);
    const rest = kept.toString();
    return <Navigate to={`/${rest ? `?${rest}` : ''}`} replace state={location.state} />;
  }
  const landed = (location.state as { banner?: string } | null)?.banner ?? '';
  // A private copy's licence, for its admins, while it needs them (note #814).
  const licence = state?.copyLicence?.line ?? '';
  return <HomeWithWindows key={org.orgId} orgId={org.orgId} notice={landed} standing={licence} />;
}

function NoWorkplaceYet() {
  // The account menu lives in a workplace's Home, so the way out is here.
  const { signOut } = useSession();
  return (
    <div className="screen" id="screenHome">
      <div className="card authpanel" id="homeNoWorkplace">
        <h2>You’re not in a workplace yet</h2>
        <div className="authsub">{PRIVATE_COPY
          ? 'This Workspace belongs to one company, and people join it through an invite link. Ask an admin of your workplace for the link and open it: your request goes to them.'
          : 'People join a workplace here through an invite link. Ask an admin of the workplace for the link and open it: your request goes to them.'}</div>
        <button className="btn ghost" type="button" onClick={() => { void signOut(); }}>Sign out</button>
      </div>
    </div>
  );
}

function HomeWithWindows({ orgId, notice, standing }: { orgId: string; notice: string; standing: string }) {
  const { refreshHome } = useWorkspace();
  // Whether the Workplace window stands, as the browser entry says
  // (`home-sheet.ts`). An entry that arrived carrying the window it did not
  // push (the overview's old address) is first rebuilt into a pushed entry,
  // so its Back closes the window rather than leaving Home. Idempotent — an
  // entry already in that shape is left alone — which is what makes it safe
  // in an initializer.
  const arrived = useLocation().state;
  const [stack, setStack] = useState<HomeSheetStack>(() => settleSheetEntry(arrived));
  // The window on its way out, drawn until the exit has played.
  const [closing, setClosing] = useState<HomeSheetStack>([]);
  // A window that was already standing when Home was drawn — a reload, a
  // Back from a screen the window opened — is returning, not arriving, and
  // stands without the way in.
  const [still, setStill] = useState(() => stack.length > 0);
  const stackRef = useRef(stack);
  // A Back or Close already sent to the browser and not yet answered: a
  // second tap must not spend a second entry — that would walk out of Home.
  const popping = useRef(false);
  const stand = useCallback((next: HomeSheetStack) => { stackRef.current = next; setStack(next); }, []);

  useEffect(() => {
    const onPop = () => {
      popping.current = false;
      const was = stackRef.current;
      const next = currentSheetStack();
      if (!next.length && was.length) setClosing(was);
      if (next.length) setClosing([]);
      stand(next);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [stand]);

  const open = useCallback(() => {
    if (stackRef.current.length || popping.current) return;
    const next: HomeSheetStack = [{ kind: 'workplace' }];
    pushSheetLevel(next);
    setStill(false);
    setClosing([]);
    stand(next);
    // The window is an entry of Home's own address, so the router sees no
    // arrival and nothing else re-reads what it shows: the subscriptions,
    // repositories, knowledge and sites ride the full read, and the copy in
    // hand is whatever Home last read — minutes old on a quiet fleet
    // (note #717). It stands on that copy while the read is out.
    void refreshHome();
  }, [refreshHome, stand]);
  const close = useCallback(() => {
    const depth = stackRef.current.length;
    if (popping.current || !depth) return;
    popping.current = true;
    window.history.go(-depth);
  }, []);

  const drawn = stack.length ? stack : closing;
  return (
    <>
      <Conversation
        orgId={orgId}
        home
        {...(notice ? { notice } : {})}
        {...(standing ? { standing } : {})}
        windowOpen={stack.length > 0}
        onOpenWindow={open}
      />
      {drawn.length
        ? (
          <HomeSheet
            leaving={!stack.length}
            still={still}
            onGone={() => setClosing([])}
            onClose={close}
          />
        )
        : null}
    </>
  );
}
