/**
 * The sealed public guide (note #1010): one visible Claude Code agent that
 * answers home-page visitors' questions about the product by reading the
 * PUBLIC code, and nothing else of the workplace.
 *
 * This file is the contract the home page section and the backend share:
 * the limits, the states a question can be in, and the two answers of the
 * public route. Everything here is safe to ship to a browser.
 *
 * Knowledge page: sealed-public-agent.
 */

/** The home page's guide. Stored on AgentRecord.sealed. */
export const PUBLIC_GUIDE_KIND = 'public-guide' as const;
/** The sealed kinds: the guide (#1010) and a visitor's own agent (#1038, shared/guest-agent.ts). */
export type SealedAgentKind = typeof PUBLIC_GUIDE_KIND | 'guest';

/**
 * The repository a guide reads: this name, in the guide's own workplace, and
 * only while it is PUBLIC. Its docs are inside it (src/docs).
 */
export const PUBLIC_GUIDE_REPO_NAME = 'agentic-cloud';

/** What a sealed guide thinks with (Adam, 5 Nov 2026): sonnet, at the lowest effort the catalog offers. */
export const PUBLIC_GUIDE_MODEL = 'sonnet';
export const PUBLIC_GUIDE_EFFORT = 'medium';

/** The numbers the design set (note #1010, section 5), in one place. */
export const PUBLIC_GUIDE_LIMITS = {
  /** Characters in one question. */
  questionMaxChars: 500,
  /** Questions one visitor may ask in an hour (keyed by address AND by visit). */
  perVisitorPerHour: 10,
  /** Questions everyone together may ask in an hour. */
  globalPerHour: 30,
  /** Questions everyone together may ask in a UTC day. */
  globalPerDay: 200,
  /** Questions waiting behind the one being answered; one more is "busy". */
  queueMax: 5,
  /** The 5-hour window's used share at which the guide rests. */
  restFiveHourPercent: 80,
  /** The week's used share at which the guide rests. */
  restWeekPercent: 90,
  /** One answer's hard wall, end to end on the machine. */
  turnTimeoutMs: 120_000,
  /** Tool rounds in one answer. */
  maxTurns: 15,
  /** Transcripts are kept this long, then deleted. */
  transcriptDays: 90,
  /** The public copy is refreshed from main when older than this. */
  refreshAfterMs: 15 * 60_000,
} as const;

/**
 * Where one question stands. `queued` waits behind others; `waking` is the
 * machine coming out of sleep; `reading` is the turn running. The three
 * ends: `answered`, `declined` (off topic, or the outgoing scan caught
 * something), `failed` (our side; not counted against the visitor). A
 * question can also end `resting` when the seat filled while it waited.
 */
export type PublicAskState = 'queued' | 'waking' | 'reading' | 'answered' | 'declined' | 'failed' | 'resting';

export const PUBLIC_ASK_FINAL_STATES: readonly PublicAskState[] = ['answered', 'declined', 'failed', 'resting'];

/** The marker the guide's instructions put at the start of a declined answer. */
export const PUBLIC_GUIDE_DECLINED_MARKER = '[declined]';

/** The sentence a declined answer becomes (the design's words). */
export const PUBLIC_GUIDE_DECLINED_TEXT = 'I only answer questions about Agentic Cloud Computer: how it works, what it needs from you, and how to run it. These are good places to start.';

/** POST /api/public/ask — the body. */
export interface PublicAskRequest {
  /** Random, made by the page per visit and kept in sessionStorage. 8–64 of [A-Za-z0-9_-]. */
  visitId: string;
  question: string;
}

/**
 * POST /api/public/ask — the answer. 202 `accepted`, otherwise 200 with the
 * state the page draws (`limited`, `resting`, `busy`), or 400 `invalid`.
 * Times are ISO; the page shows them in the visitor's own time.
 */
export type PublicAskAnswer =
  | { state: 'accepted'; questionId: string; position: number }
  | { state: 'limited'; until: string }
  | { state: 'resting'; until: string | null }
  | { state: 'busy' }
  | { state: 'invalid'; error: string };

/** GET /api/public/ask/:questionId — what the page polls every 1.5 s. */
export interface PublicAskStatus {
  questionId: string;
  state: PublicAskState;
  /** Questions ahead of this one while `queued`; 0 otherwise. */
  position: number;
  /** Repository-relative paths the turn opened, in order, without repeats. */
  files: string[];
  /** Markdown, only on `answered` (and the declined sentence on `declined`). */
  answer: string | null;
  /** On `resting`: when it answers again, if known. */
  until?: string | null;
  /** Seconds since the question was taken. */
  elapsedSeconds: number;
}

/**
 * GET /api/public/ask/status — read by the page once on load (note #1010,
 * section 10): the guide's face and name, and whether it rests. `agent` is
 * null while no guide exists, and the page then draws the resting box.
 */
export interface PublicGuideOverview {
  state: 'open' | 'resting';
  until: string | null;
  agent: { name: string; avatarUrl: string | null } | null;
}

/** One question in a stored visit (the Visits list on the guide's screen). */
export interface PublicGuideQuestionRecord {
  questionId: string;
  question: string;
  askedAt: string;
  state: PublicAskState;
  answer?: string;
  files?: string[];
  /** Seconds from taken to finished. */
  seconds?: number;
  /** The turn's own cost line, as Claude reported it (on a plan it is what the API would have charged). */
  costUsd?: number;
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Why it was flagged for the founder: the outgoing scan replaced the answer. */
  flag?: string;
}

/** One visit: what the founder reads. No address, no user agent, no cookie. */
export interface PublicGuideVisitRecord {
  visitId: string;
  agentId: string;
  startedAt: string;
  questions: PublicGuideQuestionRecord[];
  /** The visit's own Claude conversation on the guide's machine. Stored, never sent to a screen. */
  claudeSessionId?: string;
}

/** GET api/agents/:id/visits — the list. */
export interface WorkspacePublicGuideVisitsAnswer {
  visits: Array<{
    visitId: string;
    startedAt: string;
    firstQuestion: string;
    questions: number;
    flagged: boolean;
  }>;
  /** How long a visit is kept, so the screen can say so. */
  keptDays: number;
}

/** GET api/agents/:id/visits/:visitId — one visit, read-only. */
export interface WorkspacePublicGuideVisitAnswer {
  visit: PublicGuideVisitRecord;
}

const VISIT_ID = /^[A-Za-z0-9_-]{8,64}$/;
export function isValidVisitId(value: unknown): value is string {
  return typeof value === 'string' && VISIT_ID.test(value);
}
