import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Screen, H2 } from './landing-kit';
import { AnswerText, clock, localTime, repoFileUrl } from './agent-text';
import { NEW_TAB, useNewTab } from '../lib/new-tab';
import { PRIVATE_COPY_URL } from '../lib/workspace-link';
import {
  GUEST_CREATING_POLL_MS,
  GUEST_IDLE_POLL_MS,
  GUEST_MAX_CHARS,
  GUEST_TURN_GIVE_UP_MS,
  GUEST_TURN_POLL_MS,
  GUEST_WAITING_POLL_MS,
  deleteGuest,
  guestKey,
  isRunning,
  keepGuestKey,
  makeGuest,
  passTurnstile,
  readGuest,
  readTurn,
  sendMessage,
  stopTurn,
  type GuestActivity,
  type GuestAgent as Agent,
  type GuestCreateStep,
  type GuestMessage,
  type GuestRemovedReason,
  type GuestStatus,
  type GuestTurnState,
} from '../lib/guest-api';

/* ── The guest's own agent (notes #1036, #1038 and #1039) ────────────────
   Adam, 6 Nov 2026, 16:51 UTC: a visitor makes a real Claude Code agent of
   their own on the home page, talks to it and deletes it. Rosa's design on
   note #1036 (the eight screens on board-desk.png and board-phone.png) is
   the brief, with Adam's decisions of 17:20 and 17:24 UTC on note #1038: no
   Hugo anywhere (when every slot is taken, the line and nothing else), the
   chips "2 cores its own · Sonnet high effort", one browser only, the
   invisible Turnstile check on Make my agent, a fixed greeting in the
   agent's name. It replaced "Ask an agent that reads the code." (note
   #1010). The routes are Rosa's (src/lib/guest-api.ts). The words follow
   claims-we-never-make: nothing says the conversation is deleted (Adam
   keeps transcripts 90 days), nothing says free or hosted. */

export const GUEST_HEADING = 'Make an agent of your own.';
export const GUEST_LEAD = 'A real Claude Code agent on a computer of its own, reading our open-source code. Ask it anything. Delete it when you’re done.';
export const GUEST_CHIPS: ReadonlyArray<[string, string]> = [['2 cores', 'its own'], ['Sonnet', 'high effort']];
export const GUEST_MAKE = 'Make my agent';
export const GUEST_LIFE_LINE = 'It sleeps when you’re quiet, and goes after 30 quiet minutes.';
export const GUEST_STEPS: Record<GuestCreateStep['id'], string> = {
  computer: 'A computer of its own · 2 cores, 4 GB',
  code: 'A copy of the open-source code',
  claude: 'Starting Claude Code on Sonnet',
  hello: 'Saying hello',
};
export const GUEST_IDENTITY = 'Your agent · its own computer, 2 cores · Claude Code on Sonnet';
export const GUEST_FAILED = 'Something went wrong on our side. Try again in a minute.';
export const GUEST_CHECK_FAILED = 'The check that you’re a person didn’t go through. Try again.';
export const BUILD_YOURS_LABEL = 'Build your own Agentic Cloud';
/* A spare is ready in about fifteen seconds; built from nothing it takes a
   minute or two. The status's estimateSeconds says which; should a spare
   run long, the line changes once the wait has passed a spare's. */
const SPARE_SECONDS = 40;

const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
export function lineWords(position: number): string {
  const place = ORDINALS[position] ?? `number ${position}`;
  return position <= 1
    ? 'You’re next in line. Keep the page open and yours starts as soon as a computer frees up.'
    : `You’re ${place} in line. Keep the page open and yours starts as soon as a computer frees up.`;
}

export function removedWords(name: string, reason: GuestRemovedReason | null | undefined): string {
  if (reason === 'lifetime') return `${name} reached its 3 hours, and was removed.`;
  if (reason === 'messages') return `${name} had its 40 messages, and was removed.`;
  if (reason === 'quiet' || !reason) return `${name} was removed after 30 quiet minutes.`;
  return `${name} was removed.`;
}

/** Minutes left before it goes, from an ISO time; null when unknown. */
export function minutesLeft(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.round((at - now) / 60_000));
}

/** The working line, from what it is doing now. */
export function workingWords(activity: GuestActivity[], seconds: number): string {
  const last = activity[activity.length - 1];
  const doing = !last || last.kind === 'read' ? 'Reading the code'
    : last.kind === 'edit' ? 'Changing its copy'
    : last.kind === 'search' ? 'Searching the code'
    : last.kind === 'run' ? 'Running a command'
    : 'Working';
  return `${doing} · ${clock(seconds)}`;
}

