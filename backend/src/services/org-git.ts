import type { OrgStorage } from './org-storage.js';
import type { OrgDocument, OrgRole } from '../types/org.js';

/**
 * The org → git namespace binding (byo-git-design, slice 1: org-scoped repos).
 *
 * A git NAMESPACE is the first path segment of every repo clone URL and disk
 * path — what the host checks a token against, and what the registry keys
 * names and quotas on. Pre-org, the namespace was simply the userId. The org
 * layer's contract says repos are shared org-wide, so the namespace becomes
 * the ORG's: every member's agents, and every member's laptop key, resolve to
 * the same namespace and therefore reach the same repos.
 *
 * The resolution is deliberately layered so nothing moves until it is told to:
 *
 * - No membership → the user's own userId. Pre-org behavior, byte for byte.
 * - Membership, but the org has no `git.namespaceId` stamp → its founder's
 *   userId (`orgKnowledgeShelfNamespace`), so every member stands in one place.
 * - Stamped org → the stamp. Org #0's stamp is its admin's userId (the
 *   pre-org layout on the central host, unmigrated on purpose); a client org
 *   born on its own git host is stamped with its orgId.
 *
 * Role travels with the answer because destruction and spend are admin verbs
 * on shared ground: deleting a repo everyone works in, or handing org secrets
 * to its CI, is decided by the role that owns the org's spend — not by
 * whichever member's agent asked.
 *
 * Rooms (note #85) once rode this lever, each with a namespace of its own.
 * They left the product (note #843, Adam, 30 Oct 2026): a workplace is one
 * namespace, and its old rooms' namespaces are kept on it
 * (`roomsMerged.namespaces`) only so records standing there still resolve.
 */

export interface GitNamespace {
  /** The first path segment of every repo URL and disk path this caller may touch. */
  namespaceId: string;
  /** The org behind it when the caller is a member; null for an org-less user. */
  orgId: string | null;
  /** The caller's role in that org; null when org-less. */
  role: OrgRole | null;
}

/** Where a workplace's one knowledge shelf lives (note #566). */
export function orgKnowledgeShelfNamespace(org: Pick<OrgDocument, 'git' | 'createdByUserId'>): string {
  return org.git?.namespaceId ?? org.createdByUserId;
}

export class OrgGitService {
  constructor(
    private readonly deps: {
      orgStorage: Pick<OrgStorage, 'getOrg' | 'getMembership' | 'getMembershipByUser' | 'listMembers' | 'updateOrg'
        | 'getOrgByNamespace'>;
      /**
       * Where the workplace's REPOSITORIES live, whatever became of the room
       * that namespace once was (note #566). A repository belongs to the
       * workplace and keeps its clone URL for good, so it outlives a deleted
       * room — and without this its address would drop out of
       * {@link OrgGitService.namespacesForOrg} with the room row, leaving a
       * healthy repository nobody could list, clone or push.
       */
      repoNamespacesForOrg?: (orgId: string) => Promise<string[]>;
    },
  ) {}

  /**
   * Where a caller's workplace content lives: the workplace's own namespace
   * (note #843 — a workplace is one place, with no rooms), or the caller's
   * own on a personal account.
   */
  async resolveNamespace(userId: string, orgId?: string | null): Promise<GitNamespace> {
    const membership = orgId
      ? await this.deps.orgStorage.getMembership(orgId, userId)
      : await this.deps.orgStorage.getMembershipByUser(userId);
    if (!membership) return { namespaceId: userId, orgId: null, role: null };
    const org = await this.deps.orgStorage.getOrg(membership.orgId);
    return {
      namespaceId: org ? orgKnowledgeShelfNamespace(org) : userId,
      orgId: membership.orgId,
      role: membership.role,
    };
  }

