/**
 * The guest's own agent (notes #1036 design, #1038 build; Adam, 6 Nov 2026).
 *
 * A visitor of the home page, signed out, makes a sealed Claude Code agent of
 * their own: a name and a face, a dedicated 2-core machine nobody else uses,
 * Sonnet at high effort, and a copy of the PUBLIC agentic-cloud repository.
 * It has every Claude Code tool, a shell included; the machine's outbound
 * network reaches only the public repository, package registries and the
 * platform's model door, and the seat token never reaches the machine at all.
 * It sleeps like every agent; after 30 quiet minutes, or 3 hours, or 40
 * messages, it is deleted with its machine. The owner keeps the transcript.
 *
 * This file is the CONTRACT the home page section and the backend share: the
 * limits, the states, and every request and answer of the six public routes.
 * Everything here is safe to ship to a browser.
 *
 * Every route lives under `/workspace/api/public/guest` (the Workspace router
 * is mounted at /workspace), answers 403 to any other Origin than the site's,
 * and — except the first GET and the POST that makes one — carries the
 * visitor's key in the `X-Guest-Key` header. The key is made by the server,
 * returned once, and kept by the page in localStorage (one browser only, no
 * cookie). The server stores only its SHA-256.
 *
 * Knowledge page: sealed-public-agent.
 */

/** Stored on AgentRecord.sealed for a guest's agent (beside 'public-guide'). */
export const GUEST_AGENT_KIND = 'guest' as const;

/** The repository a guest's agent works in: this name, in the owner's workplace, only while PUBLIC. */
export const GUEST_AGENT_REPO_NAME = 'agentic-cloud';

/** What a guest's agent thinks with (Adam, 6 Nov 2026): Sonnet at high, fixed. */
export const GUEST_AGENT_MODEL = 'sonnet';
export const GUEST_AGENT_EFFORT = 'high';

/** Its machine: two dedicated cores and 4 GB, whatever the workplace builds its other agents on. */
export const GUEST_AGENT_MACHINE_SIZE_ID = 'performance-2x';
export const GUEST_AGENT_MACHINE = { cores: 2, memoryGb: 4, dedicated: true } as const;

/** The header the page sends the visitor's key in. */
export const GUEST_KEY_HEADER = 'X-Guest-Key';
/** The localStorage key the page keeps it under (a suggestion the page may follow). */
export const GUEST_KEY_STORAGE = 'acc.guestKey';

/**
 * The numbers (note #1038: the pilot ceilings, raised only on Adam's word).
 * One place; the routes and the sweeper read nothing else.
 *
 * No ceiling on guests alive at once, no waiting line and no spares (note
 * #1055; Adam, 7 Nov 2026: "no slots needed. no queue needed. guest agent
 * creates separate agent."): every Make my agent builds that visitor's
 * machine and agent right then, from nothing, and the visitor watches the
 * steps. The day's 40 and the address's 3 are what bound the spend.
 */
export const GUEST_AGENT_LIMITS = {
  /** Agents made in a UTC day, everyone together. */
  globalPerDay: 40,
  /** Live agents per address. */
  perAddressLive: 1,
  /** Agents made per address per UTC day. */
  perAddressPerDay: 3,
  /** Characters in one message. */
  messageMaxChars: 1000,
  /** Messages in one agent's life. */
  messagesMax: 40,
  /** An agent's whole life, busy or not. */
  lifetimeMs: 3 * 60 * 60_000,
  /** Quiet for this long — no message, no turn running — and the agent is deleted with its machine. */
  quietMs: 30 * 60_000,
  /**
   * An optional ceiling on one reply, end to end (note #1054; Adam, 7 Nov 2026:
   * none). Unset, a reply runs until the agent answers, the visitor stops it,
   * or the agent's own life ends. Set a number of ms to bring a ceiling back.
   */
  turnCeilingMs: null as number | null,
  /** Tool rounds in one turn. */
  maxTurns: 30,
  // No share of the seat's 5-hour window or week rests guests (note #1048,
  // Adam: "remove guest limit"): only a seat out of service, a turn that hits
  // the plan's limit, today's guests used up, or guests switched off.
  /** Transcripts are kept this long, then deleted. */
  transcriptDays: 90,
} as const;

/**
 * Where the visitor stands, one word the page draws a screen for (the boards
 * on note #1036):
 *  - `none`      no agent: the invitation (screen 1).
 *  - `creating`  being built from nothing; `steps` say which step is running
 *                and since when, `step` names it (screen 2, note #1055).
 *  - `ready`     awake and listening (screen 3).
 *  - `working`   a turn is running; `turn` names it (screen 3).
 *  - `asleep`    its machine is stopped; the next message wakes it (screen 5).
 *  - `removed`   gone; `removedReason` says why (screens 4 and 6).
 *  - `resting`   guests are off, the seat is out of service or hit the plan's
 *                limit, or today's guests are used up; `until`. Never the
 *                seat's share alone (note #1048).
 *  - `limited`   this address has made its agents for today; `until`.
 *  - `failed`    making it failed on our side; the page offers to try again.
 */
