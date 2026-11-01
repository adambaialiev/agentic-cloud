/**
 * Serving the React Workspace shell.
 *
 * The shell is a Vite build under dist/workspace-ui: an index.html that
 * holds no data and no inline script, plus hashed assets. That is what lets
 * its Content-Security-Policy say `script-src 'self'` and nothing else — the
 * loader refuses a build that grew an inline script rather than ship one the
 * browser would block.
 *
 * Until slice 9 of docs/workspace-react-migration.md the shell answered
 * beside a single-file page on the same addresses, chosen per browser by a
 * cookie that `?ui=react|legacy` set. The page is gone; the parameter is
 * still recognised only to clean it (and its cookie) out of an old link.
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { Router, type Request, type Response } from 'express';
import { DEFAULT_MAIL_DOMAIN, MAIL_DOMAIN } from '../shared/workspace-mail.js';
import { DEFAULT_PUBLIC_HOST, PUBLIC_HOST } from '../shared/public-host.js';
import { PRIVATE_COPY, SIGNUP_CLOSED } from '../shared/private-copy.js';

/** The retired per-browser shell choice. Cleared when seen; never set. */
export const WORKSPACE_UI_COOKIE = 'acc_workspace_ui';

/** Where `vite build` leaves the shell: backend/dist/workspace-ui, from both
 *  the src/ and the dist/ layout of this module. */
export const DEFAULT_WORKSPACE_UI_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'workspace-ui',
);

/** The public path the shell's assets are served under; Vite's `base`. */
export const WORKSPACE_UI_ASSET_BASE = '/app/assets';

/**
 * `?ui=<anything>` once chose a shell. Now it only marks an old link: the
 * choice cookie is expired and the browser is redirected to the same address
 * without the parameter, so it never sticks in a copied URL. Returns true
 * when the response has been sent.
 */
export function handleRetiredWorkspaceUiSwitch(req: Request, res: Response): boolean {
  if (req.query.ui === undefined) return false;
  res.clearCookie(WORKSPACE_UI_COOKIE, { path: '/' });
  const url = new URL(req.originalUrl, 'http://placeholder.invalid');
  url.searchParams.delete('ui');
  res.setHeader('Cache-Control', 'no-store');
  res.redirect(302, url.pathname + url.search);
  return true;
}

export interface WorkspaceUiShell {
  html: Buffer;
  etag: string;
}

let cachedShell: { dir: string; key: string; shell: WorkspaceUiShell } | null = null;

/**
 * The built index.html, read once per build (mtime+size keyed) so a fresh
 * deploy is picked up without a restart. Rejects when there is no build —
 * the caller falls back to the legacy page rather than serving a hole.
 */
/**
 * A private copy's own names (notes #804, #807) — its mail domain and the
 * host its public addresses are on — and that it IS a copy (note #808, for
 * the invite-only sign-up door), handed to the browser as data: meta tags,
 * not a script, so the policy below still holds. Unchanged when all are ours.
 */
function withCopyNames(html: Buffer): Buffer {
  const metas = [
    ...(MAIL_DOMAIN !== DEFAULT_MAIL_DOMAIN ? [`<meta name="acc-mail-domain" content="${MAIL_DOMAIN}">`] : []),
    ...(PUBLIC_HOST !== DEFAULT_PUBLIC_HOST ? [`<meta name="acc-public-host" content="${PUBLIC_HOST}">`] : []),
    ...(PRIVATE_COPY ? ['<meta name="acc-private-copy" content="1">'] : []),
    // Our own platform with sign-up closed (note #823): the door says so.
    ...(SIGNUP_CLOSED ? ['<meta name="acc-signup-closed" content="1">'] : []),
  ];
  if (metas.length === 0) return html;
  const text = html.toString('utf8');
  return Buffer.from(text.replace(/<head>/i, (head) => `${head}\n${metas.join('\n')}`), 'utf8');
}

export async function loadWorkspaceUiShell(dir: string = DEFAULT_WORKSPACE_UI_DIR): Promise<WorkspaceUiShell> {
  const file = path.join(dir, 'index.html');
  const info = await stat(file);
  const key = `${info.mtimeMs}:${info.size}`;
  if (cachedShell?.dir === dir && cachedShell.key === key) return cachedShell.shell;
  const html = withCopyNames(await readFile(file));
  if (/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html.toString('utf8'))) {
    // The policy below promises the browser there is no inline script. A build
    // that grew one must fail here, loudly, not ship a shell the browser blocks.
    throw new Error('workspace-ui index.html carries an inline script; the CSP forbids it');
  }
  const shell = { html, etag: `"${createHash('sha256').update(html).digest('base64url').slice(0, 27)}"` };
  cachedShell = { dir, key, shell };
  return shell;
}

/** The React shell's policy: same-origin everything, no inline script. */
export const WORKSPACE_UI_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "frame-src 'self' blob: https:",
  // Vite's emitted stylesheet is a file, but the screens still set inline
  // styles on elements (widths, tints, transforms).
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

export function sendWorkspaceUiShell(res: Response, shell: WorkspaceUiShell): void {
  // Always revalidate: a tab reopened after a deploy must not stay pinned to
  // an old shell, and a 304 costs nothing.
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('ETag', shell.etag);
  res.setHeader('Content-Security-Policy', WORKSPACE_UI_CONTENT_SECURITY_POLICY);
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Dictation still needs the user's browser permission. Denying the feature
  // here prevents even that prompt and makes getUserMedia reject immediately.
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  res.type('html').send(shell.html);
}

/**
 * The shell's hashed assets, cacheable forever: a changed file is a changed
 * name. Mounted by the Workspace router under its own prefix; a request for
 * a missing asset is a 404 here, never a fall-through to the shell.
 */
export function workspaceUiAssetRoutes(dir: string = DEFAULT_WORKSPACE_UI_DIR): Router {
  const router = Router();
  router.use(WORKSPACE_UI_ASSET_BASE, express.static(path.join(dir, 'assets'), {
    immutable: true,
    maxAge: '1y',
    index: false,
    fallthrough: false,
    setHeaders(res) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  }));
  return router;
}
