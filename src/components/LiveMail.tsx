import { useState } from 'react';
import type { WorkspaceMailConversationsAnswer } from '../../backend/src/shared/workspace-mail';
import { MailConversationRow, MailScreen } from '../../backend/workspace-ui/src/screens/mail/MailScreen';
import { holdMailPlace } from '../../backend/workspace-ui/src/screens/mail/mail-cache';
import { LivePanel, LiveWorkspace } from './live/LiveWorkspace';
import { DAY, HOUR, MINUTE, ago, useHydrated } from './live/fixture';

/**
 * James's mail, live: the product's own inbox screen over three rows that
 * say the whole thing — a message that has just arrived and nobody has
 * opened, the answer Ruby wrote to an earlier one, marked "sent by Ruby" for
 * James alone, and a message that came with files.
 *
 * Two doors for one answer, on purpose. MailScreen seeds itself from the
 * tab's held list and then refreshes from `api/mail/conversations`: the held list
 * is what draws the rows on the first render (an effect never runs on the
 * build machine), and the answer is what the refresh on mount then reads.
 * Same rows through both, so the panel cannot flicker between two inboxes.
 *
 * The rows wait for `useHydrated()`, the way the phone's chat log and the
 * seat usage rows do, and for the same reason: an inbox row says WHEN its
 * message came as a CLOCK (note #529), and a clock is the one thing that
 * cannot be in the server's HTML. The build machine would write its own hour
 * in its own timezone and the visitor's browser would compute another, which
 * React reads as a hydration mismatch — a real page error, caught by
 * `scripts/verify-front-page-redirect.mts`. A relative age never showed it:
 * "14m ago" is the same string on both machines, which is exactly why this
 * panel could prerender its rows before.
 */
function inbox(): WorkspaceMailConversationsAnswer {
  return {
    address: 'james@agenticcloudcomputer.com',
    conversations: [
      {
        id: 'mail_dana',
        with: [{ name: 'Dana Whitfield', address: 'dana@harbourfreight.com' }],
        subject: 'Can the pilot start a week early?',
        latest: {
          id: 'mail_dana',
          snippet: 'Our peak-season planning starts on the 30th and we want Northstar’s routes for all forty vans by then.',
          receivedAt: ago(14 * MINUTE + 20_000),
        },
        count: 1,
        opens: 'mail_dana',
        files: 0,
        unread: true,
      },
      {
        id: 'mail_priya',
        with: [{ name: 'Priya Raman', address: 'priya@harbourfreight.com' }],
        started: true,
        subject: 'Your forty driver accounts are ready',
        latest: {
          id: 'mail_priya',
          snippet: 'Thanks for writing. Every driver is in, and the app link is in each invitation.',
          receivedAt: ago(3 * HOUR + 20 * MINUTE + 10_000),
          direction: 'sent',
          // The owner's list alone says this; the recipient read James's name.
          sentBy: 'Ruby',
        },
        count: 1,
        opens: 'mail_priya',
        files: 0,
      },
      {
        id: 'mail_harbour',
        with: [{ name: 'Harbour Freight', address: 'accounts@harbourfreight.com' }],
        subject: 'Signed pilot contract and the depot addresses',
        latest: {
          id: 'mail_harbour',
          snippet: 'Both attached. The depot list is the one from the new contract, not the 2024 set.',
          receivedAt: ago(DAY + 3 * HOUR + 50_000),
        },
        count: 1,
        opens: 'mail_harbour',
        files: 2,
      },
    ],
  };
}

export default function LiveMail({ className = '' }: { className?: string }) {
  const hydrated = useHydrated();
  const [answers] = useState<Record<string, unknown>>(() => {
    const answer = inbox();
    holdMailPlace(answer);
    return { 'api/mail/conversations': answer };
  });
  return (
    <LivePanel
      size="compact"
      className={className}
      says="James’s mail: an unopened message from Dana Whitfield asking to start the pilot early; a message to Priya Raman marked “sent by Ruby”; and a message from Harbour Freight carrying two files. Under them, the row that writes an email."
    >
      <LiveWorkspace answers={answers}>
        {hydrated ? <MailScreen /> : null}
      </LiveWorkspace>
    </LivePanel>
  );
}

/**
 * The same three rows as a card of their own, for the product page's Email
 * card (note #787): a panel shows one thing, and there the thing is the
 * inbox, not the screen's search, compose door and folders. The rows are
 * the screen's own (MailConversationRow), and wait for `useHydrated()` for
 * the clock, as the whole screen does.
 */
export function LiveInbox({ className = '' }: { className?: string }) {
  const hydrated = useHydrated();
  const [rows] = useState(() => inbox().conversations);
  const [now] = useState(() => Date.now());
  return (
    <LivePanel
      size="tile"
      className={className}
      says="James’s inbox: an unopened message from Dana Whitfield asking to start the pilot early; a message to Priya Raman marked “sent by Ruby”; and a message from Harbour Freight carrying two files."
    >
      <LiveWorkspace>
        <div className="card" id="mailInbox">
          {hydrated ? rows.map((row) => <MailConversationRow key={row.id} row={row} place="inbox" now={now} />) : null}
        </div>
      </LiveWorkspace>
    </LivePanel>
  );
}
