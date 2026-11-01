/**
 * Browser-side helpers over the shared route registry. The registry itself
 * lives in backend/src/shared/workspace-routes.ts and is the only table; this
 * file only knows how to read it from a React Router location and how to
 * name a place to a person.
 */

import { useLocation, type Location } from 'react-router-dom';
import {
  WORKSPACE_ENTRY_PATTERNS,
  WORKSPACE_RETIRED_PATTERNS,
  WORKSPACE_ROUTE_DEFS,
  WORKSPACE_ROUTE_KINDS,
  canonicalWorkspacePath,
  legacyWorkspacePattern,
  parseWorkspaceRoute,
  workspaceRoutePath,
  type WorkspaceDestination,
  type WorkspaceRoute,
  type WorkspaceRouteKind,
} from '../../src/shared/workspace-routes.js';

/** The router is mounted under /workspace; React Router strips that basename
 *  from `location.pathname`, and the registry parser expects it back. */
export function routeFromLocation(location: Pick<Location, 'pathname' | 'search'>): WorkspaceRoute | null {
  return parseWorkspaceRoute(location.pathname, location.search);
}

export function useWorkspaceRoute(): WorkspaceRoute | null {
  return routeFromLocation(useLocation());
}

/** React Router path for a registered kind, relative to the basename. */
export function routerPathFor(kind: WorkspaceRouteKind): string {
  return WORKSPACE_ROUTE_DEFS[kind].pattern.join('/');
}

export const ROUTER_PATHS: ReadonlyArray<{ kind: WorkspaceRouteKind; path: string }> = WORKSPACE_ROUTE_KINDS
  .map((kind) => ({ kind, path: routerPathFor(kind) }));

/** The addresses a place answered on before its first segment was renamed
 *  (note #432); the router sends each to the place's current address. */
/**
 * The addresses a place USED to answer on, each brought up to date on
 * arrival: an old first word (organization → workplace, note #432), and
 * since 2026-09-26 the whole `/workspace` prefix (public-addresses). Home
 * and the entry doors under that prefix are listed too.
 */
export const LEGACY_ROUTER_PATHS: ReadonlyArray<{ kind: WorkspaceRouteKind | 'home' | 'entry'; path: string }> = [
  { kind: 'home' as const, path: 'workspace' },
  ...WORKSPACE_ENTRY_PATTERNS.filter((pattern) => pattern.length > 0)
    .map((pattern) => ({ kind: 'entry' as const, path: `workspace/${pattern.join('/')}` })),
  // A retired place under the old prefix too (note #843): brought up to
  // date, it is the address that opens Home.
  ...WORKSPACE_RETIRED_PATTERNS.map((pattern) => ({ kind: 'entry' as const, path: `workspace/${pattern.join('/')}` })),
  ...WORKSPACE_ROUTE_KINDS.flatMap((kind) => {
    const current = WORKSPACE_ROUTE_DEFS[kind].pattern;
    const old = legacyWorkspacePattern(current);
    return [
      { kind, path: `workspace/${current.join('/')}` },
      ...(old ? [{ kind, path: old.join('/') }, { kind, path: `workspace/${old.join('/')}` }] : []),
    ];
  }),
];

/** Router-relative `to` for the current address of a legacy one, query kept. */
export function canonicalToFor(location: Pick<Location, 'pathname' | 'search'>): string {
  return `${canonicalWorkspacePath(location.pathname)}${location.search}`;
}

/**
 * A router-relative `to` for a destination — the registry's path with the
 * basename taken off, so a tap writes exactly the address a copied link
 * would carry (`?org=` included). Null when the place cannot be
 * written, which a caller treats as "no door".
 */
export function toFor(route: WorkspaceDestination): string | null {
  return workspaceRoutePath(route);
}

/**
 * The workplace a workplace-scoped address carries: the one shape every
 * caller spreads. It named a room too, while notes were a room's (note
 * #843 took rooms out of the product, and out of every address).
 */
export function workspaceScope(orgId?: string | null): { orgId?: string } {
  return orgId ? { orgId } : {};
}
