/**
 * The last complete copy this tab read for every workplace in one signed-in
 * session. Switching workplace is a context change, not a reason to replace
 * familiar shelves with a loading screen: the provider restores this copy
 * synchronously and lets its ordinary reads update it underneath.
 *
 * The API client makes the store per tab; the session id prevents another
 * person who later signs in through that client from inheriting it.
 */

import type {
  WorkspaceNotificationRow,
  WorkspaceNoteLiveClaim,
  WorkspaceStateAnswer,
} from '../../../src/shared/workspace-api.js';
import type { WorkspaceApi } from '../api/client.js';
import type { WorkspaceHomeOverview } from './context.js';
import type { HomeAgent } from './live.js';

export interface WorkspaceLoaded {
  state: WorkspaceStateAnswer;
  agents: HomeAgent[];
  /** Live-only lease facts travel with a warm workplace copy so every screen
   *  in that copy agrees until the silent refresh lands. */
  noteClaims?: WorkspaceNoteLiveClaim[];
}

export interface HeldWorkplace {
  loaded?: WorkspaceLoaded;
  notifications?: WorkspaceNotificationRow[];
  overview?: WorkspaceHomeOverview;
}

interface HeldSession {
  sessionId: string;
  workplaces: Map<string, HeldWorkplace>;
}

const heldSessions = new WeakMap<WorkspaceApi, HeldSession>();

function heldSession(api: WorkspaceApi, sessionId: string): HeldSession {
  const current = heldSessions.get(api);
  if (current?.sessionId === sessionId) return current;
  const next = { sessionId, workplaces: new Map<string, HeldWorkplace>() };
  heldSessions.set(api, next);
  return next;
}

export function heldWorkplace(
  api: WorkspaceApi,
  sessionId: string,
  orgId: string | null | undefined,
): HeldWorkplace | null {
  return orgId ? heldSession(api, sessionId).workplaces.get(orgId) ?? null : null;
}

export function holdWorkplace(
  api: WorkspaceApi,
  sessionId: string,
  orgId: string,
  patch: Partial<HeldWorkplace>,
): void {
  const session = heldSession(api, sessionId);
  session.workplaces.set(orgId, { ...session.workplaces.get(orgId), ...patch });
}

/** Sign-out is the one time every workplace copy belongs to the wrong reader. */
export function forgetWorkspaceCache(api: WorkspaceApi): void {
  heldSessions.delete(api);
}
