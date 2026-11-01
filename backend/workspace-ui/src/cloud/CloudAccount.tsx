/**
 * The Fly account everything on the Cloud details screen is IN, and the one
 * way to swap it for another (note #372: "I should be able to replace my
 * cloud. In my cloud details screen, I should be able to replace with
 * different ones, so replace the fly token key").
 *
 * The screen already knew the answer and never said it. `api/org/spend`
 * carries `orgSlug` — every figure below is a reading of that one account —
 * so naming it costs no read at all, and it is the fact the rest of the
 * screen is meaningless without: a machine list with no account over it
 * cannot be replaced, because there is nothing on the glass to replace.
 *
 * WHY THE TOKEN BOX IS A SHEET rather than a card on the screen. The
 * workplace screen's form stands open because there is nothing connected
 * and pasting is the ONLY thing to do there. Here there is a working cloud
 * and a bill to read, and a permanently open box asking for a credential over
 * them invites the paste it should be waiting for. So the screen states the
 * account, and the form is one tap behind a button that says what it does.
 *
 * NO ROLE CHECK, deliberately: `api/org/spend` is admin-only, so anybody
 * looking at an answered version of this screen is already an admin. A second
 * check here would be a second place to get it wrong.
 */

import { useState } from 'react';
import type { WorkspaceOrgFlyAnswer } from '../../../src/shared/workspace-api.js';
import { Scrim } from '../ui/Ask.js';
import { TypeIcon } from '../ui/icons.js';
import { CloudConnectForm } from './CloudConnectForm.js';

/**
 * What a move would leave behind, counted off the screen itself.
 *
 * The rows below ARE the answer — they are what this platform has in that
 * account — so the sentence is written in the reader's own terms ("on this
 * screen") rather than claiming a total of the Fly account, which is a
 * different and larger number nobody here has read.
 */
function leftBehindWords(rows: number): string {
  if (rows <= 0) return 'Nothing of yours is running in it today, so nothing is left behind.';
  return rows === 1
    ? 'The one machine on this screen is what stays behind.'
    : `The ${rows} machines on this screen are what stays behind.`;
}

export function CloudAccount({ orgId, orgSlug, rows, onReplaced }: {
  orgId: string;
  /** The Fly organization every figure on this screen was read from. */
  orgSlug: string;
  /** Machine rows below — what a move would leave in the old account. */
  rows: number;
  onReplaced: (answer: WorkspaceOrgFlyAnswer) => void;
}) {
  const [replacing, setReplacing] = useState(false);
  return (
    <>
      <div className="card" id="orgCloudAccount">
        <div className="crow">
          <TypeIcon glyph="globe" />
          <div className="main">
            <div className="name plain">{orgSlug}</div>
            <div className="cline"><span className="ctext">Your team’s cloud · everything below runs here</span></div>
          </div>
        </div>
        <button
          className="addrow"
          id="orgCloudReplace"
          type="button"
          onClick={() => setReplacing(true)}
        >
          Replace this cloud
        </button>
      </div>
      {replacing
        ? (
          <Scrim onDismiss={() => setReplacing(false)}>
            <h3>Replace this cloud</h3>
            <CloudConnectForm
              idPrefix="replaceCloud"
              orgId={orgId}
              intro={
                /* The two things a replacement can be, said where it is about
                   to become one. Under the card instead, it is a paragraph of
                   token semantics standing over a bill nobody came here to
                   read — and it would push the machines down the screen by
                   its own height on every single visit, to be read once. */
                <p id="replaceCloudIntro">
                  A fresh token for <strong>{orgSlug}</strong> rotates the key and nothing moves.
                  A token for a different Fly account moves your cloud into it, leaving everything
                  already running behind — you are told which, and asked, before anything changes.
                  Tokens are made in your <a href="https://fly.io/dashboard" target="_blank" rel="noopener noreferrer">Fly
                  dashboard</a>, under the organization’s <strong>Tokens</strong> tab.
                </p>
              }
              continueLabel="Replace cloud"
              leavesBehind={leftBehindWords(rows)}
              onCancel={() => setReplacing(false)}
              onConnected={(answer) => { setReplacing(false); onReplaced(answer); }}
            />
          </Scrim>
        )
        : null}
    </>
  );
}
