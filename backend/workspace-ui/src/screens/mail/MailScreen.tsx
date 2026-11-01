/**
 * A person's mail: what has arrived at their own address, and what they have
 * written to somebody who never wrote to them (note #509, slices 3 and 5).
 *
 * One row per message, newest first, and every row says the four things a
 * reader scans for — who it is from, what it is about, its first line, and
 * when it came. It is laid out the way a mail app lays those out, because
 * that is what a person arrives here expecting (note #529): the name with
 * the TIME against the right edge on the same line, then the subject and the
 * first line of the message under it. No chevron — an inbox row has never
 * needed one to say it opens, and the right edge belongs to the clock.
 *
 * And no face. The first draft put a disc with the sender's initial down the
 * left edge, which is what the mail apps do; the owner's answer was plain —
 * "I don't want avatars" — so the words are the whole row, and the column
 * they start in is the card's own margin.
 *
 * Two marks beyond that, and both are honest rather than decorative: a count
 * when files came with it, and a word when nothing vouched for the sender.
 *
 * It REFRESHES while it is open (every `MAIL_POLL_MS`), so a message that
 * arrives while somebody is reading their inbox appears in it. Before that it
 * read once per visit, and mail that landed a second later sat invisible until
 * the reader happened to leave the screen and come back.
 *
 * A message nobody has opened yet is drawn HEAVIER — its name and subject in
 * the reading colour, the rest of the list a step back from it — which is the
 * one thing every mail app agrees on and the thing a person opens an inbox to
 * find. The state is the server's: opening a message is what marks it read,
 * so it is the same answer on a phone and on a laptop.
 *
 * It is NOT given a surface of its own. The first draft stood the unread row
 * on the page's own paper inside the grey card, the way a white row stands in
 * Gmail's grey list — and this app's page is already very nearly white, so
 * the two read as one wash rather than as a difference (the owner, note #529:
 * "the background becomes white. It looks bad because our background is also
 * white"). Weight and colour carry it, as they did before.
 *
 * It is an ACCOUNT screen. An inbox belongs to the person reading it, not to
 * a workplace or a room, so its address carries neither and every read here
 * is keyed on the signed-in person by the server.
 *
 * THE SAME SCREEN IS THE ARCHIVE AND TRASH (slice 7), each at its own address
 * — `mail/archive`, `mail/trash` — and reached from a card at the foot of the
 * inbox, the way the notes' archive is. A letter put in either is still
 * whole; Trash is a place, not a countdown, and nothing on any of these
 * screens removes a message for good.
 *
 * And each can be SEARCHED, from a field at the head of the list under the
 * way to write one. The words live in this entry's address (`?q=`, written in
 * place as the reader types) rather than in the screen's memory, so Back from
 * a result lands on the results — which is the whole of how a person works
 * through what a search found. From the inbox a search looks through the
 * archive too: a letter somebody archived is a letter they may be looking for.
 *
 * A ROW IS A CONVERSATION (slice 8), not a letter: every message that answers
 * another is one row — the reader's own replies among them — named by who it
 * is with, called by its first subject, and showing its NEWEST message's
 * first line and clock, with how many are in it when that is more than one.
 * It is new while any letter in it is. The row keeps note #529's shape to the
 * pixel: the count stands on the name's line, where the name gives way before
 * it does. A search still finds LETTERS — the one that says the words — and
 * opens its conversation at it.
 *
 * AND SENT (slice 9), the fourth list and the one that is not a place: every
 * message that has gone out of this address, the replies among them, ONE ROW
 * PER LETTER. A conversation answers "what is this about"; Sent answers the
 * other question a person has — "what did I say, and when" — which no list
 * of conversations can. Every row says who it went to and when, and which of
 * them an agent wrote; none of them can be new, because the reader wrote
 * them. A tap opens the conversation it is part of, standing at it.
 *
 * AND STARRED (note #666), a list of letters like Sent: every one its reader
 * starred, wherever it is kept — Trash and Spam apart — newest first. The
 * star itself sits against the right edge of every row it can be put on,
 * under the clock, and OUTSIDE the row's link: tapping it stars the letter
 * (or, on a conversation's row, its newest letter) and opens nothing. The
 * left column the words start in still carries no mark.
 *
 * EVERY LIST PAGES (note #666). The server has always answered a page at a
 * time; the screen used to show the first and stop, so the fifty-first
 * conversation simply was not there. Now the foot of a list that has more
 * carries the way to the next page, and the refresh that keeps an open
 * inbox current re-reads the first page without dropping the pages the
 * reader already asked for.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type {
  WorkspaceMailConversationSummary, WorkspaceMailConversationsAnswer,
  WorkspaceMailMessageSummary, WorkspaceMailMessagesAnswer, WorkspaceMailStarAnswer, WorkspaceMailView,
} from '../../../../src/shared/workspace-mail.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { hasEntryBeneath } from '../../chrome/history.js';
import { toFor } from '../../routes.js';
import { useSession } from '../../session/useSession.js';
import { Icon } from '../../ui/icons.js';
import { SkelText } from '../../ui/Skel.js';
import { absolute } from '../../ui/format.js';
import { readOrSayWhy, worthAskingAgain } from '../../ui/read.js';
import { useNow } from '../../ui/time.js';
import { useWait } from '../../ui/wait.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { useMessagePoll } from '../messages/useMessagePoll.js';
import { VoiceField } from '../../voice/VoiceField.js';
import { MAIL_SEARCH_PARAM, mailAddressWith, mailConversationsPath, mailListPath } from './mail-address.js';
import {
  heldMailLetters, heldMailPlace, holdMailLetters, holdMailPlace, mailPageKept, mailStarChanged, type MailListKey,
} from './mail-cache.js';
import { MailComposeScreen } from './MailComposeScreen.js';
import { MailNotSetUp, mailIsOff } from './MailNotSetUp.js';
import { MailStar } from './MailStar.js';
import {
  MAIL_PLACE_EMPTY, MAIL_PLACE_TITLE, MAIL_SEARCH_PLACEHOLDER, mailCanStar, mailConversationLine, mailConversationName, mailPlaceMark,
  mailRowName, mailSearchLine, mailWhen, type MailPlaceName,
} from './mail-words.js';

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What the list is showing: a place's conversations, or LETTERS — a search's,
 *  or Sent's — held with the key of the list it answers. */
