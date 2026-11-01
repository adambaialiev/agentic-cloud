import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { IssuedWorkspaceSession } from './workspace-web-auth.js';

export const WORKSPACE_SESSION_COOKIE = '__Host-acc_session';
export const WORKSPACE_CSRF_COOKIE = '__Host-acc_csrf';
// Plain-HTTP localhost cannot accept __Host-/Secure cookies. This fallback is
// intentionally selected only for an explicitly configured http: origin.
const DEV_SESSION_COOKIE = 'acc_session';
const DEV_CSRF_COOKIE = 'acc_csrf';

export interface WorkspaceCookieNames {
  session: string;
  csrf: string;
  secure: boolean;
}

export function workspaceCookieNames(workspaceOrigin: string): WorkspaceCookieNames {
  const secure = new URL(workspaceOrigin).protocol === 'https:';
  return secure
    ? { session: WORKSPACE_SESSION_COOKIE, csrf: WORKSPACE_CSRF_COOKIE, secure }
    : { session: DEV_SESSION_COOKIE, csrf: DEV_CSRF_COOKIE, secure };
}

export function parseCookieHeader(raw: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const pair of raw?.split(';') ?? []) {
    const index = pair.indexOf('=');
    if (index < 1) continue;
    const name = pair.slice(0, index).trim();
    const encoded = pair.slice(index + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(encoded);
    } catch {
      // A malformed cookie is absent, not a reason to reject every other one.
    }
  }
  return cookies;
}

export function workspaceSessionToken(req: Request, workspaceOrigin: string): string {
  const names = workspaceCookieNames(workspaceOrigin);
  return parseCookieHeader(req.get('cookie'))[names.session] ?? '';
}

/**
 * The CSRF cookie's raw value, for the one caller that cares whether the
 * browser is CARRYING it rather than whether it matches: the public front page
 * reads this cookie as "there is a session here" (index.html, note #526), so a
 * browser holding it with no session behind it has something to be taken back.
 */
export function workspaceCsrfCookie(req: Request, workspaceOrigin: string): string {
  const names = workspaceCookieNames(workspaceOrigin);
  return parseCookieHeader(req.get('cookie'))[names.csrf] ?? '';
}

export function setWorkspaceSessionCookies(
  res: Response,
  issued: IssuedWorkspaceSession,
  workspaceOrigin: string,
): void {
  const names = workspaceCookieNames(workspaceOrigin);
  const absoluteMs = Math.max(0, Date.parse(issued.session.absoluteExpiresAt) - Date.now());
  res.cookie(names.session, issued.token, {
    httpOnly: true,
    secure: names.secure,
    sameSite: 'lax',
    path: '/',
    maxAge: absoluteMs,
  });
  // Double-submit token: JavaScript must read it to set X-CSRF-Token, so this
  // cookie is deliberately not HttpOnly. __Host + SameSite + Origin checking
  // keep another site from choosing or learning it.
  res.cookie(names.csrf, issued.csrfToken, {
    httpOnly: false,
    secure: names.secure,
    sameSite: 'strict',
    path: '/',
    maxAge: absoluteMs,
  });
}

export function clearWorkspaceSessionCookies(res: Response, workspaceOrigin: string): void {
  const names = workspaceCookieNames(workspaceOrigin);
  const options = { secure: names.secure, path: '/' } as const;
  res.clearCookie(names.session, { ...options, httpOnly: true, sameSite: 'lax' });
  res.clearCookie(names.csrf, { ...options, httpOnly: false, sameSite: 'strict' });
}

function safeStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requestHasValidCsrf(req: Request, workspaceOrigin: string): boolean {
  const names = workspaceCookieNames(workspaceOrigin);
  const cookie = parseCookieHeader(req.get('cookie'))[names.csrf] ?? '';
  const header = req.get('x-csrf-token') ?? '';
  return Boolean(cookie && header && safeStringEqual(cookie, header));
}

/**
 * Strict origin test for login CSRF and cookie-authenticated writes.
 *
 * The canonical origin is the address new links use. A bounded list of old
 * or proxy-fronting origins may remain valid during a host migration so the
 * migration itself does not turn every already-open session into a broken
 * form. Callers still name every accepted origin from configuration; request
 * Host headers and reflected request values never enter this trust decision.
 */
export function requestHasWorkspaceOrigin(
  req: Request,
  workspaceOrigin: string,
  compatibleOrigins: readonly string[] = [],
): boolean {
  const raw = req.get('origin');
  if (!raw) return false;
  try {
    const requestOrigin = new URL(raw).origin;
    return [workspaceOrigin, ...compatibleOrigins]
      .some((candidate) => {
        try { return new URL(candidate).origin === requestOrigin; } catch { return false; }
      });
  } catch {
    return false;
  }
}

export function isSafeHttpMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}
