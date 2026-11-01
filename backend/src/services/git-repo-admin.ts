import type { GitRepoDocument } from '../types/git-repo.js';
import { GIT_TRASH_KEEP_DAYS } from '../types/git-repo.js';
import type { GitHostClient } from './git-host-client.js';
import type { GitPullRequestStorage } from './git-pr-storage.js';
import type { GitRepoStorage } from './git-repo-storage.js';

/**
 * Deleting a repo, in the one place both callers reach for it
 * (docs/agent-git-project-repos.md slice 5): the agent's own delete of an
 * unprotected repo, and the owner's tap on the ask card for a protected one.
 * Two doors, one implementation — a second copy is how the tapped path and
 * the typed path drift into meaning different things.
 *
 * Nothing here destroys bytes. The host moves the repo into its trash, and
 * this writes the tombstone that makes it invisible to every by-name lookup.
 * The purge, {@link GIT_TRASH_KEEP_DAYS} days later, happens on the host with
 * no backend involved — which is why `restorableUntil` is computed from the
 * delete time rather than read back from anywhere.
 */
export interface RepoDeleteDeps {
  repos: Pick<GitRepoStorage, 'update'>;
  host: Pick<GitHostClient, 'deleteRepo'>;
  /** Absent on a backend without proposals; then there are none to withdraw. */
  prs?: Pick<GitPullRequestStorage, 'listByRepo' | 'update'>;
}

export interface RepoDeleteResult {
  restorableUntil: string;
  /** Open proposals withdrawn along with it — nothing can land in a repo that
   *  is gone, and a card left saying "Approve" would be lying. */
  withdrawnPrs: number;
}

export function restorableUntil(deletedAt: string): string {
  return new Date(new Date(deletedAt).getTime() + GIT_TRASH_KEEP_DAYS * 86_400_000).toISOString();
}

/**
 * Is this trashed repo still something, or only the record of something?
 *
 * The host purges the bytes {@link GIT_TRASH_KEEP_DAYS} days after the delete
 * and tells nobody, so the tombstone outlives what it points at — by years, on
 * a row no sweep ever removes. Every reader that asks "does this namespace
 * still hold anything?" has to ask it of the WINDOW, not of the row: past it,
 * Restore has nothing to bring back and the trash is empty in every sense a
 * person can check.
 */
export function isRestorableRepo(doc: Pick<GitRepoDocument, 'deletedAt'>): boolean {
  return doc.deletedAt !== undefined && restorableUntil(doc.deletedAt) > new Date().toISOString();
}

/**
 * `byAgentId` is the agent whose ask this was, or null when the owner deleted
 * the repo themselves from the workspace. Null rather than the repo's creator:
 * a record that names an agent which did not do it is worse than one that
 * names nobody.
 */
export async function deleteRepoNow(
  repo: GitRepoDocument,
  byAgentId: string | null,
  deps: RepoDeleteDeps,
): Promise<RepoDeleteResult> {
  // Bytes first, record second — the same order as create, for the same
  // reason. A record that outlives its directory is a repo whose clone URL
  // 404s with no way to tell why; a directory in the trash with a record
  // still pointing at it is one retry away from being right, and the host
  // answers a repeated delete with the entry it made the first time.
  const moved = await deps.host.deleteRepo(repo.userId, repo.name);
  const deletedAt = new Date().toISOString();
  await deps.repos.update(repo.id, {
    deletedAt,
    ...(byAgentId ? { deletedByAgentId: byAgentId } : {}),
    ...(moved.trashedAs ? { trashedAs: moved.trashedAs } : {}),
    // Any ask this repo was carrying dies with it: a card that grants
    // secrets to a deleted repo has nothing honest left to do.
    deleteAsk: undefined,
    ciSecretsAsk: undefined,
    // And so does a publish link: a restored repository asks again rather
    // than resuming publishing to a site nobody re-approved for it.
    publishAsk: undefined,
    publishTo: undefined,
    // A repository that no longer belongs to the account cannot keep serving
    // either its public browser link or anonymous clones from host cache.
    publicAccess: undefined,
  });

  let withdrawnPrs = 0;
  const open = (await deps.prs?.listByRepo(repo.id))?.filter((pr) => pr.status === 'open') ?? [];
  for (const pr of open) {
    await deps.prs?.update(pr.id, {
      status: 'withdrawn',
      decidedAt: deletedAt,
      decisionNote: 'The repository was deleted.',
    });
    withdrawnPrs += 1;
  }

  return { restorableUntil: restorableUntil(deletedAt), withdrawnPrs };
}
