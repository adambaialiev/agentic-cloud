/**
 * The host the Workspace and every public address answer on (note #807):
 * agenticcloudcomputer.com for us, a private copy's own domain in a copy.
 *
 * The backend reads it from WORKSPACE_URL; the Workspace page the backend
 * serves carries it in `<meta name="acc-public-host">` for the browser, which
 * has no environment of its own. Through globalThis, like the mail domain:
 * this module also compiles for the public site, which has neither Node's
 * types nor a server environment. Anything unset or malformed is ours.
 */
export const DEFAULT_PUBLIC_HOST = 'agenticcloudcomputer.com';

const HOST_SHAPE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

function configuredPublicHost(): string {
  const host = globalThis as {
    process?: { env?: Record<string, string | undefined> };
    document?: { querySelector(selector: string): { getAttribute(name: string): string | null } | null };
  };
  let fromServer: string | undefined;
  const workspaceUrl = host.process?.env?.WORKSPACE_URL?.trim();
  if (workspaceUrl) {
    try { fromServer = new URL(workspaceUrl).hostname; } catch { fromServer = undefined; }
  }
  const fromShell = host.document?.querySelector('meta[name="acc-public-host"]')?.getAttribute('content') ?? undefined;
  const value = (fromServer ?? fromShell ?? '').trim().toLowerCase();
  return HOST_SHAPE.test(value) ? value : DEFAULT_PUBLIC_HOST;
}

/** The host every public address is on. */
export const PUBLIC_HOST = configuredPublicHost();

/** Where every deployed site is listed (note #756). */
export const CATALOGUE_URL = `https://${PUBLIC_HOST}/apps`;
