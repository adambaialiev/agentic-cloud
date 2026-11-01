/**
 * Auto-approve mode (note #944), on the workplace's own page beside its
 * other workplace-wide settings: one switch that says, in its own words,
 * what it does. Every member sees whether it is on; only an admin flips it,
 * and turning it ON is asked once more, because from then on nobody reads a
 * proposal before it merges. Off is never asked: it only puts the person
 * back in front of every proposal.
 */

import { useCallback, useEffect, useState } from 'react';
import { AUTO_APPROVE_SETTING_WORDS } from '../../../../src/shared/auto-approve.js';
import type { WorkspaceOrgAutoApproveAnswer } from '../../../../src/shared/workspace-api.js';
import { jsonBody } from '../../api/client.js';
import { useBanner } from '../../chrome/useBanner.js';
import { useConfirm } from '../../chrome/useConfirm.js';
import { errorMessage } from '../../ui/format.js';
import { relative, useNow } from '../../ui/time.js';
import { useOrgApi } from './useOrgApi.js';

/** The second line: the state, and who put it there and when. */
export function autoApproveMeta(answer: WorkspaceOrgAutoApproveAnswer, now?: number): string {
  // A flip stamped a beat after this screen's clock reads as the future, for
  // which `relative` says nothing; to the reader who just flipped it, it is
  // "just now".
  const when = answer.changedAt ? relative(answer.changedAt, now) || 'just now' : '';
  const who = answer.changedByName && answer.changedAt
    ? ` · turned ${answer.on ? 'on' : 'off'} by ${answer.changedByName} ${when}`
    : '';
  const state = answer.on ? `On${who}` : `Off${who} · every proposal waits for its owner`;
  return answer.canChange ? state : `${state} · only an admin can change this`;
}

export function AutoApproveSection() {
  const api = useOrgApi();
  const banner = useBanner();
  const ask = useConfirm();
  const now = useNow(true);
  const [answer, setAnswer] = useState<WorkspaceOrgAutoApproveAnswer | null>(null);
  const [busy, setBusy] = useState(false);

  const read = useCallback(async () => {
    try {
      setAnswer(await api.api<WorkspaceOrgAutoApproveAnswer>('api/org/auto-approve'));
    } catch {
      // A backend without the switch draws no section rather than a broken one.
    }
  }, [api]);
  useEffect(() => { void read(); }, [read]);

  if (!answer) return null;

  const toggle = async () => {
    const on = !answer.on;
    if (on) {
      const sure = await ask({
        title: 'Turn on auto-approve?',
        message: `${AUTO_APPROVE_SETTING_WORDS} Each one is recorded as approved automatically, not by you.`,
        verb: 'Turn on',
      });
      if (!sure) return;
    }
    setBusy(true);
    try {
      const written = await api.api<WorkspaceOrgAutoApproveAnswer>('api/org/auto-approve', jsonBody({ on }, 'PUT'));
      setAnswer(written);
      banner.show(on
        ? 'Auto-approve is on. Proposals with passing checks now merge without asking.'
        : 'Auto-approve is off. Every proposal waits for its owner again.', true);
    } catch (error) {
      banner.show(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="orgAutoApprove" aria-labelledby="orgAutoApproveTitle">
      <h2 id="orgAutoApproveTitle">Proposals</h2>
      <div className="card">
        <button
          className="row open" id="orgAutoApproveSwitch" type="button" role="switch"
          aria-checked={answer.on} disabled={busy || !answer.canChange}
          onClick={() => { void toggle(); }}
        >
          <div className="main">
            <div className="name plain">Auto-approve</div>
            <div className="meta">{AUTO_APPROVE_SETTING_WORDS}</div>
            <div className="meta" id="orgAutoApproveState">{autoApproveMeta(answer, now)}</div>
          </div>
          <span className={`lbswitch${answer.on ? ' on' : ''}`} aria-hidden="true"><span /></span>
        </button>
      </div>
    </section>
  );
}
