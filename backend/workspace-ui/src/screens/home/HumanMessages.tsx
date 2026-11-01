import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { toFor } from '../../routes.js';
import { Icon, TypeIcon } from '../../ui/icons.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { useSession } from '../../session/useSession.js';
import { useMessagePoll } from '../messages/useMessagePoll.js';
import { MAIL_POLL_MS } from '../mail/MailScreen.js';
import type { WorkspaceMailUnreadAnswer } from '../../../../src/shared/workspace-mail.js';
function MessageDoor({ orgId }: { orgId: string }) {
  const { api } = useSession();
  const [unread, setUnread] = useState<number | null>(null);
  const read = useCallback(async (alive: () => boolean) => {
    try { const result = await api.api<{ unread: number }>('api/messages/unread', undefined, { org: orgId }); if (alive()) setUnread(result.unread); }
    catch { if (alive()) setUnread(null); }
  }, [api, orgId]);
  useMessagePoll(read, 5000);
  // The chevron is the Mail door's beside it (note #540): two rows in one
  // card, one saying it opens onto a screen and the other saying nothing,
  // read as the silent one being a fact rather than a way in. The dot takes
  // its place when something is waiting, exactly as it does on Mail — the
  // news is what the edge of the row is for, and it only has room for one.
  return <Link className="crow open" to={toFor({ kind: 'messages', orgId })!}><TypeIcon glyph="user" /><div className="main"><div className="name plain">Direct messages</div>
    <div className="cline">{unread ? `${unread} unread ${unread === 1 ? 'message' : 'messages'}` : 'Private conversations with your teammates'}</div></div>
    {unread
      ? <span className="unreaddot" role="img" aria-label="Unread messages" />
      : <Icon name="chev" size={18} />}
  </Link>;
}

/**
 * The way in to this person's own mail (note #509). It stands in the Messages
 * card rather than in a section of its own: both rows are one person writing
 * to another, and Home's section chain is what the stylesheet's spacing walks
 * — a new section there costs more than this row is worth.
 *
 * Only for an account that HAS an address. Somebody who signed up before
 * addresses existed takes one in Settings, and a door to an empty inbox they
 * cannot receive at would be the wrong invitation.
 */
function MailDoor({ address }: { address: string }) {
  const { api } = useSession();
  const [unread, setUnread] = useState(0);
  // A COUNT, never the mail itself: this runs every few seconds on Home, and
  // there is no reason for a door to have read anybody's letters. Slower than
  // the messages door beside it for the same reason the inbox polls slower —
  // mail is not a conversation happening in the same minute.
  const read = useCallback(async (alive: () => boolean) => {
    try {
      const answer = await api.api<WorkspaceMailUnreadAnswer>('api/mail/unread');
      if (alive()) setUnread(answer.unread);
    } catch { if (alive()) setUnread(0); }
  }, [api]);
  useMessagePoll(read, MAIL_POLL_MS);
  // The address is what this row says when there is nothing new; when there
  // is, the news displaces it, exactly as the messages door does with its own.
  return <Link className="crow open" to={toFor({ kind: 'mail' })!}><TypeIcon glyph="mail" /><div className="main"><div className="name plain">Mail</div>
    <div className="cline">{unread ? `${unread} new ${unread === 1 ? 'message' : 'messages'}` : address}</div></div>
    {unread
      ? <span className="unreaddot" role="img" aria-label={`${unread} new ${unread === 1 ? 'message' : 'messages'}`} />
      : <Icon name="chev" size={18} />}
  </Link>;
}

export function HumanMessages() {
  const { state } = useWorkspace();
  const address = state?.user?.account.mailbox?.address ?? '';
  const messages = Boolean(state?.messagesAvailable && state.org);
  if (!messages && !address) return null;
  return <><h2 className="homehead" id="humanMessagesHead">Messages</h2><div className="card" id="humanMessagesCard">
    {messages ? <MessageDoor key={state!.org!.orgId} orgId={state!.org!.orgId} /> : null}
    {address ? <MailDoor address={address} /> : null}
  </div></>;
}
