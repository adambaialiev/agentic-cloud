/**
 * The durable places in the browser Workspace — the ONE route registry.
 *
 * Shared on purpose: the backend reads it to decide which paths serve the
 * Workspace shell, and the React app reads it to build its router and to
 * parse a copied URL. Parsing a URL, writing one after a tap and choosing a
 * screen all read the same record; do not add a second path table beside
 * this one.
 *
 * Ownership is explicit and is the serializer's boundary, not a presentation
 * hint (knowledge page "miniapp-navigation"): an account route carries no
 * workplace, and a workplace route carries only `org`. There were room
 * routes too, carrying `org` and `room`, until rooms left the product (note
 * #843): a link copied before then still carries `&room=`, and the parser
 * simply does not read it. Forms, editors and contextual pickers are
 * deliberately transient — they keep the stable route underneath them and
 * never get an address of their own.
 *
 * Pure: no DOM, no `location`, no framework. Importable from Node and the
 * browser alike.
 */

/**
 * Where the Workspace's ADDRESSES live: the root of the domain (knowledge
 * page "public-addresses", 2026-09-26). Empty on purpose — Home is `/`.
 */
export const WORKSPACE_BASE = '';

/**
 * Where the Workspace's API, auth doors and built assets are mounted, and
 * where every address used to live. Addresses copied before 2026-09-26
 * still start with it; parsing reads it as nothing and the server answers
 * it with a permanent redirect to the root form.
 */
export const WORKSPACE_API_BASE = '/workspace';
export const WORKSPACE_LEGACY_BASE = '/workspace';

export type WorkspaceRouteScope = 'account' | 'org';

export interface WorkspaceRouteDefinition {
  /** The legacy page's screen name for this place; the React app keys its
   *  screens on the route kind, and this stays only for the parity test. */
  readonly screen: string;
  /** Path segments under /workspace; a `:name` segment is a route property. */
  readonly pattern: readonly string[];
  readonly scope?: WorkspaceRouteScope;
  /** Extra route properties that ride the query string: property → parameter. */
  readonly query?: Readonly<Record<string, string>>;
}

