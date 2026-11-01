/**
 * Signing in a subscription: pick the provider (`/seats/sign-in`), then its
 * own page (`/seats/sign-in/claude`, `/seats/sign-in/chatgpt`,
 * `/seats/sign-in/opencode`) — or the same behind the setup gate at
 * `/setup/subscription[/…]` (2026-09-22). On the provider's page: open its
 * sign-in, paste the code back (Claude), approve with a one-time code
 * (ChatGPT) or paste an API key from its console (OpenCode, note #780), and
 * watch until the seat lands.
 * Polling IS the engine — each status read advances the flow. A repaint of
 * the same state leaves a half-typed code alone, so the paste box is keyed
 * off the phase. Neither provider waits for a machine: the server asks both
 * for their sign-in itself.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import type { WorkspaceSeatSignInAnswer, WorkspaceSeatSignInStatus } from '../../../../src/shared/workspace-api.js';
import { jsonBody } from '../../api/client.js';
import { useBanner } from '../../chrome/useBanner.js';
import { useSession } from '../../session/useSession.js';
import { copyFromTap, errorMessage, openExternal } from '../../ui/format.js';
import { Icon, Svg, TypeIcon } from '../../ui/icons.js';
import { providerForSignInSlug, signInSlug, subscriptionName } from '../../ui/seat-words.js';
import { toFor, useWorkspaceRoute } from '../../routes.js';
import { hasEntryBeneath, useReturnToParent } from '../../chrome/history.js';
import { useSeats } from '../../workspace/useSeats.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';

export const SEAT_SIGNIN_POLL_MS = 2500;

/**
 * A copy, as an icon (the owner, 2026-09-18): the tick says it landed, the
 * label is for the screen reader, and nothing on the card has to make
 * room for a word.
 */
function CopyIcon({ text, label, id }: { text: string; label: string; id: string }) {
  const banner = useBanner();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      className="copyicon" id={id} type="button" disabled={!text}
      aria-label={copied ? 'Copied' : label} title={copied ? 'Copied' : label}
      onClick={() => {
        copyFromTap(() => Promise.resolve(text)).then(() => {
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 2000);
        }).catch((error: unknown) => banner.show(errorMessage(error)));
      }}
    >
      <Svg name={copied ? 'tick' : 'copy'} size={17} />
    </button>
  );
}

/** The provider's page as a line a person can carry to another device: the
 *  address, and its copy. Held as a placeholder of its own size until the
 *  address is known. */
function SignInLink({ url }: { url: string }) {
  return (
    <div className="signinlink">
      {url
        ? <input aria-label="Sign-in link" readOnly value={url} onFocus={(event) => event.currentTarget.select()} />
        : <span className="signinpending" aria-hidden="true"><span className="skel" /></span>}
      <CopyIcon id="seatSignInCopyLink" text={url} label="Copy link" />
    </div>
  );
}

/**
 * One numbered step of a ceremony. Both providers' screens are two of these
 * on the same grid (2026-09-22): every block starts on the card's 16px
 * column, a step's heading sits the same distance above its content, and
 * each step ends in its own hint line.
 */
function SignInStep({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="signinstep">
      <div className="stepk"><span className="stepn"><span>{n}</span></span><span>{title}</span></div>
      {children}
    </div>
  );
}

/**
 * An answer with no sign-in is not a blip: the server no longer holds this
 * one (a restart forgot it, or it was replaced elsewhere). Say so, with the
 * door back in, rather than promising to notice an approval nobody is
 * waiting for — or taking a pasted code nowhere.
 */
function interrupted(status: WorkspaceSeatSignInStatus): WorkspaceSeatSignInStatus {
  return { ...status, state: { phase: 'failed', reason: 'This sign-in was interrupted — start it again.' } };
}

type View = { kind: 'loading' } | { kind: 'pick' } | { kind: 'error'; text: string } | { kind: 'status'; status: WorkspaceSeatSignInStatus };

/**
 * The picker and each provider's page are separate addresses, and moving
 * between them is a new screen: keyed by the address word, a provider's
 * ceremony — its poll, its half-typed code — never outlives its page.
 */
export function SeatSignInScreen() {
  const route = useWorkspaceRoute();
  const slug = route?.kind === 'seatSignInProvider' ? route.id : undefined;
  return <SeatSignIn key={slug ?? ''} slug={slug} />;
}

