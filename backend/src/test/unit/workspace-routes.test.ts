import { describe, expect, it } from 'vitest';
import {
  canonicalWorkspacePath,
  legacyWorkspacePattern,
  WORKSPACE_RETIRED_PATTERNS,
  WORKSPACE_ROUTE_DEFS,
  WORKSPACE_ROUTE_KINDS,
  parseWorkspaceRoute,
  sameWorkspaceRoute,
  workspaceRoutePath,
  workspaceScreenForRoute,
  workspaceShellPathPatterns,
  workspacePublicPathPatterns,
  publicHandlePattern,
  publicHandleSegment,
  type WorkspaceRouteDefinition,
} from '../../shared/workspace-routes.js';

/**
 * The shared route registry (shared/workspace-routes.ts) is the one table the
 * server and the React shell agree on: a route added there is parsed, written
 * and served without a second edit.
 */

describe('parsing an address', () => {
  it('reads the kind, the segment fields and exactly the scope its definition names', () => {
    expect(parseWorkspaceRoute('/agents/a1')).toEqual({ kind: 'agent', id: 'a1' });
    expect(parseWorkspaceRoute('/agents/a1/jobs')).toEqual({ kind: 'agentJobs', id: 'a1' });
    // A workplace route never carries a room, even when the URL offers one:
    // a note link copied while notes were a room's opens the same note (note
    // #843), the room unread.
    expect(parseWorkspaceRoute('/notes/12', '?org=o1&room=r1')).toEqual({ kind: 'note', id: '12', orgId: 'o1' });
    expect(parseWorkspaceRoute('/notes', '?org=o1&room=r1')).toEqual({ kind: 'notes', orgId: 'o1' });
    expect(parseWorkspaceRoute('/notes/archive', '?room=r1&org=o1')).toEqual({ kind: 'noteArchive', orgId: 'o1' });
    // An account route carries neither.
    expect(parseWorkspaceRoute('/profile', '?org=o1&room=r1')).toEqual({ kind: 'profile' });
    // An unscoped route ignores the query entirely.
    expect(parseWorkspaceRoute('/decisions/pr/7', '?org=o1')).toEqual({ kind: 'pr', id: '7' });
  });

  it('reads the query-borne fields a definition names, and no others', () => {
    // A repository belongs to the workplace (note #566): a link copied while
    // it still carried its room opens the same screen, the room unread.
    expect(parseWorkspaceRoute('/repositories/site', '?org=o&room=r&path=src%2Fapp&tab=content'))
      .toEqual({ kind: 'repo', id: 'site', orgId: 'o', path: 'src/app' });
    expect(parseWorkspaceRoute('/knowledge/working-here', '?org=o&room=r'))
      .toEqual({ kind: 'knowledgePage', id: 'working-here', orgId: 'o' });
    expect(parseWorkspaceRoute('/sites/school', '?org=o&room=r'))
      .toEqual({ kind: 'site', id: 'school', orgId: 'o' });
    // Secrets are the workplace's too (note #783): the room is read off.
    expect(parseWorkspaceRoute('/secrets/API_KEY', '?org=o&room=r&agent=ag1'))
      .toEqual({ kind: 'secret', id: 'API_KEY', orgId: 'o', agentId: 'ag1' });
    expect(parseWorkspaceRoute('/repositories/site/commits/deadbeef', '?org=o&room=r'))
      .toEqual({ kind: 'repoCommit', id: 'site', sha: 'deadbeef', orgId: 'o' });
  });

  it('keeps a fixed child ahead of its parameterized sibling', () => {
    expect(parseWorkspaceRoute('/notes/archive')?.kind).toBe('noteArchive');
    expect(parseWorkspaceRoute('/notes/archived')?.kind).toBe('note');
    expect(parseWorkspaceRoute('/seats/sign-in')?.kind).toBe('seatSignIn');
    expect(parseWorkspaceRoute('/seats/s1')?.kind).toBe('seat');
    expect(parseWorkspaceRoute('/workplace/cloud')?.kind).toBe('organizationCloud');
    expect(parseWorkspaceRoute('/workplace/people')?.kind).toBe('organizationPeople');
    expect(parseWorkspaceRoute('/workplace/invite')?.kind).toBe('organizationInvite');
    // The joiner's door is an entry, never a place: the two must not collide.
    expect(parseWorkspaceRoute('/invite/abc')).toBeNull();
  });

  it('addresses each setup step and each subscription\'s own sign-in (2026-09-22)', () => {
    expect(parseWorkspaceRoute('/setup', '?org=o1')).toEqual({ kind: 'setup', orgId: 'o1' });
    expect(parseWorkspaceRoute('/setup/cloud', '?org=o1')).toEqual({ kind: 'setupCloud', orgId: 'o1' });
    expect(parseWorkspaceRoute('/setup/subscription', '?org=o1')).toEqual({ kind: 'setupSubscription', orgId: 'o1' });
    expect(parseWorkspaceRoute('/setup/subscription/chatgpt', '?org=o1'))
      .toEqual({ kind: 'setupSubscriptionProvider', id: 'chatgpt', orgId: 'o1' });
    expect(parseWorkspaceRoute('/setup/team', '?org=o1')).toEqual({ kind: 'setupTeam', orgId: 'o1' });
    expect(parseWorkspaceRoute('/seats/sign-in/claude', '?org=o1'))
      .toEqual({ kind: 'seatSignInProvider', id: 'claude', orgId: 'o1' });
    expect(workspaceRoutePath({ kind: 'setupSubscriptionProvider', id: 'claude', orgId: 'o1' }))
      .toBe('/setup/subscription/claude?org=o1');
  });

  it('decodes segments and survives a malformed one', () => {
    expect(parseWorkspaceRoute('/knowledge/how%20deploys%20work')?.id).toBe('how deploys work');
    expect(parseWorkspaceRoute('/knowledge/%E0%A4%A')?.id).toBe('%E0%A4%A');
  });

  it('is null for Home, the entry doors and anything else', () => {
    expect(parseWorkspaceRoute('/')).toBeNull();
    expect(parseWorkspaceRoute('/')).toBeNull();
    expect(parseWorkspaceRoute('/signup')).toBeNull();
    expect(parseWorkspaceRoute('/invite/tok')).toBeNull();
    // One word nobody in the registry owns is a person's address (slice 5);
    // whether anybody holds it is the server's answer, never the parser's.
    expect(parseWorkspaceRoute('/notifications')).toEqual({ kind: 'person', handle: 'notifications' });
    expect(parseWorkspaceRoute('/agents/a1/extra')).toBeNull();
    expect(parseWorkspaceRoute('/elsewhere/agents/a1')).toBeNull();
  });
});

