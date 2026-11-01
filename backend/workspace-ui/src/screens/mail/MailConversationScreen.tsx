/**
 * One conversation, read (note #509, slices 3 and 8).
 *
 * Until slice 8 this screen was ONE letter with the reader's own replies
 * under it — and when the other person answered one of those replies, the
 * answer arrived as a fresh row of the inbox with nothing to say it belonged
 * here. Now a message opens the CONVERSATION it is part of: every letter
 * that answers another in it, oldest at the top, each with who wrote it and
 * when, and the reader's own among them, marked as theirs. The address names
 * a MESSAGE — the one a search found, or the first new one — and the screen
 * opens standing at it.
 *
 * Everything on it came from someone we have never met, which decides its
 * rules, and they hold for every letter in the conversation:
 *
 * THE WORDS ARE SHOWN AS THE SENDER SHAPED THEM. A letter that carried a
 * formatted version is drawn from it, built through the SAME allowlist a
 * knowledge page goes through — node by node, never innerHTML, with script,
 * style and every event attribute refused by name.
 *
 * SO THERE IS ONE BODY, NOT TWO (note #534). The plain text is the body of a
 * letter that carried NO markup, and it catches a formatted one the
 * allowlist emptied, because an empty card is not a letter.
 *
 * NO PICTURE IS FETCHED UNTIL ITS READER ASKS (slice 10). A remote image in a
 * message is a read receipt, so nothing at somebody else's address is drawn
 * on open: the letter says one line about what was left out, and a button
 * that says what loading them costs. What travelled INSIDE the message is
 * different in kind — the bytes are ours already — so those are drawn in
 * place with no tap, and a picture one pixel across is refused either way.
 *
 * THE QUOTE AT THE BOTTOM IS FOLDED, NEVER REMOVED (slice 8). An answer
 * carries a copy of the letter it answers, and in a conversation that letter
 * is already on the screen just above it: a quote at the very end that
 * repeats one of them is one tap away instead of on the page twice.
 *
 * A LETTER CAN BE PASSED ON (slice 12): Forward sits under every letter, and
 * the forward stands in this conversation as a letter of the reader's own —
 * `Forwarded to …` — while the letter it forwarded says, under its words,
 * who it was forwarded to and when.
 *
 * AND IT IS PUT AWAY WHOLE (slices 7 and 8): Archive, Move to Trash and their
 * undos act on every letter of the conversation, from the buttons under the
 * title. Neither leaves the screen; the line saying where it now is comes
 * from the server's answer, and the undo stands where the button was.
 * Nothing here deletes a message for good; Trash is a place.
 *
 * EVERY LETTER CAN BE STARRED (note #666) — the reader's own among them —
 * from the star beside the moment on the line that says who wrote it — the
 * moment keeps the right-hand edge it has always had (note #545). A star moves nothing; the letter joins
 * Starred and stays where it is kept. None is offered in Trash or Spam,
 * where Starred could never show it.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import type { WorkspaceFileAccessAnswer } from '../../../../src/shared/workspace-api.js';
import type {
  WorkspaceMailBlockAnswer,
  WorkspaceMailBlockedSendersAnswer,
  WorkspaceMailConversation,
  WorkspaceMailConversationAnswer,
  WorkspaceMailConversationMoveAnswer,
  WorkspaceMailForwardAnswer,
  WorkspaceMailImageSendersAnswer,
  WorkspaceMailMove,
  WorkspaceMailParty,
  WorkspaceMailReply,
  WorkspaceMailReplyAnswer,
  WorkspaceMailStarAnswer,
  WorkspaceMailThreadMessage,
} from '../../../../src/shared/workspace-mail.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { placeScroll } from '../../chrome/place-scroll.js';
import { recallScroll } from '../../chrome/scroll-memory.js';
import { useBackClaim } from '../../chrome/useBack.js';
import { jsonBody } from '../../api/client.js';
import { SafeHtml, safeHtmlHasWords } from '../../render/SafeHtml.js';
import { useSession } from '../../session/useSession.js';
import { bytes, fileIcon } from '../../ui/file-kind.js';
import { Icon, TypeIcon } from '../../ui/icons.js';
import { SkelText } from '../../ui/Skel.js';
import { readOrSayWhy, worthAskingAgain } from '../../ui/read.js';
import { useWait } from '../../ui/wait.js';
import {
  forgetMailLists, heldMailConversation, holdMailConversation, mailConversationMoved, mailStandingAs, mailStarChanged, mailStarredAs,
  markMailConversationRead,
} from './mail-cache.js';
import { MailStar } from './MailStar.js';
import { mailWordsOf, splitQuotedHtml, splitQuotedText, type MailQuoteSplit } from './mail-quote.js';
import { mailImageDecider, mailInlinePictures, mailPictures } from './mail-pictures.js';
import { VoiceField } from '../../voice/VoiceField.js';
import { absolute } from '../../ui/format.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { mailOutFileRefusal } from '../../../../src/shared/workspace-mail.js';
import { MailCcField, MailFilesField } from './MailOutgoing.js';
import { mailCcAddresses, mailPost, type MailPick } from './mail-outgoing.js';
import {
  MAIL_LOAD_PICTURES, MAIL_NO_PICTURES, MAIL_REPLY_MAX, MAIL_UNREADABLE, mailAlwaysPictures, mailBlockSender, mailCanStar, mailEnvelope, mailLetterPlace,
  mailOwnLine, mailParty, mailPlaceLine, mailSender, mailStopPictures, mailSuspicion, mailTrashedLine, mailUnblockSender, reflowMailText,
  type MailPlaceName,
} from './mail-words.js';

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * When something in this conversation happened — every letter through THIS
 * function, arrived or sent, because a conversation is read in order and the
 * reader needs the stamps to be comparable more than they need any one of
 * them to be clever. Nothing is aged ("15h ago") against a dated neighbour.
 */
