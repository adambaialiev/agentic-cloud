/**
 * The home page's side of the guest agent's routes (notes #1036 design,
 * #1038 build, #1039 this section). The contract is Rosa's,
 * backend/src/shared/guest-agent.ts (fixed 6 Nov 2026, live with PR #83).
 * Change it there first, then here: this file is the only place the page
 * touches the routes.
 *
 *   GET    /workspace/api/public/guest                       → GuestStatus
 *   POST   /workspace/api/public/guest {turnstileToken?, arrival?} → {key?, status} | {state:'invalid'}
 *   POST   /workspace/api/public/guest/messages {text}       → GuestMessageAnswer
 *   GET    /workspace/api/public/guest/turns/:turnId         → GuestTurnStatus
 *   POST   /workspace/api/public/guest/turns/:turnId/stop    → {state}
 *   DELETE /workspace/api/public/guest                       → {status}
 *
 * The types and limits are imported from the contract itself, so the page
 * and the backend cannot drift apart.
 *
 * The visitor is known by a key the server makes and returns once; the page
 * keeps it in this browser's localStorage and sends it as X-Guest-Key (no
 * cookie, no address; one browser only, decision 9).
 */

import {
  GUEST_AGENT_LIMITS,
  GUEST_KEY_HEADER,
  GUEST_KEY_STORAGE,
  GUEST_TURNSTILE_ACTION,
  type GuestActivity,
  type GuestCreateAnswer as GuestCreated,
  type GuestCreateStep,
  type GuestMessage,
  type GuestMessageAnswer,
  type GuestRemovedReason,
  type GuestState,
  type GuestStatus,
  type GuestTurnState,
  type GuestTurnStatus,
} from '../../backend/src/shared/guest-agent';
import { readArrival } from './guest-arrival';

export { GUEST_KEY_HEADER, GUEST_KEY_STORAGE };
export type { GuestActivity, GuestCreateStep, GuestMessage, GuestMessageAnswer, GuestRemovedReason, GuestState, GuestStatus, GuestTurnState, GuestTurnStatus };

export const GUEST_PATH = '/workspace/api/public/guest';

/** A message is at most this long. */
export const GUEST_MAX_CHARS = GUEST_AGENT_LIMITS.messageMaxChars;
/** A running turn is read every second… */
export const GUEST_TURN_POLL_MS = 1000;
/** …the agent being made every 1.5 s… */
export const GUEST_CREATING_POLL_MS = 1500;
/** …and, while nothing happens, every 20 s, for the chip, the minutes left and removal. */
export const GUEST_IDLE_POLL_MS = 20_000;
/** …but every 5 s while a background job runs, so its answer arrives by itself (note #1064). */
export const GUEST_JOB_POLL_MS = 5000;
/** A turn the page has not been able to read for this long is drawn as failed. Every read that answers resets it: a turn has no time limit (note #1054). */
export const GUEST_TURN_GIVE_UP_MS = 240_000;

export type GuestAgent = NonNullable<GuestStatus['agent']>;

/**
 * A background job the guest's agent runs (note #1063, Rosa's side; the
 * shape agreed in a comment there): a redacted display label, never the
 * command line, its cwd or its output. The status lists the running ones,
 * at most 4, oldest first. Read through `jobsOf`, which answers [] while the
 * route does not carry `jobs` yet, and drops anything not in this shape.
 */
export interface GuestJob { id: string; label: string; startedAt: string }
export const GUEST_JOBS_MAX = 4;
export function jobsOf(status: GuestStatus | null | undefined): GuestJob[] {
  const jobs = (status as { jobs?: unknown } | null | undefined)?.jobs;
  if (!Array.isArray(jobs)) return [];
  return jobs.filter((job): job is GuestJob => Boolean(job) && typeof job.id === 'string' && typeof job.label === 'string'
    && typeof job.startedAt === 'string' && !Number.isNaN(Date.parse(job.startedAt))).slice(0, GUEST_JOBS_MAX);
}
/** POST's answer as the page reads it: the contract's, or the 400 refusal. */
export type GuestCreateAnswer = GuestCreated | { state: 'invalid'; error: string };

export function isRunning(state: GuestTurnState): boolean {
  return state === 'waking' || state === 'working';
}

/** The repository files a finished message's activity touched, in order, without repeats. */
export function filesOf(activity: GuestActivity[] | undefined): string[] {
  const out: string[] = [];
  for (const step of activity ?? []) {
    if ((step.kind === 'read' || step.kind === 'edit') && !out.includes(step.label)) out.push(step.label);
  }
  return out;
}

/* ── The key, in this browser only ───────────────────────────────────── */

const KEY_SHAPE = /^[A-Za-z0-9_.~+/=-]{16,256}$/;