// Order matters: a fixed child must precede a parameterized sibling with the
// same segment count (`notes/archive` before `notes/:id`, `seats/sign-in`
// before `seats/:id`), because parsing takes the first record that matches.
export const WORKSPACE_ROUTE_DEFS = {
  agent: { screen: 'agent', pattern: ['agents', ':id'] },
  agentJobs: { screen: 'agentjobs', pattern: ['agents', ':id', 'jobs'] },
  chat: { screen: 'agentchat', pattern: ['chat', ':id'] },
  pr: { screen: 'pr', pattern: ['decisions', 'pr', ':id'] },
  knowledge: { screen: 'kp', pattern: ['decisions', 'knowledge', ':id'] },
  drive: { screen: 'drive', pattern: ['drive'], scope: 'org' },
  driveTrash: { screen: 'driveTrash', pattern: ['drive', 'trash'], scope: 'org' },
  driveFolder: { screen: 'driveFolder', pattern: ['drive', 'folders', ':id'], scope: 'org' },
  driveFile: { screen: 'driveFile', pattern: ['drive', 'files', ':id'], scope: 'org' },
  // Notes belong to the WORKPLACE since rooms left the product (note #843):
  // one list, one series of numbers. A note link copied while they were a
  // room's still carries `&room=` and opens the same note — the parser
  // simply does not read it.
  notes: { screen: 'notes', pattern: ['notes'], scope: 'org' },
  noteArchive: { screen: 'notearchive', pattern: ['notes', 'archive'], scope: 'org' },
  note: { screen: 'note', pattern: ['notes', ':id'], scope: 'org' },
  // Knowledge, repositories and sites belong to the WORKPLACE (note #566), as
  // Drive does: their addresses carry the workplace and no room. A link copied
  // before that still carries `&room=` and opens the same screen — the parser
  // simply does not read it.
  knowledgeList: { screen: 'knowledge', pattern: ['knowledge'], scope: 'org' },
  knowledgePage: { screen: 'kpage', pattern: ['knowledge', ':id'], scope: 'org' },
  // The Workplace window is an index since note #960: each shelf it held
  // inline is a screen of its own now, as Notes, Drive and Secrets were.
  repositories: { screen: 'repos', pattern: ['repositories'], scope: 'org' },
  repo: { screen: 'repo', pattern: ['repositories', ':id'], scope: 'org', query: { path: 'path' } },
  repoFile: { screen: 'file', pattern: ['repositories', ':id', 'file'], scope: 'org', query: { path: 'path' } },
  repoHistory: { screen: 'commits', pattern: ['repositories', ':id', 'history'], scope: 'org' },
  repoContributors: { screen: 'contributors', pattern: ['repositories', ':id', 'contributors'], scope: 'org' },
  repoCommit: { screen: 'prdiff', pattern: ['repositories', ':id', 'commits', ':sha'], scope: 'org' },
  // A person's own mail (note #509). Account scope, and deliberately: an
  // inbox belongs to the reader, not to a workplace or a room, so its address
  // carries neither. `mail` precedes `mail/:id` for the parser, and so do the
  // two places a message can be put away in (slice 7) and Sent (slice 9).
  mail: { screen: 'mail', pattern: ['mail'], scope: 'account' },
  mailArchive: { screen: 'mailarchive', pattern: ['mail', 'archive'], scope: 'account' },
  mailSpam: { screen: 'mailspam', pattern: ['mail', 'spam'], scope: 'account' },
  mailTrash: { screen: 'mailtrash', pattern: ['mail', 'trash'], scope: 'account' },
  mailSent: { screen: 'mailsent', pattern: ['mail', 'sent'], scope: 'account' },
  // Starred (note #666): every letter its reader starred, one row each.
  mailStarred: { screen: 'mailstarred', pattern: ['mail', 'starred'], scope: 'account' },
  // Email set up after the install, in a private copy (note #946): an
  // admin's screen for the provider, the receiver and the records.
  mailSetup: { screen: 'mailsetup', pattern: ['mail', 'setup'], scope: 'account' },
  mailMessage: { screen: 'mailmessage', pattern: ['mail', ':id'], scope: 'account' },
  profile: { screen: 'profile', pattern: ['profile'], scope: 'account' },
  // The work radio's library (note #758): every track, to hear in full and
  // take off the station. The platform operator's alone — the server refuses
  // anyone else — and the account's, since the station is the platform's.
  radioLibrary: { screen: 'radiolibrary', pattern: ['radio'], scope: 'account' },
  // The private copies that send us their daily pulse (note #1058): one row
  // each, and one copy's history. The platform operator's alone, like the
  // radio library, and the account's: copies belong to no workplace.
  copies: { screen: 'copies', pattern: ['copies'], scope: 'account' },
  copy: { screen: 'copy', pattern: ['copies', ':id'], scope: 'account' },
  organizations: { screen: 'orgpicker', pattern: ['workplaces'], scope: 'account' },
  organization: { screen: 'org', pattern: ['workplace'], scope: 'org' },
  organizationCloud: { screen: 'orgcloud', pattern: ['workplace', 'cloud'], scope: 'org' },
  /** What's new, in a company's own Agentic Cloud (note #1006): the
   *  releases newer than the running one, with their notes. Admins only. */
  copyReleases: { screen: 'copyreleases', pattern: ['workplace', 'whats-new'], scope: 'org' },
  /** Upgrade, in a company's own Agentic Cloud (note #1008): one run's
   *  progress, then how it ended. Admins only. */
  copyUpgrade: { screen: 'copyupgrade', pattern: ['workplace', 'upgrade'], scope: 'org' },
  /** The Workspace Agent's conversation used to live here (note #423); since
   *  2026-10-10 it IS Home, and this address only sends its reader there. */
  recapChat: { screen: 'recapChat', pattern: ['recap'], scope: 'org' },
  /** The workplace's overview, 2026-10-10 to note #715: the Workspace
   *  Agent's details, the two halves that used to be Home (Workplace and
   *  Rooms). Since note #715 those are two windows over Home, and this
   *  address — with its `?half=&room=&content=` — opens Home with the window
   *  it names. Kept because buttons and open tabs still name it. */
  recapAgent: { screen: 'overview', pattern: ['overview'], scope: 'org' },
  /** The Chief of Staff's own screen (note #960): its state, machine, reach,
   *  event turns, versions and context, which closed the Workplace window
   *  until then. */
  chiefOfStaff: { screen: 'chiefofstaff', pattern: ['chief-of-staff'], scope: 'org' },
  messages: { screen: 'messages', pattern: ['messages'], scope: 'org' },
  directMessage: { screen: 'directMessage', pattern: ['messages', ':id'], scope: 'org' },
  organizationPeople: { screen: 'orgpeople', pattern: ['workplace', 'people'], scope: 'org' },
  /** Where the workplace menu's "Invite" lands: the workplace's join link, ready to
   *  copy. Not the entry door `invite/:token`, which is the joiner's side. */
  organizationInvite: { screen: 'orginvite', pattern: ['workplace', 'invite'], scope: 'org' },
  organizationMember: { screen: 'orgmember', pattern: ['workplace', 'members', ':id'], scope: 'org' },
  seats: { screen: 'seats', pattern: ['seats'], scope: 'org' },
  seatSignIn: { screen: 'seatsignin', pattern: ['seats', 'sign-in'], scope: 'org' },
  /** One subscription's own sign-in (2026-09-22): `:id` is `claude`,
   *  `chatgpt` or `opencode`. A reload resumes the ceremony the server holds for it. */
  seatSignInProvider: { screen: 'seatsignin', pattern: ['seats', 'sign-in', ':id'], scope: 'org' },
  seat: { screen: 'seat', pattern: ['seats', ':id'], scope: 'org' },
  sites: { screen: 'sites', pattern: ['sites'], scope: 'org' },
  site: { screen: 'site', pattern: ['sites', ':id'], scope: 'org' },
  /** One object-storage bucket (note #778): a workplace's, like a site. */
  storage: { screen: 'storage', pattern: ['storage'], scope: 'org' },
  bucket: { screen: 'bucket', pattern: ['storage', ':id'], scope: 'org' },
  // The setup a workplace must finish before it opens (2026-09-22): each step
  // of the gate at its own address. The gate owns them — it moves the reader
  // to the step the workplace is really on, so an address can show a step
  // but never skip one. `setup` alone is that move; once the workplace is
  // set up, every one of them lands on Home.
  setup: { screen: 'setup', pattern: ['setup'], scope: 'org' },
  setupCloud: { screen: 'setup', pattern: ['setup', 'cloud'], scope: 'org' },
  setupSubscription: { screen: 'setup', pattern: ['setup', 'subscription'], scope: 'org' },
  setupSubscriptionProvider: { screen: 'setup', pattern: ['setup', 'subscription', ':id'], scope: 'org' },
  setupTeam: { screen: 'setup', pattern: ['setup', 'team'], scope: 'org' },
  secrets: { screen: 'secrets', pattern: ['secrets'], scope: 'org' },
  secret: { screen: 'secret', pattern: ['secrets', ':id'], scope: 'org', query: { agentId: 'agent' } },
  // The app catalogue (note #756): every site deployed on the platform,
  // newest first. Public like a person's page — no scope, no sign-in — and
  // a fixed word (already on the reserved list) that precedes `person`.
  apps: { screen: 'apps', pattern: ['apps'] },
  // A PERSON's public page (knowledge page "public-addresses", slice 5):
  // `/adam` is the profile of whoever holds adam@ on the mail domain. No
  // scope — it belongs to nobody's workplace and needs no sign-in — and
  // ORDERED LAST, after every fixed word, because parsing takes the first
  // match and a parameterized first segment would otherwise swallow them.
  // The reserved list (shared/handles.ts) is what keeps a person from
  // taking a fixed word; the parser refuses the registry's own words too.
  person: { screen: 'person', pattern: [':handle'] },
  // A WORKPLACE has no page of its own (the owner, 2026-10-12, note #748):
  // its handle shares the one namespace, so `/acme` parses as `person` and
  // the server answers it only for a member, who is sent on to the
  // workplace's own screen. Its repositories live under it: `/acme/site`,
  // with the folder or file being read in the query, as the link-only door
  // carried them.
  workplaceRepo: { screen: 'workplaceRepo', pattern: [':handle', ':repo'], query: { path: 'path', file: 'file' } },
  // What HAPPENED in a public repository, beside what it contains: the
  // default branch's history, one commit's diff, and its proposals — the
  // same pages a member reads on the repository's own screen, at the
  // repository's public address. Three and four segments never collide
  // with `/<handle>/<repo>`, so a repository named `commits` keeps its page.
  workplaceRepoCommits: { screen: 'workplaceRepoCommits', pattern: [':handle', ':repo', 'commits'] },
  workplaceRepoCommit: { screen: 'workplaceRepoCommit', pattern: [':handle', ':repo', 'commits', ':sha'] },
  workplaceRepoProposals: { screen: 'workplaceRepoProposals', pattern: [':handle', ':repo', 'proposals'] },
  workplaceRepoProposal: { screen: 'workplaceRepoProposal', pattern: [':handle', ':repo', 'proposals', ':number'] },
  // And who wrote it: every contributor git counts, with their numbers.
  workplaceRepoContributors: { screen: 'workplaceRepoContributors', pattern: [':handle', ':repo', 'contributors'] },
} as const satisfies Record<string, WorkspaceRouteDefinition>;