/* ── Small pieces ──────────────────────────────────────────────────────── */

function Face({ agent, size = 32, dim = false }: { agent: Agent | null; size?: number; dim?: boolean }) {
  const cls = `shrink-0 rounded-full object-cover ${dim ? 'opacity-55 grayscale' : ''}`;
  return agent?.avatarUrl
    ? <img src={agent.avatarUrl} alt="" width={size} height={size} style={{ width: size, height: size }} className={cls} />
    : <span aria-hidden="true" style={{ width: size, height: size }} className="shrink-0 rounded-full bg-panel-soft" />;
}

const INK_BUTTON = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-white px-5 type-sm font-semibold text-panel transition-colors hover:bg-white/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:bg-hint/35 sm:type-base';
const LINE_BUTTON = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-white/25 px-5 type-sm font-semibold text-white transition-colors hover:border-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:type-base';

function BuildYours({ ink = false }: { ink?: boolean }) {
  return <a href={PRIVATE_COPY_URL} className={ink ? INK_BUTTON : LINE_BUTTON}>{BUILD_YOURS_LABEL}</a>;
}

function ArrowRight() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4" fill="none">
      <path d="M4 10h11M11 5.5L15.5 10 11 14.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Trash() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 7h15M10 7V5.2c0-.7.5-1.2 1.2-1.2h1.6c.7 0 1.2.5 1.2 1.2V7M6.5 7l.8 11.3c.1 1 .9 1.7 1.9 1.7h5.6c1 0 1.8-.7 1.9-1.7L17.5 7" />
    </svg>
  );
}

type StepState = 'done' | 'doing' | 'waiting';
function StepMark({ state }: { state: StepState }) {
  if (state === 'done') {
    return (
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ok text-panel" aria-hidden="true">
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
      </span>
    );
  }
  if (state === 'doing') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true" className="h-5 w-5 shrink-0 motion-safe:animate-spin" fill="none">
        <circle cx="10" cy="10" r="8" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2" />
        <path d="M10 2a8 8 0 0 1 8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  return <span aria-hidden="true" className="h-5 w-5 shrink-0 rounded-full border-2 border-hint/25" />;
}

type Chip = 'Ready' | 'Reading' | 'Working' | 'Waking' | 'Asleep';
function StateChip({ chip }: { chip: Chip }) {
  const dot = chip === 'Ready' ? 'bg-ok' : chip === 'Asleep' ? 'bg-hint/50' : 'bg-accent';
  return (
    <span data-guest-chip className="inline-flex items-center gap-1.5 rounded-full bg-panel-soft px-2.5 py-0.5 type-xs font-medium text-hint">
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {chip}
    </span>
  );
}

function Dots() {
  return (
    <span aria-hidden="true" className="inline-flex gap-1.5">
      <span className="h-2 w-2 rounded-full bg-white motion-safe:animate-pulse" />
      <span className="h-2 w-2 rounded-full bg-white/40" />
      <span className="h-2 w-2 rounded-full bg-white/15" />
    </span>
  );
}

/* ── The section ───────────────────────────────────────────────────────── */

type View =
  | { kind: 'loading' }
  | { kind: 'invite'; problem?: string }
  | { kind: 'creating' }
  | { kind: 'chat' }
  | { kind: 'removed'; reason: GuestRemovedReason | null }
  | { kind: 'deleted' }
  | { kind: 'waiting'; position: number }
  | { kind: 'resting'; until: string | null }
  | { kind: 'limited'; until: string | null }
  | { kind: 'failed' };

type Turn = { turnId: string; state: GuestTurnState; partial: string; activity: GuestActivity[]; files: string[]; startedAt: number; heardAt: number };