type MailShown =
  | { key: string; kind: 'place'; answer: WorkspaceMailConversationsAnswer }
  | { key: string; kind: 'letters'; answer: WorkspaceMailMessagesAnswer };

/** How often an open inbox asks whether anything has arrived. */
export const MAIL_POLL_MS = 15_000;
/** How long the typing has to pause before the words are asked about — the
 *  notes' search waits exactly as long. */
export const MAIL_SEARCH_DEBOUNCE_MS = 250;

/**
 * What a row says beyond the four ordinary things — and only when there is
 * something to say. A mark on every row is a mark nobody reads.
 */
function MailMarks({ message, place }: { message: WorkspaceMailMessageSummary; place: MailPlaceName }) {
  const marks = [
    // First, because it changes who the reader thinks wrote the row.
    message.sentBy ? `sent by ${message.sentBy}` : '',
    message.files ? `${message.files} ${message.files === 1 ? 'file' : 'files'}` : '',
    message.unreadable ? 'could not be read' : '',
    // Spam's own row already says this, as the reason it is there.
    message.suspicious && message.spamWhy !== 'suspicious' ? 'unverified sender' : '',
    // Where it is kept, in a list that does not already say — a search from
    // the inbox finds archived letters too — and which agent put it there.
    mailPlaceMark(message, place),
    // A star an agent put there (note #666): the owner should be able to see
    // which of the stars on their list are not their own.
    message.starred && message.starredBy ? `starred by ${message.starredBy}` : '',
  ].filter(Boolean);
  return marks.length ? <div className="cline mailmarks">{marks.join(' · ')}</div> : null;
}