export type WorkspaceRouteKind = keyof typeof WORKSPACE_ROUTE_DEFS;

export const WORKSPACE_ROUTE_KINDS = Object.keys(WORKSPACE_ROUTE_DEFS) as WorkspaceRouteKind[];

/** A parsed or about-to-be-written destination. Only the properties the kind's
 *  definition names are ever set; the rest stay absent, never empty strings. */
export interface WorkspaceRoute {
  kind: WorkspaceRouteKind;
  id?: string;
  sha?: string;
  orgId?: string;
  path?: string;
  agentId?: string;
  /** A public address's word: the person or the workplace at `/<handle>`. */
  handle?: string;
  /** The repository under a workplace's handle: `/<handle>/<repo>`. */
  repo?: string;
  /** `1` when a public repository address names a file rather than a folder. */
  file?: string;
  /** A proposal's number under a public repository's address. */
  number?: string;
}

/** Home is a destination without a record: it is `/` itself. */
export type WorkspaceDestination = WorkspaceRoute | { kind: 'home' };

/**
 * The doors that are not destinations: the sign-in page itself, account
 * creation, and a workplace invite landing. They serve the same shell but
 * never appear in the registry — they are how you reach a place, not a place.
 */
export const WORKSPACE_ENTRY_PATTERNS: readonly (readonly string[])[] = [
  [],
  // The sign-in page's own address (public-addresses): the root belongs to
  // the landing page for a visitor, so a signed-out person needs a word.
  ['login'],
  ['signup'],
  ['verify-email'],
  ['reset-password'],
  ['confirm-recovery'],
  ['invite', ':token'],
  // A link-only public repository is an entry door, not a Workspace
  // destination: it carries no account/workplace scope and needs no sign-in.
  ['public', 'repositories', ':id'],
];

