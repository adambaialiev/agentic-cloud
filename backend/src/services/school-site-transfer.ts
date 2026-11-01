import type { DeploymentStorage } from './deployment-storage.js';
import type { OrgStorage } from './org-storage.js';

/**
 * A ONE-TIME, PINNED move of the live site `school` between two workplaces the
 * same person administers — owner decision, 2026-09-20, the third part of the
 * School-to-Personal move (repositories were PR #1062).
 *
 * WHAT A SITE TRANSFER ACTUALLY IS. Unlike a repository, a site is scoped by
 * `orgId` alone: `listByOrg` is what every agent-facing site read walks, and
 * nothing else decides access. So who owns, sees and may redeploy a
 * site IS one field, and moving it needs no downtime, no new app, no new
 * volume and no DNS change. The public address, the Fly app, the machine, the
 * volume, the contents and the deploy history are all untouched by this.
 *
 * WHY THE HOSTING PIN IS NOT OPTIONAL. The same `orgId` also decides which Fly
 * token acts on the app (`FlyAppOrgContextResolver` → `resolveOrgFlyContext`),
 * and a Fly app answers only to its own org's token — a foreign one gets 403,
 * measured. `school`'s app lives in Org #0's Fly account. So moving `orgId`
 * alone would leave the site online but unmanageable by anybody: no redeploy,
 * no restart, no logs, no destroy. That is the deadlock a stranded agent
 * machine once caused, and it bills the owner the whole time it is stuck.
 *
 * This writes `flyOrgId` in the same update, pinning the resolver to the
 * account the app is really in, so the site stays fully manageable from its
 * new workplace. The consequence, which is the owner's to accept and is said
 * plainly in the proposal: the site goes on RUNNING on Org #0's Fly account
 * while BELONGING to Personal. Moving the infrastructure itself would mean
 * rebuilding the app in the other account — new machine, new volume, real
 * downtime — and is a different job.
 *
 * NOTHING IS DESTROYED and no Fly call is made. One record is updated; undo is
 * the same two fields back (the room it also set went with rooms, note #843).
 */

/** Exactly what this migration may touch. */
export const SCHOOL_SITE_TRANSFER_PLAN = {
  siteName: 'school',
  /** Pinned by record id AND Fly app: both must match or nothing happens. */
  deploymentId: 'bb8f8d8d-7053-4834-a133-d03e1bbdc2ee',
  flyApp: 'iapp-756ba29a608f',
  sourceOrgId: 'ec4c119f-94f4-4880-affa-07828b90291c',
  targetOrgId: '0567bf78-759a-4d99-88d6-b44e3b65f104',
} as const;

const PLAN = SCHOOL_SITE_TRANSFER_PLAN;

export interface SchoolSiteTransferDeps {
  orgStorage: Pick<OrgStorage, 'getOrg' | 'listMembers'>;
  deploymentStorage: Pick<DeploymentStorage, 'get' | 'update'>;
}

export type SchoolSiteTransferResult =
  | { state: 'moved'; from: string; to: string; flyOrgId: string }
  | { state: 'already-done' }
  | { state: 'deferred'; reason: string };

/** The authorization premise, re-proved at run time: one person must be an
 *  admin of both workplaces. */
async function hasSharedAdmin(deps: SchoolSiteTransferDeps): Promise<boolean> {
  const [source, target] = await Promise.all([
    deps.orgStorage.listMembers(PLAN.sourceOrgId),
    deps.orgStorage.listMembers(PLAN.targetOrgId),
  ]);
  const targetAdmins = new Set(
    target.filter((member) => member.role === 'admin').map((member) => member.userId),
  );
  return source.some((member) => member.role === 'admin' && targetAdmins.has(member.userId));
}

export async function transferSchoolSiteToPersonal(
  deps: SchoolSiteTransferDeps,
): Promise<SchoolSiteTransferResult> {
  const doc = await deps.deploymentStorage.get(PLAN.deploymentId);
  if (!doc) return { state: 'deferred', reason: 'no such site record' };

  // Done already — an earlier run, or a rerun after a restart.
  if (doc.orgId === PLAN.targetOrgId) {
    return doc.flyOrgId === PLAN.sourceOrgId
      ? { state: 'already-done' }
      // Owned by Personal with no hosting pin is the stranded state this
      // migration exists to avoid. Repair it rather than walking past.
      : await pin(deps, doc.id);
  }

  const mismatch = doc.name !== PLAN.siteName ? `the site is named "${doc.name}"`
    : doc.flyApp !== PLAN.flyApp ? `its Fly app is "${doc.flyApp ?? 'none'}"`
    : doc.orgId !== PLAN.sourceOrgId ? `it belongs to "${doc.orgId ?? 'no workplace'}"`
    : doc.status === 'destroyed' ? 'the site is destroyed'
    : null;
  if (mismatch) return { state: 'deferred', reason: `not where this migration expected it — ${mismatch}` };

  const targetOrg = await deps.orgStorage.getOrg(PLAN.targetOrgId);
  if (!targetOrg) return { state: 'deferred', reason: 'the target workplace does not exist' };
  if (!(await hasSharedAdmin(deps))) {
    return { state: 'deferred', reason: 'no one is an admin of both workplaces' };
  }

  // One update: ownership and the hosting pin land together, so the stranded
  // state in between never exists.
  const updated = await deps.deploymentStorage.update(doc.id, {
    orgId: PLAN.targetOrgId,
    flyOrgId: PLAN.sourceOrgId,
  });
  if (!updated) return { state: 'deferred', reason: 'the site record refused the update' };
  return { state: 'moved', from: PLAN.sourceOrgId, to: PLAN.targetOrgId, flyOrgId: PLAN.sourceOrgId };
}

/** Repair a half-done move: owned by the target, but with no hosting pin. */
async function pin(deps: SchoolSiteTransferDeps, id: string): Promise<SchoolSiteTransferResult> {
  const updated = await deps.deploymentStorage.update(id, { flyOrgId: PLAN.sourceOrgId });
  return updated
    ? { state: 'moved', from: PLAN.sourceOrgId, to: PLAN.targetOrgId, flyOrgId: PLAN.sourceOrgId }
    : { state: 'deferred', reason: 'the site record refused the hosting pin' };
}