export type GuestState =
  | 'none' | 'creating' | 'ready' | 'working' | 'asleep' | 'removed'
  | 'resting' | 'limited' | 'failed';

export type GuestRemovedReason = 'quiet' | 'visitor' | 'owner' | 'lifetime' | 'messages';

/**
 * The build, step by step (note #1055): each one a real event on the
 * backend, in this order, every visitor's agent built from nothing.
 *  - `machine`  its own computer is made: a Fly app, a volume and a
 *               2-core machine, started (the longest step).
 *  - `agent`    the sealed agent is made on it: the guide user, the network
 *               lock, the egress proxy, Claude Code's runner and instructions.
 *  - `code`     the public agentic-cloud repository is copied onto its volume.
 *  - `waking`   Claude Code is started once as the agent's user, to prove it
 *               runs there.
 *  - `ready`    the greeting is written; the status turns `ready` with it.
 */
export type GuestCreateStepId = 'machine' | 'agent' | 'code' | 'waking' | 'ready';
export const GUEST_CREATE_STEP_IDS: readonly GuestCreateStepId[] = ['machine', 'agent', 'code', 'waking', 'ready'];
export interface GuestCreateStep {
  id: GuestCreateStepId;
  /** Finished. */
  done: boolean;
  /** When the step began (ISO), or null while it has not. The page's clock for a step runs from here. */
  startedAt: string | null;
  /** When it finished (ISO), or null. */
  doneAt: string | null;
}

/**
 * About how long a build from nothing takes, measured (note #1055): the
 * page's `estimateSeconds` while `creating`. Spares built from nothing on
 * production took 25 to 55 s from reservation to ready (6 and 7 Nov 2026).
 */
export const GUEST_BUILD_ESTIMATE_SECONDS = 35;

/** One line of the conversation. The first is always the agent's fixed greeting. */
export interface GuestMessage {
  id: string;
  role: 'visitor' | 'agent';
  /** Markdown for the agent (read strictly: no raw HTML, links only to the site), plain text for the visitor. */
  text: string;
  at: string;
  /** Agent lines only: how the turn ended. */
  state?: 'answered' | 'declined' | 'failed' | 'stopped';
  /** Agent lines only: what it did, in order (see GuestActivity). */
  activity?: GuestActivity[];
}

/**
 * One thing the agent did in a turn, for the margin: a file it read or
 * changed (repository-relative), a search, or a command it ran (the first
 * 160 characters). `label` is safe to show as it is.
 */
export interface GuestActivity {
  kind: 'read' | 'edit' | 'search' | 'run' | 'other';
  label: string;
}

/**
 * GET /workspace/api/public/guest — read once on load and while creating
 * (every 1.5 s). With no key, or a key the server no
 * longer knows, the answer is `none` — or `resting` (with `until`) when no
 * agent could be made right now, so the page can draw screen 8 before the
 * tap — and `removed` when the key's agent was deleted within the last day.
 * A failed build answers `failed` for an hour.
 */
export interface GuestStatus {
  state: GuestState;
  agent: { name: string; avatarUrl: string | null } | null;
  /** The agent's computer, for the margin ("Juno's computer"). */
  machine: { cores: number; memoryGb: number; dedicated: boolean; awake: boolean } | null;
  /** The whole conversation, oldest first (empty unless a live agent). */
  messages: GuestMessage[];
  /** The running turn, while `working`. */
  turn: { turnId: string } | null;
  /** While `creating`: all five steps, in order, each with when it started and finished (note #1055). */
  steps: GuestCreateStep[] | null;
  /** While `creating`: the step running now. */
  step: GuestCreateStepId | null;
  /** While `creating`: about how long a build takes in all (GUEST_BUILD_ESTIMATE_SECONDS). */
  estimateSeconds: number | null;
  /** When the visitor tapped Make my agent (ISO): the build's whole clock runs from here. */
  createdAt: string | null;
  /** When the agent goes if it stays quiet (ISO). */
  quietUntil: string | null;
  /** When its 3 hours end (ISO). */
  endsAt: string | null;
  /** Messages it can still take. */
  messagesLeft: number | null;
  /** While `resting` or `limited`: when to come back (ISO), if known. */
  until: string | null;
  /** While `removed`. */
  removedReason: GuestRemovedReason | null;
  /** The Turnstile site key for the widget on Make my agent; null when the check is off. */
  turnstileSiteKey: string | null;
  limits: { messageMaxChars: number; quietMinutes: number; lifetimeHours: number; messagesMax: number };
}

/** The Turnstile widget's action; a token made for another action is refused. */
export const GUEST_TURNSTILE_ACTION = 'make-guest-agent';

