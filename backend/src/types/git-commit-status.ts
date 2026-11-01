/**
 * A CI verdict for one commit, one check (docs/ci-status-miniapp.md).
 *
 * Keyed on the SHA, not the proposal: pushes to a default branch produce
 * statuses and no PR at all, so a PR-keyed store would drop most of CI on the
 * floor. The proposal view joins by its pinned headSha.
 *
 * One document per (repo, sha, context), latest wins — no screen has ever
 * wanted a status's history, only its current answer.
 */

export type GitCommitStatusState =
  | 'pending'
  | 'success'
  | 'failure'
  | 'error'
  /**
   * The job looked and found nothing to do (a path filter said so). Distinct
   * from success on purpose: "deploy/prod ✓" on a commit that deployed
   * nothing is a lie, and the most expensive kind — a green one.
   */
  | 'skipped'
  /**
   * A newer commit for the same branch arrived, so this job was dropped from
   * the queue (or cancelled mid-build) and will never report.
   *
   * Its own state because the two readers want opposite answers and used to
   * get the same wrong one. It was filed as `error`, which says "this commit
   * is broken" — and nothing broke; no build ran. So:
   *  - the merge gate keeps BLOCKING on it, exactly as it blocked on error:
   *    there is no verdict for this sha, and `requireChecks` exists precisely
   *    to hold a sha CI has not judged. Reusing `skipped` here would have
   *    counted it as passing and let an unbuilt commit merge.
   *  - `agentbuilt repo checks` does NOT count it as a failed build, because
   *    the agent's question is "did MY build break", and the answer is no.
   */
  | 'superseded';

export interface GitCommitStatusDocument {
  id: string;
  userId: string;
  repoId: string;
  /** Full 40-hex commit sha. */
  sha: string;
  /** e.g. 'ci/checks', 'deploy/prod'. */
  context: string;
  state: GitCommitStatusState;
  /** One line, ≤140 chars — the CI daemon already caps at this. */
  description: string;
  startedAt: string;
  completedAt?: string;
  /** Tail of the job log, delivered with the terminal status. Capped. */
  logTail?: string;
  /**
   * The Fly machine shape this run's job machine had, written by whoever
   * created it (lane A's daemon, an org's own CI service). What the cloud
   * spending screen prices the run's minutes at (note #319): a check machine
   * lives only for its run, so the spend is the run's length at this shape's
   * hourly rate — a fact, where a monthly projection was a fiction. Absent on
   * runs filed before the shape travelled, and on lane B jobs, which run on
   * the runner host rather than on a machine of their own.
   */
  machine?: GitCommitStatusMachine;
}

export interface GitCommitStatusMachine {
  cpuKind: string;
  cpus: number;
  memoryMb: number;
}

export const GIT_COMMIT_STATUS_STATES: ReadonlySet<string> = new Set(
  ['pending', 'success', 'failure', 'error', 'skipped', 'superseded'],
);

/**
 * States that must not read as green: something either broke, or never
 * reported a verdict at all. The merge gate and the checks pip share this so
 * they cannot drift into disagreeing about what counts as passing.
 */
export const GIT_COMMIT_STATUS_NOT_PASSING: ReadonlySet<GitCommitStatusState> = new Set(
  ['failure', 'error', 'superseded'] as const,
);

/** 64 KB, matching the lane A runner's own report cap. */
export const GIT_COMMIT_STATUS_LOG_TAIL_MAX_BYTES = 64 * 1024;

/**
 * A `pending` older than this is treated as failed at READ time (state
 * 'error' in every API response): a daemon crash mid-job strands its pending
 * forever, and rendering it as still-running would keep the Mini App polling
 * and the user hoping. The write is left untouched — a late result can still
 * land and win.
 */
export const GIT_COMMIT_STATUS_STALE_PENDING_MS = 30 * 60_000;

export function effectiveStatusState(
  doc: Pick<GitCommitStatusDocument, 'state' | 'startedAt'>,
  now: Date,
): GitCommitStatusState {
  if (doc.state !== 'pending') return doc.state;
  const age = now.getTime() - new Date(doc.startedAt).getTime();
  return age > GIT_COMMIT_STATUS_STALE_PENDING_MS ? 'error' : 'pending';
}

/**
 * The worst effective state across every check filed under one sha, or null
 * when CI has not spoken at all — a repo without checks must render exactly as
 * it always did, never as "0 checks".
 *
 * ONE definition, because three surfaces read it now: home's proposal pip, the
 * repository's list, and the proposal card in the chat. A card that called a
 * sha green while the row beside it called the same sha red would be worse
 * than either being wrong on its own.
 *
 * `superseded` counts as not-passing here for the reason it does at the merge
 * gate: it is not a broken build, but it is not a verdict either, and green
 * over a sha nothing judged is the one lie this must never tell.
 */
export function worstCheckState(
  docs: Array<Pick<GitCommitStatusDocument, 'state' | 'startedAt'>>,
  now: Date,
): 'success' | 'pending' | 'failure' | 'superseded' | null {
  if (docs.length === 0) return null;
  const states = docs.map((doc) => effectiveStatusState(doc, now));
  // BROKEN and NEVER-REPORTED are both "not passing", and the gate is right to
  // stop on either — but they are not the same news, and this function is what
  // decides which one the reader is TOLD (note #76, Owner 2026-08-27).
  //
  // Collapsing them here painted a red dot on #279 and #282: both were merged
  // and immediately overtaken, so their leftover jobs were abandoned as
  // pointless. Nothing failed. The Mini App has always known what to do with a
  // superseded check — its pip renders it grey — but it never saw the word,
  // because this returned 'failure' before the payload was built. So the dot
  // said "broken" while the screen it opened said "never ran".
  //
  // A real failure still outranks everything: a set holding both a failure and
  // a superseded job is a failing set.
  if (states.some((s) => s === 'failure' || s === 'error')) return 'failure';
  if (states.some((s) => s === 'pending')) return 'pending';
  if (states.some((s) => s === 'superseded')) return 'superseded';
  return 'success';
}

export function validateStatusContext(context: string): string | null {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._\-/]{0,99}$/.test(context)) {
    return `"${context}" is not a usable status context.`;
  }
  return null;
}
