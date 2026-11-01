/**
 * What a repository's rows say about it, ported function for function from
 * the legacy page so both shells describe the same repository the same way.
 */

import { NO_SUCH_REPOSITORY, type WorkspaceRepoRow } from '../../../../src/shared/workspace-api.js';
import { WorkspaceApiError } from '../../api/client.js';
import { errorMessage } from '../../ui/format.js';
import { relative } from '../../ui/time.js';

/** How much history one fetch carries. It answers BOTH screens — the latest
 *  commit on the repository's own screen and the whole list one tap deeper —
 *  so opening the list costs nothing and the two can never disagree. */
export const COMMITS_SHOWN = 20;

/** How many check runs the Actions card shows before "Show more". */
export const CHECK_RUNS_SHOWN = 5;

/**
 * When this repository was last TOUCHED, for the order the list is read in.
 * The branch stamp counts only when the branch is named — a time the branch
 * did not earn would claim exactly the thing that rule exists to stop.
 */
export function repoActivityAt(repo: WorkspaceRepoRow): number {
  const when = repo.branchPushAt && repo.branch
    ? repo.branchPushAt
    : (repo.lastPushAt || repo.createdAt);
  const at = Date.parse(when || '');
  return Number.isFinite(at) ? at : 0;
}

/**
 * Most recently touched first (the owner, 2026-08-16) — the same move the
 * fleet list made, for the same reason: this list is read to find the
 * repository something just happened in. Sorted on a COPY, and ties keep the
 * order they arrived in, which is the backend's creation order and the right
 * second answer for two repositories with nothing to separate them.
 */
export function reposByActivity(repos: readonly WorkspaceRepoRow[]): WorkspaceRepoRow[] {
  return [...repos].sort((a, b) => repoActivityAt(b) - repoActivityAt(a));
}

/**
 * What the row's activity line says, in the words the owner's rule allows: a
 * branch is NAMED only for a landing the backend actually saw on it. Any
 * other push says "pushed" and nothing about where, because it went
 * somewhere else — and a branch sitting next to a time it did not earn would
 * claim exactly what that rule exists to stop.
 *
 * The clock is an argument, not a module global: a helper that reads one
 * shared `now` can hand a component a moment from before it existed, which
 * is a bug this shell has already paid for once (`useNow`, slice 4).
 */
export function repoPushLine(repo: WorkspaceRepoRow, now?: number): { branch?: string; when: string } {
  if (repo.branchPushAt && repo.branch) {
    return { branch: repo.branch, when: `· pushed ${relative(repo.branchPushAt, now)}` };
  }
  if (repo.lastPushAt) return { when: `pushed ${relative(repo.lastPushAt, now)}` };
  // A repository nobody has pushed to yet. Saying so beats the row going
  // quiet under a name whose "0 B" then looks like a failure to load.
  return { when: 'no pushes yet' };
}

/** The badge a repository wears when a proposal is waiting on it. */
export function proposalBadge(count: number): string {
  return count === 1 ? '1 PR' : `${count} PRs`;
}

/** Whether a repository read failed because there is no repository by that
 *  name here — never a missing folder or file, which share the 404. */
export function isMissingRepo(error: unknown): boolean {
  return error instanceof WorkspaceApiError && error.status === 404 && error.code === NO_SUCH_REPOSITORY;
}

/**
 * What a screen says when the repository is not the reader's to open (note
 * #671). The server answers a repository of another workplace exactly as one
 * that never existed, so the words cannot say which — they name where the
 * reader looked, and the two likely reasons a link lands here.
 */
export function missingRepoWords(repoName: string, workplace: string | null | undefined): string {
  const where = workplace ? ` in ${workplace}` : '';
  return `There is no repository called “${repoName}”${where}. A repository opens only for the people of its own workplace, so a link to one may come from a workplace you are not in — or the repository has been renamed or deleted.`;
}

/** The words for a failed repository read: the missing-repository answer in
 *  full, anything else as the server said it. */
export function repoReadError(error: unknown, repoName: string, workplace: string | null | undefined): string {
  return isMissingRepo(error) ? missingRepoWords(repoName, workplace) : errorMessage(error);
}