describe('writing an address', () => {
  it('round-trips every kind through parse', () => {
    for (const kind of WORKSPACE_ROUTE_KINDS) {
      const definition: WorkspaceRouteDefinition = WORKSPACE_ROUTE_DEFS[kind];
      const route: Record<string, string> = { kind };
      // A first-segment parameter is a public handle and keeps the handle
      // grammar; every other parameter is an opaque id that may need escaping.
      for (const [index, part] of definition.pattern.entries()) {
        if (part.startsWith(':')) route[part.slice(1)] = index === 0 ? `${part.slice(1)}-value.1` : `${part.slice(1)} value/1`;
      }
      if (definition.scope === 'org') route.orgId = 'o1';
      for (const property of Object.keys(definition.query ?? {})) route[property] = `${property}-v`;
      const path = workspaceRoutePath(route as never);
      expect(path, kind).toMatch(/^\/[a-z]/);
      const [pathname, search = ''] = path!.split('?');
      // A workplace's address is written, never parsed: one word is read as
      // a person, and the server says which of the two holds it.
      expect(parseWorkspaceRoute(pathname!, search), kind).toEqual(kind === 'workplace' ? { ...route, kind: 'person' } : route);
    }
  });

  it('is Home for Home and null for a half-written place', () => {
    expect(workspaceRoutePath({ kind: 'home' })).toBe('/');
    expect(workspaceRoutePath(null)).toBe('/');
    expect(workspaceRoutePath({ kind: 'note' })).toBeNull();
    expect(workspaceRoutePath({ kind: 'note', id: '' })).toBeNull();
    expect(workspaceRoutePath({ kind: 'bogus' } as never)).toBeNull();
  });

  it('writes only the scope the definition names, and skips empty query fields', () => {
    expect(workspaceRoutePath({ kind: 'profile', orgId: 'o1' })).toBe('/profile');
    expect(workspaceRoutePath({ kind: 'repo', id: 'a b', orgId: 'o1', path: '' })).toBe('/repositories/a%20b?org=o1');
    // A note is the workplace's (note #843): its address says whose, and no
    // room — even when a caller still spreads one in.
    expect(workspaceRoutePath({ kind: 'note', id: '12', orgId: 'o1' })).toBe('/notes/12?org=o1');
    expect(workspaceRoutePath({ kind: 'note', id: '12', orgId: 'o1', ...{ roomId: 'r1' } })).toBe('/notes/12?org=o1');
    expect(workspaceRoutePath({ kind: 'repo', id: 'a', orgId: 'o1', path: 'src/x' })).toBe('/repositories/a?org=o1&path=src%2Fx');
  });

  it('compares places as parsed routes, not as spellings', () => {
    const a = parseWorkspaceRoute('/notes/12', '?room=r1&org=o1');
    const b = parseWorkspaceRoute('/notes/12', '?org=o1&room=r1&legacy=1');
    expect(sameWorkspaceRoute(a, b)).toBe(true);
    // An old link's room is no part of the place (note #843).
    expect(sameWorkspaceRoute(a, parseWorkspaceRoute('/notes/12', '?org=o1'))).toBe(true);
    expect(sameWorkspaceRoute(a, parseWorkspaceRoute('/notes/13', '?org=o1&room=r1'))).toBe(false);
    expect(sameWorkspaceRoute(null, null)).toBe(true);
    expect(sameWorkspaceRoute(a, null)).toBe(false);
  });

  it('names the legacy screen for a place', () => {
    expect(workspaceScreenForRoute({ kind: 'home' })).toBe('home');
    expect(workspaceScreenForRoute({ kind: 'chat', id: 'a' })).toBe('agentchat');
    expect(workspaceScreenForRoute({ kind: 'nope' } as never)).toBeNull();
  });
});