/** POST /workspace/api/public/guest — Make my agent. */
export interface GuestCreateRequest {
  /** The Turnstile token from the invisible widget (required while the check is on), rendered with action GUEST_TURNSTILE_ACTION. */
  turnstileToken?: string;
}

/**
 * POST /workspace/api/public/guest — the answer. 201 with a NEW key when an
 * agent is being built (`creating`, its first step running); 200 with the
 * status alone when the key already has one, or the
 * visitor is `resting`/`limited`; 400 `{state:'invalid', error:'challenge'}`
 * when the Turnstile check failed; 403 from another Origin.
 * Keep `key` and send it on every later call.
 */
export interface GuestCreateAnswer {
  key?: string;
  status: GuestStatus;
}

/** POST /workspace/api/public/guest/messages — the body. */
export interface GuestMessageRequest {
  text: string;
}

/**
 * POST /workspace/api/public/guest/messages — 202 `accepted` with the turn
 * to poll; 409 `busy` while a turn runs; 200 with `status` when the agent
 * cannot take it (`removed`, `resting`, `limited` = its 40 messages are
 * spent); 400 `invalid`; 401 `{state:'unknown'}` for a key the server does
 * not know.
 */
export type GuestMessageAnswer =
  | { state: 'accepted'; turnId: string; messageId: string }
  | { state: 'busy'; turnId: string }
  | { state: 'invalid'; error: string }
  | { state: 'unknown' }
  | { state: 'status'; status: GuestStatus };

/**
 * One turn's state. `waking` is the machine coming out of sleep (about ten
 * seconds); `working` is Claude Code running. The ends: `answered`,
 * `declined` (off topic, or the outgoing check held the answer), `failed`
 * (our side; it does not count against the visitor's 40), `stopped` (the
 * visitor pressed Stop), `resting` (the seat filled mid-turn).
 */
export type GuestTurnState = 'waking' | 'working' | 'answered' | 'declined' | 'failed' | 'stopped' | 'resting';

export const GUEST_TURN_FINAL_STATES: readonly GuestTurnState[] = ['answered', 'declined', 'failed', 'stopped', 'resting'];

/** GET /workspace/api/public/guest/turns/:turnId — poll every second while it runs. */
export interface GuestTurnStatus {
  turnId: string;
  state: GuestTurnState;
  /** The answer's text so far while `working` (Markdown, may end mid-sentence). */
  partial: string | null;
  /** The final answer (Markdown) once it ends; the declined sentence on `declined`. */
  answer: string | null;
  /** What it did so far, in order. */
  activity: GuestActivity[];
  /** Repository-relative files it read or changed, in order, without repeats. */
  files: string[];
  elapsedSeconds: number;
  /** On `resting`: when guests answer again (ISO), if known. */
  until?: string | null;
}

/** POST /workspace/api/public/guest/turns/:turnId/stop — 200 `{state:'stopped'}` (or the turn's final state if it already ended). */
export interface GuestStopAnswer {
  state: GuestTurnState;
}

/** DELETE /workspace/api/public/guest — the visitor's Delete. 200 with the `removed` status. */
export interface GuestDeleteAnswer {
  status: GuestStatus;
}

/** The marker the instructions put at the start of a declined answer. */
export const GUEST_DECLINED_MARKER = '[declined]';

/** The sentence a declined answer becomes. */
export const GUEST_DECLINED_TEXT = 'I only work on Agentic Cloud Computer and its open-source code. Ask me how it works, or what you would change in it.';

/** The fixed greeting (note #1038, decision 13): no turn is spent on hello. */
export function guestGreeting(name: string): string {
  return `Hi, I'm ${name}. I run on a computer of my own, with a copy of the Agentic Cloud's open-source code. Ask me how it works, or ask me to change something and I'll show you what I did.`;
}

/** The owner's transcript of one guest agent (the Guests screen). */
export interface GuestTranscriptRecord {
  agentId: string;
  name: string;
  avatarUrl: string | null;
  createdAt: string;
  removedAt: string | null;
  removedReason: GuestRemovedReason | null;
  messages: Array<GuestMessage & {
    seconds?: number;
    costUsd?: number;
    tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
    /** Set when the outgoing check held an answer back; the held answer stays here for the owner. */
    flag?: string;
  }>;
}

/** GET /workspace/api/guests — the owner's Guests screen: live first, then the last 90 days. */
export interface WorkspaceGuestsAnswer {
  live: Array<{ agentId: string; name: string; avatarUrl: string | null; createdAt: string; messages: number; state: GuestState; quietUntil: string | null }>;
  past: Array<{ agentId: string; name: string; avatarUrl: string | null; createdAt: string; removedAt: string | null; removedReason: GuestRemovedReason | null; messages: number; costUsd: number }>;
  limits: { globalPerDay: number; perAddressPerDay: number };
  madeToday: number;
}
