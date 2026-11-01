/**
 * The emails a workplace's deletion sends (owner, 2026-09-22): when an admin
 * asks for it, when an admin keeps the workplace after all, and when the
 * three days are up and it is gone. Every member gets each one — the owner's answer
 * to "should the others be told?" was an email to each of them.
 *
 * A member is reached at up to two addresses, deduplicated: their own
 * address here (delivered straight into that inbox, never through the
 * internet and back), and the outside address a password reset would use —
 * because the one place a locked workplace cannot tell anyone anything is the
 * Workspace they can no longer open into it.
 *
 * The words are plain and the same for every member; only the admin's name
 * and the dates change. Dates are written in UTC with the zone said, since
 * an email is read wherever its reader happens to be.
 */

import type { WorkspaceNoticeEmail } from './workspace-verification-email.js';

export type WorkplaceDeletionNoticeKind = 'scheduled' | 'cancelled' | 'deleted';

export interface WorkplaceDeletionNoticeWords {
  subject: string;
  paragraphs: string[];
  action?: { label: string; url: string };
}

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const DATE_AND_TIME = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
});

/** "29 September" — the subject line's date. */
export function noticeDay(iso: string): string {
  return DAY.format(new Date(iso));
}

/** "29 September 2026 at 14:05 UTC" — the body's, exact enough to plan by. */
export function noticeMoment(iso: string): string {
  const parts = Object.fromEntries(DATE_AND_TIME.formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return `${parts.day} ${parts.month} ${parts.year} at ${parts.hour}:${parts.minute} UTC`;
}

export function workplaceDeletionNoticeWords(input: {
  kind: WorkplaceDeletionNoticeKind;
  workplace: string;
  /** Who asked (scheduled, deleted) or who kept it (cancelled). */
  actor: string;
  requestedAt: string;
  purgeAt: string;
  /** Where the Workspace opens, when this backend knows its own address. */
  workspaceUrl?: string;
  /** The Fly organization the workplace ran in, if it had one. */
  cloudSlug?: string;
}): WorkplaceDeletionNoticeWords {
  const { workplace, actor } = input;
  const unaffected = 'Your account, your email, your private Claude and ChatGPT sign-ins and your other workplaces are not affected.';
  const cloud = input.cloudSlug
    ? `Nothing in the workplace’s own Fly account (${input.cloudSlug}) is destroyed: its machines and storage stay there, and keep costing money until an admin of that Fly account removes them.`
    : '';
  if (input.kind === 'scheduled') {
    return {
      subject: `${workplace} will be deleted on ${noticeDay(input.purgeAt)}`,
      paragraphs: [
        `${actor} asked to delete the workplace ${workplace}.`,
        `It will be deleted for good on ${noticeMoment(input.purgeAt)}: its agents, notes, repositories, knowledge pages, Drive and sites go with it, and its site addresses become free for anyone to take.`,
        'Until then the workplace is locked. Its agents are stopped and nothing new can start there. Any admin of the workplace can still keep it: open it in the Workspace and choose Keep this workplace.',
        ...cloud ? [cloud] : [],
        unaffected,
      ],
      ...input.workspaceUrl ? { action: { label: 'Open the Workspace', url: input.workspaceUrl } } : {},
    };
  }
  if (input.kind === 'cancelled') {
    return {
      subject: `${workplace} will not be deleted`,
      paragraphs: [
        `${actor} kept the workplace ${workplace}, so it will not be deleted after all.`,
        'Everything in it is as it was. Its agents start again the next time somebody writes to them.',
      ],
      ...input.workspaceUrl ? { action: { label: 'Open the Workspace', url: input.workspaceUrl } } : {},
    };
  }
  return {
    subject: `${workplace} has been deleted`,
    paragraphs: [
      `The workplace ${workplace} has been deleted, as ${actor} asked on ${noticeDay(input.requestedAt)}. Its agents, notes, repositories, knowledge pages, Drive and sites are gone, and its site addresses are free.`,
      ...cloud ? [cloud] : [],
      unaffected,
    ],
  };
}

/** Where one member is reached: their address here, their outside one, or both. */
export interface WorkplaceDeletionRecipient {
  userId: string;
  name: string;
  /** Their own address on the mail domain, delivered straight into that inbox. */
  inbox?: string;
  /** The outside address a password reset would reach. */
  outside?: string;
}

export interface WorkplaceDeletionNoticeDeps {
  /** Straight into an inbox here — the ingest path, with a message we wrote. */
  deliverToInbox?: (args: { to: string; from: string; raw: Buffer }) => Promise<unknown>;
  /** Out through the platform's transactional sender. */
  sendOutside?: (message: WorkspaceNoticeEmail) => Promise<void>;
  /** The platform's own From line, e.g. `Agentic Cloud Computer <workspace@updates.…>`. */
  from: string;
  now?: () => Date;
  log?: (line: string) => void;
}

/** The From line's bare address. */
function addressOf(from: string): string {
  const match = /<([^>]+)>/.exec(from);
  return (match?.[1] ?? from).trim();
}

/**
 * RFC 5322 text for one notice, the shape the inbound parser reads. Only the
 * subject can carry a name that is not ASCII, so it alone is encoded.
 */
export function noticeMessage(input: {
  from: string;
  to: string;
  words: WorkplaceDeletionNoticeWords;
  date: Date;
  messageId: string;
}): Buffer {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(input.words.subject, 'utf8').toString('base64')}?=`;
  const body = [
    ...input.words.paragraphs,
    ...input.words.action ? [`${input.words.action.label}: ${input.words.action.url}`] : [],
  ].join('\r\n\r\n');
  const headers = [
    `From: ${input.from}`,
    `To: <${input.to}>`,
    `Subject: ${encodedSubject}`,
    `Date: ${input.date.toUTCString()}`,
    `Message-ID: <${input.messageId}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  const encodedBody = Buffer.from(`${body}\r\n`, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${encodedBody}`, 'utf8');
}

/**
 * Send one notice to every recipient, at every address they have. Never
 * throws: a notice that cannot go out must not undo or block the decision it
 * reports, so each failure is logged and the rest still go. Answers how many
 * addresses were reached, for the route's log line and the tests.
 */
export async function sendWorkplaceDeletionNotice(
  deps: WorkplaceDeletionNoticeDeps,
  recipients: readonly WorkplaceDeletionRecipient[],
  words: WorkplaceDeletionNoticeWords,
  /** Stable per decision, so a retried request never mails anybody twice. */
  idempotencyKey: string,
): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => new Date());
  const fromAddress = addressOf(deps.from);
  const domain = fromAddress.split('@')[1] ?? 'localhost';
  let reached = 0;
  for (const recipient of recipients) {
    const inbox = recipient.inbox?.toLowerCase();
    const outside = recipient.outside?.toLowerCase();
    if (inbox && deps.deliverToInbox) {
      try {
        await deps.deliverToInbox({
          to: inbox,
          from: fromAddress,
          raw: noticeMessage({
            from: deps.from,
            to: inbox,
            words,
            date: now(),
            // The key makes the id stable, so the inbox's own duplicate check
            // is what keeps a retried decision from delivering twice.
            messageId: `${idempotencyKey}.${recipient.userId}@${domain}`,
          }),
        });
        reached += 1;
      } catch (error) {
        log(`[workplace-deletion] inbox notice to ${recipient.userId} failed: ${(error as Error).message}`);
      }
    }
    if (outside && outside !== inbox && deps.sendOutside) {
      try {
        await deps.sendOutside({
          email: outside,
          subject: words.subject,
          paragraphs: words.paragraphs,
          ...words.action ? { action: words.action } : {},
          idempotencyKey: `${idempotencyKey}-${recipient.userId}`,
        });
        reached += 1;
      } catch (error) {
        log(`[workplace-deletion] outside notice to ${recipient.userId} failed: ${(error as Error).message}`);
      }
    }
  }
  return reached;
}