/**
 * Addresses that USED to be places and are not any more: the shell still
 * answers them — a link copied, forwarded or bookmarked before keeps
 * landing somewhere — but they parse as Home, which is where the React
 * shell sends them, and their first word stays out of anybody's handle.
 *
 * The rooms list and a room's own screen, until rooms left the product
 * (note #843): there is nothing of a room left to show, and Home is the
 * workplace the room was a part of.
 */
export const WORKSPACE_RETIRED_PATTERNS: readonly (readonly string[])[] = [
  ['rooms'],
  ['rooms', ':id'],
];

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 32;

/**
 * The one grammar a public handle keeps, whoever holds it: lowercase letters
 * and digits with single dots or hyphens between them. It is the mail-address
 * grammar, because a person's handle IS their address name; a workplace
 * handle keeps the same shape so the two can share the root of the domain.
 * Defined here, where the parser reads it, and re-exported by
 * shared/handles.ts, which owns the reserved list around it.
 */
export const HANDLE_SHAPE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

/** Whether a first segment could be a public handle at all: the grammar,
 *  the length, and none of the words the registry itself answers on. The
 *  broader reserved list lives in shared/handles.ts (which imports this
 *  module, so this one cannot read it); the server checks that too. */
export function publicHandleSegment(segment: string): boolean {
  return segment.length >= HANDLE_MIN && segment.length <= HANDLE_MAX
    && HANDLE_SHAPE.test(segment) && !registryFirstWords().has(segment);
}

let registryWords: Set<string> | null = null;
/** Every fixed first word the registry answers on: entry doors, destinations,
 *  the retired places, and the retired words still brought up to date. */