/** What a conversation's row says beyond the ordinary things — only when
 *  there is something to say, exactly as a letter's row does. */
function MailConversationMarks({ row, place }: { row: WorkspaceMailConversationSummary; place: MailPlaceName }) {
  const marks = [
    // First, because it changes who the reader thinks wrote the line above.
    row.latest.sentBy ? `sent by ${row.latest.sentBy}` : '',
    row.files ? `${row.files} ${row.files === 1 ? 'file' : 'files'}` : '',
    row.unreadable ? 'could not be read' : '',
    row.suspicious && row.spamWhy !== 'suspicious' ? 'unverified sender' : '',
    mailPlaceMark(row, place),
    row.trashed ? `${row.trashed} in Trash` : '',
  ].filter(Boolean);
  return marks.length ? <div className="cline mailmarks">{marks.join(' · ')}</div> : null;
}

/**
 * One conversation, as a row of the inbox, the archive or Trash (slice 8) —
 * note #529's row, whole: who it is with and its newest clock on the first
 * line, then its subject, then its newest first line. The count rides the
 * name's line, after the names and before the clock, and never gives way.
 * A tap opens it at its first new letter, else at its newest.
 */
export function MailConversationRow({ row, place, now, star }: {
  row: WorkspaceMailConversationSummary;
  place: MailPlaceName;
  now: number;
  /** The row's star, when one can be put on it here (note #666). */
  star?: { busy: boolean; onPress: () => void };
}) {
  const line = mailConversationLine(row);
  return <div className={`mailrow${star ? ' starrable' : ''}`}><Link
    className={`crow open${row.unread ? ' mailnew' : ''}`}
    to={toFor({ kind: 'mailMessage', id: row.opens })!}
  >
    <div className="main">
      <div className="mailtop">
        <div className="name plain">
          {row.unread ? <span className="sr-only">New. </span> : null}
          <span className="mailnames">{mailConversationName(row)}</span>
          {row.count > 1 ? <span className="mailcount" aria-label={`${row.count} messages`}>{row.count}</span> : null}
        </div>
        <time className="cwhen mailwhen" dateTime={row.latest.receivedAt} title={absolute(row.latest.receivedAt) || undefined}>
          {mailWhen(row.latest.receivedAt, now)}
        </time>
      </div>
      <div className="cline mailsubject">
        <span className="ctext">{row.subject || '(no subject)'}</span>
      </div>
      {line ? <div className="cline"><span className="ctext">{line}</span></div> : null}
      <MailConversationMarks row={row} place={place} />
    </div>
  </Link>
  {star ? <MailStar id={`mailStar-${row.id}`} starred={Boolean(row.starred)} busy={star.busy} what="conversation" onPress={star.onPress} /> : null}
  </div>;
}

/** One message, as a row of a search — the letter that says the words — or of
 *  Sent, where every row is a letter this person sent. It opens its
 *  conversation, standing at this letter. */
function MailRow({ message, place, now, star }: {
  message: WorkspaceMailMessageSummary;
  place: MailPlaceName;
  now: number;
  star?: { busy: boolean; onPress: () => void };
}) {
  return <div className={`mailrow${star ? ' starrable' : ''}`}><Link
    className={`crow open${message.unread ? ' mailnew' : ''}`}
    to={toFor({ kind: 'mailMessage', id: message.id })!}
  >
    <div className="main">
      <div className="mailtop">
        <div className="name plain">
          {message.unread ? <span className="sr-only">New. </span> : null}
          {mailRowName(message)}
        </div>
        <time className="cwhen mailwhen" dateTime={message.receivedAt} title={absolute(message.receivedAt) || undefined}>
          {mailWhen(message.receivedAt, now)}
        </time>
      </div>
      <div className="cline mailsubject">
        <span className="ctext">{message.subject || '(no subject)'}</span>
      </div>
      {message.snippet ? <div className="cline"><span className="ctext">{message.snippet}</span></div> : null}
      <MailMarks message={message} place={place} />
    </div>
  </Link>
  {star ? <MailStar id={`mailStar-${message.id}`} starred={Boolean(message.starred)} busy={star.busy} onPress={star.onPress} /> : null}
  </div>;
}