  /**
   * Every namespace an org's content can live under: its own, the old
   * rooms' namespaces recorded on it when rooms were merged and dropped
   * (note #843) — whatever still stands at one is the workplace's — and
   * wherever its repositories live. Quota sums and org-wide sweeps walk THIS list.
   */
  async namespacesForOrg(userId: string, orgId: string): Promise<string[]> {
    const base = await this.resolveNamespace(userId, orgId);
    const [repoNamespaces, org] = await Promise.all([
      this.deps.repoNamespacesForOrg?.(orgId).catch(() => []) ?? [],
      this.deps.orgStorage.getOrg(orgId),
    ]);
    return [...new Set([
      base.namespaceId,
      ...(org?.roomsMerged?.namespaces ?? []),
      ...repoNamespaces,
    ])];
  }

  /**
   * The namespace whose knowledge base a caller standing in `namespaceId`
   * reads and writes (note #566). Knowledge belongs to the workplace: once its
   * shelf has been merged, every room's namespace answers with the
   * workplace's own. Anything else — a personal account, a workplace whose
   * merge has not run yet, the workplace's own namespace — answers itself.
   *
   * The workplace's own namespace is the one room creation already treats as
   * such (`org.git.namespaceId`, else the founder's), NOT the per-member
   * fallback of {@link resolveNamespace}: a shelf must be one place.
   */
  async knowledgeShelfFor(namespaceId: string): Promise<string> {
    const org = await this.deps.orgStorage.getOrgByNamespace(namespaceId);
    if (!org?.knowledgeShelf?.mergedAt) return namespaceId;
    return orgKnowledgeShelfNamespace(org);
  }

  /**
   * The namespace whose SECRETS a caller standing in `namespaceId` reads and
   * writes (note #783). Secrets belong to the workplace, like repositories:
   * once its secret shelf has been merged, every room's namespace answers
   * with the workplace's own. Anything else — a personal account, a
   * workplace whose merge has not run yet, the workplace's own namespace, a
   * platform-credential owner — answers itself.
   */
  async secretShelfFor(namespaceId: string): Promise<string> {
    const org = await this.deps.orgStorage.getOrgByNamespace(namespaceId);
    if (!org?.secretShelf?.mergedAt) return namespaceId;
    return orgKnowledgeShelfNamespace(org);
  }

  /**
   * Who decides destruction and spend for this namespace: the org's admins,
   * or the sole user a personal namespace belongs to. Never empty — an org
   * that somehow has no admin falls back to the namespace itself rather than
   * leaving a decision with nobody to make it.
   */
  async adminsForNamespace(ns: GitNamespace): Promise<string[]> {
    if (!ns.orgId) return [ns.namespaceId];
    const admins = (await this.deps.orgStorage.listMembers(ns.orgId))
      .filter((member) => member.role === 'admin')
      .map((member) => member.userId);
    return admins.length > 0 ? admins : [ns.namespaceId];
  }

  /**
   * Stamp an org's git namespace — once. The stamp is identity-shaped (every
   * clone URL and disk path hangs off it), so re-stamping a different value
   * is refused rather than absorbed: getting here twice with two answers is a
   * bug somewhere else, and the second answer silently winning would strand
   * every repo under the first.
   */
  async stampOrgGitNamespace(orgId: string, namespaceId: string): Promise<void> {
    const trimmedOrg = orgId.trim();
    const trimmedNs = namespaceId.trim();
    if (!trimmedOrg || !trimmedNs) {
      throw new Error('stamping a git namespace needs an orgId and a namespaceId');
    }
    const org = await this.deps.orgStorage.getOrg(trimmedOrg);
    if (!org) throw new Error(`org ${trimmedOrg} does not exist`);
    if (org.git?.namespaceId) {
      if (org.git.namespaceId === trimmedNs) return; // idempotent
      throw new Error(
        `org ${trimmedOrg} already has git namespace "${org.git.namespaceId}" — refusing to move it to "${trimmedNs}"`,
      );
    }
    await this.deps.orgStorage.updateOrg(trimmedOrg, { git: { namespaceId: trimmedNs } });
  }
}
