import type { GitHostClient } from './git-host-client.js';
import type { GitRepoStorage } from './git-repo-storage.js';
import type { OrgStorage } from './org-storage.js';
import { isLiveRepo } from '../types/git-repo.js';
import type { OrgDocument } from '../types/org.js';

/**
 * A ONE-TIME, PINNED move of two repositories between two workplaces the same
 * person administers — owner decision, 2026-09-20.
 *
 * `eldiyar-math` and `eldiyar-backups` were created in Org #0's School room
 * and belong with the owner's separate **Personal** workplace, whose own
 * School room stands at that workplace's namespace. This module moves exactly
 * those two, exactly once.
 *
 * WHY A PINNED MIGRATION AND NOT A `repo transfer` VERB. "Nothing moves
 * between workplaces" is the one wall the product has
 * (workplace-wide-repositories-knowledge-and-sites). A general transfer verb
 * would punch a permanent hole in it for the sake of a move the owner asked
 * for once. This is the same shape as `knowledge-shelf-backfill.ts`: pinned by
 * id, idempotent, guarded, it reports counts, and it is a no-op forever after.
 *
 * WHY THE NAMESPACE HAS TO CHANGE, rather than only the `orgId` stamp.
 * Authorization flows through the NAMESPACE, not through `GitRepoDocument.orgId`
 * (which that type calls informational): `ownedRepo` and `/git/verify` both ask
 * `OrgGitService.namespacesForOrg`, which contains every live room's namespace.
 * School is still a live room of Org #0, so a repository left at School's
 * namespace stays listable, clonable and pushable by Org #0's agents however it
 * is stamped. Moving the bytes to the target workplace's own namespace is what
 * actually transfers it — and is what drops it out of Org #0's reach.
 *
 * NOTHING IS DELETED. The bytes are one `rename(2)` on the host
 * (`/internal/repos/move`), so the repository is only ever at one end or the
 * other; protection, CI config and hooks ride along inside the directory. Old
 * backup bundles stay where they are under the previous path.
 *
 * WHAT DOES NOT RIDE ALONG is the clone URL — it carries the namespace, so
 * every existing clone must be re-pointed with `git remote set-url`. Proposals
 * follow the repository by `repoId` (`listByRepo`), so its history stays with
 * it; their own stored `userId` is left alone, being a record of where each
 * proposal was raised rather than an address anything resolves through.
 */

/**
 * Exactly what this migration may touch. Exported so the pins are readable in
 * one place — by a reviewer, and by the test that proves nothing else moves.
 */
export const SCHOOL_REPO_TRANSFER_PLAN = {
  /** Org #0 — where both repositories were created. */
  sourceOrgId: 'ec4c119f-94f4-4880-affa-07828b90291c',
  /** Org #0's School room namespace — where the bytes are today. */
  sourceNamespaceId: '64570a2c-bc33-4d0c-babe-6b017b196805',
  /** The separate workplace named Personal. */
  targetOrgId: '0567bf78-759a-4d99-88d6-b44e3b65f104',
  /** Pinned by id AND name: both must match a stored record or it is skipped. */
  repos: [
    { id: 'be66f72a-e09a-4fb5-9377-ce023604e2ee', name: 'eldiyar-math' },
    { id: 'a635f2d8-e0bf-459d-a688-c0fe44e479c2', name: 'eldiyar-backups' },
  ],
} as const;

const { sourceOrgId: SOURCE_ORG_ID, sourceNamespaceId: SOURCE_NAMESPACE_ID, targetOrgId: TARGET_ORG_ID } =
  SCHOOL_REPO_TRANSFER_PLAN;
const REPOS = SCHOOL_REPO_TRANSFER_PLAN.repos;

export interface SchoolRepoTransferDeps {
  orgStorage: Pick<OrgStorage, 'getOrg' | 'listMembers'>;
  gitRepoStorage: Pick<GitRepoStorage, 'get' | 'getLiveByNameIn' | 'update'>;
  hostFor: (orgId: string) => Promise<Pick<GitHostClient, 'moveRepo'>>;
}

export interface SchoolRepoTransferResult {
  moved: Array<{ name: string; fromNamespaceId: string; toNamespaceId: string }>;
  /** Already at the destination — an earlier run, or a rerun. */
  alreadyDone: string[];
  /** Left exactly as it was, with the reason. Never a partial move. */
  deferred: Array<{ name: string; reason: string }>;
}

/** The workplace's own namespace: what a new repository of that workplace gets
 *  (`OrgGitService.resolveNamespace` with no room). */
function ownNamespace(org: OrgDocument): string {
  return org.git?.namespaceId ?? org.createdByUserId;
}

/** Every namespace the target workplace's live repositories may occupy, so the
 *  workplace-wide name fence is checked the way `create` checks it. */