function SeatSignIn({ slug }: { slug: string | undefined }) {
  const { api } = useSession();
  const { state, reload } = useWorkspace();
  const seats = useSeats();
  const banner = useBanner();
  const navigate = useNavigate();
  const location = useLocation();
  // Null on the picker; a provider's page names its own.
  const provider = providerForSignInSlug(slug);
  const [view, setView] = useState<View>(provider ? { kind: 'loading' } : { kind: 'pick' });
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const finished = useRef(false);
  // The last code and link on screen, so the check after an approval keeps
  // showing them rather than blanking the card.
  const lastAwaiting = useRef<WorkspaceSeatSignInStatus['state'] | undefined>(undefined);
  // The poll re-enters `show`; the timer reads the newest one through a ref.
  const showRef = useRef<(status: WorkspaceSeatSignInStatus) => void>(() => {});
  const startRef = useRef<(provider: string) => Promise<void>>(async () => {});
  const orgId = state?.org?.orgId ?? '';
  const orgName = state?.org?.name ?? 'the active workplace';
  const pickTo = toFor({ kind: 'seatSignIn', orgId })!;
  const returnToPicker = useReturnToParent(pickTo, { state: location.state });
  const providerTo = (chosen: string) => toFor({ kind: 'seatSignInProvider', id: signInSlug(chosen), orgId })!;

  // Opened from the Chief of Staff's sign-in card (note #726): back to
  // Home when it lands, and no banner — the chat's own row says it.
  const afterSignIn = (location.state as { afterSignIn?: unknown } | null)?.afterSignIn;
  const backHome = afterSignIn === '/';
  const landed = useCallback(async (status: WorkspaceSeatSignInStatus) => {
    if (finished.current) return;
    finished.current = true;
    if (backHome) {
      seats.invalidate();
      navigate('/', { replace: true });
      await reload();
      return;
    }
    const st = status.state as { label?: string; attention?: string };
    banner.show(st.attention === 'payment_required'
      ? `“${st.label}” is signed in, but Claude paused it because the subscription needs attention.`
      : `“${st.label}” is signed in — your agents run on it now.`, true);
    // The cache goes FIRST, or the list walks back one seat short.
    seats.invalidate();
    navigate(toFor({ kind: 'seats', orgId })!, { replace: true });
    await reload();
  }, [backHome, banner, navigate, orgId, reload, seats]);

  const show = useCallback((status: WorkspaceSeatSignInStatus) => {
    if (!alive.current) return;
    if (status.state.phase === 'done') {
      setView({ kind: 'status', status });
      void landed(status);
      return;
    }
    if (status.state.phase === 'awaiting_code' || status.state.phase === 'awaiting_approval') lastAwaiting.current = status.state;
    setView({ kind: 'status', status });
    if (status.state.phase === 'failed') return;
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      let payload: WorkspaceSeatSignInAnswer | null = null;
      try {
        payload = await api.api<WorkspaceSeatSignInAnswer>('api/org/signin');
      } catch { payload = null; }
      if (!alive.current) return;
      // A transient read failure must not strand a device ceremony. Repaint
      // the same non-terminal state to arm the next bounded poll; no words
      // on screen change.
      if (!payload) { showRef.current(status); return; }
      showRef.current(payload.signin ?? interrupted(status));
    }, SEAT_SIGNIN_POLL_MS);
  }, [api, landed]);

  const start = useCallback(async (provider: string) => {
    setView({ kind: 'loading' });
    setCode('');
    try {
      const payload = await api.api<WorkspaceSeatSignInAnswer>('api/org/signin', jsonBody({ provider }));
      if (payload.signin) show(payload.signin);
    } catch (error) {
      if (alive.current) setView({ kind: 'error', text: errorMessage(error) });
    }
  }, [api, show]);
  useEffect(() => { showRef.current = show; startRef.current = start; });

  // Once, on open: the ceremony must not restart because a dependency of the
  // painter changed under it (the state read landing, say). A provider's
  // page resumes the ceremony the server already holds for that provider —
  // a reload, or coming back to the tab, keeps the same code — and starts
  // one otherwise. The picker asks nothing.
  useEffect(() => {
    alive.current = true;
    if (!provider && !hasEntryBeneath(location)) {
      // Opened fresh — a reload, a return to the tab, the gate's own move
      // here — while a sign-in is still under way: its page, not the picker,
      // is where the reader left off. Only fresh, so Back from a provider's
      // page to the picker stays on the picker.
      void api.api<WorkspaceSeatSignInAnswer>('api/org/signin')
        .then((payload) => {
          const held = payload.signin;
          if (!alive.current || !held || held.state.phase === 'failed' || held.state.phase === 'done') return;
          navigate(providerTo(held.provider), { replace: true, state: location.state });
        })
        .catch(() => { /* the picker is still a fine place to be */ });
    }
    if (provider) {
      void Promise.resolve()
        .then(() => api.api<WorkspaceSeatSignInAnswer>('api/org/signin'))
        .then((payload) => {
          if (!alive.current) return;
          const held = payload.signin;
          if (held && held.provider === provider && held.state.phase !== 'failed') showRef.current(held);
          else void startRef.current(provider);
        })
        .catch(() => { if (alive.current) void startRef.current(provider); });
    }
    return () => { alive.current = false; clearTimeout(timer.current); };
    // Once per page: see above. The picker's address and its state are the
    // ones it opened on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, provider]);

  /** Back to the picker: spend our own entry when the picker is under it,
   *  otherwise put the picker in this page's place (miniapp-navigation). */
  const toPicker = () => {
    returnToPicker();
  };

  const cancel = async () => {
    clearTimeout(timer.current);
    try { await api.api('api/org/signin', { method: 'DELETE' }); } catch { /* gone is gone */ }
    if (alive.current) toPicker();
  };

  const chooseAnother = () => {
    clearTimeout(timer.current);
    navigate(pickTo, { replace: true, state: location.state });
  };

  const status = view.kind === 'status' ? view.status : null;
  const st = status?.state as ({ phase: string; url?: string; note?: string; userCode?: string; reason?: string } | undefined);
  const title = provider ? `Sign in to ${subscriptionName(provider)}` : 'Sign in a subscription';
  // A provider's page wears its two steps from the first paint (2026-09-22):
  // while its sign-in is being started, what is not known yet — the code,
  // the link — is held in place at its own size, so nothing jumps when it
  // lands. While a finished sign-in is checked, the steps keep what they
  // showed and the commit says "Checking…".
  const pending = Boolean(provider) && (view.kind === 'loading' || st?.phase === 'starting');
  const checking = st?.phase === 'verifying';
  type Ceremony = { url?: string; note?: string; userCode?: string };
  const ceremony: Ceremony | undefined = st?.phase === 'awaiting_code' || st?.phase === 'awaiting_approval'
    ? st
    : checking ? lastAwaiting.current as Ceremony | undefined : undefined;
  const held = pending || checking;
  const showClaude = provider === 'claude' && (held || st?.phase === 'awaiting_code');
  const showChatgpt = provider === 'codex' && (held || st?.phase === 'awaiting_approval');
  const showOpenCode = provider === 'opencode' && (held || st?.phase === 'awaiting_code');
  const pasteCode = async () => {
    setSending(true);
    try {
      const payload = await api.api<WorkspaceSeatSignInAnswer>('api/org/signin/code', jsonBody({ code: code.trim() }));
      show(payload.signin ?? interrupted(status!));
    } catch (error) { banner.show(errorMessage(error)); }
    if (alive.current) setSending(false);
  };
  const finishLabel = sending || checking ? 'Checking…' : 'Finish sign-in';

  // A word that names no subscription is the picker's address misspelled.
  if (slug && !provider) return <Navigate to={pickTo} replace />;

  return (
    <div className="screen" id="screenSeatSignIn">
      <ScreenTitle titleId="seatSignInTitle" title={title} />
      <div className="sub" id="seatSignInSub">{view.kind === 'pick' ? `Choose what your agents will run first. This sign-in starts assigned to ${orgName} only.` : ''}</div>
      <div className="card">
        <div id="seatSignInBody" aria-busy={held}>
          {held ? <span className="sr-only" role="status">{checking ? 'Checking the sign-in…' : 'Starting the sign-in…'}</span> : null}
          {view.kind === 'error'
            ? (
              <>
                <div className="empty">{view.text}</div>
                {/* A dead end with no door is where Emma's live test found a
                    newcomer stuck: every refusal here names its way out. */}
                <div className="signinfoot">
                  <button className="btn bare" type="button" onClick={() => navigate('/')}>Back to Home</button>
                  <button className="formcommit" type="button" onClick={() => { if (provider) void start(provider); }}>Try again</button>
                </div>
              </>
            )
            : null}
          {view.kind === 'pick'
            ? (
              <>
                {/* Each subscription's sign-in is its own page (2026-09-22). */}
                {[['claude', 'Claude', 'Claude Pro or Max subscription'], ['codex', 'Codex', 'ChatGPT Plus or Pro subscription'], ['opencode', 'OpenCode', 'OpenCode Go subscription, with its API key']].map(([choice, name, detail]) => (
                  <button className="crow open" type="button" key={choice} onClick={() => navigate(providerTo(choice!), { state: location.state })}>
                    <TypeIcon glyph="card" />
                    <div className="main"><div className="name plain">{name}</div><div className="cline"><span className="ctext">{detail}</span></div></div>
                    <Icon name="chev" size={17} className="icon chev" />
                  </button>
                ))}
              </>
            )
            : null}
          {showClaude
            ? (
              <>
                {ceremony?.note && !held ? <div className="empty">{ceremony.note}</div> : null}
                <SignInStep n={1} title="Open and approve">
                  <button className={code.trim() ? 'btn ghost' : 'btn primary'} type="button" disabled={!ceremony?.url || checking} onClick={() => openExternal(ceremony?.url ?? '')}>Open the Claude sign-in</button>
                  <SignInLink url={ceremony?.url ?? ''} />
                  {/* Who the sign-in belongs to, on the page where it
                      happens (the owner, 2026-10-09): Anthropic's own page,
                      never ours. Never that Anthropic allows the arrangement,
                      or that the account is safe (claims-we-never-make). */}
                  <div className="fieldhint" id="seatSignInWhere">You sign in on Anthropic’s own page, and your password never touches us.</div>
                </SignInStep>
                <SignInStep n={2} title="Paste the code it gives you">
                  <input
                    type="text" autoCapitalize="none" autoComplete="off" spellCheck={false} autoCorrect="off"
                    aria-label="Paste the sign-in code" placeholder="xxxxxxxx#xxxxxxxx"
                    disabled={held}
                    value={code} onChange={(event) => setCode(event.target.value)}
                  />
                  <div className="fieldhint">It is two long strings joined by a # — copy it whole, # and all.</div>
                </SignInStep>
                {/* One foot row on both ceremonies (the owner, 2026-09-18),
                    ending the way every onboarding screen before it ends
                    (2026-09-22): Cancel quiet on the left, the commit on
                    the right as the tinted pill "Create account" and
                    "Continue" wear. */}
                <div className="signinfoot">
                  <button className="btn bare" id="seatSignInCancel" type="button" onClick={() => { void cancel(); }}>Cancel</button>
                  <button
                    className="formcommit"
                    id="seatSignInFinish"
                    type="button"
                    disabled={!code.trim() || sending || held}
                    onClick={() => { void pasteCode(); }}
                  >
                    {finishLabel}
                  </button>
                </div>
              </>
            )
            : null}
          {showOpenCode
            ? (
              <>
                {/* No OAuth here (note #780): OpenCode's subscription is
                    one API key from its console, the same steps on the
                    same grid as Claude's — the key is the code. */}
                {ceremony?.note && !held ? <div className="empty">{ceremony.note}</div> : null}
                <SignInStep n={1} title="Make a key in OpenCode">
                  <button className={code.trim() ? 'btn ghost' : 'btn primary'} type="button" disabled={!ceremony?.url || checking} onClick={() => openExternal(ceremony?.url ?? '')}>Open the OpenCode console</button>
                  <SignInLink url={ceremony?.url ?? ''} />
                  <div className="fieldhint" id="seatSignInWhere">Sign in on OpenCode’s own page, subscribe to Go there if you haven’t, and create an API key. Your password never touches us.</div>
                </SignInStep>
                <SignInStep n={2} title="Paste your key">
                  <input
                    type="password" autoCapitalize="none" autoComplete="off" spellCheck={false} autoCorrect="off"
                    aria-label="Paste your OpenCode API key" placeholder="Your OpenCode API key"
                    disabled={held}
                    value={code} onChange={(event) => setCode(event.target.value)}
                  />
                  <div className="fieldhint">It is checked with OpenCode, kept with your other sign-ins, and never shown again.</div>
                </SignInStep>
                <div className="signinfoot">
                  <button className="btn bare" id="seatSignInCancel" type="button" onClick={() => { void cancel(); }}>Cancel</button>
                  <button
                    className="formcommit"
                    id="seatSignInFinish"
                    type="button"
                    disabled={!code.trim() || sending || held}
                    onClick={() => { void pasteCode(); }}
                  >
                    {sending || checking ? 'Checking…' : 'Add key'}
                  </button>
                </div>
              </>
            )
            : null}
          {showChatgpt
            ? (
              <>
                {/* The code first and large, with its own copy; then the
                    link, to open here or to carry to another device (the
                    owner, 2026-09-18) — as the same two numbered steps
                    Claude's screen has, the heading naming what the box
                    holds (2026-09-22). */}
                <SignInStep n={1} title="Copy your code">
                  <div className="signincode">
                    {ceremony?.userCode
                      ? <div className="v" id="seatSignInCode">{ceremony.userCode}</div>
                      : <div className="v" aria-hidden="true"><span className="skel" /></div>}
                    <CopyIcon id="seatSignInCopyCode" text={ceremony?.userCode ?? ''} label="Copy code" />
                  </div>
                </SignInStep>
                <SignInStep n={2} title="Enter it and approve">
                  <button className="btn primary" type="button" disabled={!ceremony?.url || checking} onClick={() => openExternal(ceremony?.url ?? '')}>Open the ChatGPT sign-in</button>
                  <SignInLink url={ceremony?.url ?? ''} />
                  {/* OpenAI's own page, as Claude's names Anthropic's. */}
                  <div className="fieldhint" id="seatSignInWhere">You sign in on OpenAI’s own page, and your password never touches us. This screen notices on its own once you approve.</div>
                </SignInStep>
                {/* The same foot row as Claude's. Finish sign-in asks the
                    server now rather than waiting for the next poll. */}
                <div className="signinfoot">
                  <button className="btn bare" id="seatSignInCancel" type="button" onClick={() => { void cancel(); }}>Cancel</button>
                  <button
                    className="formcommit" id="seatSignInFinish" type="button" disabled={sending || held}
                    onClick={async () => {
                      setSending(true);
                      try {
                        clearTimeout(timer.current);
                        const payload = await api.api<WorkspaceSeatSignInAnswer>('api/org/signin');
                        show(payload.signin ?? interrupted(status!));
                      } catch (error) {
                        banner.show(errorMessage(error));
                        // The poll this tap cleared must come back, or the
                        // screen stops noticing the approval.
                        show(status!);
                      }
                      if (alive.current) setSending(false);
                    }}
                  >
                    {finishLabel}
                  </button>
                </div>
              </>
            )
            : null}
          {st?.phase === 'done' ? <div className="empty">Signed in.</div> : null}
          {st?.phase === 'failed'
            ? (
              <>
                <div className="empty">{st.reason || 'The sign-in did not complete.'}</div>
                {/* Start again means the SAME subscription, not the picker
                    (note #132): the provider was chosen once, and a retry
                    that asks again reads as the choice not having taken. */}
                <div className="signinfoot">
                  <button className="btn bare" type="button" onClick={chooseAnother}>Choose another subscription</button>
                  <button className="formcommit" type="button" onClick={() => { void start(status!.provider); }}>Start again</button>
                </div>
              </>
            )
            : null}
        </div>
      </div>
      {/* Little under the card behind the gate (the owner, 2026-09-18) —
          the reason above, and the way out to another workplace, which this step carries
          since it became setup's first screen (note #664, from note #653).
          It draws nothing for a person with nowhere else to go. */}
      {/* One line under the card behind the gate after all (the owner,
          2026-10-08, from note #188): a newcomer asked for a paid plan with
          no reason given is the step every outside account stopped at. */}
      {view.kind === 'pick'
        ? <div className="formhint" id="seatSignInHint">It stays private to you. You may reuse it in other workplaces later, simultaneously, while their admins see neither its credential nor its usage. You sign in on Anthropic’s, OpenAI’s or OpenCode’s own page, and your password never touches us.</div>
        : null}
    </div>
  );
}
