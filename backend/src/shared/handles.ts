/**
 * The first segment of an address on the product's own domain.
 *
 * Since the owner's decision of 2026-09-26 (knowledge page "public-addresses")
 * a person's name here is also their public address —
 * `agenticcloudcomputer.com/adam` — and a workplace's handle is the same kind
 * of thing at the same place: `/acme`, with its repositories under it at
 * `/acme/<repo>`. People and workplaces therefore share ONE namespace, and
 * neither may take a word the domain already answers on: a marketing page,
 * an entry door, or the first word of any Workspace address. This module is
 * that one list, in shared code, so the signup field, the workplace form and
 * the server all refuse the same words.
 *
 * Pure: no DOM, no framework, importable from Node and the browser alike.
 */

import { PUBLIC_HOST } from './public-host.js';
import { HANDLE_MAX, HANDLE_MIN, HANDLE_SHAPE, WORKSPACE_ENTRY_PATTERNS, WORKSPACE_RETIRED_PATTERNS, WORKSPACE_ROUTE_DEFS } from './workspace-routes.js';

/** The grammar lives with the parser that reads an address; this module
 *  owns the reserved list around it. Re-exported so every caller keeps
 *  reading it from here. */
export { HANDLE_MAX, HANDLE_MIN, HANDLE_SHAPE };

/**
 * The addresses the static landing site answers on (src/App.tsx and the
 * retired addresses public/_redirects still forwards). Kept as a literal on
 * purpose: the landing site and the backend are built separately, and the
 * backend cannot read the landing router. Adding a landing route means
 * adding its first segment here, or a person may take it as their name and
 * never be reachable at it.
 */
export const LANDING_FIRST_SEGMENTS: readonly string[] = [
  'terms', 'privacy', 'claude-code-in-the-cloud', 'codex-in-the-cloud', 'ai-agents-for-your-team',
  'four-phases', 'docs', 'teams', 'og-preview', 'product', 'own-cloud', 'why-fly',
  // Retired, still redirected at the edge.
  'pricing', 'tour', 'guides', 'refunds', 'shots', 'en', 'ru', 'open-source', 'request-access',
  'leaderboard', 'private-copy',
];

/**
 * Words the backend itself answers on at the root of the domain, outside
 * the Workspace registry, plus the words any web product is expected to keep
 * for itself. `workspace` stays reserved after the prefix goes: every link
 * copied before then still starts with it.
 */
export const PLATFORM_FIRST_SEGMENTS: readonly string[] = [
  'workspace', 'api', 'ops', 'internal', 'assets', 'static', 'public', 'files', 'media',
  'admin', 'login', 'logout', 'signin', 'signout', 'signup', 'register', 'auth', 'oauth',
  'settings', 'account', 'help', 'about', 'blog', 'status', 'health', 'www', 'new',
  'explore', 'search', 'orgs', 'organizations', 'organization', 'users', 'user', 'people',
  'repositories', 'repos', 'sites', 'site', 'apps', 'app', 'dashboard', 'home', 'index',
  'sitemap', 'robots', 'favicon', 'manifest', 'well-known',
  // The outreach letters' short links, /go/<code> (note #1106).
  'go',
];

/** The first word of every registered Workspace destination and entry door,
 *  read from the registry so a new route reserves its word by existing —
 *  and of every retired place (note #843: `/rooms`), which the shell still
 *  answers and nobody may take as a handle. */
export function workspaceFirstSegments(): string[] {
  const words = new Set<string>();
  for (const pattern of [...WORKSPACE_ENTRY_PATTERNS, ...WORKSPACE_RETIRED_PATTERNS]) {
    const first = pattern[0];
    if (first && !first.startsWith(':')) words.add(first);
  }
  for (const definition of Object.values(WORKSPACE_ROUTE_DEFS)) {
    const first = definition.pattern[0];
    if (first && !first.startsWith(':')) words.add(first);
  }
  return [...words].sort();
}

/**
 * The founder's address, agenticcloudcomputer.com/adam: the builder page
 * the front page shows (note #786), and so the one whose numbers anybody
 * may read (note #824); everyone else's are theirs alone.
 */
export const FOUNDER_HANDLE = 'adam';

/**
 * Names the mail domain itself needs or must never hand to one person: the
 * two RFC 2142 mailboxes every domain owes the internet, the roles a stranger
 * assumes are staff, and the senders our own mail already uses. A person
 * holding `support@` or `billing@` would be taken for us by anyone writing
 * to them — and since the same word is also `/support`, a workplace may not
 * take it either.
 */
