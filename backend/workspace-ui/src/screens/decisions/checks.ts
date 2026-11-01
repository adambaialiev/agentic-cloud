/**
 * What a check MEANS, in one place.
 *
 * "Actions" is what the product calls these on screen; the CLI and the API
 * still say "checks" (`--require-checks`, `ci/checks`), which is why the code
 * says so too. Home's queue pip, the proposal's Actions row and the delivery
 * sequence all read these, so none of the three can mean a different thing by
 * the same state.
 */

import type { WorkspaceCheckRow, WorkspaceCheckState } from '../../../../src/shared/workspace-api.js';

export type CheckBucket = 'passed' | 'nothing-to-do' | 'running' | 'no-verdict' | 'failed';

export function checkBucket(state: WorkspaceCheckState | string): CheckBucket {
  return state === 'success' ? 'passed'
    : state === 'skipped' ? 'nothing-to-do'
      : state === 'pending' ? 'running'
        : state === 'superseded' ? 'no-verdict'
          : 'failed';
}

/**
 * Grey covers both "did nothing" and "never reported": neither is green, and
 * neither is a failure. Red on a superseded row is what made a merely
 * unjudged commit look like a broken build.
 */
export function pipClass(state: WorkspaceCheckState | string): 'ok' | 'wait' | 'bad' | 'skip' {
  const bucket = checkBucket(state);
  return bucket === 'passed' ? 'ok' : bucket === 'running' ? 'wait' : bucket === 'failed' ? 'bad' : 'skip';
}

export interface ChecksTally {
  failing: number;
  running: number;
  /** Neither passing nor failing nor running: a job that never got to report.
   *  Counted out loud, because on a required-checks repo it is the whole
   *  explanation for a merge button that will not unlock. */
  unjudged: number;
  passed: number;
  worst: WorkspaceCheckState;
}

export function tallyChecks(checks: readonly WorkspaceCheckRow[]): ChecksTally {
  const of = (bucket: CheckBucket) => checks.filter((check) => checkBucket(check.state) === bucket).length;
  const failing = of('failed');
  const running = of('running');
  const unjudged = of('no-verdict');
  return {
    failing,
    running,
    unjudged,
    passed: of('passed'),
    worst: failing ? 'failure' : running ? 'pending' : unjudged ? 'superseded' : 'success',
  };
}

/** The Actions row's right-hand column, in one word about the whole run. */
export function checksSide(checks: readonly WorkspaceCheckRow[]): string {
  const tally = tallyChecks(checks);
  return tally.failing ? `${tally.failing} failing`
    : tally.running ? `${tally.running} running`
      : tally.unjudged ? `${tally.unjudged} never ran`
        : `${checks.length} passed`;
}

/**
 * "Green" for a required-checks repo: every check success or skipped, and at
 * least one has spoken — a sha CI has not judged yet is exactly what the flag
 * exists to hold at the door.
 */
export function checksGreen(checks: readonly WorkspaceCheckRow[]): boolean {
  return checks.length > 0 && checks.every((check) => {
    const bucket = checkBucket(check.state);
    return bucket === 'passed' || bucket === 'nothing-to-do';
  });
}
