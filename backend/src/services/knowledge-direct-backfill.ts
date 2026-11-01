import type { GitHostClient } from './git-host-client.js';
import { KnowledgeService, type KnowledgeShelfResolver } from './knowledge-service.js';
import type { KnowledgePageCommentStorage } from './knowledge-page-comments.js';
import { moveMarginsForLandedChanges } from './knowledge-page-comments.js';
import type { KnowledgeProposalStorage } from './knowledge-storage.js';
import type { OrgStorage } from './org-storage.js';
import { newMarginComment } from '../types/comment.js';
import type { KnowledgePageAttachment } from '../types/knowledge.js';

/**
 * Settle what was still waiting when knowledge stopped needing approval
 * (note #746, 12 Oct 2026). Runs at boot, once per open proposal, and leaves
 * nothing hanging in a "waiting for your decision" list:
 *
 * - a proposal its agent had made READY is applied, exactly as the agent
 *   would apply it today — it was finished work waiting only for a tap that
 *   no longer exists;
 * - a QUIET one (never made ready) is withdrawn: its agent was still on it,
 *   and landing half-finished words would be worse than asking the agent
 *   to propose again;
 * - one whose page moved is marked conflict, as a refused approval was.
 *
 * Each gets a signed platform remark saying what happened and why, so the
 * agent that comes back to it is not left guessing. Idempotent: an open
 * proposal is settled once and is then no longer open.
 */
export interface KnowledgeDirectBackfillDeps {
  proposals: Pick<KnowledgeProposalStorage, 'listAllOpen' | 'update' | 'get' | 'addComment' | 'listByUser'>;
  orgStorage?: Pick<OrgStorage, 'getOrgByNamespace'>;
  /** The host a namespace's pages live on: a workplace's own, or the central one. */
  hostFor: (orgId: string | null) => Promise<GitHostClient>;
  shelf?: KnowledgeShelfResolver;
  pageComments?: KnowledgePageCommentStorage;
  media?: { deleteObject?: (args: { storagePath: string }) => Promise<unknown> };
  /** Tell the owner, in the agent's chat, that a page changed. Best-effort. */
  told?: (args: { userId: string; agentId: string; proposalId: string }) => Promise<boolean>;
  now?: () => Date;
}

export interface KnowledgeDirectBackfillResult {
  applied: number[];
  withdrawn: number[];
  conflicts: number[];
  deferred: Array<{ number: number; reason: string }>;
}

const PLATFORM_AUTHOR = 'platform';

export async function settleOpenKnowledgeProposals(deps: KnowledgeDirectBackfillDeps): Promise<KnowledgeDirectBackfillResult> {
  const result: KnowledgeDirectBackfillResult = { applied: [], withdrawn: [], conflicts: [], deferred: [] };
  const now = () => (deps.now ?? (() => new Date()))().toISOString();
  const open = await deps.proposals.listAllOpen();
  for (const doc of open) {
    const remark = (text: string) => deps.proposals.addComment(doc.id, newMarginComment(PLATFORM_AUTHOR, text)).catch(() => null);
    if (doc.direct) {
      // A direct change caught between its record and its landing (a crash,
      // or an apply in flight while this runs): never applied here — its
      // agent retries on its own terms, with a fresh read of the page.
      await deps.proposals.update(doc.id, { status: 'conflict', decidedAt: now() });
      await remark('<p>Marked conflict by the platform: this change was interrupted between being recorded and landing, so it was not applied. Propose it again from the page as it stands now.</p>');
      result.conflicts.push(doc.number);
      continue;
    }
    if (doc.draft) {
      await deps.proposals.update(doc.id, { status: 'withdrawn', decidedAt: now() });
      await remark('<p>Withdrawn by the platform on 12 Oct 2026: knowledge changes apply the moment they are written now (note #746), and this one was never made ready. Propose it again and it is live at once.</p>');
      result.withdrawn.push(doc.number);
      continue;
    }
    try {
      const org = deps.orgStorage ? await deps.orgStorage.getOrgByNamespace(doc.userId).catch(() => null) : null;
      const host = await deps.hostFor(org?.orgId ?? null);
      const service = new KnowledgeService(host, deps.proposals as KnowledgeProposalStorage, deps.shelf);
      const landed = await service.land(doc.id, doc.createdByUserId ?? doc.createdByAgentId, doc.note);
      if (landed.status === 'landed') {
        await deps.proposals.update(doc.id, { direct: true });
        for (const file of landed.orphaned as KnowledgePageAttachment[]) {
          await deps.media?.deleteObject?.({ storagePath: file.storagePath }).catch(() => null);
        }
        await moveMarginsForLandedChanges(deps.pageComments, doc.userId, doc.changes);
        await remark('<p>Applied by the platform on 12 Oct 2026: knowledge changes no longer wait for approval (note #746). This one was ready, so it is live as written.</p>');
        if (doc.createdByUserId) {
          await deps.told?.({ userId: doc.createdByUserId, agentId: doc.createdByAgentId, proposalId: doc.id }).catch(() => false);
        }
        result.applied.push(doc.number);
      } else if (landed.status === 'conflict') {
        if ((await deps.proposals.get(doc.id))?.status === 'open') {
          await deps.proposals.update(doc.id, { status: 'conflict', decidedAt: now() });
        }
        await remark(`<p>Could not be applied on 12 Oct 2026, when knowledge changes stopped waiting for approval (note #746): ${landed.pages.map((page) => `"${page}"`).join(', ')} changed after it was written. Reread the page and propose again from its current words.</p>`);
        result.conflicts.push(doc.number);
      } else {
        result.deferred.push({ number: doc.number, reason: landed.status });
      }
    } catch (error) {
      result.deferred.push({ number: doc.number, reason: (error as Error).message });
    }
  }
  return result;
}