export function guestKey(): string | null {
  try {
    const kept = window.localStorage.getItem(GUEST_KEY_STORAGE);
    return kept && KEY_SHAPE.test(kept) ? kept : null;
  } catch {
    return (window as unknown as { __accGuestKey?: string | null }).__accGuestKey ?? null;
  }
}

export function keepGuestKey(key: string | null): void {
  try {
    if (key) window.localStorage.setItem(GUEST_KEY_STORAGE, key);
    else window.localStorage.removeItem(GUEST_KEY_STORAGE);
  } catch {
    /* Storage refused (some private windows): the key lives as long as the page. */
    (window as unknown as { __accGuestKey?: string | null }).__accGuestKey = key;
  }
}

/* ── The calls ───────────────────────────────────────────────────────── */

function headers(json = false): Record<string, string> {
  const out: Record<string, string> = { accept: 'application/json' };
  if (json) out['content-type'] = 'application/json';
  const key = guestKey();
  if (key) out[GUEST_KEY_HEADER] = key;
  return out;
}

/* The routes answer their refusals (400 invalid, 401 unknown, 409 busy) with
   a body the page reads; anything else at 400 or above is our side failing. */
async function read<T>(response: Response): Promise<T> {
  if (!response.ok && ![400, 401, 409].includes(response.status)) {
    /* Read the body anyway: left unread, the browser keeps the request open. */
    await response.text().catch(() => '');
    throw new Error(`guest: ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function readGuest(signal?: AbortSignal): Promise<GuestStatus> {
  return read<GuestStatus>(await fetch(GUEST_PATH, { headers: headers(), signal }));
}

export async function makeGuest(turnstileToken: string | null): Promise<GuestCreateAnswer> {
  // How this tab arrived (note #1139): data for the owner's Guests group, never shown to the agent.
  const arrival = typeof window === 'undefined' ? undefined : readArrival(window);
  return read<GuestCreateAnswer>(await fetch(GUEST_PATH, {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify({ ...(turnstileToken ? { turnstileToken } : {}), ...(arrival ? { arrival } : {}) }),
  }));
}

export async function sendMessage(text: string): Promise<GuestMessageAnswer> {
  return read<GuestMessageAnswer>(await fetch(`${GUEST_PATH}/messages`, {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify({ text }),
  }));
}

export async function readTurn(turnId: string, signal?: AbortSignal): Promise<GuestTurnStatus> {
  return read<GuestTurnStatus>(await fetch(`${GUEST_PATH}/turns/${encodeURIComponent(turnId)}`, { headers: headers(), signal }));
}

export async function stopTurn(turnId: string): Promise<void> {
  const response = await fetch(`${GUEST_PATH}/turns/${encodeURIComponent(turnId)}/stop`, { method: 'POST', headers: headers() });
  await response.text().catch(() => '');
}

export async function deleteGuest(): Promise<GuestStatus | null> {
  const response = await fetch(GUEST_PATH, { method: 'DELETE', headers: headers() });
  if (!response.ok && response.status !== 401 && response.status !== 404) {
    await response.text().catch(() => '');
    throw new Error(`guest: ${response.status}`);
  }
  try {
    return ((await response.json()) as { status?: GuestStatus }).status ?? null;
  } catch {
    return null;
  }
}

/* ── The invisible Cloudflare Turnstile check on Start guest agent (decision 12) ──
   The site key comes with the status (turnstileSiteKey); null means the
   check is off and the page sends no token. The backend holds the secret. */

const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

type Turnstile = {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  remove: (widgetId: string) => void;
};

let loading: Promise<Turnstile> | null = null;

function loadTurnstile(): Promise<Turnstile> {
  const w = window as unknown as { turnstile?: Turnstile };
  if (w.turnstile) return Promise.resolve(w.turnstile);
  loading ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.onload = () => (w.turnstile ? resolve(w.turnstile) : reject(new Error('turnstile')));
    script.onerror = () => { loading = null; reject(new Error('turnstile')); };
    document.head.appendChild(script);
  });
  return loading;
}

/** Runs the check in `host` and resolves with a one-time token. Invisible
    unless Cloudflare wants the visitor to tick a box, which then shows in host. */
export async function passTurnstile(siteKey: string, host: HTMLElement, timeoutMs = 30_000): Promise<string> {
  const turnstile = await loadTurnstile();
  return new Promise<string>((resolve, reject) => {
    let id = '';
    const done = (fn: () => void) => { window.clearTimeout(timer); fn(); try { turnstile.remove(id); } catch { /* gone */ } };
    const timer = window.setTimeout(() => done(() => reject(new Error('turnstile timeout'))), timeoutMs);
    id = turnstile.render(host, {
      sitekey: siteKey,
      action: GUEST_TURNSTILE_ACTION,
      appearance: 'interaction-only',
      callback: (token: string) => done(() => resolve(token)),
      'error-callback': () => done(() => reject(new Error('turnstile'))),
      'expired-callback': () => done(() => reject(new Error('turnstile expired'))),
    });
  });
}
