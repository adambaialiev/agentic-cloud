import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { DEFAULT_WORKSPACE_UI_DIR, handleRetiredWorkspaceUiSwitch, loadWorkspaceUiShell, sendWorkspaceUiShell } from './workspace-ui.js';
import { isReservedHandle } from '../shared/handles.js';
import { WORKSPACE_BASE, parseWorkspaceRoute, workspacePublicPathPatterns, workspaceShellPathPatterns } from '../shared/workspace-routes.js';

/**
 * Whether this address is a PUBLIC one — `/adam` — rather than a word the
 * backend answers on outside the registry (its API, the ops pages, a
 * reserved word). The registry parses it as a public route AND the word is
 * not reserved (shared/handles.ts, which the parser cannot read); anything
 * else falls through to whatever is mounted after the shell, usually a 404.
 */
const PUBLIC_KINDS = new Set<string>(['person', 'workplaceRepo', 'workplaceRepoCommits', 'workplaceRepoCommit', 'workplaceRepoProposals', 'workplaceRepoProposal', 'workplaceRepoContributors']);
export function publicAddress(pathname: string): boolean {
  const route = parseWorkspaceRoute(pathname);
  return PUBLIC_KINDS.has(route?.kind ?? '') && !isReservedHandle(route?.handle ?? '');
}

/**
 * What a browser asks the root of the domain for by itself: the font the
 * shell's stylesheet names, the tab icon and the home-screen icon. On our
 * platform the public site answers these (public/_routes.json) and the
 * backend never sees them. A private copy has no such site, so it answered
 * them with the shell's HTML: the fallback font and no icon (note #815).
 */
export const BRAND_FILES = ['fonts/inter-latin-var.woff2', 'favicon.ico', 'apple-touch-icon.png'] as const;

/** The repository's public/ folder, from both the src/ and the dist/ layout;
 *  the backend image puts the files above beside its code at the same place. */
export const DEFAULT_BRAND_FILES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'public',
);

/**
 * The Workspace at the ROOT of the domain (knowledge page "public-addresses",
 * 2026-09-26): the shell is served at every registered address and entry
 * door, and nothing else — the API, the auth doors and the built assets stay
 * mounted under /workspace (WORKSPACE_API_BASE), and a shell address that
 * still carries that prefix is a permanent redirect here (routes/workspace.ts).
 *
 * The shell's HTML is static and unauthenticated; every fact it displays
 * comes from an authenticated API call. A URL names a destination; it never
 * grants access to one.
 */
export function workspaceRootRoutes(options: {
  workspaceUiDir?: string;
  /**
   * Where the link-only door `/public/repositories/<id>` now leads
   * (public-addresses, slice 6): the repository's address under its
   * workplace's handle, or null when it has none — then the old door still
   * serves the shell, so a link forwarded before the move keeps working.
   */
  publicRepoAddress?: (publicId: string) => Promise<string | null>;
  /** Serve BRAND_FILES from this folder (a private copy only); before the
   *  public addresses, which would otherwise read `/fonts/…` as a person. */
  brandFilesDir?: string;
} = {}): Router {
  const router = Router();
  if (options.brandFilesDir) {
    const dir = options.brandFilesDir;
    for (const file of BRAND_FILES) {
      router.get(`/${file}`, (_req: Request, res: Response) => {
        res.sendFile(path.join(dir, file), { maxAge: '1d' }, (error) => {
          if (error && !res.headersSent) res.status(404).end();
        });
      });
    }
  }
  const workspaceUiDir = options.workspaceUiDir ?? DEFAULT_WORKSPACE_UI_DIR;
  const serveWorkspacePage = async (req: Request, res: Response) => {
    // `?ui=` was the switch between this shell and the retired single-file
    // page (routes/workspace-ui.ts). A link that still carries it is cleaned
    // and redirected, so the parameter never sticks in a copied address.
    if (handleRetiredWorkspaceUiSwitch(req, res)) return;
    const door = /^\/public\/repositories\/([^/]+)$/.exec(String(req.path ?? ''));
    if (door && options.publicRepoAddress) {
      const address = await options.publicRepoAddress(decodeURIComponent(door[1]!)).catch(() => null);
      if (address) {
        const query = new URL(req.originalUrl ?? req.path, 'http://placeholder.invalid').search;
        res.setHeader('Cache-Control', 'no-store');
        return res.redirect(301, `${address}${query}`);
      }
    }
    const shell = await loadWorkspaceUiShell(workspaceUiDir).catch(() => null);
    if (!shell) return res.status(404).json({ error: 'Workspace shell not found on this backend build' });
    // Link-only means exactly that: the page works for whoever receives its
    // opaque address, but search engines are not invited to turn it into a
    // public directory by crawling shared links.
    if (String(req.path ?? '').startsWith('/public/repositories/')) {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    }
    return sendWorkspaceUiShell(res, shell);
  };
  // The entry doors and every registered destination (shared/workspace-routes.ts)
  // serve the shell; the registry is the one list, so a route added there is
  // served here without a second edit — and nothing else is served at all.
  for (const pattern of workspaceShellPathPatterns()) router.get(pattern, serveWorkspacePage);
  // The cloud screen was `/organization/spending` until note #355 made it the
  // cloud's own screen rather than a bill. An address that has been in a
  // chat for months still arrives.
  router.get('/organization/spending', (req, res) => {
    const query = new URL(req.originalUrl, 'http://placeholder.invalid').search;
    res.redirect(301, `${WORKSPACE_BASE}/workplace/cloud${query}`);
  });
  // The public addresses LAST, and only for a word that could be one: the
  // shell at `/adam` says who adam is (or what workplace acme is, and at
  // `/acme/site` which repository), or that there is nothing here — and that
  // answer is the same for a handle nobody holds, so the address itself
  // leaks nothing. A reserved word (`/ops`, `/api`) is not this router's.
  for (const pattern of workspacePublicPathPatterns()) {
    router.get(pattern, (req: Request, res: Response, next: NextFunction) => {
      if (!publicAddress(String(req.path ?? ''))) return next();
      return serveWorkspacePage(req, res);
    });
  }
  return router;
}