/**
 * The search field: the same row the notes are searched from, at the head of
 * the list. From the inbox it says `Search mail` because it looks through the
 * archive too; elsewhere it names the one list it looks through — Trash, the
 * archive, or Sent, where the words of a reply are searched and a letter is
 * found by who it went TO.
 */
function MailSearchField({ place, value, onType }: { place: MailPlaceName; value: string; onType: (value: string) => void }) {
  return <div id="mailSearch" role="search">
    <div className="filter">
      <Icon name="search" size={16} />
      <VoiceField onTranscript={(said) => onType(said)}>
        <input
          type="search"
          id="mailSearchField"
          placeholder={MAIL_SEARCH_PLACEHOLDER[place]}
          aria-label={MAIL_SEARCH_PLACEHOLDER[place]}
          value={value}
          onChange={(event) => onType(event.target.value)}
        />
      </VoiceField>
    </div>
  </div>;
}

/** The other lists of this mailbox, from the foot of the inbox — what the
 *  reader starred, what has gone out, and the three places a letter can be
 *  put away in, Spam among them since slice 13 — in a card of their own, so
 *  none of them reads as one more message. Starred heads it (note #666): a
 *  star is a letter somebody marked to come back to, and this is where they
 *  come back to it. Sent follows, the other one a person comes looking for. */
function MailPlacesCard() {
  return <div className="card" id="mailPlaces">
    <Link className="crow open" id="mailStarredDoor" to={toFor({ kind: 'mailStarred' })!}>
      <div className="main">
        <div className="name plain">Starred</div>
        <div className="cline"><span className="ctext">Messages you starred to come back to</span></div>
      </div>
      <Icon name="chev" size={17} className="icon chev" />
    </Link>
    <Link className="crow open" id="mailSentDoor" to={toFor({ kind: 'mailSent' })!}>
      <div className="main">
        <div className="name plain">Sent</div>
        <div className="cline"><span className="ctext">Everything that has gone out of this address</span></div>
      </div>
      <Icon name="chev" size={17} className="icon chev" />
    </Link>
    <Link className="crow open" id="mailArchiveDoor" to={toFor({ kind: 'mailArchive' })!}>
      <div className="main">
        <div className="name plain">Archive</div>
        <div className="cline"><span className="ctext">Out of the inbox, kept whole</span></div>
      </div>
      <Icon name="chev" size={17} className="icon chev" />
    </Link>
    <Link className="crow open" id="mailSpamDoor" to={toFor({ kind: 'mailSpam' })!}>
      <div className="main">
        <div className="name plain">Spam</div>
        <div className="cline"><span className="ctext">Letters nothing vouched for, and from senders you blocked</span></div>
      </div>
      <Icon name="chev" size={17} className="icon chev" />
    </Link>
    <Link className="crow open" id="mailTrashDoor" to={toFor({ kind: 'mailTrash' })!}>
      <div className="main">
        <div className="name plain">Trash</div>
        <div className="cline"><span className="ctext">Nothing here is deleted for good</span></div>
      </div>
      <Icon name="chev" size={17} className="icon chev" />
    </Link>
  </div>;
}

/** Three rows of the shape the answer will land in. */
function MailWait() {
  return <div className="card" id="mailWait">
    {[0, 1, 2].map((row) => <div className="crow" key={row}>
      <div className="main">
        <div className="name plain"><SkelText width="38%" delay={`${(row * 0.09).toFixed(2)}s`} /></div>
        <div className="cline"><SkelText width="72%" height={9} delay={`${(row * 0.09 + 0.05).toFixed(2)}s`} /></div>
      </div>
    </div>)}
  </div>;
}

/** The way to write one — the same row a note is written from, because it is
 *  the same act. It stands at the HEAD of the list (note #529): the thing a
 *  person comes to an inbox to do, other than read, is write one, and under a
 *  hundred messages that door is a scroll away from anybody who wants it. */