function registryFirstWords(): Set<string> {
  if (registryWords) return registryWords;
  const words = new Set<string>();
  for (const pattern of [...WORKSPACE_ENTRY_PATTERNS, ...WORKSPACE_RETIRED_PATTERNS]) {
    if (pattern[0] && !pattern[0].startsWith(':')) words.add(pattern[0]);
  }
  for (const definition of Object.values(WORKSPACE_ROUTE_DEFS)) {
    const first = definition.pattern[0];
    if (first && !first.startsWith(':')) words.add(first);
  }
  for (const old of Object.keys(WORKSPACE_LEGACY_SEGMENTS)) words.add(old);
  registryWords = words;
  return words;
}

/** A pattern whose FIRST segment is a parameter: a public address. */
export function publicHandlePattern(pattern: readonly string[]): boolean {
  return Boolean(pattern[0]?.startsWith(':'));
}

export function workspaceRouteDefinition(kind: string): WorkspaceRouteDefinition | null {
  return Object.prototype.hasOwnProperty.call(WORKSPACE_ROUTE_DEFS, kind)
    ? WORKSPACE_ROUTE_DEFS[kind as WorkspaceRouteKind]
    : null;
}

function decodeSegment(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/**
 * Read a destination out of an address. `pathname` is the full path
 * (`/workspace/notes/12`); `search` is the query string with or without its
 * `?`. Null for Home, the entry doors, and anything unknown — a URL names a
 * destination, it never grants access to one, so the caller still resolves it.
 */
/**
 * The first segment a place USED to be addressed by (note #432: the word
 * "organization" left the product for "workplace" on 2026-09-09). A link
 * copied, forwarded or bookmarked before then still names a place, so
 * parsing reads the old segment as the new one; writing never produces it.
 * The React shell replaces the address with the canonical one on arrival.
 */
export const WORKSPACE_LEGACY_SEGMENTS: Readonly<Record<string, string>> = {
  organizations: 'workplaces',
  organization: 'workplace',
};

/** The path without the old `/workspace` prefix, if it carried one. */
export function stripWorkspaceLegacyBase(pathname: string): string {
  if (pathname === WORKSPACE_LEGACY_BASE || pathname === `${WORKSPACE_LEGACY_BASE}/`) return '/';
  return pathname.startsWith(`${WORKSPACE_LEGACY_BASE}/`) ? pathname.slice(WORKSPACE_LEGACY_BASE.length) : pathname;
}

/**
 * The same address brought up to date: the old `/workspace` prefix off, and
 * an old first word replaced. Unchanged when it was already current.
 */
export function canonicalWorkspacePath(pathname: string): string {
  const stripped = stripWorkspaceLegacyBase(pathname);
  const parts = stripped.split('/');
  const first = parts[1];
  const modern = first === undefined ? undefined : WORKSPACE_LEGACY_SEGMENTS[first];
  if (!modern) return stripped;
  parts[1] = modern;
  return parts.join('/');
}

export function parseWorkspaceRoute(pathname: string, search = ''): WorkspaceRoute | null {
  const tail = canonicalWorkspacePath(pathname).split('/').filter(Boolean);
  for (const kind of WORKSPACE_ROUTE_KINDS) {
    const definition: WorkspaceRouteDefinition = WORKSPACE_ROUTE_DEFS[kind];
    if (tail.length !== definition.pattern.length) continue;
    const fields: Record<string, string> = {};
    let matches = true;
    for (let index = 0; index < definition.pattern.length; index += 1) {
      const part = definition.pattern[index]!;
      const segment = tail[index]!;
      if (part.startsWith(':')) {
        // A public address's word is read as typed, never decoded: the
        // grammar has nothing to escape, and a word that needs decoding is
        // not one anybody holds.
        if (index === 0) {
          if (!publicHandleSegment(segment)) { matches = false; break; }
          fields[part.slice(1)] = segment;
        } else {
          fields[part.slice(1)] = decodeSegment(segment);
        }
      } else if (segment !== part) { matches = false; break; }
    }
    if (!matches) continue;
    if (definition.scope || definition.query) {
      const query = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
      if (definition.scope === 'org') {
        const orgId = query.get('org');
        if (orgId) fields.orgId = orgId;
      }
      for (const [property, parameter] of Object.entries(definition.query ?? {})) {
        const value = query.get(parameter);
        if (value) fields[property] = value;
      }
    }
    return { kind, ...fields } as WorkspaceRoute;
  }
  return null;
}

/**
 * Write the address of a destination. Null when a required segment is missing
 * (a note route with no number) or the kind is unknown — a caller must never
 * end up navigating to a half-written path.
 */
export function workspaceRoutePath(route: WorkspaceDestination | null | undefined): string | null {
  if (!route || route.kind === 'home') return `${WORKSPACE_BASE}/`;
  const definition = workspaceRouteDefinition(route.kind);
  if (!definition) return null;
  const fields = route as unknown as Record<string, string | undefined>;
  const parts: string[] = [];
  for (const part of definition.pattern) {
    if (!part.startsWith(':')) { parts.push(part); continue; }
    const value = fields[part.slice(1)];
    if (value === undefined || value === null || value === '') return null;
    parts.push(encodeURIComponent(value));
  }
  const query = new URLSearchParams();
  if (definition.scope === 'org' && fields.orgId) query.set('org', fields.orgId);
  for (const [property, parameter] of Object.entries(definition.query ?? {})) {
    const value = fields[property];
    if (value !== undefined && value !== null && value !== '') query.set(parameter, value);
  }
  const suffix = query.toString();
  return `${WORKSPACE_BASE}/${parts.join('/')}${suffix ? `?${suffix}` : ''}`;
}

/** The legacy page's screen for a destination; `home` for Home, null if unknown. */
export function workspaceScreenForRoute(route: WorkspaceDestination | null | undefined): string | null {
  if (!route || route.kind === 'home') return 'home';
  return workspaceRouteDefinition(route.kind)?.screen ?? null;
}

/**
 * Two destinations are the same place when every named property agrees —
 * compared as parsed routes, so parameter order and encoding differences in
 * the raw URL cannot make one place look like two.
 */
export function sameWorkspaceRoute(
  left: WorkspaceDestination | null | undefined,
  right: WorkspaceDestination | null | undefined,
): boolean {
  if (!left || !right) return !left && !right;
  if (left.kind !== right.kind) return false;
  const a = left as unknown as Record<string, string | undefined>;
  const b = right as unknown as Record<string, string | undefined>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a[key] ?? '') !== (b[key] ?? '')) return false;
  }
  return true;
}