export function GuestAgentSection() {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [agent, setAgent] = useState<Agent | null>(null);
  const [status, setStatus] = useState<GuestStatus | null>(null);
  const [messages, setMessages] = useState<GuestMessage[]>([]);
  const [turn, setTurn] = useState<Turn | null>(null);
  const [lastActivity, setLastActivity] = useState<GuestActivity[]>([]);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [creatingSince, setCreatingSince] = useState<number | null>(null);
  const checkHost = useRef<HTMLDivElement>(null);
  const turnRef = useRef<Turn | null>(null);
  turnRef.current = turn;

  const name = agent?.name ?? 'Your agent';
  const running = turn ? isRunning(turn.state) : false;

  const follow = useCallback((turnId: string, state: GuestTurnState = 'working') => {
    const at = Date.now();
    setTurn({ turnId, state, partial: '', activity: [], files: [], startedAt: at, heardAt: at });
    setNow(at);
  }, []);

  /* What the routes say, drawn. A turn the page is following keeps its own
     messages: the status only fills in what the page does not know. */
  /* `settled`: a turn just ended, so the status's conversation is the truth
     even before the page has dropped the turn it followed. */
  const apply = useCallback((next: GuestStatus, settled = false) => {
    if (settled) turnRef.current = null;
    setStatus(next);
    setNow(Date.now());
    if (next.agent) setAgent(next.agent);
    if (next.state !== 'creating') setCreatingSince(null);
    switch (next.state) {
      case 'none':
        if (guestKey()) keepGuestKey(null);
        setView((v) => (v.kind === 'deleted' || v.kind === 'removed' ? v : { kind: 'invite' }));
        return;
      case 'creating':
        setCreatingSince((since) => since ?? Date.now());
        setView({ kind: 'creating' });
        return;
      case 'waiting':
        setView({ kind: 'waiting', position: next.linePosition ?? 1 });
        return;
      case 'resting':
        if (next.agent && next.messages.length) {
          /* Its agent lives on; only new turns rest. */
          setView({ kind: 'chat' });
          if (!turnRef.current) setMessages(next.messages);
          setNotice(restingNotice(next.until));
          return;
        }
        setView({ kind: 'resting', until: next.until });
        return;
      case 'limited':
        if (next.agent && next.messages.length) {
          /* Its 40 messages are spent: the chat stays to read until it goes. */
          setView({ kind: 'chat' });
          if (!turnRef.current) setMessages(next.messages);
          setNotice(`${next.agent.name} has had its 40 messages.`);
          return;
        }
        setView({ kind: 'limited', until: next.until });
        return;
      case 'failed':
        setView({ kind: 'failed' });
        return;
      case 'removed':
        keepGuestKey(null);
        setTurn(null);
        setView({ kind: 'removed', reason: next.removedReason });
        return;
      default:
        setView({ kind: 'chat' });
        if (!turnRef.current) {
          setMessages(next.messages);
          const lastAgent = [...next.messages].reverse().find((m) => m.role === 'agent');
          setLastActivity(lastAgent?.activity ?? []);
          if (next.state === 'working' && next.turn) follow(next.turn.turnId, next.machine?.awake === false ? 'waking' : 'working');
        }
    }
  }, [follow]);

  const refresh = useCallback((signal?: AbortSignal, settled = false) => readGuest(signal).then((next) => { if (!signal?.aborted) apply(next, settled); }), [apply]);

  /* On load: is there an agent of this browser's, and in what state. */
  useEffect(() => {
    const abort = new AbortController();
    refresh(abort.signal).catch(() => {
      if (!abort.signal.aborted) setView({ kind: 'invite' });
    });
    return () => abort.abort();
  }, [refresh]);

  /* Keep reading the state: every 1.5 s while it is made, every 5 s in line
     (the place is kept only while the page asks), every 20 s while the chat
     is quiet (the chip, the minutes left, removal). And at once when the
     tab comes back, since a hidden tab's timers slow down. */
  const pollEvery = view.kind === 'creating' ? GUEST_CREATING_POLL_MS
    : view.kind === 'waiting' ? GUEST_WAITING_POLL_MS
    : view.kind === 'chat' && !running ? GUEST_IDLE_POLL_MS
    : 0;
  useEffect(() => {
    if (!pollEvery) return undefined;
    const abort = new AbortController();
    const read = () => { refresh(abort.signal).catch(() => { /* next tick */ }); };
    const timer = window.setInterval(read, pollEvery);
    const back = () => { if (document.visibilityState === 'visible') read(); };
    document.addEventListener('visibilitychange', back);
    return () => { abort.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', back); };
  }, [pollEvery, refresh]);

  /* The clocks ("Your agent · 0:09", "Reading the code · 0:11"). */
  const ticking = view.kind === 'creating' || running;
  useEffect(() => {
    if (!ticking) return undefined;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [ticking]);

  /* Follow a running turn every second; the text arrives as it is written. */
  const turnId = running ? turn?.turnId : undefined;
  useEffect(() => {
    if (!turnId) return undefined;
    const abort = new AbortController();
    let timer = 0;
    const poll = async () => {
      const current = turnRef.current;
      if (current && Date.now() - current.heardAt > GUEST_TURN_GIVE_UP_MS) {
        setTurn(null);
        setNotice(GUEST_FAILED);
        return;
      }
      try {
        const read = await readTurn(turnId, abort.signal);
        if (abort.signal.aborted) return;
        if (isRunning(read.state)) {
          /* The backend's own clock, so a reload mid-turn keeps counting. */
          const startedAt = Date.now() - Math.max(0, read.elapsedSeconds ?? 0) * 1000;
          setTurn((t) => (t && t.turnId === turnId ? { ...t, state: read.state, partial: read.partial ?? '', activity: read.activity ?? [], files: read.files ?? [], startedAt: Math.min(t.startedAt, startedAt), heardAt: Date.now() } : t));
          timer = window.setTimeout(poll, GUEST_TURN_POLL_MS);
          return;
        }
        const text = read.answer ?? read.partial ?? '';
        if ((read.state === 'answered' || read.state === 'declined' || read.state === 'stopped') && text.trim()) {
          setMessages((list) => [...list, { id: read.turnId, role: 'agent', text, at: new Date().toISOString(), state: read.state as GuestMessage['state'], activity: read.activity ?? [] }]);
        }
        setLastActivity(read.activity?.length ? read.activity : (read.files ?? []).map((label) => ({ kind: 'read' as const, label })));
        setTurn(null);
        /* A failed turn: the backend writes its own line into the
           conversation (the refresh below brings it), so no second notice. */
        if (read.state === 'stopped') setNotice('Stopped.');
        if (read.state === 'resting') setNotice(restingNotice(read.until ?? null));
        /* Its new quiet clock, messages left, and any line the backend wrote. */
        refresh(undefined, true).then(() => undefined, () => { if (read.state === 'failed') setNotice(GUEST_FAILED); });
      } catch {
        if (!abort.signal.aborted) timer = window.setTimeout(poll, GUEST_TURN_POLL_MS);
      }
    };
    timer = window.setTimeout(poll, GUEST_TURN_POLL_MS);
    return () => { abort.abort(); window.clearTimeout(timer); };
  }, [turnId, refresh]);

  const make = async () => {
    if (making) return;
    setMaking(true);
    setConfirming(false);
    let token: string | null = null;
    const siteKey = status?.turnstileSiteKey ?? null;
    if (siteKey) {
      try {
        token = await passTurnstile(siteKey, checkHost.current!);
      } catch {
        setMaking(false);
        setView({ kind: 'invite', problem: GUEST_CHECK_FAILED });
        return;
      }
    }
    try {
      const reply = await makeGuest(token);
      if ('state' in reply) {
        setView({ kind: 'invite', problem: reply.error === 'challenge' ? GUEST_CHECK_FAILED : GUEST_FAILED });
        return;
      }
      if (reply.key) keepGuestKey(reply.key);
      setMessages([]);
      setLastActivity([]);
      setNotice(null);
      apply(reply.status);
    } catch {
      setView({ kind: 'invite', problem: GUEST_FAILED });
    } finally {
      setMaking(false);
    }
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim().slice(0, GUEST_MAX_CHARS);
    if (!text || running) return;
    setNotice(null);
    try {
      const reply = await sendMessage(text);
      if (reply.state === 'accepted') {
        setDraft('');
        setMessages((list) => [...list, { id: reply.messageId, role: 'visitor', text, at: new Date().toISOString() }]);
        follow(reply.turnId, status?.state === 'asleep' || status?.machine?.awake === false ? 'waking' : 'working');
      } else if (reply.state === 'busy') {
        follow(reply.turnId);
      } else if (reply.state === 'status') {
        apply(reply.status);
      } else if (reply.state === 'unknown') {
        keepGuestKey(null);
        setView({ kind: 'removed', reason: null });
      } else {
        setNotice(GUEST_FAILED);
      }
    } catch {
      setNotice(GUEST_FAILED);
    }
  };

  const stop = () => {
    if (turn) void stopTurn(turn.turnId).catch(() => { /* the poll still settles it */ });
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await deleteGuest();
      keepGuestKey(null);
      setTurn(null);
      setConfirming(false);
      setView({ kind: 'deleted' });
    } catch {
      setNotice(GUEST_FAILED);
    } finally {
      setDeleting(false);
    }
  };

  const again = () => {
    keepGuestKey(null);
    setAgent(null);
    setMessages([]);
    void make();
  };

  return (
    <Screen id="your-agent" label="Make an agent of your own">
      <div data-guest-view={view.kind} aria-live="polite">
        {view.kind === 'loading' || view.kind === 'invite' ? (
          <Invite making={making} problem={view.kind === 'invite' ? view.problem : undefined} onMake={make} />
        ) : null}
        {view.kind === 'creating' ? <Creating agent={agent} steps={status?.steps ?? null} since={status?.createdAt ? new Date(status.createdAt).getTime() : creatingSince ?? now} estimate={status?.estimateSeconds ?? null} now={now} /> : null}
        {view.kind === 'chat' ? (
          <Chat
            agent={agent}
            status={status}
            messages={messages}
            turn={turn}
            lastActivity={lastActivity}
            now={now}
            draft={draft}
            notice={notice}
            confirming={confirming}
            deleting={deleting}
            onDraft={setDraft}
            onSend={send}
            onStop={stop}
            onAskDelete={() => setConfirming(true)}
            onKeep={() => setConfirming(false)}
            onDelete={remove}
          />
        ) : null}
        {view.kind === 'deleted' ? (
          <Ending title={`${name} is deleted, computer and all.`} line="Your own agents live in your own Agentic Cloud.">
            <BuildYours ink />
            <button type="button" onClick={again} disabled={making} className={LINE_BUTTON}>Make another agent</button>
          </Ending>
        ) : null}
        {view.kind === 'removed' ? (
          <Ending title={removedWords(name, view.reason)} line="Its computer went with it. Make a new one any time.">
            <button type="button" onClick={again} disabled={making} className={INK_BUTTON}>Make a new agent</button>
            <BuildYours />
          </Ending>
        ) : null}
        {view.kind === 'failed' ? (
          <Ending title={`${name} couldn’t be made.`} line="Something went wrong on our side. Try again in a minute.">
            <button type="button" onClick={again} disabled={making} className={INK_BUTTON}>Try again</button>
            <BuildYours />
          </Ending>
        ) : null}
        {view.kind === 'waiting' ? (
          <Ending title="Every guest agent is taken right now." line={lineWords(view.position)} />
        ) : null}
        {view.kind === 'resting' ? (
          <Ending
            title={localTime(view.until ?? undefined) ? `Guest agents are resting until ${localTime(view.until ?? undefined)}.` : 'Guest agents are resting for now.'}
            line="Come back then and make one. Or build your own Agentic Cloud now, with your own Claude plan."
          >
            <BuildYours ink />
          </Ending>
        ) : null}
        {view.kind === 'limited' ? (
          <Ending
            title="That’s three agents from here today."
            line={localTime(view.until ?? undefined) ? `You can make another at ${localTime(view.until ?? undefined)}. Or build your own Agentic Cloud now.` : 'You can make another tomorrow. Or build your own Agentic Cloud now.'}
          >
            <BuildYours ink />
          </Ending>
        ) : null}
      </div>
      {/* Turnstile draws here only if Cloudflare asks the visitor to tick a box. */}
      <div ref={checkHost} data-guest-check className="mt-4 empty:hidden" />
    </Screen>
  );
}

function restingNotice(until: string | null): string {
  const at = localTime(until ?? undefined);
  return at ? `Guest agents are resting until ${at}. Your agent waits for you.` : 'Guest agents are resting for now. Your agent waits for you.';
}

function Invite({ making, problem, onMake }: { making: boolean; problem?: string; onMake: () => void }) {
  return (
    <div className="max-w-[40rem]">
      <h2 className={`[text-wrap:balance] ${H2}`}>{GUEST_HEADING}</h2>
      <p className="mt-4 type-base text-hint sm:mt-5 sm:type-md-sm">{GUEST_LEAD}</p>
      <ul data-guest-chips className="mt-5 flex flex-wrap gap-2">
        {GUEST_CHIPS.map(([strong, rest]) => (
          <li key={strong} className="rounded-full border border-white/15 px-3 py-1 type-sm text-hint">
            <b className="font-semibold text-white">{strong}</b> {rest}
          </li>
        ))}
      </ul>
      <button type="button" onClick={onMake} disabled={making} data-guest-make className={`mt-7 w-full sm:w-auto ${INK_BUTTON} sm:min-h-12 sm:px-6`}>
        {making ? 'Making your agent…' : GUEST_MAKE}
        {making ? null : <ArrowRight />}
      </button>
      <p className="mt-3 type-sm text-hint">{GUEST_LIFE_LINE}</p>
      {problem ? <p data-guest-problem role="status" className="mt-3 type-sm text-white">{problem}</p> : null}
    </div>
  );
}

function Creating({ agent, steps, since, estimate, now }: { agent: Agent | null; steps: GuestCreateStep[] | null; since: number; estimate: number | null; now: number }) {
  const list = steps?.length ? steps : (['computer', 'code', 'claude', 'hello'] as const).map((id) => ({ id, done: false }));
  const doing = list.findIndex((step) => !step.done);
  const seconds = (now - since) / 1000;
  return (
    <div className="max-w-[40rem]">
      <div className="flex items-center gap-4">
        <Face agent={agent} size={56} />
        <div className="min-w-0">
          <h2 className={`[text-wrap:balance] ${H2}`}>{agent ? `${agent.name} is getting ready.` : 'Your agent is getting ready.'}</h2>
          <p className="mt-1 type-sm tabular-nums text-hint">Your agent · {clock(seconds)}</p>
        </div>
      </div>
      <ol data-guest-steps className="mt-7 grid gap-3.5">
        {list.map((step, index) => {
          const state: StepState = step.done ? 'done' : index === doing ? 'doing' : 'waiting';
          return (
            <li key={step.id} data-step={state} className={`flex items-center gap-3 type-base ${state === 'waiting' ? 'text-hint/70' : 'text-white'}`}>
              <StepMark state={state} />
              {GUEST_STEPS[step.id]}
            </li>
          );
        })}
      </ol>
      <p className="mt-7 type-sm text-hint">{(estimate ?? 0) > 60 || seconds > SPARE_SECONDS ? 'Keep this page open. This one takes about two minutes.' : 'Keep this page open. It takes about fifteen seconds.'}</p>
    </div>
  );
}

function Ending({ title, line, children }: { title: string; line: string; children?: ReactNode }) {
  return (
    <div className="max-w-[40rem]">
      <h2 className={`[text-wrap:balance] ${H2}`}>{title}</h2>
      <p className="mt-4 type-base text-hint sm:type-md-sm">{line}</p>
      {children ? <div className="mt-7 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">{children}</div> : null}
    </div>
  );
}

type ChatProps = {
  agent: Agent | null;
  status: GuestStatus | null;
  messages: GuestMessage[];
  turn: Turn | null;
  lastActivity: GuestActivity[];
  now: number;
  draft: string;
  notice: string | null;
  confirming: boolean;
  deleting: boolean;
  onDraft: (text: string) => void;
  onSend: (event: FormEvent) => void;
  onStop: () => void;
  onAskDelete: () => void;
  onKeep: () => void;
  onDelete: () => void;
};

const ACTIVITY_WORD: Record<GuestActivity['kind'], string> = { read: 'read', edit: 'changed', search: 'searched', run: 'ran', other: '' };

/** What the agent did in a turn, in order: files linked to the public code
    (a changed file is its own copy's; the link shows ours), searches and
    commands as they were run. The last one is the one still running. */
function ActivityList({ activity, running }: { activity: GuestActivity[]; running: boolean }) {
  const newTab = useNewTab();
  const shown = activity.slice(-12);
  return (
    <ol data-guest-activity className="grid gap-2.5">
      {shown.map((step, index) => {
        const now = running && index === shown.length - 1;
        const isFile = step.kind === 'read' || step.kind === 'edit';
        const slash = step.label.lastIndexOf('/');
        return (
          <li key={`${index}-${step.label}`} className="min-w-0">
            <span className="block type-xs text-hint/80">{ACTIVITY_WORD[step.kind]}</span>
            {isFile ? (
              <a
                href={repoFileUrl(step.label)}
                {...(newTab ? NEW_TAB : {})}
                className={`break-words font-mono type-sm leading-snug underline underline-offset-[3px] focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${now ? 'text-hint no-underline' : 'text-white decoration-white/25 hover:decoration-white'}`}
              >
                {step.label.slice(slash + 1)}
                <span className="block font-mono type-xs text-hint/80 no-underline">{slash >= 0 ? step.label.slice(0, slash + 1) : ''}</span>
              </a>
            ) : (
              <code className={`block break-words font-mono type-xs leading-snug ${now ? 'text-hint' : 'text-white'}`}>{step.label}</code>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Chat({ agent, status, messages, turn, lastActivity, now, draft, notice, confirming, deleting, onDraft, onSend, onStop, onAskDelete, onKeep, onDelete }: ChatProps) {
  const name = agent?.name ?? 'Your agent';
  const running = turn ? isRunning(turn.state) : false;
  const asleep = !running && (status?.state === 'asleep' || status?.machine?.awake === false);
  const lastKind = turn?.activity[turn.activity.length - 1]?.kind;
  const chip: Chip = running ? (turn!.state === 'waking' ? 'Waking' : !lastKind || lastKind === 'read' || lastKind === 'search' ? 'Reading' : 'Working') : asleep ? 'Asleep' : 'Ready';
  const left = minutesLeft(status?.quietUntil, now);
  const activity = running ? (turn!.activity.length ? turn!.activity : turn!.files.map((label) => ({ kind: 'read' as const, label }))) : lastActivity;
  const seconds = turn ? (now - turn.startedAt) / 1000 : 0;
  const machine = status?.machine;
  const size = `${machine?.cores ?? 2} cores, ${machine?.memoryGb ?? 4} GB`;

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-14">
      <div className="flex min-w-0 flex-col">
        <h2 className="sr-only">{GUEST_HEADING}</h2>
        <header className="flex items-start gap-3 border-b border-hint/16 pb-4">
          <Face agent={agent} size={44} />
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2">
              <b data-guest-name className="type-md-sm font-semibold text-white">{name}</b>
              <StateChip chip={chip} />
            </p>
            <p className="mt-0.5 type-sm text-hint">{GUEST_IDENTITY}</p>
          </div>
          <button
            type="button"
            onClick={onAskDelete}
            aria-label={`Delete ${name}`}
            data-guest-delete
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-white/20 text-white transition-colors hover:border-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:inline-flex sm:h-9 sm:w-auto sm:gap-1.5 sm:px-3.5 sm:type-sm sm:font-semibold"
          >
            <Trash />
            <span aria-hidden="true" className="hidden sm:inline">Delete</span>
          </button>
        </header>

        {confirming ? (
          <div data-guest-confirm role="alertdialog" aria-labelledby="guest-confirm-title" className="mt-5 rounded-2xl border border-hint/20 p-5 sm:p-6">
            <p id="guest-confirm-title" className="type-md-sm font-semibold text-white">Delete {name}?</p>
            <p className="mt-1 type-base text-hint">{name} and its computer are deleted now. This can’t be undone.</p>
            <div className="mt-4 flex flex-wrap gap-3">
              <button type="button" onClick={onDelete} disabled={deleting} className="inline-flex min-h-11 items-center rounded-full bg-danger px-5 type-sm font-semibold text-[#fcfcfb] transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60">
                {deleting ? 'Deleting…' : `Delete ${name}`}
              </button>
              <button type="button" onClick={onKeep} className={LINE_BUTTON}>Keep</button>
            </div>
          </div>
        ) : null}

        <ol data-guest-messages className="mt-5 grid gap-5">
          {messages.map((message) => (
            <li key={message.id} className={message.role === 'visitor' ? 'flex justify-end' : 'flex items-start gap-3'}>
              {message.role === 'visitor' ? (
                <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-panel-soft px-4 py-2.5 type-base text-white sm:max-w-[34em]">{message.text}</p>
              ) : (
                <>
                  <Face agent={agent} size={24} />
                  <div className={`min-w-0 max-w-[40em] space-y-3 type-base leading-relaxed ${message.state === 'declined' || message.state === 'failed' ? 'text-hint' : 'text-white'}`}>
                    <AnswerText text={message.text} />
                  </div>
                </>
              )}
            </li>
          ))}
          {running ? (
            <li className="flex items-start gap-3">
              <Face agent={agent} size={24} />
              <div className="min-w-0 max-w-[40em] flex-1">
                {turn!.partial ? <div className="mb-3 space-y-3 type-base leading-relaxed text-white"><AnswerText text={turn!.partial} /></div> : null}
                <p data-guest-working className="flex items-center gap-2.5 type-sm tabular-nums text-hint">
                  <Dots />
                  {turn!.state === 'waking' ? `Waking ${name}’s computer · about ten seconds` : workingWords(turn!.activity, seconds)}
                </p>
                {/* On a phone, what it is doing sits under the line (the desk
                    has the margin). The text arrives only when the answer
                    does, so these carry the wait. */}
                {activity.length > 0 ? (
                  <p data-guest-doing className="mt-2 flex flex-wrap gap-1.5 lg:hidden">
                    {activity.slice(-3).map((step, index) => (
                      <code key={`${index}-${step.label}`} className="max-w-full truncate rounded bg-panel-soft px-1.5 py-0.5 font-mono type-xs text-white">
                        {step.kind === 'read' || step.kind === 'edit' ? step.label.split('/').pop() : step.label}
                      </code>
                    ))}
                  </p>
                ) : null}
              </div>
            </li>
          ) : null}
        </ol>

        {asleep ? (
          <p data-guest-asleep className="mt-5 flex items-center gap-3 rounded-2xl bg-panel-soft px-4 py-3 type-sm text-white">
            <Face agent={agent} size={20} dim />
            {name}’s computer went to sleep while you were away. Your next message wakes it, in about ten seconds.
          </p>
        ) : null}

        {notice ? <p data-guest-notice role="status" className="mt-4 type-sm text-hint">{notice}</p> : null}

        <form onSubmit={onSend} className="mt-5 flex min-h-14 items-center gap-3 rounded-2xl bg-panel-soft py-2 pl-4 pr-1.5 sm:min-h-[60px] sm:pl-5 sm:pr-2.5">
          <label htmlFor="guest-input" className="sr-only">Your message to {name}</label>
          <input
            id="guest-input"
            value={draft}
            onChange={(event) => onDraft(event.target.value)}
            maxLength={GUEST_MAX_CHARS}
            autoComplete="off"
            enterKeyHint="send"
            placeholder={`Message ${name}`}
            className="min-w-0 flex-1 bg-transparent type-base text-white placeholder:text-hint focus:outline-none sm:type-md-sm"
          />
          {running ? (
            <button type="button" onClick={onStop} aria-label="Stop" className="group grid h-11 w-11 shrink-0 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent">
              <span aria-hidden="true" className="grid h-10 w-10 place-items-center rounded-full bg-white text-panel transition-colors group-hover:bg-white/85">
                <span className="h-3 w-3 rounded-[3px] bg-current" />
              </span>
            </button>
          ) : (
            /* The home page's send circle (note #1034): grey until there is a message. */
            <button type="submit" aria-label="Send" disabled={!draft.trim()} className="group grid h-11 w-11 shrink-0 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent">
              <span aria-hidden="true" className="grid h-10 w-10 place-items-center rounded-full bg-white text-panel transition-colors group-hover:bg-white/85 group-disabled:bg-hint/35 group-disabled:text-panel">
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 19V5" />
                  <path d="M5.5 11.5L12 5l6.5 6.5" />
                </svg>
              </span>
            </button>
          )}
        </form>
        {left !== null ? <p data-guest-left className="mt-2 type-sm tabular-nums text-hint">{name} goes after 30 quiet minutes · {left} left</p> : null}
      </div>

      {/* The desk margin: what it does, as it does it (files linked to the
          public code, searches and commands as they were run), then its
          computer. */}
      <aside aria-label={`${name}’s computer`} className="hidden border-l border-hint/16 pl-6 type-sm text-hint lg:block">
        {activity.length > 0 ? (
          <div className="mb-7">
            <p className="mb-3 type-xs font-semibold uppercase tracking-[0.06em] text-hint">{running ? 'What it’s doing' : 'What it did'}</p>
            <ActivityList activity={activity} running={running} />
          </div>
        ) : null}
        <p className="mb-2 type-xs font-semibold uppercase tracking-[0.06em] text-hint">{name}’s computer</p>
        <ul data-guest-computer className="grid gap-1">
          <li><b className="font-semibold text-white">{asleep ? 'Asleep' : 'Awake'}</b> · {size}</li>
          <li>{asleep ? 'Wakes on your next message' : 'Sleeps after 3 quiet minutes'}</li>
          <li>{status?.quietUntil && localTime(status.quietUntil) ? `Goes at ${localTime(status.quietUntil)} if it stays quiet` : 'Goes after 30 quiet minutes'}</li>
        </ul>
      </aside>
    </div>
  );
}