async function namespacesOf(deps: SchoolRepoTransferDeps, org: OrgDocument): Promise<string[]> {
  return [...new Set([ownNamespace(org), ...(org.roomsMerged?.namespaces ?? [])])];
}

/**
 * The authorization premise, re-proved at run time rather than trusted from
 * the day this was written: one person must be an ADMIN of both workplaces.
 * If the owner's membership changed in between, the move does not happen.
 */
async function sharedAdmins(deps: SchoolRepoTransferDeps): Promise<string[]> {
  const [source, target] = await Promise.all([
    deps.orgStorage.listMembers(SOURCE_ORG_ID),
    deps.orgStorage.listMembers(TARGET_ORG_ID),
  ]);
  const targetAdmins = new Set(
    target.filter((member) => member.role === 'admin').map((member) => member.userId),
  );
  return source
    .filter((member) => member.role === 'admin' && targetAdmins.has(member.userId))
    .map((member) => member.userId);
}

export async function transferSchoolReposToPersonal(
  deps: SchoolRepoTransferDeps,
): Promise<SchoolRepoTransferResult> {
  const result: SchoolRepoTransferResult = { moved: [], alreadyDone: [], deferred: [] };

  const [sourceOrg, targetOrg] = await Promise.all([
    deps.orgStorage.getOrg(SOURCE_ORG_ID),
    deps.orgStorage.getOrg(TARGET_ORG_ID),
  ]);
  // Every refusal below is whole: nothing is touched unless all of it holds.
  if (!sourceOrg || !targetOrg) {
    const missing = !sourceOrg ? SOURCE_ORG_ID : TARGET_ORG_ID;
    return { ...result, deferred: REPOS.map((r) => ({ name: r.name, reason: `workplace ${missing} does not exist` })) };
  }
  // Both must sit on the CENTRAL git host. `moveRepo` is one rename(2) inside
  // one repository root; across two hosts it would move nothing and the record
  // would then point at bytes that were never there.
  if (sourceOrg.git?.host || targetOrg.git?.host) {
    return {
      ...result,
      deferred: REPOS.map((r) => ({ name: r.name, reason: 'a workplace has its own git host — a local move cannot cross hosts' })),
    };
  }
  const admins = await sharedAdmins(deps);
  if (admins.length === 0) {
    return {
      ...result,
      deferred: REPOS.map((r) => ({ name: r.name, reason: 'no one is an admin of both workplaces' })),
    };
  }

  const toNamespaceId = ownNamespace(targetOrg);
  const targetNamespaces = await namespacesOf(deps, targetOrg);
  const host = await deps.hostFor(SOURCE_ORG_ID);

  for (const pinned of REPOS) {
    const doc = await deps.gitRepoStorage.get(pinned.id);
    if (!doc) {
      result.deferred.push({ name: pinned.name, reason: 'no such repository record' });
      continue;
    }
    // Done already — an earlier run, or a rerun after a restart.
    if (doc.userId === toNamespaceId && doc.orgId === TARGET_ORG_ID) {
      result.alreadyDone.push(pinned.name);
      continue;
    }
    // Every pin is checked, so a record that drifted is reported rather than
    // moved on a stale assumption.
    const mismatch = doc.name !== pinned.name ? `name is "${doc.name}"`
      : doc.userId !== SOURCE_NAMESPACE_ID ? `namespace is "${doc.userId}"`
      : doc.orgId !== SOURCE_ORG_ID ? `workplace is "${doc.orgId ?? 'none'}"`
      : !isLiveRepo(doc) ? 'the repository is deleted'
      : null;
    if (mismatch) {
      result.deferred.push({ name: pinned.name, reason: `not where this migration expected it — ${mismatch}` });
      continue;
    }
    // Names are unique per workplace among live repositories.
    const clash = await deps.gitRepoStorage.getLiveByNameIn(targetNamespaces, pinned.name);
    if (clash) {
      result.deferred.push({ name: pinned.name, reason: 'a live repository of that name is already in the target workplace' });
      continue;
    }

    await host.moveRepo(SOURCE_NAMESPACE_ID, pinned.name, toNamespaceId);
    try {
      const updated = await deps.gitRepoStorage.update(doc.id, { userId: toNamespaceId, orgId: TARGET_ORG_ID });
      if (!updated) throw new Error('the repository record refused the update');
      result.moved.push({ name: pinned.name, fromNamespaceId: SOURCE_NAMESPACE_ID, toNamespaceId });
    } catch (error) {
      // Put the bytes back, so the pair is never left disagreeing: the record
      // still says School, and now the directory does too.
      await host.moveRepo(toNamespaceId, pinned.name, SOURCE_NAMESPACE_ID).catch(() => {});
      result.deferred.push({ name: pinned.name, reason: `record update failed, bytes moved back (${(error as Error).message})` });
    }
  }

  return result;
}