describe('a person’s public address (public-addresses, slice 5)', () => {
  it('reads one word nobody in the registry owns as a person, and writes it back', () => {
    expect(parseWorkspaceRoute('/adam')).toEqual({ kind: 'person', handle: 'adam' });
    expect(parseWorkspaceRoute('/mira.chen', '?org=o1')).toEqual({ kind: 'person', handle: 'mira.chen' });
    expect(parseWorkspaceRoute('/workspace/adam')).toEqual({ kind: 'person', handle: 'adam' });
    expect(workspaceRoutePath({ kind: 'person', handle: 'adam' })).toBe('/adam');
    expect(workspaceRoutePath({ kind: 'person' })).toBeNull();
    expect(workspaceScreenForRoute({ kind: 'person', handle: 'adam' })).toBe('person');
  });

  it('never reads a fixed word, an entry door or a retired word as a person', () => {
    for (const word of ['login', 'signup', 'invite', 'public', 'notes', 'profile', 'mail', 'workplaces', 'organizations', 'organization', 'setup', 'rooms']) {
      const route = parseWorkspaceRoute(`/${word}`);
      expect(route?.kind, word).not.toBe('person');
      expect(publicHandleSegment(word), word).toBe(false);
    }
    // The fixed words still parse as themselves, ordered before the person.
    expect(parseWorkspaceRoute('/profile')).toEqual({ kind: 'profile' });
    expect(parseWorkspaceRoute('/workplaces')).toEqual({ kind: 'organizations' });
  });

  it('reads only the handle grammar: lowercase letters and digits, single dots or hyphens, 3–32 long', () => {
    for (const bad of ['ab', 'Adam', 'adam_x', '.adam', 'adam.', 'a..b', 'a%20b', 'adam%2Fx', 'x'.repeat(33)]) {
      expect(parseWorkspaceRoute(`/${bad}`), bad).toBeNull();
    }
    expect(parseWorkspaceRoute('/a-b.c9')).toEqual({ kind: 'person', handle: 'a-b.c9' });
    // Two segments are a workplace's repository, never a person's.
    expect(parseWorkspaceRoute('/adam/x')).toEqual({ kind: 'workplaceRepo', handle: 'adam', repo: 'x' });
  });
});

