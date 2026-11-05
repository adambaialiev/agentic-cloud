/**
 * The home page's side of the public guide's routes (note #1010). The
 * contract is on note #1010, section 10, agreed between the page and the
 * backend; change it there first.
 *
 *   GET  /api/public/ask/status        → AskStatus
 *   POST /api/public/ask {visitId, question} → AskAccepted | AskRefused
 *   GET  /api/public/ask/:questionId   → AskQuestion
 *
 * Same origin: the site's Cloudflare function proxies /api to the backend.
 */

export const ASK_STATUS_PATH = '/api/public/ask/status';
export const ASK_PATH = '/api/public/ask';

/** One question is at most this long, after trim (the route refuses more). */
export const ASK_MAX_CHARS = 500;
/** The page polls a pending question this often… */
export const ASK_POLL_MS = 1500;
/** …and gives up, drawing "failed", after this long. */
export const ASK_GIVE_UP_MS = 180_000;

export type AskAgent = { name: string; avatarUrl: string };

export type AskStatus = {
  state: 'open' | 'resting';
  until?: string;
  agent: AskAgent | null;
};

export type AskPendingState = 'queued' | 'waking' | 'reading';
export type AskQuestionState = AskPendingState | 'answered' | 'declined' | 'failed' | 'resting';

export type AskAccepted = { state: AskPendingState; questionId: string; position: number };
export type AskRefused =
  | { state: 'limited'; until: string }
  | { state: 'resting'; until?: string }
  | { state: 'busy' };

export type AskQuestion = {
  questionId: string;
  state: AskQuestionState;
  position?: number;
  files: string[];
  answer?: string;
  until?: string;
  seconds?: number;
};

export function isPending(state: string): state is AskPendingState {
  return state === 'queued' || state === 'waking' || state === 'reading';
}

/* A visit is one tab: sessionStorage, so a reload or a new tab is a fresh
   conversation (Adam's decision 6), and nothing outlives the tab. */
const VISIT_KEY = 'acc-ask-visit';
const VISIT_ID = /^[A-Za-z0-9_-]{16,64}$/;

export function newVisitId(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function visitId(): string {
  try {
    const kept = window.sessionStorage.getItem(VISIT_KEY);
    if (kept && VISIT_ID.test(kept)) return kept;
    const made = newVisitId();
    window.sessionStorage.setItem(VISIT_KEY, made);
    return made;
  } catch {
    /* Storage refused (a private window on some browsers): one id for the page's life. */
    const w = window as unknown as { __accAskVisit?: string };
    w.__accAskVisit ??= newVisitId();
    return w.__accAskVisit;
  }
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`ask: ${response.status}`);
  return (await response.json()) as T;
}

export async function readStatus(signal?: AbortSignal): Promise<AskStatus> {
  return json<AskStatus>(await fetch(ASK_STATUS_PATH, { headers: { accept: 'application/json' }, signal }));
}

export async function askQuestion(visit: string, question: string): Promise<AskAccepted | AskRefused> {
  return json<AskAccepted | AskRefused>(await fetch(ASK_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ visitId: visit, question }),
  }));
}

export async function readQuestion(questionId: string, signal?: AbortSignal): Promise<AskQuestion> {
  return json<AskQuestion>(await fetch(`${ASK_PATH}/${encodeURIComponent(questionId)}`, { headers: { accept: 'application/json' }, signal }));
}
