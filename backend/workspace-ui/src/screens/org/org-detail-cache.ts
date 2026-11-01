/**
 * The last workplace record (`GET api/org`) this tab actually read, per
 * workplace — for the member screen (note #613), in the owner's words:
 * "should be cached like other screens and silently refetched when opened".
 *
 * The member screen is a route, so every open rebuilt it from nothing and
 * drew "Loading…" while `api/org` — the heavy record, which calls out to the
 * git host — made its way back. It opens on the held copy now and reads
 * underneath it, exactly as the people deck does (`people-cache.ts`).
 *
 * Opt-in, through `useOrgDetail({ cached: true })`: the invite page decides
 * whether to MINT a link from `invites` on this record, and a held copy that
 * predates another admin's link would mint a second one. Only screens that
 * merely draw the record should open on an old one.
 *
 * Per TAB, and emptied by `SessionProvider` on sign-out and by the test setup
 * between tests; a reader who loses access has the copy dropped by the hook.
 */

import type { WorkspaceOrgDetail } from '../../../../src/shared/workspace-api.js';

const held = new Map<string, WorkspaceOrgDetail>();

export function heldOrgDetail(orgId: string | null | undefined): WorkspaceOrgDetail | null {
  return orgId ? held.get(orgId) ?? null : null;
}

export function holdOrgDetail(orgId: string, org: WorkspaceOrgDetail): void {
  held.set(orgId, org);
}

export function forgetOrgDetailOf(orgId: string): void {
  held.delete(orgId);
}

/** Every workplace, gone. Sign-out, and every test. */
export function forgetOrgDetails(): void {
  held.clear();
}