function when(iso: string): string {
  const at = new Date(iso);
  // The date a person would write, not a machine's: no seconds, and the month
  // in words so 9/14 and 14/9 cannot be read for each other.
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * The plain-text body, exactly as the sender wrote it — one text node under
 * `white-space: pre-wrap`, because mail is full of hand-made shapes (a
 * signature, an indent, a column of figures) that rewrapping would flatten.
 */
function MailText({ text, className = '' }: { text: string; className?: string }) {
  return <div className={`mailbody mailtext${className ? ` ${className}` : ''}`}>{reflowMailText(text)}</div>;
}

/**
 * The quote under an answer, folded (slice 8). A button a reader can see —
 * not a disclosure triangle — because the words behind it are the sender's,
 * and nothing about folding them may look like they are gone.
 */
function MailFold({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <div className="mailfold">
    <button className="btn ghost mailfoldtoggle" type="button" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
      {open ? 'Hide quoted text' : 'Show quoted text'}
    </button>
    {open ? children : null}
  </div>;
}

/** Only what was actually attached, under the letter it came with — one that
 *  arrived, or since slice 12 one the reader sent. A letter with nothing on
 *  it — which is most of them — gets no shelf at all. */
function MailFiles({ message, onOpen }: { message: WorkspaceMailThreadMessage; onOpen: (fileId: string) => void }) {
  if (!message.attachments.length) return null;
  return <>
    <h2 className="mailfileshead">Files</h2>
    <div className="card mailfiles">
      {message.attachments.map((file) => <button key={file.id} className="crow open" type="button" onClick={() => onOpen(file.id)}>
        <TypeIcon {...fileIcon(file.fileName)} />
        <div className="main">
          <div className="name plain">{file.fileName}</div>
          <div className="cline">{bytes(file.size)}{file.inline ? ' · shown inside the message' : ''}</div>
        </div>
        <Icon name="chev" size={18} />
      </button>)}
    </div>
  </>;
}

/**
 * Under a letter the reader passed on (slice 12): who it went to and when,
 * one quiet line per forward. Read off the forwards standing in this same
 * conversation — each carries the id of the letter it forwarded — so the
 * line and the letter it points at can never disagree.
 */
function MailForwarded({ forwards }: { forwards: WorkspaceMailThreadMessage[] }) {
  if (!forwards.length) return null;
  return <div className="mailforwarded">
    {forwards.map((one) => <div className="cline" key={one.id}>
      {`Forwarded to ${[...one.to, ...one.cc].map((party) => party.name?.trim() || party.address).join(', ')} on ${when(one.receivedAt)}`}
    </div>)}
  </div>;
}

/**
 * The doors at one letter's foot: to pass it on, and — on a letter that
 * ARRIVED — to block or unblock whoever sent it (slice 13). None from Trash:
 * a letter put there is one its reader is done with, and Restore is at the
 * top. Blocking is offered here, on a letter that sender wrote, exactly where
 * the picture allowlist is: a decision about a sender is made looking at
 * something they sent, and the way back is on every letter of theirs.
 */
function MailLetterDoors({ message, place, onForward, onBlock }: {
  message: WorkspaceMailThreadMessage;
  place: MailPlaceName;
  onForward?: (messageId: string) => void;
  onBlock?: (address: string, block: boolean) => void;
}) {
  if (place === 'trash' || message.place === 'trash') return null;
  const sender = message.direction !== 'sent' && onBlock ? message.from?.address ?? '' : '';
  if (!onForward && !sender) return null;
  return <div className="mailletterdoors">
    {onForward ? <button className="btn bare" id={`mailForward-${message.id}`} type="button" onClick={() => onForward(message.id)}>
      Forward
    </button> : null}
    {sender ? <button className="btn bare" id={`mailBlock-${message.id}`} type="button"
      onClick={() => onBlock!(sender, !message.senderBlocked)}>
      {message.senderBlocked ? mailUnblockSender(sender) : mailBlockSender(sender)}
    </button> : null}
  </div>;
}

/** The star on a letter's first line, just before its moment (note #666),
 *  where one can be put: not in Trash or Spam, the conversation's or the
 *  letter's own. */
function LetterStar({ message, place, busy, onStar }: {
  message: WorkspaceMailThreadMessage;
  place: MailPlaceName;
  busy: boolean;
  onStar?: (messageId: string, starred: boolean) => void;
}) {
  if (!onStar || !mailCanStar(place) || !mailCanStar(message.place)) return null;
  return <MailStar id={`mailStar-${message.id}`} starred={Boolean(message.starred)} busy={busy}
    onPress={() => onStar(message.id, Boolean(message.starred))} />;
}

/**
 * One letter that ARRIVED: its envelope — who, when, and what the name does
 * not say — any warning it has earned, its one body with the quote at the end
 * folded when it repeats a letter above it, and its files.
 */
function MailLetter({ message, earlier, place, mine, forwards, onOpenFile, onSenderImages, onForward, onBlock, starring = false, onStar }: {
  message: WorkspaceMailThreadMessage;
  /** Its star is on its way to the server (note #666). */
  starring?: boolean;
  onStar?: (messageId: string, starred: boolean) => void;
  /** The reader's forwards of this letter, oldest first (slice 12). */
  forwards: WorkspaceMailThreadMessage[];
  onForward?: (messageId: string) => void;
  /** The words of every letter above this one, to recognise a quote of them. */
  earlier: string[];
  place: MailPlaceName;
  mine: string;
  onOpenFile: (messageId: string, fileId: string) => void;
  /** Put this sender on the reader's always-load list, or take them off it. */
  onSenderImages: (address: string, always: boolean) => void;
  /** Block this sender, or unblock them (slice 13). */
  onBlock?: (address: string, block: boolean) => void;
}) {
  /**
   * THE PICTURES (slice 10). What came INSIDE this letter is ours already and
   * is drawn with no tap; what it points at is not drawn until this reader
   * asks — here, or standing, by having put this sender on their list. The
   * tap lives in this component on purpose: it is one letter's answer, in one
   * view, and Back is what forgets it.
   */
  const inline = useMemo(() => mailInlinePictures(message.id, message.attachments), [message.attachments, message.id]);
  const [asked, setAsked] = useState(false);
  const loading = asked || message.imagesAllowed === true;
  const pictures = useMemo(() => mailPictures(message.html ?? '', inline), [inline, message.html]);
  const images = useMemo(
    () => mailImageDecider({ messageId: message.id, inline, load: loading }),
    [inline, loading, message.id],
  );

  // The formatted version whenever the message carried one that the allowlist
  // leaves words in — asked before anything is drawn, so the fallback to the
  // text half happens in the same paint rather than as a flicker after it.
  // A letter whose formatted half is ONE PHOTOGRAPH has no words and is still
  // that letter, so a picture this screen will draw counts as well.
  const hasText = Boolean(message.text?.trim());
  const showHtml = useMemo(() => {
    const html = message.html?.trim() ?? '';
    if (!html) return false;
    return safeHtmlHasWords(html) || pictures.drawn > 0 || (loading && pictures.remote > 0);
  }, [loading, message.html, pictures.drawn, pictures.remote]);
  const split = useMemo((): MailQuoteSplit => {
    if (showHtml) {
      const cut = splitQuotedHtml(message.html ?? '', earlier);
      // The half left above the fold must still be something the allowlist
      // draws; if it is not, nothing is folded.
      return cut.quoted && !safeHtmlHasWords(cut.said) ? { said: message.html ?? '' } : cut;
    }
    return hasText ? splitQuotedText(message.text ?? '', earlier) : { said: '' };
  }, [earlier, hasText, message.html, message.text, showHtml]);
  const envelope = useMemo(() => mailEnvelope(message, mine), [message, mine]);
  const suspicion = useMemo(() => mailSuspicion(message), [message]);
  const kept = mailLetterPlace(message, place);
  /** Who the always-load answer would be about: the address the letter claims
   *  to be from. Absent on a letter with no From at all, which is also a
   *  letter nobody could decide anything about. */
  const sender = message.from?.address ?? '';
  /**
   * Whether this letter's pictures are the reader's question at all.
   *
   * Only about the body they are actually being shown: a remote picture
   * inside a formatted half the allowlist emptied is not offered, because
   * loading it would swap the words they are reading for a tracking pixel in
   * an empty box. The exception is a letter whose formatted half is ALL it
   * has — a newsletter that is one photograph — where there is no other body
   * to protect and the picture is the letter.
   */
  const offerPictures = pictures.remote > 0 && (showHtml || !hasText);
  const notes = [
    offerPictures && !loading ? MAIL_NO_PICTURES : '',
    message.bodyTruncated ? 'This message is longer than what is shown here.' : '',
  ].filter(Boolean).join(' ');

  return <article className="mailletter" id={`mailLetter-${message.id}`}>
    <div className="mailenvelope">
      <div className="mailwho">
        <span className="name plain">{envelope.who}</span>
        <LetterStar message={message} place={place} busy={starring} {...(onStar ? { onStar } : {})} />
        <time className="mailwhen" dateTime={message.receivedAt} title={absolute(message.receivedAt) || undefined}>
          {when(message.receivedAt)}
        </time>
      </div>
      {envelope.detail ? <div className="cline mailabout"><span className="ctext">{envelope.detail}</span></div> : null}
      {message.starred && message.starredBy ? <div className="cline mailabout mailstarredby"><span className="ctext">{`Starred by ${message.starredBy}`}</span></div> : null}
    </div>
    {kept ? <div className="cline mailplace mailletterplace">{kept}</div> : null}
    {suspicion ? <div className="hintblock mailwarn" role="note">{suspicion}</div> : null}
    {message.unreadable ? <div className="hintblock" role="note">{MAIL_UNREADABLE}</div> : null}

    {showHtml
      ? <SafeHtml className="mailbody mailhtml" source={split.said} images={images} />
      : hasText ? <MailText text={split.said} /> : null}
    {split.quoted ? <MailFold>
      {showHtml
        ? <SafeHtml className="mailbody mailhtml mailquotedbody" source={split.quoted} images={images} />
        : <MailText text={split.quoted} className="mailquotedbody" />}
    </MailFold> : null}
    {/* Neither half has words: said in a sentence, because an envelope with
        nothing under it looks like a screen that failed. */}
    {!showHtml && !hasText && !message.unreadable && !offerPictures
      ? <div className="card"><div className="empty">This message had no words in it.</div></div>
      : null}

    {/* What was left out of the body, when something was — and only then.
        A picture is "left out" only if it is one at somebody else's address
        that this reader has not asked for: the ones that travelled inside the
        letter are already on the screen, and a tracking pixel was never going
        to be seen by anybody. */}
    {notes ? <div className="cline mailnotes">{notes}</div> : null}

    {/* The two taps, under the letter they are about (slice 10). The first is
        offered while there is a picture to load; the second only once this
        reader has loaded one, because "always?" is a question about a sender
        they have already answered about once. */}
    {offerPictures ? <div className="mailpictures" id={`mailPictures-${message.id}`}>
      {!loading ? <button className="btn ghost" id={`mailLoadPictures-${message.id}`} type="button"
        onClick={() => setAsked(true)}>{MAIL_LOAD_PICTURES}</button> : null}
      {loading && sender ? <button className="btn ghost mailalways" id={`mailAlwaysPictures-${message.id}`} type="button"
        onClick={() => onSenderImages(sender, !message.imagesAllowed)}>
        {message.imagesAllowed ? mailStopPictures(sender) : mailAlwaysPictures(sender)}
      </button> : null}
    </div> : null}

    <MailFiles message={message} onOpen={(fileId) => onOpenFile(message.id, fileId)} />
    <MailForwarded forwards={forwards} />
    <MailLetterDoors message={message} place={place} {...(onForward ? { onForward } : {})} {...(onBlock ? { onBlock } : {})} />
  </article>;
}

/**
 * One letter the READER sent, marked as theirs twice over (note #545): it
 * stands on the accent's own tint with the rule down its left edge that the
 * chat puts beside an aside, and the line above it SAYS it — `From you to …`
 * — so the colour never carries the fact alone. What is shown is what they
 * wrote: the quote under it went to the recipient, who needed the context,
 * and the letter it quotes is already on this screen.
 */
function MailOwn({ message, senders, place, forwards, onOpenFile, onForward, starring = false, onStar }: {
  message: WorkspaceMailThreadMessage;
  starring?: boolean;
  onStar?: (messageId: string, starred: boolean) => void;
  senders: string[];
  place: MailPlaceName;
  forwards: WorkspaceMailThreadMessage[];
  onOpenFile: (messageId: string, fileId: string) => void;
  onForward?: (messageId: string) => void;
}) {
  const kept = mailLetterPlace(message, place);
  const words = message.text ?? (message.forwards ? '' : message.snippet);
  return <article className="mailletter mailown" id={`mailLetter-${message.id}`}>
    <div className="cline mailownhead">
      <span className="ctext">{mailOwnLine(message, senders)}</span>
      <LetterStar message={message} place={place} busy={starring} {...(onStar ? { onStar } : {})} />
      <time className="cwhen" dateTime={message.receivedAt} title={absolute(message.receivedAt) || undefined}>
        {when(message.receivedAt)}
      </time>
    </div>
    {/* An answer an agent wrote, said where it is read. It still went out of
        the reader's address — which is why the line above says `from you`
        and this one says who wrote it. */}
    {message.sentBy ? <div className="mailreplyby">Sent by {message.sentBy}</div> : null}
    {message.starred && message.starredBy ? <div className="mailreplyby mailstarredby">Starred by {message.starredBy}</div> : null}
    {kept ? <div className="cline mailplace mailletterplace">{kept}</div> : null}
    {words ? <div className="mailbody mailtext">{words}</div>
      : message.forwards ? <div className="cline mailnowords">Forwarded with no words of your own.</div> : null}
    {/* What went with it (slice 12). A forward's files are the letter's own,
        and they are listed here as what LEFT, whatever the letter keeps. */}
    <MailFiles message={message} onOpen={(fileId) => onOpenFile(message.id, fileId)} />
    <MailForwarded forwards={forwards} />
    <MailLetterDoors message={message} place={place} {...(onForward ? { onForward } : {})} />
  </article>;
}

/**
 * Writing the answer (note #509, slice 4).
 *
 * A transient leaf: it has no address of its own, it keeps the conversation
 * underneath it, and Back closes it rather than spending a history entry.
 *
 * The recipient is shown and is NOT a field. It was decided by the server off
 * the letter being answered, and there is nowhere here to type somebody
 * else's address as the one the answer goes TO: that is the whole reason
 * replying can be open on a free address at all.
 *
 * The Cc line IS the reader's (slice 12), and Reply to all fills it with the
 * letter's other recipients as the server read them off it. A Cc naming
 * somebody the letter was not addressed to reaches somebody new, and the
 * server counts it against the new-message allowance for exactly that.
 */
function MailReplyComposer({ message, to, all, allLeftOut, onClose, onSent }: {
  message: WorkspaceMailThreadMessage;
  to: WorkspaceMailParty;
  all?: WorkspaceMailParty[];
  allLeftOut?: number;
  onClose: () => void;
  onSent: (reply: WorkspaceMailReply) => void;
}) {
  const { api } = useSession();
  const [text, setText] = useState('');
  const [cc, setCc] = useState<string[]>([]);
  const [picked, setPicked] = useState<MailPick[]>([]);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState('');
  useBackClaim(onClose);

  const send = useCallback(async (): Promise<boolean> => {
    if (!text.trim() || sending) return false;
    setSending(true); setFailed('');
    try {
      const copies = mailCcAddresses(cc);
      const answer = await mailPost<WorkspaceMailReplyAnswer>(
        api,
        `api/mail/messages/${encodeURIComponent(message.id)}/reply`,
        { text, ...(copies.length ? { cc: copies } : {}) },
        picked.map(({ file }) => file),
      );
      onSent(answer.reply);
      onClose();
      return true;
    } catch (error) {
      // The words stay in the box: a failure here is the provider's or the
      // network's, and losing what somebody just wrote is unforgivable.
      setFailed(errorMessage(error));
      setSending(false);
      return false;
    }
  }, [api, cc, message.id, onClose, onSent, picked, sending, text]);

  return <div className="screen" id="screenMailReply">
    <ScreenTitle title="Reply" sub={`to ${mailParty(to)}`} />
    <div className="card mailreplycard">
      <MailCcField cc={cc} onChange={setCc} offer={all?.map((party) => party.address)} offerLeftOut={allLeftOut ?? 0} />
      {/* The same field a note is written in — `.frow` is what gives a
          textarea the page's own face rather than the browser's monospace
          default, and the head carries the count the box owes a long reply. */}
      <label className="drow frow">
        <div className="head">
          <div className="k">Your reply</div>
          <div className="count" id="mailReplyCount">
            {text.length ? `${text.length} character${text.length === 1 ? '' : 's'}` : ''}
          </div>
        </div>
      <VoiceField
        onTranscript={setText}
        review={{
          value: text,
          onChange: setText,
          autoGrow: true,
          maxLength: MAIL_REPLY_MAX,
          sending,
          onSend: send,
          words: {
            review: 'Review your reply',
            record: 'Dictate a reply',
            back: 'Back to writing',
            field: 'Your reply',
            placeholder: 'Write your reply',
            hint: 'Make any changes before you send.',
            commit: 'Send reply',
            committing: 'Sending…',
            icon: 'send',
            failed: 'The reply could not be sent. Your words are still here. Try again.',
          },
        }}
      >
        <textarea
          id="mailReplyText"
          className="prose"
          placeholder="Write your reply"
          rows={7}
          maxLength={MAIL_REPLY_MAX}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </VoiceField>
      </label>
      <MailFilesField picked={picked} onPicked={setPicked} />
      {failed ? <div className="autherror" role="alert">{failed}</div> : null}
      <div className="authactions">
        <button className="btn bare" type="button" onClick={onClose}>Cancel</button>
        <button className="formcommit" id="mailReplySend" type="button" disabled={sending || !text.trim()}
          onClick={() => { void send(); }}>{sending ? 'Sending…' : 'Send reply'}</button>
      </div>
    </div>
    {/* What they are answering, so the reply is written with it in view. */}
    <h2 id="mailReplyQuotedHead">The message you are answering</h2>
    <div className="card mailquoted">
      <div className="cline"><span className="ctext">{mailSender(message)} · {message.subject || '(no subject)'}</span></div>
      <div className="mailquotedtext">{reflowMailText(message.text ?? message.snippet ?? '')}</div>
    </div>
  </div>;
}

/**
 * Passing a letter on (slice 12). Drawn in place over the conversation, like
 * the reply composer, and gone with Back.
 *
 * Unlike a reply it DOES name its recipient — it reaches somebody who has not
 * written, which is why the server counts it as a new message — so it asks
 * for one address and up to three Cc boxes, exactly as Write email does. The
 * words are optional: the letter under them is what is being sent. The
 * letter's own files are listed ticked, because forwarding means passing on
 * what came with it; unticking one leaves it off.
 */
function MailForwardComposer({ message, onClose, onSent }: {
  message: WorkspaceMailThreadMessage;
  onClose: () => void;
  onSent: () => void;
}) {
  const { api } = useSession();
  const [to, setTo] = useState('');
  const [cc, setCc] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<MailPick[]>([]);
  const [carry, setCarry] = useState<string[]>(() => message.attachments
    .filter((file) => !mailOutFileRefusal({ fileName: file.fileName, size: file.size }))
    .map((file) => file.id));
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState('');
  useBackClaim(onClose);

  const send = useCallback(async (): Promise<boolean> => {
    if (!to.trim() || sending) return false;
    setSending(true); setFailed('');
    try {
      const copies = mailCcAddresses(cc);
      await mailPost<WorkspaceMailForwardAnswer>(
        api,
        `api/mail/messages/${encodeURIComponent(message.id)}/forward`,
        { to, text, carry, ...(copies.length ? { cc: copies } : {}) },
        picked.map(({ file }) => file),
      );
      onSent();
      onClose();
      return true;
    } catch (error) {
      setFailed(errorMessage(error));
      setSending(false);
      return false;
    }
  }, [api, carry, cc, message.id, onClose, onSent, picked, sending, text, to]);

  return <div className="screen" id="screenMailForward">
    <ScreenTitle title="Forward" sub={`${mailSender(message)} · ${message.subject || '(no subject)'}`} />
    <div className="mailcompose">
      <label className="drow frow">
        <div className="head"><div className="k">To</div></div>
        <input
          id="mailForwardTo"
          type="email"
          inputMode="email"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="name@example.com"
          value={to}
          onChange={(event) => setTo(event.target.value)}
        />
      </label>
      <MailCcField cc={cc} onChange={setCc} />
      <label className="drow frow">
        <div className="head">
          <div className="k">Your words</div>
          <div className="count">{text.length ? `${text.length} character${text.length === 1 ? '' : 's'}` : 'optional'}</div>
        </div>
        <VoiceField
          onTranscript={setText}
          review={{
            value: text,
            onChange: setText,
            autoGrow: true,
            maxLength: MAIL_REPLY_MAX,
            sending,
            onSend: send,
            words: {
              review: 'Review your words',
              record: 'Dictate a note',
              back: 'Back to writing',
              field: 'Your words',
              placeholder: 'Say why you are passing it on',
              hint: 'The letter goes under your words.',
              commit: 'Send forward',
              committing: 'Sending…',
              icon: 'send',
              failed: 'The forward could not be sent. Your words are still here. Try again.',
            },
          }}
        >
          <textarea
            id="mailForwardText"
            className="prose"
            placeholder="Say why you are passing it on"
            rows={4}
            maxLength={MAIL_REPLY_MAX}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </VoiceField>
      </label>
      <MailFilesField picked={picked} onPicked={setPicked}
        carried={message.attachments} carry={carry} onCarry={setCarry} />
      {failed ? <div className="autherror" role="alert">{failed}</div> : null}
      <div className="authactions">
        <button className="btn bare" type="button" onClick={onClose}>Cancel</button>
        <button className="formcommit" id="mailForwardSend" type="button" disabled={sending || !to.trim()}
          onClick={() => { void send(); }}>{sending ? 'Sending…' : 'Send forward'}</button>
      </div>
    </div>
    <h2 id="mailForwardQuotedHead">The letter you are forwarding</h2>
    <div className="card mailquoted">
      <div className="cline"><span className="ctext">{mailSender(message)} · {message.subject || '(no subject)'}</span></div>
      <div className="mailquotedtext">{reflowMailText(message.text ?? message.snippet ?? '')}</div>
    </div>
  </div>;
}

/**
 * Where this conversation is kept, and the way to change it (slices 7 and 8).
 *
 * The buttons are the ones that make sense from where it IS: from the inbox,
 * Archive and Move to Trash; from the archive, back to the inbox or on to
 * Trash; from Trash, Restore — the one way out of it, which puts every letter
 * back where it was, the archive included. And while the conversation is NOT
 * in Trash but some of its letters are — one an agent trashed alone, or the
 * ones left there when an answer brought the rest back — a line says so, with
 * the way to bring them back beside it.
 */
function MailTools({ conversation, busy, onMove }: {
  conversation: WorkspaceMailConversation;
  busy: WorkspaceMailMove | null;
  onMove: (move: WorkspaceMailMove) => void;
}) {
  const line = mailPlaceLine(conversation);
  const trashed = conversation.place === 'trash' ? '' : mailTrashedLine(conversation.trashed);
  const button = (move: WorkspaceMailMove, icon: 'archive' | 'trash' | 'back' | 'shield', words: string, doing: string) => (
    <button className="btn ghost" id={`mail${move[0]!.toUpperCase()}${move.slice(1)}`} type="button"
      disabled={Boolean(busy)} onClick={() => onMove(move)}>
      <Icon name={icon} size={18} />{busy === move ? doing : words}
    </button>
  );
  return <div className="mailtools" id="mailTools">
    {line ? <div className="cline mailplace" id="mailPlace" role="status">{line}</div> : null}
    {trashed ? <div className="cline mailplace" id="mailTrashed" role="status">{trashed}</div> : null}
    <div className="mailtoolrow">
      {conversation.place === 'trash'
        ? button('restore', 'back', 'Restore', 'Restoring…')
        : conversation.place === 'spam'
          // From Spam (slice 13): Not spam is the one way back to the inbox,
          // and Trash is still there for what the reader is done with.
          ? <>
            {button('unspam', 'back', 'Not spam', 'Moving…')}
            {button('trash', 'trash', 'Move to Trash', 'Moving…')}
          </>
          : <>
          {conversation.place === 'archive'
            ? button('unarchive', 'back', 'Move to inbox', 'Moving…')
            : button('archive', 'archive', 'Archive', 'Archiving…')}
          {button('spam', 'shield', 'Mark as spam', 'Marking…')}
          {button('trash', 'trash', 'Move to Trash', 'Moving…')}
          {/* The letters of it that are in Trash come back with Restore, as
              a whole conversation's would: each to where it was before. */}
          {trashed ? <button className="btn ghost" id="mailRestoreTrashed" type="button"
            disabled={Boolean(busy)} onClick={() => onMove('restore')}>
            <Icon name="back" size={18} />{busy === 'restore' ? 'Restoring…' : 'Restore from Trash'}
          </button> : null}
        </>}
    </div>
  </div>;
}

/** The letter the reader has just sent, standing in the conversation the
 *  moment the server said it went — built from that answer, never from the
 *  box, and replaced by the server's own copy on the read that follows. */
function sentLetter(reply: WorkspaceMailReply, answering: WorkspaceMailThreadMessage, mine: string): WorkspaceMailThreadMessage {
  const subject = answering.subject.trim();
  return {
    id: reply.id,
    direction: 'sent',
    from: { address: mine },
    to: reply.to,
    cc: reply.cc ?? [],
    replyTo: [],
    subject: /^re\s*:/i.test(subject) ? subject : `Re: ${subject || '(no subject)'}`,
    snippet: reply.text.replace(/\s+/g, ' ').slice(0, 200),
    receivedAt: reply.sentAt,
    files: reply.attachments?.length ?? 0,
    text: reply.text,
    attachments: reply.attachments ?? [],
    rawSize: 0,
    ...(reply.sentBy ? { sentBy: reply.sentBy } : {}),
  };
}

export function MailConversationScreen() {
  const { id = '' } = useParams();
  const location = useLocation();
  const { api } = useSession();
  const { state } = useWorkspace();
  const [conversation, setConversation] = useState<WorkspaceMailConversation | null>(() => heldMailConversation(id));
  const [failed, setFailed] = useState<{ said: string; retry: boolean } | null>(null);
  const [replying, setReplying] = useState(false);
  /** The letter being passed on, while the forward composer is up. */
  const [forwarding, setForwarding] = useState<string | null>(null);
  const [moving, setMoving] = useState<WorkspaceMailMove | null>(null);
  const [moveFailed, setMoveFailed] = useState('');
  /** The reader's own address, so an envelope can say `you` rather than
   *  spelling out the address every message they own was sent to. */
  const mine = state?.user?.account.mailbox?.address ?? '';

  const read = useCallback(async () => {
    const kept = heldMailConversation(id);
    if (kept) setConversation((current) => current ?? kept);
    try {
      const answer = await readOrSayWhy<WorkspaceMailConversationAnswer>(
        (init) => api.api(`api/mail/conversations/${encodeURIComponent(id)}`, init),
      );
      setConversation(answer.conversation);
      holdMailConversation(answer.conversation);
      // Opening it here is what marked every letter in it read on the
      // server; the list this reader came from is holding a row that said
      // it was new.
      markMailConversationRead(answer.conversation);
      setFailed(null);
    } catch (failure) {
      if (kept && worthAskingAgain(failure)) return;
      setFailed({ said: errorMessage(failure), retry: worthAskingAgain(failure) });
    }
  }, [api, id]);

  useEffect(() => { void read(); }, [read]);

  /**
   * OPEN AT THE LETTER THE ADDRESS NAMES — the one a search found, or the
   * first one nobody has read — when that is not the first letter anyway.
   * Once, when the conversation is first on the screen, and never over a
   * Back: a line this entry already remembers is the reader's own, and the
   * shell puts them back on it. Through `placeScroll`, which holds the line
   * while the screen settles, because the shell's own placement of a new
   * entry at its top would otherwise take a bare scroll straight back.
   */
  const placed = useRef(false);
  const release = useRef<(() => void) | null>(null);
  useEffect(() => () => release.current?.(), []);
  useEffect(() => {
    if (placed.current || !conversation) return;
    placed.current = true;
    if (conversation.messages[0]?.id === id || recallScroll(location.key) !== undefined) return;
    const letter = document.getElementById(`mailLetter-${id}`);
    if (!letter) return;
    const head = document.querySelector('.pagehead')?.getBoundingClientRect().bottom ?? 0;
    release.current = placeScroll(Math.max(0, Math.round(letter.getBoundingClientRect().top + window.scrollY - head - 10)));
  }, [conversation, id, location.key]);

  /** A file, opened the way every other file in this app is: the screen asks
   *  for a short-lived URL and the browser takes it from there. */
  const open = useCallback(async (messageId: string, fileId: string) => {
    try {
      const access = await api.api<WorkspaceFileAccessAnswer>(
        `api/mail/messages/${encodeURIComponent(messageId)}/files/${encodeURIComponent(fileId)}`,
      );
      window.open(access.url, '_blank', 'noopener,noreferrer');
    } catch (failure) {
      setFailed({ said: errorMessage(failure), retry: true });
    }
  }, [api]);

  /**
   * ALWAYS, OR NO LONGER, FOR ONE SENDER (slice 10). The list is the server's,
   * so the answer is what the conversation is rewritten from: every letter
   * from that address in it gets — or loses — the standing yes at once, which
   * is what stops one letter saying "always" while the one above it still
   * offers the tap.
   */
  const setSenderImages = useCallback(async (address: string, always: boolean) => {
    try {
      const answer = await api.api<WorkspaceMailImageSendersAnswer>(
        always ? 'api/mail/image-senders' : `api/mail/image-senders/${encodeURIComponent(address)}`,
        always ? jsonBody({ address }) : { method: 'DELETE' },
      );
      const allowed = new Set(answer.addresses.map((one) => one.toLowerCase()));
      setConversation((current) => {
        if (!current) return current;
        const next: WorkspaceMailConversation = {
          ...current,
          messages: current.messages.map((message) => {
            const from = message.from?.address.toLowerCase() ?? '';
            const rest: WorkspaceMailThreadMessage = { ...message };
            delete rest.imagesAllowed;
            return from && allowed.has(from) ? { ...rest, imagesAllowed: true as const } : rest;
          }),
        };
        holdMailConversation(next);
        return next;
      });
    } catch (failure) {
      setFailed({ said: errorMessage(failure), retry: false });
    }
  }, [api]);

  /**
   * Archive, Trash and their undos, for the whole conversation. Where it now
   * is comes from the SERVER's answer: the line under the title, each
   * letter's own mark and the lists this tab holds are rewritten from what it
   * said, so nothing claims a move that did not happen.
   */
  const move = useCallback(async (to: WorkspaceMailMove) => {
    if (moving) return;
    setMoving(to); setMoveFailed('');
    try {
      const answer = await api.api<WorkspaceMailConversationMoveAnswer>(
        `api/mail/conversations/${encodeURIComponent(id)}/${to}`,
        { method: 'POST' },
      );
      mailConversationMoved(answer);
      const places = new Map(answer.messages.map((message) => [message.id, message]));
      setConversation((current) => {
        if (!current) return current;
        const next: WorkspaceMailConversation = {
          ...mailStandingAs(current, answer.conversation),
          messages: current.messages.map((message) => {
            const now = places.get(message.id);
            return now ? mailStandingAs(message, now) : message;
          }),
        };
        holdMailConversation(next);
        return next;
      });
    } catch (failure) {
      setMoveFailed(errorMessage(failure));
    } finally {
      setMoving(null);
    }
  }, [api, id, moving]);

  /**
   * A STAR on one letter, or off it (note #666). Redrawn from the server's
   * answer — the conversation as it now stands and every letter in it — and
   * the lists this tab holds are made to agree, so Back lands on a row that
   * wears the star the letter does.
   */
  const [starring, setStarring] = useState<ReadonlySet<string>>(() => new Set());
  const star = useCallback(async (messageId: string, starred: boolean) => {
    if (starring.has(messageId)) return;
    setStarring((current) => new Set(current).add(messageId));
    setMoveFailed('');
    try {
      const answer = await api.api<WorkspaceMailStarAnswer>(
        `api/mail/messages/${encodeURIComponent(messageId)}/${starred ? 'unstar' : 'star'}`,
        { method: 'POST' },
      );
      mailStarChanged(answer);
      const letters = new Map(answer.messages.map((message) => [message.id, message]));
      setConversation((current) => {
        if (!current) return current;
        const next: WorkspaceMailConversation = {
          ...mailStarredAs(current, answer.conversation),
          messages: current.messages.map((message) => {
            const now = letters.get(message.id);
            return now ? mailStarredAs(message, now) : message;
          }),
        };
        holdMailConversation(next);
        return next;
      });
    } catch (failure) {
      setMoveFailed(errorMessage(failure));
    } finally {
      setStarring((current) => {
        const next = new Set(current);
        next.delete(messageId);
        return next;
      });
    }
  }, [api, starring]);
  const onStar = useCallback((messageId: string, starred: boolean) => { void star(messageId, starred); }, [star]);

  const answering = useMemo(
    () => (conversation?.reply ? conversation.messages.find((message) => message.id === conversation.reply!.id) ?? null : null),
    [conversation],
  );

  /** A reply that has just gone stands at the foot of the conversation, and
   *  in the held copy, so Back does not lose it — and the read after it puts
   *  the server's own copy there. */
  const keepReply = useCallback((reply: WorkspaceMailReply) => {
    setConversation((current) => {
      if (!current || !answering) return current;
      const letter = sentLetter(reply, answering, mine);
      const next: WorkspaceMailConversation = {
        ...current,
        messages: [...current.messages, letter],
        count: current.count + 1,
        latest: { id: letter.id, snippet: letter.snippet, receivedAt: letter.receivedAt, direction: 'sent' },
      };
      holdMailConversation(next);
      return next;
    });
    void read();
  }, [answering, mine, read]);
  const closeComposer = useCallback(() => setReplying(false), []);
  const closeForward = useCallback(() => setForwarding(null), []);

  /**
   * Block a sender, or unblock one (slice 13). Their letters leave for Spam
   * on the server; the conversation is read again rather than redrawn from
   * the button, so what the screen says is what the server did.
   */
  const setSenderBlocked = useCallback(async (address: string, block: boolean) => {
    try {
      if (block) {
        await api.api<WorkspaceMailBlockAnswer>('api/mail/blocked-senders', jsonBody({ address }));
      } else {
        await api.api<WorkspaceMailBlockedSendersAnswer>(`api/mail/blocked-senders/${encodeURIComponent(address)}`, { method: 'DELETE' });
      }
      forgetMailLists();
      await read();
    } catch (failure) {
      setFailed({ said: errorMessage(failure), retry: false });
    }
  }, [api, read]);
  /** A forward is a letter of this conversation too: read it back in. */
  const forwarded = useCallback(() => { void read(); }, [read]);
  /** Each letter's forwards, read off the forwards standing in it. */
  const forwardsOf = useMemo(() => {
    const out = new Map<string, WorkspaceMailThreadMessage[]>();
    for (const message of conversation?.messages ?? []) {
      if (message.forwards) out.set(message.forwards, [...(out.get(message.forwards) ?? []), message]);
    }
    return out;
  }, [conversation?.messages]);
  const forwardingLetter = forwarding ? conversation?.messages.find((message) => message.id === forwarding) ?? null : null;

  /** The words of every letter above each one, to recognise its quote. */
  const earlier = useMemo(() => {
    const words = (conversation?.messages ?? []).map(mailWordsOf);
    return words.map((_, at) => words.slice(0, at));
  }, [conversation?.messages]);
  const senders = useMemo(
    () => (conversation?.messages ?? []).flatMap((message) => (message.direction !== 'sent' && message.from ? [message.from.address] : [])),
    [conversation?.messages],
  );

  const wait = useWait(!conversation && !failed);

  if (failed && !conversation) {
    return <div className="screen" id="screenMailMessage">
      <ScreenTitle title="Mail" />
      <div className="card"><div className="empty" role="alert">
        {failed.said}
        {failed.retry ? <><br /><button className="btn" type="button" onClick={() => { setFailed(null); void read(); }}>Try again</button></> : null}
      </div></div>
    </div>;
  }

  if (!conversation) {
    return <div className="screen" id="screenMailMessage">
      <ScreenTitle title="Mail" />
      {wait === 'drawn' ? <div className="card" id="mailMessageWait">
        <SkelText width="64%" />
        <SkelText width="38%" height={9} delay="0.08s" />
        <div className="mailbody"><SkelText width="92%" delay="0.16s" /><SkelText width="86%" delay="0.24s" /><SkelText width="54%" delay="0.32s" /></div>
      </div> : null}
    </div>;
  }

  if (replying && answering && conversation.reply) {
    return <MailReplyComposer message={answering} to={conversation.reply.to}
      {...(conversation.reply.all ? { all: conversation.reply.all } : {})}
      {...(conversation.reply.allLeftOut ? { allLeftOut: conversation.reply.allLeftOut } : {})}
      onClose={closeComposer} onSent={keepReply} />;
  }
  if (forwardingLetter) {
    return <MailForwardComposer message={forwardingLetter} onClose={closeForward} onSent={forwarded} />;
  }

  const place: MailPlaceName = conversation.place ?? 'inbox';
  return <div className="screen" id="screenMailMessage">
    {/* The conversation's name is the screen's; each letter says below who
        wrote it, so the header does not repeat a name in its second line. */}
    <ScreenTitle title={conversation.subject || '(no subject)'} />

    <MailTools conversation={conversation} busy={moving} onMove={(to) => { void move(to); }} />
    {moveFailed ? <div className="hintblock mailwarn" role="alert">{moveFailed}</div> : null}

    <div className="mailconversation" id="mailConversation">
      {conversation.messages.map((message, at) => (message.direction === 'sent'
        ? <MailOwn key={message.id} message={message} senders={senders} place={place}
          forwards={forwardsOf.get(message.id) ?? []}
          onOpenFile={(messageId, fileId) => { void open(messageId, fileId); }}
          onForward={setForwarding}
          starring={starring.has(message.id)} onStar={onStar} />
        : <MailLetter key={message.id} message={message} earlier={earlier[at] ?? []} place={place} mine={mine}
          forwards={forwardsOf.get(message.id) ?? []}
          starring={starring.has(message.id)} onStar={onStar}
          onOpenFile={(messageId, fileId) => { void open(messageId, fileId); }}
          onSenderImages={(address, always) => { void setSenderImages(address, always); }}
          onForward={setForwarding}
          onBlock={(address, block) => { void setSenderBlocked(address, block); }} />))}
    </div>

    {/* No Reply from Trash, and none from Spam (slice 13): a conversation
        put there is one its reader is done with, or one nothing vouched for
        — Not spam first, then answer. The name on the button is who the
        server says the answer goes to. */}
    {conversation.reply && answering && place !== 'trash' && place !== 'spam' ? <div className="mailactions">
      <button className="btn primary" id="mailReply" type="button" onClick={() => setReplying(true)}>
        {`Reply to ${conversation.reply.to.name?.trim() || conversation.reply.to.address}`}
      </button>
    </div> : null}

    {failed ? <div className="hintblock" role="alert">{failed.said}</div> : null}
  </div>;
}
