/**
 * The inbox, the archive, Spam and Trash (note #509, slices 7 and 13) — what
 * the two doors onto a person's mail, their own Workspace and their agent's
 * CLI, say about where a message is. One copy, so a refusal reads the same in
 * both.
 */

import {
  MAIL_VIEWS,
  type MailMessageDocument,
  type MailMoveOutcome,
  type MailPlace,
  type MailStarOutcome,
  type MailView,
} from './mail-message-storage.js';

export function mailPlaceOf(doc: Pick<MailMessageDocument, 'archivedAt' | 'spamAt' | 'trashedAt'>): MailPlace {
  return doc.trashedAt ? 'trash' : doc.spamAt ? 'spam' : doc.archivedAt ? 'archive' : 'inbox';
}

/**
 * The agent that put it where it is, when a person did not — named, not
 * hidden, for the reason `sentBy` is: a letter that left its owner's inbox
 * without them touching it is exactly what they should be able to see.
 */
export function mailMovedBy(doc: Pick<MailMessageDocument, 'archivedAt' | 'spamAt' | 'trashedAt' | 'archivedBy' | 'spamBy' | 'trashedBy'>): string | undefined {
  const by = doc.trashedAt ? doc.trashedBy : doc.spamAt ? doc.spamBy : doc.archivedAt ? doc.archivedBy : undefined;
  return by ? by.name ?? 'an agent' : undefined;
}

/**
 * `?in=` off a request: absent is absent, and anything else must be one of
 * the five. An unknown place is refused rather than read as the inbox —
 * somebody who asked for Trash and was shown their inbox would be told
 * something untrue about their own mail.
 */
export function readMailView(value: unknown): { view?: MailView } | { refused: string } {
  if (value === undefined || value === '') return {};
  const said = String(value);
  return (MAIL_VIEWS as readonly string[]).includes(said)
    ? { view: said as MailView }
    : { refused: `There is no "${said.slice(0, 40)}" in a mailbox. Ask for inbox, archive, spam, trash, sent, starred or all.` };
}

/**
 * `?in=` where only a PLACE will do — the conversation lists, since a
 * conversation is kept in exactly one place. `all`, `sent` (slice 9) and
 * `starred` (note #666) are views of LETTERS, and none is somewhere a
 * conversation can be, so all three are refused here in the words that say
 * which lists they belong to.
 */
export function readMailPlace(value: unknown): { place?: MailPlace } | { refused: string } {
  const read = readMailView(value);
  if ('refused' in read) return read;
  if (read.view === 'all' || read.view === 'sent' || read.view === 'starred') {
    return { refused: 'Conversations are listed by place: inbox, archive, spam or trash.' };
  }
  return read.view ? { place: read.view } : {};
}

/** Why a move was refused, as a status and a sentence — about one message,
 *  or about the conversation it is in (slice 8). */
export function mailMoveRefusal(
  outcome: Extract<MailMoveOutcome, { refused: string }>,
  what: 'message' | 'conversation' = 'message',
): { status: number; code: string; error: string } {
  switch (outcome.refused) {
    case 'is_reply':
      return { status: 409, code: 'is_reply', error: 'That is a reply, read in its conversation. Move the message it answers, or the whole conversation, and its replies go with it.' };
    case 'in_trash':
      return { status: 409, code: 'in_trash', error: `That ${what} is in Trash. Restore it first.` };
    case 'in_spam':
      return { status: 409, code: 'in_spam', error: `That ${what} is in Spam. Mark it Not spam first.` };
    default:
      return { status: 404, code: 'no_such_message', error: 'No such message.' };
  }
}

/** Why a star was refused (note #666): a letter in Trash or Spam could never
 *  be shown in Starred, so the way to star it starts with bringing it back. */
export function mailStarRefusal(
  outcome: Extract<MailStarOutcome, { refused: string }>,
): { status: number; code: string; error: string } {
  switch (outcome.refused) {
    case 'in_trash':
      return { status: 409, code: 'in_trash', error: 'That message is in Trash. Restore it first, then star it.' };
    case 'in_spam':
      return { status: 409, code: 'in_spam', error: 'That message is in Spam. Mark it Not spam first, then star it.' };
    default:
      return { status: 404, code: 'no_such_message', error: 'No such message.' };
  }
}

/** The agent that starred it, when a person did not. */
export function mailStarredBy(doc: Pick<MailMessageDocument, 'starredAt' | 'starredBy'>): string | undefined {
  return doc.starredAt && doc.starredBy ? doc.starredBy.name ?? 'an agent' : undefined;
}