/**
 * Every path pattern the Workspace shell answers on, relative to where it
 * is mounted (the root today; `/workspace` before, where each one is now a
 * redirect) and in Express/React Router `:param` syntax: the entry doors
 * first, then every registered destination, then the retired places (note
 * #843), which the shell sends Home. The server registers exactly these and
 * nothing else, so an unknown address is a 404 from the API host, not a
 * shell that then has to apologize.
 */
export function workspaceShellPathPatterns(): string[] {
  const patterns = [
    ...WORKSPACE_ENTRY_PATTERNS,
    ...WORKSPACE_ROUTE_KINDS.map((kind) => WORKSPACE_ROUTE_DEFS[kind].pattern),
    ...WORKSPACE_RETIRED_PATTERNS,
  ].filter((pattern) => !publicHandlePattern(pattern));
  // A destination's OLD first segment still serves the shell (an address
  // that was copied before the rename), which then moves to the new one.
  const legacy = patterns.map((pattern) => legacyWorkspacePattern(pattern)).filter((pattern): pattern is readonly string[] => pattern !== null);
  return [...patterns, ...legacy].map((pattern) => `/${pattern.join('/')}`);
}

/**
 * The public addresses, apart: every pattern whose first segment is a
 * handle (`/:handle`), in the same syntax. A server registers these LAST,
 * after every fixed word it answers on — its own API, its assets, the ops
 * pages — and only for a segment `publicHandleSegment` accepts, or the
 * parameter would swallow the lot.
 */
export function workspacePublicPathPatterns(): string[] {
  const patterns = WORKSPACE_ROUTE_KINDS.map((kind) => WORKSPACE_ROUTE_DEFS[kind].pattern)
    .filter((pattern) => publicHandlePattern(pattern))
    .map((pattern) => `/${pattern.join('/')}`);
  return [...new Set(patterns)];
}

/** The pattern a destination used to answer on, or null if it never moved. */
export function legacyWorkspacePattern(pattern: readonly string[]): readonly string[] | null {
  const [first, ...rest] = pattern;
  const old = first === undefined ? undefined
    : Object.keys(WORKSPACE_LEGACY_SEGMENTS).find((key) => WORKSPACE_LEGACY_SEGMENTS[key] === first);
  return old ? [old, ...rest] : null;
}