export const RESERVED_MAILBOX_LOCALS: readonly string[] = [
  'abuse', 'account', 'accounts', 'admin', 'administrator', 'agent', 'agentbuilt', 'agents',
  'alert', 'alerts', 'api', 'billing', 'bounce', 'bounces', 'ceo', 'contact', 'dev',
  'devnull', 'dmarc', 'dkim', 'donotreply', 'do-not-reply', 'everyone', 'feedback', 'ftp',
  'help', 'helpdesk', 'hello', 'hostmaster', 'info', 'inbox', 'it', 'legal', 'list',
  'mail', 'mailer-daemon', 'mailerdaemon', 'marketing', 'news', 'newsletter', 'noc',
  'noreply', 'no-reply', 'notification', 'notifications', 'notify', 'null', 'office',
  'owner', 'postmaster', 'press', 'privacy', 'root', 'sales', 'security', 'spam', 'spf',
  'ssl', 'ssl-admin', 'staff', 'status', 'support', 'sysadmin', 'system', 'team', 'test',
  'updates', 'usenet', 'uucp', 'webmaster', 'workspace', 'www',
];

/** Every word a person or a workplace can never be addressed by. */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  ...RESERVED_MAILBOX_LOCALS,
  ...LANDING_FIRST_SEGMENTS,
  ...PLATFORM_FIRST_SEGMENTS,
  ...workspaceFirstSegments(),
]);

/** Whether this word is kept for the domain itself. Callers normalize first. */
export function isReservedHandle(word: string): boolean {
  return RESERVED_HANDLES.has(word);
}

/** The host every public address is on: ours, or a private copy's (note #807). */
export const PUBLIC_ADDRESS_HOST = PUBLIC_HOST;

export type HandleProblem = 'empty' | 'too-short' | 'too-long' | 'shape' | 'reserved';

/** What was typed, reduced to the candidate we test: spaces off, lowercase,
 *  a pasted `agenticcloudcomputer.com/acme` accepted as `acme`. */
export function normalizeHandle(value: unknown): string {
  if (typeof value !== 'string') return '';
  let candidate = value.trim().toLowerCase();
  candidate = candidate.replace(/^https?:\/\//, '');
  if (candidate.startsWith(`${PUBLIC_ADDRESS_HOST}/`)) candidate = candidate.slice(PUBLIC_ADDRESS_HOST.length + 1);
  candidate = candidate.replace(/^\/+|\/+$/g, '');
  return candidate;
}

/** The one reason this word cannot be a handle, or null. */
export function handleProblem(handle: string): HandleProblem | null {
  if (!handle) return 'empty';
  if (handle.length < HANDLE_MIN) return 'too-short';
  if (handle.length > HANDLE_MAX) return 'too-long';
  if (!HANDLE_SHAPE.test(handle)) return 'shape';
  if (isReservedHandle(handle)) return 'reserved';
  return null;
}

/** The sentence a person reads under the field. */
export function handleHint(problem: HandleProblem): string {
  switch (problem) {
    case 'empty': return 'Choose the word that comes after the slash.';
    case 'too-short': return `Use at least ${HANDLE_MIN} characters.`;
    case 'too-long': return `Use at most ${HANDLE_MAX} characters.`;
    case 'reserved': return 'That name is kept for the platform. Choose another.';
    case 'shape': return 'Use lowercase letters and numbers, with single dots or hyphens between them.';
  }
}

/**
 * A handle proposed from a display name — "Acme Trading" becomes
 * `acme-trading`, "Adam’s workplace" becomes `adams-workplace` — so a
 * workplace made without one (at signup, or before handles existed) still
 * has an address. Always a valid, unreserved shape; whether it is FREE is
 * the registry's question, and `withSuffix` is how the caller tries again.
 */
export function deriveHandle(name: string, suffix?: number): string {
  let base = name.toLowerCase()
    .replace(/[’'`]s\b/g, 's')
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (base.length < HANDLE_MIN) base = base ? `${base}-workplace` : 'my-workplace';
  const tail = suffix && suffix > 1 ? `-${suffix}` : '';
  base = base.slice(0, HANDLE_MAX - tail.length).replace(/-+$/g, '');
  let candidate = `${base}${tail}`;
  if (isReservedHandle(candidate)) candidate = `${base.slice(0, HANDLE_MAX - tail.length - 10).replace(/-+$/g, '')}-workplace${tail}`;
  return candidate;
}
