/**
 * The Workspace API client — the importable replacement for the legacy page's
 * `api()` and `authApi()` wrappers.
 *
 * Same wire contract, deliberately: relative paths under /workspace, cookie
 * credentials, the double-submit CSRF header read from the readable cookie on
 * EVERY call (the server rotates it on sign-in, so a cached header is a stale
 * one), and `?org=` appended to ordinary calls from the scope the CALLER
 * names, else the workplace this tab stands in. Auth calls (`authApi`) carry
 * no workplace: sign-in happens before there is one.
 *
 * Ordinary calls carried `?room=` as well — the viewed room, named by the
 * caller — until rooms left the product (note #843). No call names one now.
 *
 * Errors are `WorkspaceApiError`: the server's sentence as `message`, plus the
 * HTTP status, the error `code` when the flow needs to branch on it, and the
 * whole body, which a caller is allowed to read.
 */

import type { WorkspaceApiErrorBody } from '../../../src/shared/workspace-api.js';
import { WORKSPACE_API_BASE } from '../../../src/shared/workspace-routes.js';

/** The production cookie and the plain-http development fallback the server
 *  sets instead (services/workspace-web-session.ts). Read in this order. */
export const WORKSPACE_CSRF_COOKIES: readonly string[] = ['__Host-acc_csrf', 'acc_csrf'];

export class WorkspaceApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'WorkspaceApiError';
    this.status = status;
    this.body = body;
    const code = (body as Partial<WorkspaceApiErrorBody> | null)?.code;
    this.code = typeof code === 'string' ? code : undefined;
  }
}

/** Where an ordinary call stands: the workplace it rides as `?org=`. */
export interface WorkspaceApiScope {
  org?: string | null;
}

export interface WorkspaceApiOptions {
  /** Mount of the Workspace router; `/workspace` in production. */
  base?: string;
  /** Read at call time so a test may install one after construction. */
  fetch?: typeof fetch;
  /** The cookie jar, as `document.cookie` text. */
  cookies?: () => string;
  /** The workplace this tab stands in, read at call time; rides every
   *  ordinary call whose caller names none. */
  standingOrg?: () => string | null;
}

export interface WorkspaceApi {
  /** An ordinary Workspace call, in the workplace the caller names. */
  api<T = unknown>(path: string, init?: RequestInit, scope?: WorkspaceApiScope): Promise<T>;
  /** A sign-in door: same cookies and CSRF header. Names a
   *  workplace only when the caller asks it to. */
  authApi<T = unknown>(path: string, init?: RequestInit, scope?: Pick<WorkspaceApiScope, 'org'>): Promise<T>;
  /** The current double-submit token, or '' when signed out. */
  csrfToken(): string;
}

export function cookieValue(jar: string, name: string): string {
  const prefix = `${name}=`;
  const pair = jar.split(';').map((value) => value.trim()).find((value) => value.startsWith(prefix));
  if (!pair) return '';
  try { return decodeURIComponent(pair.slice(prefix.length)); } catch { return ''; }
}

/** A JSON POST body with its header, the shape every sign-in form sends. */
export function jsonBody(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/** Where early-read.ts leaves the reads it started as the page opened. The
 *  name is repeated here rather than imported, so the shell does not pull
 *  that file in as a chunk of its own; early-read.test.ts pins the two. */
export const EARLY_READS_KEY = '__accEarlyReads';
/** How long a read started at page open may wait to be claimed. */
export const EARLY_READ_TTL_MS = 60_000;

/**
 * The read early-read.ts started for exactly this URL as the page opened, if
 * one is still waiting — taken, so it serves one request and no other.
 * Follow-up to note #825: a deep link's screen no longer waits for the shell
 * to boot before its own read leaves.
 */
export function takeEarlyRead(url: string, now = Date.now()): Promise<Response> | null {
  if (typeof window === 'undefined') return null;
  const held = (window as unknown as Record<string, Array<{ url: string; at: number; response: Promise<Response> }> | undefined>)[EARLY_READS_KEY];
  if (!held?.length) return null;
  // Matched as written: neither side names a room since note #843, so the
  // read the page started is the one the screen asks for, letter for letter.
  const at = held.findIndex((read) => read.url === url);
  if (at < 0) return null;
  const [read] = held.splice(at, 1);
  return read && now - read.at <= EARLY_READ_TTL_MS ? read.response : null;
}

export function createWorkspaceApi(options: WorkspaceApiOptions = {}): WorkspaceApi {
  const base = options.base ?? WORKSPACE_API_BASE;
  const cookies = options.cookies ?? (() => (typeof document === 'undefined' ? '' : document.cookie));
  const doFetch: typeof fetch = (input, init) => (options.fetch ?? globalThis.fetch)(input, init);

  const csrfToken = (): string => {
    const jar = cookies();
    for (const name of WORKSPACE_CSRF_COOKIES) {
      const value = cookieValue(jar, name);
      if (value) return value;
    }
    return '';
  };

  const request = async <T,>(path: string, init: RequestInit | undefined, scope: WorkspaceApiScope | undefined): Promise<T> => {
    // A path that already names its workplace in its own query (Drive
    // writes `?org=` itself) keeps that one: a second copy would reach the
    // server as an array and be refused as no workplace at all.
    const named = new URLSearchParams(path.includes('?') ? path.slice(path.indexOf('?') + 1) : '');
    const extra: string[] = [];
    if (scope?.org && !named.has('org')) extra.push(`org=${encodeURIComponent(scope.org)}`);
    // Absolute on purpose: named Workspace routes may be several segments deep,
    // and a relative path would resolve against whichever one is open.
    const url = `${base}/${path}${extra.length ? (path.includes('?') ? '&' : '?') + extra.join('&') : ''}`;
    const token = csrfToken();
    const headers = new Headers(init?.headers);
    if (token && !headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', token);
    // A plain read the page already started as it opened (early-read.ts):
    // take its answer when it succeeded, and otherwise ask as always — a
    // failure there may be one this request, made now, would not have.
    const reading = (init?.method ?? 'GET').toUpperCase() === 'GET' && init?.body == null;
    const early = reading ? await takeEarlyRead(url)?.catch(() => null) : null;
    const response = early?.ok ? early : await doFetch(url, { credentials: 'same-origin', ...init, headers });
    let body: unknown = null;
    try { body = await response.json(); } catch { /* non-JSON error page, or no body */ }
    if (!response.ok) {
      const sentence = (body as Partial<WorkspaceApiErrorBody> | null)?.error;
      throw new WorkspaceApiError(
        typeof sentence === 'string' && sentence ? sentence : `Request failed (${response.status})`,
        response.status,
        body,
      );
    }
    return body as T;
  };

  return {
    api: (path, init, scope) => request(path, init, { ...scope, org: scope?.org || options.standingOrg?.() || null }),
    authApi: (path, init, scope) => request(path, init, scope),
    csrfToken,
  };
}