function WriteMailRow({ id, top, onPress }: { id: string; top?: boolean; onPress: () => void }) {
  return <button className={top ? 'addrow cardtop' : 'addrow'} id={id} type="button" onClick={onPress}>Write email</button>;
}

export function MailScreen({ place = 'inbox' }: { place?: MailPlaceName }) {
  const { api } = useSession();
  const { state } = useWorkspace();
  // Arriving WITH somebody to write to — a person's own screen (note #626)
  // — opens on the composer, their address already in it. Closing it then
  // spends that entry, back to the screen it was opened from; sending lands
  // here, on the list with the message at its top.
  const location = useLocation();
  const navigate = useNavigate();
  const arrivedToWrite = (location.state as { writeTo?: unknown } | null)?.writeTo;
  const writeTo = place === 'inbox' && typeof arrivedToWrite === 'string' ? arrivedToWrite : '';
  const [writing, setWriting] = useState(Boolean(writeTo));
  const sent = useRef(false);
  const now = useNow(true);

  // The search this list is standing in for: the address's words, and the
  // field's while they are being typed. From the inbox a search looks
  // through everything but Trash.
  const [params, setParams] = useSearchParams();
  const searched = (params.get(MAIL_SEARCH_PARAM) ?? '').trim();
  const [typed, setTyped] = useState(() => params.get(MAIL_SEARCH_PARAM) ?? '');
  const view: WorkspaceMailView = searched && place === 'inbox' ? 'all' : place;
  // Sent is a list of LETTERS, searched or not: it is the one list a reply is
  // a row of, and one row per letter is what "what did I say" is asking for.
  // So is Starred (note #666): a star is on a letter, not a conversation.
  const letters = place === 'sent' || place === 'starred' || Boolean(searched);
  const list = useMemo<MailListKey>(() => ({ view, ...(searched ? { search: searched } : {}) }), [view, searched]);
  const listKey = `${view}\n${searched}`;
  const typing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(typing.current), []);
  const type = useCallback((value: string) => {
    setTyped(value);
    clearTimeout(typing.current);
    // In place, never a push: Back from the list still leaves the SCREEN,
    // rather than walking back through every word typed on it.
    const write = () => setParams((current) => mailAddressWith(current, value.trim()), { replace: true, state: location.state });
    // Emptying the field is answered at once — the reader who cleared it is
    // looking for their list, and there is nothing to wait for.
    if (!value.trim()) write();
    else typing.current = setTimeout(write, MAIL_SEARCH_DEBOUNCE_MS);
  }, [location.state, setParams]);

  // Seeded from what this tab last read, so coming back opens on the list
  // the reader left rather than on a skeleton over it. Held WITH the list it
  // answers, so an answer for the last words is never taken for the next.
  const held = useCallback((): MailShown | null => {
    if (letters) {
      const found = heldMailLetters(list);
      return found ? { key: listKey, kind: 'letters', answer: found } : null;
    }
    const kept = heldMailPlace(place);
    return kept ? { key: listKey, kind: 'place', answer: kept } : null;
  }, [letters, list, listKey, place]);
  const [shown, setShown] = useState<MailShown | null>(held);
  const [failed, setFailed] = useState<{ key: string; said: string; retry: boolean } | null>(null);

  const read = useCallback(async (alive: () => boolean = () => true) => {
    const kept = held();
    if (kept) setShown((current) => (current?.key === listKey ? current : kept));
    try {
      // The FIRST page, always — and the older pages the reader has already
      // opened are kept under it rather than dropped (note #666).
      if (letters) {
        const fresh = await readOrSayWhy<WorkspaceMailMessagesAnswer>((init) => api.api(mailListPath(list), init));
        if (!alive()) return;
        const before = heldMailLetters(list);
        const page = mailPageKept(
          { rows: fresh.messages, ...(fresh.nextBefore ? { nextBefore: fresh.nextBefore } : {}) },
          before ? { rows: before.messages, ...(before.nextBefore ? { nextBefore: before.nextBefore } : {}) } : null,
        );
        const answer: WorkspaceMailMessagesAnswer = {
          ...(fresh.address ? { address: fresh.address } : {}),
          messages: page.rows,
          ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
        };
        setShown({ key: listKey, kind: 'letters', answer });
        holdMailLetters(answer, list);
      } else {
        const fresh = await readOrSayWhy<WorkspaceMailConversationsAnswer>((init) => api.api(mailConversationsPath(place), init));
        if (!alive()) return;
        const before = heldMailPlace(place);
        const page = mailPageKept(
          { rows: fresh.conversations, ...(fresh.nextBefore ? { nextBefore: fresh.nextBefore } : {}) },
          before ? { rows: before.conversations, ...(before.nextBefore ? { nextBefore: before.nextBefore } : {}) } : null,
        );
        const answer: WorkspaceMailConversationsAnswer = {
          ...(fresh.address ? { address: fresh.address } : {}),
          conversations: page.rows,
          ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
        };
        setShown({ key: listKey, kind: 'place', answer });
        holdMailPlace(answer, place);
      }
      setFailed(null);
    } catch (failure) {
      // A refresh that failed for a reason another attempt could fix leaves
      // the inbox standing; a refusal takes it away and says why. On a POLL
      // this is the ordinary case — a phone that lost the network for four
      // seconds — and the inbox must not flicker into an error for it.
      if (!alive() || (kept && worthAskingAgain(failure))) return;
      setFailed({ key: listKey, said: errorMessage(failure), retry: worthAskingAgain(failure) });
    }
  }, [api, held, letters, list, listKey, place]);

  /**
   * Mail that arrives while the reader is looking at the list now appears
   * there, rather than waiting for them to leave the screen and come back.
   *
   * Slower than the poll behind direct messages (3s), on purpose: a chat is
   * two people in the same minute, and mail is not — a letter that shows up
   * fifteen seconds after it landed is still, to its reader, instant.
   *
   * It stops while the composer is open. Somebody writing a message cannot
   * see the list underneath it, and a read whose answer nobody can look at is
   * a request nobody needed. And it starts again at once for new search
   * words: the poll is keyed on the list it reads.
   */
  const poll = useCallback(async (alive: () => boolean) => {
    if (writing) return;
    await read(alive);
  }, [read, writing]);
  useMessagePoll(poll, MAIL_POLL_MS);

  /**
   * THE NEXT PAGE (note #666): what comes after the last row on the screen,
   * by the cursor the server answered the last page with, added under it.
   * A row the reader already has is not drawn twice — mail that arrived
   * while they were reading pushes the pages down by exactly that much.
   */
  const [paging, setPaging] = useState<{ key: string; failed?: string } | null>(null);
  const loadOlder = useCallback(async () => {
    const standing = shown;
    const cursor = standing?.key === listKey ? standing.answer.nextBefore : undefined;
    if (!standing || !cursor || (paging?.key === listKey && !paging.failed)) return;
    setPaging({ key: listKey });
    try {
      if (standing.kind === 'letters') {
        const next = await api.api<WorkspaceMailMessagesAnswer>(mailListPath(list, cursor));
        const have = new Set(standing.answer.messages.map((message) => message.id));
        const answer: WorkspaceMailMessagesAnswer = {
          ...standing.answer,
          messages: [...standing.answer.messages, ...next.messages.filter((message) => !have.has(message.id))],
        };
        if (next.nextBefore) answer.nextBefore = next.nextBefore; else delete answer.nextBefore;
        holdMailLetters(answer, list);
        setShown({ key: listKey, kind: 'letters', answer });
      } else {
        const next = await api.api<WorkspaceMailConversationsAnswer>(mailConversationsPath(place, cursor));
        const have = new Set(standing.answer.conversations.map((row) => row.id));
        const answer: WorkspaceMailConversationsAnswer = {
          ...standing.answer,
          conversations: [...standing.answer.conversations, ...next.conversations.filter((row) => !have.has(row.id))],
        };
        if (next.nextBefore) answer.nextBefore = next.nextBefore; else delete answer.nextBefore;
        holdMailPlace(answer, place);
        setShown({ key: listKey, kind: 'place', answer });
      }
      setPaging(null);
    } catch (failure) {
      setPaging({ key: listKey, failed: errorMessage(failure) });
    }
  }, [api, list, listKey, paging, place, shown]);

  /**
   * A STAR, on or off (note #666). The answer is the conversation as it now
   * stands and every letter in it; the lists this tab holds are made to
   * agree with it — Starred loses a letter that lost its star — and this
   * list is redrawn from them, so the fill on the screen is the server's.
   */
  const [starring, setStarring] = useState<ReadonlySet<string>>(() => new Set());
  const [starFailed, setStarFailed] = useState('');
  const star = useCallback(async (target: { id: string; starred: boolean; whole: boolean }) => {
    if (starring.has(target.id)) return;
    setStarring((current) => new Set(current).add(target.id));
    setStarFailed('');
    try {
      const answer = await api.api<WorkspaceMailStarAnswer>(
        `api/mail/${target.whole ? 'conversations' : 'messages'}/${encodeURIComponent(target.id)}/${target.starred ? 'unstar' : 'star'}`,
        { method: 'POST' },
      );
      mailStarChanged(answer);
      const kept = held();
      if (kept) setShown(kept);
    } catch (failure) {
      setStarFailed(errorMessage(failure));
    } finally {
      setStarring((current) => {
        const next = new Set(current);
        next.delete(target.id);
        return next;
      });
    }
  }, [api, held, starring]);

  const failure = failed?.key === listKey ? failed : null;
  const answer = shown?.answer ?? null;
  // The rows on the screen answer THESE words — not the last ones, still
  // drawn while the new answer is on its way.
  const current = shown?.key === listKey;
  const wait = useWait(!answer && !failure);
  const address = answer?.address ?? state?.user?.account.mailbox?.address ?? '';
  const messages = shown?.kind === 'letters' ? shown.answer.messages : [];
  const conversations = shown?.kind === 'place' ? shown.answer.conversations : [];
  const rows = shown?.kind === 'letters' ? messages.length : conversations.length;

  /** What was just sent, at the top of the list this tab is holding, so the
   *  reader sees it the moment they land back here rather than after a read.
   *  It starts a conversation of its own, keyed as the server keys it: by
   *  the message that started it. */
  const keepSent = useCallback((message: WorkspaceMailMessageSummary) => {
    const row: WorkspaceMailConversationSummary = {
      id: message.id,
      with: message.to ?? [],
      started: true,
      subject: message.subject,
      latest: {
        id: message.id, snippet: message.snippet, receivedAt: message.receivedAt, direction: 'sent',
        ...(message.sentBy ? { sentBy: message.sentBy } : {}),
      },
      count: 1,
      opens: message.id,
      files: 0,
    };
    const kept = heldMailPlace('inbox');
    const next = kept ? { ...kept, conversations: [row, ...kept.conversations] } : { address, conversations: [row] };
    holdMailPlace(next, 'inbox');
    if (!searched) setShown({ key: listKey, kind: 'place', answer: next });
    // And in Sent, if this tab is holding it: it is the list of what has gone
    // out, and the message that just went is the newest thing in it.
    const sent = heldMailLetters({ view: 'sent' });
    if (sent) holdMailLetters({ ...sent, messages: [message, ...sent.messages] }, { view: 'sent' });
    void read();
  }, [address, listKey, read, searched]);

  if (writing) {
    const close = () => {
      if (writeTo && !sent.current && hasEntryBeneath(location)) { navigate(-1); return; }
      // The list, and never the composer again on a reload of this entry.
      if (writeTo) navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
      setWriting(false);
    };
    return <MailComposeScreen
      address={address}
      to={writeTo}
      onClose={close}
      onSent={(message) => { sent.current = true; keepSent(message); }}
    />;
  }

  const screenId = place === 'inbox' ? 'screenMail'
    : place === 'archive' ? 'screenMailArchive'
      : place === 'spam' ? 'screenMailSpam'
        : place === 'sent' ? 'screenMailSent'
          : place === 'starred' ? 'screenMailStarred' : 'screenMailTrash';
  // Where a star can be put from this list: never from Trash or Spam, and on
  // a letter only while the letter itself is not in either.
  const listStars = mailCanStar(place);
  const more = current && answer?.nextBefore ? answer.nextBefore : '';
  const pagingHere = paging?.key === listKey ? paging : null;
  // The inbox with nothing in it says so in its own card, with the way to
  // write one — but only while nothing is being searched for: a search that
  // finds nothing says THAT, in the list's own words.
  const emptyInbox = place === 'inbox' && answer && !rows && !searched && !typed.trim();
  // A private copy installs without email (note #946): until an admin sets
  // it up, the inbox says so above itself and offers no way to write out.
  const mailSetup = state?.mailSetup;
  const mailOff = mailIsOff(mailSetup);

  return <div className="screen" id={screenId}>
    <ScreenTitle title={MAIL_PLACE_TITLE[place]} sub={address || 'Your address'} />
    {failure ? <div className="card"><div className="empty" role="alert">
      {failure.said}
      {failure.retry ? <><br /><button className="btn" type="button" onClick={() => { setFailed(null); void read(); }}>Try again</button></> : null}
    </div></div> : null}
    {!failure && wait === 'drawn' && !answer ? <MailWait /> : null}
    {starFailed ? <div className="hintblock mailwarn" role="alert" id="mailStarFailed">{starFailed}</div> : null}
    {mailOff && place === 'inbox' ? <MailNotSetUp setup={mailSetup} domain={address.split('@')[1] ?? ''} /> : null}
    {answer && !(emptyInbox) ? <div className="card" id="mailList">
      {place === 'inbox' && !mailOff ? <WriteMailRow id="mailWrite" top onPress={() => setWriting(true)} /> : null}
      <MailSearchField place={place} value={typed} onType={type} />
      {searched ? <div className="empty mailfound" id="mailFound" aria-live="polite">
        {current ? mailSearchLine(messages.length, searched, place, Boolean(answer.nextBefore)) : 'Searching…'}
      </div> : null}
      {messages.map((message) => <MailRow key={message.id} message={message} place={place} now={now}
        {...(listStars && mailCanStar(message.place) ? {
          star: {
            busy: starring.has(message.id),
            onPress: () => { void star({ id: message.id, starred: Boolean(message.starred), whole: false }); },
          },
        } : {})} />)}
      {conversations.map((row) => <MailConversationRow key={row.id} row={row} place={place} now={now}
        {...(listStars ? {
          star: {
            busy: starring.has(row.id),
            onPress: () => { void star({ id: row.id, starred: Boolean(row.starred), whole: true }); },
          },
        } : {})} />)}
      {!rows && !searched && place !== 'inbox'
        ? <div className="empty" id="mailPlaceEmpty">{MAIL_PLACE_EMPTY[place]}</div>
        : null}
      {more ? <button className="addrow" id="mailOlder" type="button" disabled={Boolean(pagingHere && !pagingHere.failed)}
        onClick={() => { void loadOlder(); }}>
        {pagingHere && !pagingHere.failed ? 'Loading…' : letters ? 'Show older messages' : 'Show older conversations'}
      </button> : null}
      {pagingHere?.failed ? <div className="hintblock" role="alert" id="mailOlderFailed">{pagingHere.failed}</div> : null}
    </div> : null}
    {emptyInbox && !mailOff ? <div className="card">
      <div className="empty">
        {address ? <>Nothing has arrived yet. Mail sent to <strong>{address}</strong> lands here.</> : 'Choose your address in Settings, and mail sent to it lands here.'}
      </div>
      {address ? <WriteMailRow id="mailWriteEmpty" onPress={() => setWriting(true)} /> : null}
    </div> : null}
    {place === 'inbox' && (answer || failure) ? <MailPlacesCard /> : null}
  </div>;
}