describe('a workplace’s repositories at their address (slice 6)', () => {
  it('has no address to write for a workplace itself, and reads a single word as a person — the server tells the two apart (note #748)', () => {
    expect(WORKSPACE_ROUTE_KINDS).not.toContain('workplace');
    expect(parseWorkspaceRoute('/acme')).toEqual({ kind: 'person', handle: 'acme' });
  });

  it('reads /<handle>/<repo> with the folder or file being read in the query, and writes it back', () => {
    expect(parseWorkspaceRoute('/acme/site')).toEqual({ kind: 'workplaceRepo', handle: 'acme', repo: 'site' });
    expect(parseWorkspaceRoute('/acme/site', '?path=src%2Fapp&file=1')).toEqual({ kind: 'workplaceRepo', handle: 'acme', repo: 'site', path: 'src/app', file: '1' });
    expect(parseWorkspaceRoute('/workspace/acme/site')).toEqual({ kind: 'workplaceRepo', handle: 'acme', repo: 'site' });
    expect(workspaceRoutePath({ kind: 'workplaceRepo', handle: 'acme', repo: 'my site', path: 'src' })).toBe('/acme/my%20site?path=src');
    // The first word keeps the handle grammar; a fixed word never becomes one.
    expect(parseWorkspaceRoute('/Acme/site')).toBeNull();
    expect(parseWorkspaceRoute('/notes/12')).toEqual({ kind: 'note', id: '12' });
    expect(parseWorkspaceRoute('/workplace/people')).toEqual({ kind: 'organizationPeople' });
  });

  it('reads the pages under a repository — its history, one commit, its proposals, one proposal — and writes them back', () => {
    expect(parseWorkspaceRoute('/acme/site/commits')).toEqual({ kind: 'workplaceRepoCommits', handle: 'acme', repo: 'site' });
    expect(parseWorkspaceRoute('/acme/site/commits/0afae37a')).toEqual({ kind: 'workplaceRepoCommit', handle: 'acme', repo: 'site', sha: '0afae37a' });
    expect(parseWorkspaceRoute('/acme/site/proposals')).toEqual({ kind: 'workplaceRepoProposals', handle: 'acme', repo: 'site' });
    expect(parseWorkspaceRoute('/acme/site/proposals/12')).toEqual({ kind: 'workplaceRepoProposal', handle: 'acme', repo: 'site', number: '12' });
    expect(parseWorkspaceRoute('/acme/site/contributors')).toEqual({ kind: 'workplaceRepoContributors', handle: 'acme', repo: 'site' });
    expect(workspaceRoutePath({ kind: 'workplaceRepoCommit', handle: 'acme', repo: 'site', sha: 'abc' })).toBe('/acme/site/commits/abc');
    expect(workspaceRoutePath({ kind: 'workplaceRepoProposal', handle: 'acme', repo: 'site', number: '12' })).toBe('/acme/site/proposals/12');
    // A repository named after a page keeps its own address: two segments are the repository.
    expect(parseWorkspaceRoute('/acme/commits')).toEqual({ kind: 'workplaceRepo', handle: 'acme', repo: 'commits' });
    expect(parseWorkspaceRoute('/Acme/site/commits')).toBeNull();
  });
});

