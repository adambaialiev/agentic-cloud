/**
 * Whether this platform is a private copy in a customer's own Fly
 * organization (notes #802, #804, #807, #808). Off for us.
 *
 * The backend reads PRIVATE_COPY; the Workspace page the backend serves
 * carries it in `<meta name="acc-private-copy" content="1">` for the
 * browser, which has no environment of its own — the sign-up door reads it
 * to say that accounts here come through an invite (note #808). Through
 * globalThis, like the mail domain and the public host: this module also
 * compiles for the public site, which has neither Node's types nor a server
 * environment.
 */
function configuredPrivateCopy(): boolean {
  const host = globalThis as {
    process?: { env?: Record<string, string | undefined> };
    document?: { querySelector(selector: string): { getAttribute(name: string): string | null } | null };
  };
  const fromServer = host.process?.env?.PRIVATE_COPY;
  const fromShell = host.document?.querySelector('meta[name="acc-private-copy"]')?.getAttribute('content') ?? undefined;
  return ['1', 'true', 'yes', 'on'].includes((fromServer ?? fromShell ?? '').trim().toLowerCase());
}

export const PRIVATE_COPY = configuredPrivateCopy();

/**
 * Whether new sign-ups on OUR hosted platform are closed (note #823, the
 * owner, 2026-10-28: "we should not host yet ... Only on-premise"). One
 * setting, SIGNUP_CLOSED, so hosting reopens without a rebuild: unset it and
 * restart. The backend reads the environment; the Workspace page carries it
 * in `<meta name="acc-signup-closed" content="1">`, so the sign-up door
 * points at the private copy instead of drawing a form that would be
 * refused. Never on in a private copy: its own sign-up rules (note #808)
 * are its own.
 */
function configuredSignupClosed(): boolean {
  if (PRIVATE_COPY) return false;
  const host = globalThis as {
    process?: { env?: Record<string, string | undefined> };
    document?: { querySelector(selector: string): { getAttribute(name: string): string | null } | null };
  };
  const fromServer = host.process?.env?.SIGNUP_CLOSED;
  const fromShell = host.document?.querySelector('meta[name="acc-signup-closed"]')?.getAttribute('content') ?? undefined;
  return ['1', 'true', 'yes', 'on'].includes((fromServer ?? fromShell ?? '').trim().toLowerCase());
}

export const SIGNUP_CLOSED = configuredSignupClosed();

/** The fragment the installer opens the sign-up door with to make a copy's
 *  first account (note #808): `/signup#first-account=<FIRST_ACCOUNT_CODE>`.
 *  A fragment, so the code never reaches a request line or a log. */
export const FIRST_ACCOUNT_FRAGMENT = 'first-account';
