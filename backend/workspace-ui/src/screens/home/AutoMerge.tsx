/**
 * Auto-merge (note #944), in the Workplace window: the reader's OWN switch
 * ("Each user should enable disable for itself", Adam, 1 Nov 2026). It
 * covers only their own agents' proposals, and nobody else can flip it.
 * Turning it on is asked once more, because from then on nobody reads those
 * proposals before they merge; turning it off is never asked. While it is
 * on, the Chief of Staff's header says so in yellow.
 */

import { useState } from 'react';
import { AUTO_APPROVE_SETTING_WORDS } from '../../../../src/shared/auto-approve.js';
import { useBanner } from '../../chrome/useBanner.js';
import { useConfirm } from '../../chrome/useConfirm.js';
import { errorMessage } from '../../ui/format.js';
import { relative, useNow } from '../../ui/time.js';
import { useAutoMerge } from '../../workspace/useAutoMerge.js';

/** The second line: the state, and since when. */
export function autoMergeMeta(answer: { on: boolean; changedAt?: string }, now?: number): string {
  // A flip stamped a beat after this screen's clock reads as the future, for
  // which `relative` says nothing; to the reader who just flipped it, it is
  // "just now".
  const when = answer.changedAt ? ` · turned ${answer.on ? 'on' : 'off'} ${relative(answer.changedAt, now) || 'just now'}` : '';
  return answer.on ? `On${when}` : `Off${when} · every proposal waits for you`;
}

export function AutoMerge() {
  const { autoMerge: answer, set } = useAutoMerge();
  const banner = useBanner();
  const ask = useConfirm();
  const now = useNow(true);
  const [busy, setBusy] = useState(false);
  if (!answer) return null;

  const toggle = async () => {
    const on = !answer.on;
    if (on) {
      const sure = await ask({
        title: 'Turn on auto-merge?',
        message: `${AUTO_APPROVE_SETTING_WORDS} Each one is recorded as approved automatically, not by you. Only your own agents’ proposals — a teammate’s still wait for them.`,
        verb: 'Turn on',
      });
      if (!sure) return;
    }
    setBusy(true);
    try {
      await set(on);
      banner.show(on
        ? 'Auto-merge is on. Your agents’ proposals with passing checks now merge without asking.'
        : 'Auto-merge is off. Every proposal waits for you again.', true);
    } catch (error) {
      banner.show(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="homeAutoMerge" aria-labelledby="homeAutoMergeTitle">
      <h2 className="homehead" id="homeAutoMergeTitle">Auto-merge</h2>
      <div className="card">
        <button
          className="row open" id="homeAutoMergeSwitch" type="button" role="switch"
          aria-checked={answer.on} disabled={busy}
          onClick={() => { void toggle(); }}
        >
          <div className="main">
            <div className="name plain">Auto-merge</div>
            <div className="meta">{AUTO_APPROVE_SETTING_WORDS}</div>
            <div className="meta" id="homeAutoMergeState">{autoMergeMeta(answer, now)}</div>
          </div>
          <span className={`lbswitch${answer.on ? ' on' : ''}`} aria-hidden="true"><span /></span>
        </button>
      </div>
    </section>
  );
}