describe('what the server serves', () => {
  it('lists the entry doors first, then every registered destination, in :param syntax', () => {
    const patterns = workspaceShellPathPatterns();
    expect(patterns.slice(0, 8)).toEqual([
      '/', '/login', '/signup', '/verify-email', '/reset-password', '/confirm-recovery', '/invite/:token',
      '/public/repositories/:id',
    ]);
    expect(patterns).toContain('/repositories/:id/commits/:sha');
    expect(patterns).toContain('/agents/:id/jobs');
    expect(patterns).toContain('/seats/sign-in');
    // Every destination but the public addresses, which are served apart,
    // and the two retired room places (note #843).
    expect(patterns).toHaveLength(8 + WORKSPACE_ROUTE_KINDS.length - 7 + 2 + 6);
    expect(patterns).not.toContain('/:handle');
    expect(patterns).not.toContain('/:handle/:repo');
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  it('keeps the public addresses apart, for a server to register last', () => {
    expect(workspacePublicPathPatterns()).toEqual([
      '/:handle', '/:handle/:repo',
      '/:handle/:repo/commits', '/:handle/:repo/commits/:sha', '/:handle/:repo/proposals', '/:handle/:repo/proposals/:number',
      '/:handle/:repo/contributors',
    ]);
    expect(publicHandlePattern([':handle'])).toBe(true);
    expect(publicHandlePattern(['notes', ':id'])).toBe(false);
  });

  it('still serves the addresses a workplace answered on when it was called an organization (note #432)', () => {
    const patterns = workspaceShellPathPatterns();
    for (const old of ['/organizations', '/organization', '/organization/cloud', '/organization/people', '/organization/members/:id']) {
      expect(patterns).toContain(old);
    }
    expect(legacyWorkspacePattern(['workplace', 'people'])).toEqual(['organization', 'people']);
    expect(legacyWorkspacePattern(['notes', ':id'])).toBeNull();
  });
});

describe('the rooms that left the product (note #843)', () => {
  it('has no room place any more: the rooms list and a room\'s own screen are retired', () => {
    expect(WORKSPACE_ROUTE_KINDS).not.toContain('rooms');
    expect(WORKSPACE_ROUTE_KINDS).not.toContain('room');
    for (const definition of Object.values(WORKSPACE_ROUTE_DEFS) as WorkspaceRouteDefinition[]) {
      expect(definition.scope ?? 'none', definition.screen).not.toBe('room');
    }
    expect(WORKSPACE_RETIRED_PATTERNS).toEqual([['rooms'], ['rooms', ':id']]);
  });

  it('reads an old room address as Home, and never as a person or a repository', () => {
    expect(parseWorkspaceRoute('/rooms', '?org=o1')).toBeNull();
    expect(parseWorkspaceRoute('/rooms/r9', '?org=o1&room=r1')).toBeNull();
    expect(parseWorkspaceRoute('/workspace/rooms/r9', '?org=o1')).toBeNull();
    expect(publicHandleSegment('rooms')).toBe(false);
  });

  it('still serves the shell at those addresses, so an old link lands on Home rather than a 404', () => {
    const patterns = workspaceShellPathPatterns();
    expect(patterns).toContain('/rooms');
    expect(patterns).toContain('/rooms/:id');
  });
});

describe('the old word in an address', () => {
  it('reads a copied organization link as the workplace it names', () => {
    expect(parseWorkspaceRoute('/organizations')).toEqual({ kind: 'organizations' });
    expect(parseWorkspaceRoute('/organization', '?org=o1')).toEqual({ kind: 'organization', orgId: 'o1' });
    expect(parseWorkspaceRoute('/organization/members/u2', '?org=o1')).toEqual({ kind: 'organizationMember', id: 'u2', orgId: 'o1' });
  });

  it('writes only the new word, and brings an old path up to date without touching the rest', () => {
    expect(workspaceRoutePath({ kind: 'organizationPeople', orgId: 'o1' })).toBe('/workplace/people?org=o1');
    expect(canonicalWorkspacePath('/organization/cloud')).toBe('/workplace/cloud');
    expect(canonicalWorkspacePath('/organizations')).toBe('/workplaces');
    expect(canonicalWorkspacePath('/notes/12')).toBe('/notes/12');
    expect(canonicalWorkspacePath('/repositories/organization')).toBe('/repositories/organization');
    // The whole /workspace prefix is the older word now (public-addresses).
    expect(canonicalWorkspacePath('/workspace')).toBe('/');
    expect(canonicalWorkspacePath('/workspace/')).toBe('/');
    expect(canonicalWorkspacePath('/workspace/notes/12')).toBe('/notes/12');
    expect(canonicalWorkspacePath('/workspace/organization/people')).toBe('/workplace/people');
    expect(parseWorkspaceRoute('/workspace/notes/12', 'org=o1&room=r1')).toEqual({ kind: 'note', id: '12', orgId: 'o1' });
    expect(parseWorkspaceRoute('/workspace')).toBeNull();
    expect(parseWorkspaceRoute('/workspace/login')).toBeNull();
  });
});
