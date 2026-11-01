import type { GitCommitStatusDocument } from '../types/git-commit-status.js';
import { effectiveStatusState } from '../types/git-commit-status.js';
import type { GitPullRequestDocument } from '../types/git-pr.js';
import {
  pullRequestQuickNoteNamespaceId,
  pullRequestQuickNoteNumbers,
} from '../types/git-pr.js';
import type { QuickNoteClaim, QuickNoteDocument, QuickNoteHandoff } from '../types/quick-note.js';
import { activeQuickNoteClaim, activeQuickNoteHandoff } from '../types/quick-note.js';
import type { GitCommitStatusStorage } from './git-commit-status-storage.js';
import type { GitPullRequestStorage } from './git-pr-storage.js';

/** The structured state note #99 asks every note surface to show. */
export type QuickNoteWork =
  | { state: 'unclaimed' }
  /** Given to an agent by the user, not yet picked up (notes #234/#258). */
  | { state: 'handed'; handoff: QuickNoteHandoff }
  | { state: 'working'; claim: QuickNoteClaim }
  | { state: 'proposal'; proposal: GitPullRequestDocument }
  | { state: 'merged'; proposal: GitPullRequestDocument }
  | { state: 'live'; proposal: GitPullRequestDocument };

const commitKey = (repoId: string, sha: string): string => `${repoId}\0${sha}`;

export const LIVE_DEPLOY_CONTEXTS = new Set([
  'deploy/prod',
  'deploy/site',
  'deploy/git-host',
  'deploy/machine-image',
  'deploy/git-host-image',
  'deploy/msg-host-image',
]);

/** The platform's own release contexts that put nothing in front of a user. */
const NOT_LIVE_DEPLOY_CONTEXTS = new Set(['deploy/mirror-github', 'deploy/db-backup']);

/**
 * Whether a check is evidence of a user-facing release: one of the
 * platform's own, or a repository's site published on approval
 * (`agentbuilt repo publish` files `deploy/<site>`).
 */
export function isLiveDeployContext(context: string): boolean {
  if (LIVE_DEPLOY_CONTEXTS.has(context)) return true;
  return /^deploy\/[a-z0-9][a-z0-9-]{0,62}$/.test(context) && !NOT_LIVE_DEPLOY_CONTEXTS.has(context);
}

export function mergedProposalIsLive(statuses: GitCommitStatusDocument[], now: Date): boolean {
  // A mirror, backup or dev release is not evidence that the approved change
  // reached a user-facing production surface. Keep that distinction here so
  // “Live” cannot be awarded by deploy/mirror-github alone.
  const deploys = statuses.filter((status) => isLiveDeployContext(status.context));
  if (!deploys.length) return false;
  const states = deploys.map((status) => effectiveStatusState(status, now));
  // At least one deploy actually ran. “Skipped” is an answer, but it did not
  // put this change anywhere; pending/failure/superseded cannot read as live.
  return states.some((state) => state === 'success')
    && states.every((state) => state === 'success' || state === 'skipped');
}

/**
 * Resolve a batch at once so a hundred-note list pays one proposal read per
 * namespace and one status read per repository, not a query for every row.
 */
export async function resolveQuickNoteWorkMap(args: {
  notes: QuickNoteDocument[];
  pullRequests?: GitPullRequestStorage;
  commitStatuses?: GitCommitStatusStorage;
  now?: Date;
}): Promise<Map<string, QuickNoteWork>> {
  const now = args.now ?? new Date();
  const result = new Map<string, QuickNoteWork>();
  if (!args.notes.length) return result;

  const proposals: GitPullRequestDocument[] = [];
  if (args.pullRequests) {
    // A moved note keeps its completed or waiting work (note #111). Proposals
    // belong to the repository namespace where they were made and do not move
    // with the note, so read both its current address and every earlier one.
    const namespaces = [...new Set(args.notes.flatMap((note) => [
      note.userId,
      ...(note.previousLocations ?? []).map((location) => location.userId),
    ]))];
    proposals.push(...(await Promise.all(
      namespaces.map((namespace) => args.pullRequests!.listByQuickNoteNamespace(namespace)),
    )).flat());
  }

  const byNote = new Map<string, GitPullRequestDocument[]>();
  for (const note of args.notes) byNote.set(note.id, []);
  for (const proposal of proposals) {
    const linked = new Set(pullRequestQuickNoteNumbers(proposal));
    if (!linked.size) continue;
    for (const note of args.notes) {
      const addresses = [
        { userId: note.userId, number: note.number },
        ...(note.previousLocations ?? []),
      ];
      if (addresses.some((location) => (
        location.userId === pullRequestQuickNoteNamespaceId(proposal)
        && linked.has(location.number)
      ))) {
        byNote.get(note.id)!.push(proposal);
      }
    }
  }

  // A merged proposal can become Live after the read that first said Merged.
  // Fetch every relevant sha in one call per repo and let later reads advance.
  const merged = [...byNote.values()].flat().filter((proposal) => proposal.status === 'merged');
  const shasByRepo = new Map<string, Set<string>>();
  for (const proposal of merged) {
    const sha = proposal.mergeCommitSha ?? proposal.headSha;
    if (!sha) continue;
    const shas = shasByRepo.get(proposal.repoId) ?? new Set<string>();
    shas.add(sha);
    shasByRepo.set(proposal.repoId, shas);
  }
  const statusByCommit = new Map<string, GitCommitStatusDocument[]>();
  if (args.commitStatuses) {
    await Promise.all([...shasByRepo].map(async ([repoId, shas]) => {
      const docs = await args.commitStatuses!.listByShas(repoId, [...shas]);
      for (const sha of shas) {
        statusByCommit.set(commitKey(repoId, sha), docs.filter((doc) => doc.sha === sha));
      }
    }));
  }

  for (const note of args.notes) {
    const linked = byNote.get(note.id) ?? [];
    // Merged is irreversible and outranks any legacy duplicate left open.
    const landed = linked
      .filter((proposal) => proposal.status === 'merged')
      .sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt))[0];
    if (landed) {
      const sha = landed.mergeCommitSha ?? landed.headSha;
      const statuses = statusByCommit.get(commitKey(landed.repoId, sha)) ?? [];
      result.set(note.id, mergedProposalIsLive(statuses, now)
        ? { state: 'live', proposal: landed }
        : { state: 'merged', proposal: landed });
      continue;
    }
    const open = linked
      .filter((proposal) => proposal.status === 'open')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (open) {
      result.set(note.id, { state: 'proposal', proposal: open });
      continue;
    }
    const claim = activeQuickNoteClaim(note, now);
    if (claim) {
      result.set(note.id, { state: 'working', claim });
      continue;
    }
    // Under the claim, because a lease is what an agent DID and a handoff is
    // only what was asked of it — an agent already holding this note is the
    // better answer to "who has this", whoever it was handed to.
    const handoff = activeQuickNoteHandoff(note, now);
    if (handoff) {
      result.set(note.id, { state: 'handed', handoff });
      continue;
    }
    // Conflict does not fence a corrected replacement, but remains the most
    // useful pointer until somebody claims that correction — and a handoff IS
    // somebody being asked for it, which is why it is read first.
    const conflict = linked
      .filter((proposal) => proposal.status === 'conflict')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    result.set(note.id, conflict
      ? { state: 'proposal', proposal: conflict }
      : { state: 'unclaimed' });
  }
  return result;
}
