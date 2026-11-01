/**
 * The landing, after approval: what happened once the change reached the
 * target branch, split into the two questions the reader is asking — did the
 * landing pass, and did it reach anywhere? Everything under `deploy/` answers
 * the latter; custom checks stay with the former.
 *
 * Pure: the sentences and the polling arithmetic. The component draws them.
 */

import type { WorkspaceCheckRow, WorkspaceProposalDelivery } from '../../../../src/shared/workspace-api.js';
import { checkBucket } from './checks.js';

/** A main-branch run can be serial: later deploy jobs do not file their first
 *  row until earlier ones finish. With no row at all, keep looking for six
 *  minutes; once the run has spoken, one quiet minute catches the hand-off
 *  between jobs without polling a settled record forever. */
export const DELIVERY_FIRST_POLLS = 72;
export const DELIVERY_QUIET_POLLS = 12;
export const DELIVERY_RECENT_MS = 10 * 60 * 1000;

/** The screen's own copy of a landing: the server's record plus the two
 *  facts only the screen knows — that a merge is in flight, and that the
 *  sequence has stopped being able to say anything new. */
export interface DeliveryView extends WorkspaceProposalDelivery {
  merging?: boolean;
  settled?: boolean;
}

export type DeliveryStageKind = 'checks' | 'deploys';

export interface DeliveryStage {
  state: WorkspaceCheckRow['state'];
  side: string;
  caption: string;
}

export function deliveryGroups(delivery: DeliveryView | null): Record<DeliveryStageKind, WorkspaceCheckRow[]> {
  const all = delivery && Array.isArray(delivery.checks) ? delivery.checks : [];
  return {
    checks: all.filter((check) => !String(check.context || '').startsWith('deploy/')),
    deploys: all.filter((check) => String(check.context || '').startsWith('deploy/')),
  };
}

/** One stage's compact answer. The full action rows are one tap underneath;
 *  this is the line that keeps all three stages visible together on a phone. */
export function deliveryStage(
  kind: DeliveryStageKind,
  actions: readonly WorkspaceCheckRow[],
  delivery: DeliveryView,
): DeliveryStage {
  // CI off (note #662): a push to this repository starts no run, so no row
  // is on its way — not after the merge and not after six minutes. Said from
  // the first frame, merge included. Rows that did arrive (CI switched off
  // after they ran) still speak for themselves below.
  if (delivery.ci === false && actions.length === 0) {
    return {
      state: 'skipped', side: 'off',
      caption: kind === 'checks'
        ? 'CI is off for this repository.'
        : 'Nothing is delivered while CI is off.',
    };
  }
  if (delivery.merging) {
    return {
      state: 'skipped', side: 'next',
      caption: kind === 'checks'
        ? `Starts after the change lands on ${delivery.branch}.`
        : `Starts after the checks on ${delivery.branch}.`,
    };
  }
  if (actions.length === 0) {
    if (delivery.settled) {
      return {
        state: 'skipped', side: 'none',
        caption: kind === 'checks'
          ? 'No checks reported for this landing.'
          : 'No delivery action reported for this landing.',
      };
    }
    return {
      state: 'pending', side: 'waiting',
      caption: kind === 'checks'
        ? `Waiting for the new checks on ${delivery.branch} to start.`
        : 'Waiting for delivery actions to report.',
    };
  }
  const count = (bucket: string) => actions.filter((check) => checkBucket(check.state) === bucket).length;
  const failing = count('failed');
  const running = count('running');
  const unjudged = count('no-verdict');
  const passed = count('passed');
  if (failing) {
    return {
      state: 'failure', side: `${failing} failing`,
      caption: kind === 'checks' ? 'The landing has a failing check.' : 'A delivery action needs attention.',
    };
  }
  if (running) {
    return {
      state: 'pending', side: `${running} running`,
      caption: kind === 'checks'
        ? `The landing is being checked on ${delivery.branch}.`
        : 'This landing is being delivered.',
    };
  }
  if (unjudged) {
    return {
      state: 'superseded', side: `${unjudged} never ran`,
      caption: "A newer commit took an action's place before it started.",
    };
  }
  if (!passed) {
    return {
      state: 'skipped', side: 'nothing to do',
      caption: kind === 'checks'
        ? 'The checks found nothing to do.'
        : 'This change needed no delivery action.',
    };
  }
  // "Live" is the terminal claim. A serial pipeline can show one successful
  // deploy before the next context has even appeared, so keep saying what is
  // complete during the quiet follow window and award Live only once that
  // window has settled. This prevents Live → running → Live whiplash.
  if (kind === 'deploys' && delivery.live && delivery.settled) {
    return { state: 'success', side: 'Live', caption: 'This landing reached a live surface.' };
  }
  return {
    state: 'success',
    side: kind === 'checks' ? `${passed} passed` : `${passed} complete`,
    caption: kind === 'checks'
      ? `The checks on ${delivery.branch} passed.`
      : 'The reported delivery actions completed.',
  };
}

export function deliverySignature(delivery: DeliveryView | null): string {
  return JSON.stringify((delivery?.checks ?? []).map((check) => [
    check.context, check.state, check.startedAt, check.completedAt, check.description,
  ]));
}

/**
 * Whether this landing can still say something new on its own. A running row
 * always wins; a repository with CI off has nothing else coming; otherwise a
 * bounded quiet window catches jobs that enter the serial delivery lane after
 * the previous one finishes, and an age bound settles even a screen whose
 * backend has become unreachable.
 */
export function deliveryWaiting(delivery: DeliveryView | null, quietPolls: number, now = Date.now()): boolean {
  if (!delivery || delivery.merging) return false;
  const checks = delivery.checks ?? [];
  if (checks.some((check) => check.state === 'pending')) return true;
  // With CI off, nothing that has not reported yet ever will.
  if (delivery.ci === false) return false;
  const mergedAt = Date.parse(delivery.mergedAt || '');
  if (Number.isFinite(mergedAt) && now - mergedAt > DELIVERY_RECENT_MS) return false;
  const limit = checks.length === 0 ? DELIVERY_FIRST_POLLS : DELIVERY_QUIET_POLLS;
  return quietPolls < limit;
}
