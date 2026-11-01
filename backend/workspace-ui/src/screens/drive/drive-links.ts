import { WORKSPACE_API_BASE } from '../../../../src/shared/workspace-routes.js';
import { toFor } from '../../routes.js';
export function folderLink(orgId: string, id: string | null) {
  return toFor(id ? { kind: 'driveFolder', orgId, id } : { kind: 'drive', orgId })!;
}

/**
 * A Drive address the BROWSER follows by itself — an <img> in a list row, an
 * anchor that saves a folder's .zip (note #694). Neither can carry a header,
 * so these are GETs on the reader's own session cookie, like the inbox's
 * pictures; everything else goes through the session's `api` with its CSRF
 * header, as `driveApi` paths.
 */
export function driveBrowserUrl(orgId: string, suffix: string) {
  return `${WORKSPACE_API_BASE}/api/drive${suffix}?${new URLSearchParams({ org: orgId })}`;
}

/**
 * Drive is ONE place in the browser's history: every step INSIDE it — into a
 * folder, into a file, up a breadcrumb, over to Trash — REPLACES that entry
 * rather than stacking another on top of it (note #521).
 *
 * The trail above the reader is the breadcrumbs' job, and it is on the screen
 * the whole time: four folders down, any of them is one tap away. So what
 * Back owes a reader is the way OUT — Home, or wherever they opened Drive
 * from — and not the fifth tap of a walk they can already see. That is the
 * owner's report: "if I'm traversing in drive, user should navigate through
 * breadcrumbs. If user press Back in the header, it should navigate back to
 * the home page."
 *
 * Replacing is what makes that true for every Back there is. The header's
 * button spends the same entry as the phone's edge gesture and the browser's
 * own arrow, so the three cannot disagree about where Drive leads — the rule
 * the repository screens keep the other way round, by pushing every step
 * (knowledge page "miniapp-navigation"). One place, one entry, one way out,
 * and the header needs no Drive-shaped exception to know it.
 *
 * Every address stays real: a replace still writes the folder's or file's own
 * URL, so a link copied four folders down opens there and a reload stays put.
 */
export const WITHIN_DRIVE = { replace: true } as const;
