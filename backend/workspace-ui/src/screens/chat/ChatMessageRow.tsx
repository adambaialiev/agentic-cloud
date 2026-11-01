/**
 * One row of the transcript.
 *
 * Which renderer a row gets is decided BEFORE its class is, because the class
 * IS the difference: a peer agent's message wears the incoming bubble, never
 * the receipt card (note #183), and the fresh-chat marker is punctuation
 * rather than a platform event, so its structured kind is tested before the
 * generic platform renderer claims it.
 *
 * Since note #481 there are three voices here and each is drawn as what it
 * is, rather than as three variations on a grey rectangle:
 *
 *  - An AGENT speaks on the page — its words in the page's own type, full
 *    column width, no fill and no border. A reply is prose with headings,
 *    lists and code in it, and a balloon around prose is a frame that says
 *    nothing (the same argument note #160 already made about a picture).
 *  - The READER wears the one bubble. Keeping exactly one means it is a
 *    landmark when they scroll back, instead of wallpaper.
 *  - The PLATFORM annotates in the margin, and a frame is reserved for news
 *    that arrived or a decision waiting — see `PlatformNotice` below.
 *
 * Two rules the port keeps:
 *
 *  - A receipt that carries a door is a real <button> (note #159), which is
 *    where the pressed state, Enter and Space come from — and why iOS applies
 *    `:active` to it at all.
 *  - The bubble's clock rides a data attribute and is drawn by CSS, so the
 *    row's TEXT stays the message alone. Not on platform notices: a quiet
 *    centred line with a floated clock stops being either. A peer's message
 *    IS a bubble, so it keeps the clock every other bubble wears.
 */

import { CHIEF_OF_STAFF } from '../../ui/chief-of-staff.js';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { WorkspaceChatFile, WorkspaceChatFileAccessAnswer, WorkspaceChatFileTextAnswer } from '../../../../src/shared/workspace-api.js';
import { toFor } from '../../routes.js';
import { useSession } from '../../session/useSession.js';
import { AgentHover } from '../../ui/AgentHover.js';
import { bytes, fileIcon, isAudio, isInlineHtml, isInlineImage, isInlinePdf, isMarkdown, isVideo, safeFileName } from '../../ui/file-kind.js';
import { Icon, TypeIcon } from '../../ui/icons.js';
import { PdfPreview } from '../../ui/PdfPreview.js';
import { Markdown } from '../../render/Markdown.js';
import { splitNoteRefs, type NoteRefs } from '../../render/note-refs.js';
import { useNoteRefs } from '../../render/useNoteRefs.js';
import { useImageViewer } from '../../ui/useImageViewer.js';
import { usePdfViewer } from '../../ui/usePdfViewer.js';
import { usePlayer, videoSrc } from '../../ui/usePlayer.js';
import { agentNamed } from '../../workspace/live.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { cardTone, noticeBadgeClass, peerChatMessage, platformChatNotice } from './chat-notice.js';
import { ScheduleAskActions } from './ScheduleAskActions.js';
import { useChatGallery } from './chat-gallery-context.js';
import { heldChatFileText, readChatFileText } from './chat-file-text.js';
import { filesOf, type TranscriptRow } from './transcript.js';
import { foldsReport, reportPreview } from './report-fold.js';
import { MailApprovalCard } from './MailApprovalCard.js';
import { ForwardedProposals } from './ForwardedProposals.js';
import type { OutgoingMessage } from './outbox.js';

const clockOf = (at: string): string =>
  new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/**
 * A run of words, unchanged, with any note named in them made tappable.
 *
 * Written for the OWNER's message, which is deliberately NOT markdown — what
 * they typed is what they see — and this keeps that promise: every character
 * is still printed in the order it was written, and only a `note #284` inside
 * it gains an anchor. The app writes that sentence itself when a note is
 * handed to an agent ("pick up the note #284"), so it is the reader's own
 * most common mention.
 *
 * The quiet fresh-chat line uses it for the same reason (note #394): its
 * sentence names a note, and one sentence with a link in it is the whole row
 * — so the number is the door, exactly as it is in every other message here.
 */
export function NoteLinked({ text, notes }: { text: string; notes: NoteRefs }) {
  return (
    <>
      {splitNoteRefs(text).map((part, at) => {
        const to = part.number === undefined ? null : notes.link(part.number);
        // The plain pieces stay text nodes: the bubble's own `pre-wrap` is
        // what keeps the reader's line breaks, and a wrapper would be one
        // more element between it and the words.
        return to ? <Link className="noteref" key={at} to={to.to}>{part.text}</Link> : part.text;
      })}
    </>
  );
}

/**
 * The frame a picture is drawn into before its bytes arrive (note #302): an
 * empty block with the picture's aspect ratio, sized by the stylesheet from
 * the same two caps the picture itself obeys — the column and the height
 * ceiling — and never wider than the picture's own pixels. It is pure
 * layout, so it is its final size at the FIRST layout, and the picture is
 * then laid OVER it rather than into the flow: the bytes landing change
 * nothing about the row, and a transcript whose rows grow as their pictures
 * decode — moving the reader every time — is exactly what this replaces.
 *
 * Not an image stand-in. An <img> with the right size and a data: SVG is
 * still 0x0 until that SVG has loaded, a beat after layout, and an opening
 * snap taken in that beat lands the reader short by every picture on the
 * screen (measured in Chrome against this stylesheet, 2026-09-03).
 */
const frameStyle = (width: number, height: number): CSSProperties =>
  ({ '--picture-ratio': `${width} / ${height}`, '--picture-width': `${width}px` } as CSSProperties);

const pictureSize = (file: WorkspaceChatFile): { width: number; height: number } | null =>
  (file.width && file.height ? { width: file.width, height: file.height } : null);

/**
 * One attachment: a picture that is part of the message, so it is seen and
 * not merely named, or the name of anything else.
 *
 * A picture whose size the row carries is framed at once and the bytes land
 * into that frame. One stored before sizes were recorded keeps its name until
 * the preview read answers — that read measures it and says so — and is
 * framed from then on; only a picture whose size nobody knows is drawn the
 * old way, growing into the flow as it loads. A picture that fails puts the
 * named row back: the name is the truthful fallback, and a chat should not
 * grow an error banner because one preview failed to load.
 *
 * A PDF is the third shape (note #403): the top of its first page above the
 * name it keeps, and a tap opens the whole document full screen rather than
 * downloading it. It is a <div> where the other two are a <button>, because
 * the frame drawing that page is interactive content and cannot live inside
 * one; the name line is the button instead, stretched over the card by the
 * stylesheet so the tap lands on a real control wherever it falls.
 *
 * An HTML page (note #557) keeps a picture-less row's shape — its name, its
 * size, the web glyph — and once its preview link is minted a tap opens it
 * full screen in the same document viewer, sandboxed, instead of saving it.
 * No band of the page above the name: a page has no fixed first-page shape
 * a band could honestly show, and a sandboxed frame per row in a transcript
 * is a cost nobody asked to pay for a glimpse.
 */
function FileItem({ agentId, file, seq, index, onOpen, onPictureLoaded, onShown }: {
  agentId: string;
  file: WorkspaceChatFile;
  /** Where this file was said (note #544): the conversation's gallery is
   *  ordered by these, so the viewer steps through it as it was read. */
  seq: number;
  index: number;
  onOpen: (file: WorkspaceChatFile) => void;
  onPictureLoaded: () => void;
  /** The signed URL of a picture that is now PAINTED, and '' for one that
   *  turned out not to be — so the row above opens the viewer on exactly the
   *  pictures the reader can see, rather than on a URL that draws nothing.
   *  A PDF hands its URL up the moment the read answers: a cross-origin frame
   *  never says whether it painted, and the document is the same document
   *  full screen whether or not the browser drew the band. */
  onShown: (id: string, url: string) => void;
}) {
  const { api } = useSession();
  const kind = fileIcon(file.fileName);
  const showsPicture = Boolean(agentId) && isInlineImage(file.contentType);
  const showsPdf = Boolean(agentId) && isInlinePdf(file.contentType, file.fileName);
  const showsHtml = Boolean(agentId) && isInlineHtml(file.contentType, file.fileName);
  const [url, setUrl] = useState('');
  const [size, setSize] = useState(() => pictureSize(file));
  const [loaded, setLoaded] = useState(false);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    if (!showsPicture && !showsPdf && !showsHtml) return;
    let alive = true;
    void api.api<WorkspaceChatFileAccessAnswer>(
      `api/agents/${encodeURIComponent(agentId)}/chat/files/${encodeURIComponent(file.id)}?preview=1`,
    )
      .then((access) => {
        if (!alive || !access?.url) return;
        setUrl(access.url);
        if (showsPdf || showsHtml) onShown(file.id, access.url);
        const { width, height } = access;
        if (width && height) setSize((held) => held ?? { width, height });
      })
      .catch(() => { /* stays a named row */ });
    return () => { alive = false; };
  }, [agentId, api, file.id, onShown, showsHtml, showsPdf, showsPicture]);

  const framed = showsPicture && !broken && size !== null;
  const picture = showsPicture && !broken && Boolean(url);
  const painted = loaded && !broken;
  // A page whose preview link has been minted opens full screen (note #557);
  // until then a tap saves it, exactly as a picture whose bytes never came.
  const opensPage = showsHtml && Boolean(url);

  // A picture that PAINTED joins the conversation's gallery (note #544), and
  // leaves it when it unmounts or breaks. An effect with a cleanup, not a
  // call from onLoad: StrictMode runs the pair twice in development, and a
  // register written from a load event would be emptied by the rehearsal
  // and never refilled.
  const gallery = useChatGallery();
  useEffect(() => {
    if (!gallery || !painted || !url) return undefined;
    gallery.add({ file, url, seq, index });
    return () => gallery.remove(file.id);
  }, [file, gallery, index, painted, seq, url]);

  // A frame that arrives AFTER the row was first drawn — the preview read
  // measured a picture stored without a size — grows the row the way the
  // picture itself used to, once; a following reader is carried with it, as
  // they were. A row framed from its first paint never asks: nothing about
  // it changes when the bytes land.
  const framedAtFirst = useRef(framed);
  useLayoutEffect(() => {
    if (framed && !framedAtFirst.current) { framedAtFirst.current = true; onPictureLoaded(); }
  }, [framed, onPictureLoaded]);

  // The document card stands from the FIRST layout, band and all, and the
  // frame drops into it when the read answers. Nothing about the row changes
  // when the URL arrives, so a reader at the end of the conversation is still
  // there — which is the whole of note #302's lesson, and cheaper here: every
  // page gets the same band, so there is no shape to discover first.
  if (showsPdf) {
    return (
      <div className="chatfileitem chatpdfitem">
        <PdfPreview url={url} name={file.fileName} />
        <button
          className="chatfileline"
          type="button"
          // What the tap DOES, which is not "full screen" until there is a
          // URL to open full screen WITH: until then it saves the file,
          // exactly as a picture whose bytes never arrived does.
          aria-label={url ? `Open ${file.fileName} full screen` : `Download ${file.fileName}`}
          onClick={() => onOpen(file)}
        >
          <TypeIcon glyph={kind.glyph} tint={kind.tint} />
          <span>{file.fileName} · {bytes(file.sizeBytes)}</span>
        </button>
      </div>
    );
  }

  const className = [
    'chatfileitem',
    (framed || painted) && 'haspicture',
    framed && !loaded && 'loading',
  ].filter(Boolean).join(' ');
  const bytes_ = (
    <img
      className={framed ? 'chatpicturebytes' : undefined}
      src={url}
      alt={file.fileName}
      decoding="async"
      onError={() => { setBroken(true); onShown(file.id, ''); }}
      onLoad={() => {
        setLoaded(true);
        onShown(file.id, url);
        // A picture growing into the flow carries a following reader with
        // it; one landing in its frame changed nothing and asks for nothing.
        if (!framed) onPictureLoaded();
      }}
    />
  );
  return (
    <button
      className={className}
      type="button"
      // What the tap DOES, which differs by row: a picture PAINTED on screen
      // opens full screen here, so does a page with a link to open it on
      // (note #557), and everything else — including a picture whose bytes
      // have not arrived, framed or not — is saved (note #552).
      aria-label={painted || opensPage ? `Open ${file.fileName} full screen` : `Download ${file.fileName}`}
      onClick={() => onOpen(file)}
    >
      {framed
        ? <span className="chatpicture" style={frameStyle(size.width, size.height)}>{picture ? bytes_ : null}</span>
        : picture ? bytes_ : null}
      <div className="chatfileline">
        <TypeIcon glyph={kind.glyph} tint={kind.tint} />
        <span>{file.fileName} · {bytes(file.sizeBytes)}</span>
        {/* A file that is only ever SAVED says so at its right edge (note
            #552): an archive's row read as a label until now, and the owner
            had no way to tell it was the way to the bytes. A picture's row is
            the picture's caption and stays as it was — a picture that will be
            drawn is not a download, even before its bytes land — and a page
            that opens full screen carries its Download in the viewer's head
            instead (note #557). */}
        {!showsPicture && !opensPage ? <Icon name="arrowdown" size={16} className="icon chatsave" /> : null}
      </div>
    </button>
  );
}

/** The nearest box that scrolls this one, or null for the window. */
const scrollerOf = (node: HTMLElement): Element | null => {
  for (let at = node.parentElement; at; at = at.parentElement) {
    const { overflowY } = window.getComputedStyle(at);
    if (overflowY === 'auto' || overflowY === 'scroll') return at;
  }
  return null;
};

/**
 * Whether a card has come within a screen of what the reader can see — and
 * stays true once it has. Where nothing can watch for that, at once.
 * Measured against the pane the transcript scrolls in, not the window: a
 * margin on the window cannot reach past the pane's clip, so a card a
 * thumb-flick away would wait until it was already on the glass.
 */
function useNearScreen(card: RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(() => typeof window.IntersectionObserver !== 'function');
  useEffect(() => {
    const node = card.current;
    if (near || !node || typeof window.IntersectionObserver !== 'function') return undefined;
    const observer = new window.IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      setNear(true);
    }, { root: scrollerOf(node), rootMargin: '100% 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [card, near]);
  return near;
}

/** How much of a Markdown file the row's glimpse is drawn from: far more
 *  than its band can show, and a bounded parse however long the file is. */
const GLIMPSE_CHARS = 2400;

const glimpseOf = (text: string): string => {
  if (text.length <= GLIMPSE_CHARS) return text;
  const cut = text.lastIndexOf('\n', GLIMPSE_CHARS);
  return text.slice(0, cut > 0 ? cut : GLIMPSE_CHARS);
};

/**
 * A Markdown file (note #677), shown as the page it is.
 *
 * The write-up an agent hands over most — a plan, a report, a file of drafts
 * — was a name and a size with a download arrow, and reading it meant
 * leaving the Workspace for whatever the phone opens a `.md` with, which
 * prints the asterisks. It is a card now, built like a PDF's: the top of the
 * document above its name, and a tap anywhere on it opens the whole of it
 * full screen in the document viewer, set as a page.
 *
 * The glimpse is the same renderer and the same type the full-screen page
 * uses, laid out wider than the card and scaled down to it, so what the band
 * promises is what the tap delivers — headings, lists and all. Its band is a fixed
 * height from the first layout, grey until the words land (the PDF card's
 * bargain, and note #302's: nothing about the row moves when they do).
 *
 * The words are read only once the card is near the screen: a conversation
 * scrolled back through a month of reports should not pull every one of them
 * through the backend on open. They are held per tab (`chat-file-text.ts`),
 * and the card opens the viewer with them at the tap.
 *
 * A file whose words cannot be read — gone, too large, or the read failed —
 * goes back to being the named row it always was, whose tap saves it.
 */
function MarkdownFileItem({ onOpenPage, ...props }: Parameters<typeof FileItem>[0] & {
  onOpenPage: (file: WorkspaceChatFile, text: string) => void;
}) {
  const { agentId, file, onOpen } = props;
  const { api } = useSession();
  const kind = fileIcon(file.fileName);
  const [answer, setAnswer] = useState<WorkspaceChatFileTextAnswer | null>(() => heldChatFileText(agentId, file.id));
  const [failed, setFailed] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const near = useNearScreen(card);

  useEffect(() => {
    if (answer || failed || !near) return undefined;
    let alive = true;
    readChatFileText(api, agentId, file.id)
      .then((read) => { if (alive) setAnswer(read); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [agentId, answer, api, failed, file.id, near]);

  const words = answer?.kind === 'markdown' ? answer.content : null;

  if (failed || (answer && words === null)) return <FileItem {...props} />;
  return (
    <div className="chatfileitem chatmditem" ref={card}>
      {/* A picture of the page, not a second place to read in: nothing in
          it takes a tap or the focus, and the name below is the control. */}
      <span className={words === null ? 'mdglimpse loading' : 'mdglimpse'} aria-hidden="true" inert>
        {words !== null ? <Markdown source={glimpseOf(words)} className="mdpage" /> : null}
      </span>
      <button
        className="chatfileline"
        type="button"
        // What the tap DOES: full screen once there are words to show, and
        // until then it saves the file, as a PDF card does before its link.
        aria-label={words !== null ? `Open ${file.fileName} full screen` : `Download ${file.fileName}`}
        onClick={() => (words !== null ? onOpenPage(file, words) : onOpen(file))}
      >
        <TypeIcon glyph={kind.glyph} tint={kind.tint} />
        <span>{file.fileName} · {bytes(file.sizeBytes)}</span>
      </button>
    </div>
  );
}

/**
 * A video or a recording (note #693), played where it was said.
 *
 * The clip an agent renders and hands over — a promo, a screen recording, a
 * voiceover — was a name, a size and a download arrow, and watching it meant
 * leaving the Workspace for wherever the phone files an `.mp4`. It is the
 * browser's own player now, above the name it keeps: that name line is the
 * row's Download, as it is on every file that is only saved (note #552). A
 * <div> holds the two, as a PDF card's does, because a player's controls are
 * interactive content and cannot live inside a button.
 *
 * A video's card is a frame from the first layout — 16:9 until the player
 * has read the clip's own shape, then that shape, once, carrying a following
 * reader with it the way a picture of unknown size does (note #302). A
 * recording's card is the player's own height and never moves.
 *
 * The link is minted when the card comes near the screen, as a Markdown
 * card's words are read; what happens when it runs out, or the clip will not
 * play, is `usePlayer`'s — and a clip that will not play puts the named row
 * back, whose tap saves the file.
 */
function MediaFileItem(props: Parameters<typeof FileItem>[0]) {
  const { agentId, file, onOpen, onPictureLoaded } = props;
  const { api } = useSession();
  const kind = fileIcon(file.fileName);
  const video = isVideo(file.contentType, file.fileName);
  const card = useRef<HTMLDivElement>(null);
  const near = useNearScreen(card);
  const mint = useCallback(() => api.api<WorkspaceChatFileAccessAnswer>(
    `api/agents/${encodeURIComponent(agentId)}/chat/files/${encodeURIComponent(file.id)}?preview=1`,
  ), [agentId, api, file.id]);
  const { link, broken, shape, events } = usePlayer(file.id, mint, near);

  // The frame taking the clip's own shape after the row was drawn grows or
  // shrinks it, once; a following reader is carried with it.
  const drawnShape = useRef(shape);
  useLayoutEffect(() => {
    if (shape === drawnShape.current) return;
    drawnShape.current = shape;
    onPictureLoaded();
  }, [onPictureLoaded, shape]);

  if (broken) return <FileItem {...props} />;
  return (
    <div
      className={`chatfileitem chatmediaitem ${video ? 'chatvideoitem' : 'chataudioitem'}`}
      ref={card}
      style={video ? ({ '--video-shape': shape ?? '16 / 9' } as CSSProperties) : undefined}
    >
      {video
        ? (
          <span className="chatvideo">
            <video src={link ? videoSrc(link.url) : undefined} controls playsInline preload="metadata" aria-label={file.fileName} {...events} />
          </span>
        )
        : <audio src={link?.url} controls preload="metadata" aria-label={file.fileName} {...events} />}
      <button className="chatfileline" type="button" aria-label={`Download ${file.fileName}`} onClick={() => onOpen(file)}>
        <TypeIcon glyph={kind.glyph} tint={kind.tint} />
        <span>{file.fileName} · {bytes(file.sizeBytes)}</span>
        <Icon name="arrowdown" size={16} className="icon chatsave" />
      </button>
    </div>
  );
}

function PlatformNotice({ row, notes, onOpenProposal, agentId = '' }: {
  row: TranscriptRow;
  notes: NoteRefs;
  onOpenProposal: (open: { pr?: string; kp?: string }) => void;
  agentId?: string;
}) {
  const notice = platformChatNotice(row.text);
  const open = row.open ?? {};
  const navigate = useNavigate();
  // A receipt that names a note is a door to it, exactly as one naming a
  // proposal is a door to that. WHERE that door sits depends on the shape the
  // row takes below: on a CARD the whole card is the target, because a link
  // cannot sit inside the button the card already is; on a quiet line there is
  // no button, so the number in the sentence is the link itself.
  const noteNumber = notice.note ? Number(notice.note) : 0;
  const toNote = noteNumber ? notes.link(noteNumber) : null;
  const opensScreen = Boolean(open.pr || open.kp || row.href);
  const opens = opensScreen || Boolean(toNote);
  // The recogniser names its own door, because what is behind one differs: an
  // ask is decided, an outcome is read. A row carrying `open` whose text no
  // recogniser claimed still opens — it just says so in the one word that
  // cannot be wrong about a screen nobody here identified.
  const door = notice.door || 'Open';
  // A row the reader did not receive so much as LIVE THROUGH — their own stop
  // (note #384), the fresh chat they asked for (note #394) — is not news to be
  // filed: it says its one sentence in the day rail's quiet voice, where the
  // fresh-chat rule already speaks, and keeps the moment on `title` exactly as
  // that rule does.
  //
  // A note named in that sentence is still a door, but an INLINE one: the
  // whole quiet line cannot be the button a card is, because a line that looks
  // like the day rail and behaves like a button is a target nobody can see.
  // The number wears the same anchor a note gets in any other message, which
  // is a phrase rather than four digits precisely so a thumb can hit it.
  // A row with a PROPOSAL behind it is news from elsewhere and keeps its card.
  if (notice.quiet && !opensScreen) {
    return (
      <div
        className={`chatmsg chatquiet${row.arriving ? ' arriving' : ''}`}
        title={row.at ? new Date(row.at).toLocaleString() : undefined}
      >
        <NoteLinked text={notice.title} notes={notes} />
      </div>
    );
  }
  const detail = typeof notice.detail === 'string' ? [notice.detail] : notice.detail;
  // A generic receipt has no icon, category or status (note #448), so there
  // is nothing to justify a separate header row. Put its time into the title
  // line instead: it floats at the right of the first line while wrapped
  // title text reclaims the full width beneath it.
  const plain = !notice.icon && !notice.label && !notice.badge;
  const card = (
    <div className={cardTone(notice.tone)}>
      {notice.icon ? <div className="chatnoticeicon"><Icon name={notice.icon} size={16} /></div> : null}
      <div className="chatnoticebody">
        {plain
          ? (
            <div className="chatnoticetitle chatnoticeplaintitle">
              {row.at ? <span className="chatnoticetime">{clockOf(row.at)}</span> : null}
              {notice.title}
            </div>
          )
          : (
            <>
              <div className="chatnoticehead">
                {notice.label ? <span className="chatnoticelabel">{notice.label}</span> : null}
                {notice.badge ? <span className={noticeBadgeClass(notice)}>{notice.badge}</span> : null}
                {row.at ? <span className="chatnoticetime">{clockOf(row.at)}</span> : null}
              </div>
              <div className="chatnoticetitle">{notice.title}</div>
            </>
          )}
        {detail.length
          ? (
            <div className="chatnoticedetail">
              {detail.map((part, index) => (typeof part === 'string'
                ? <span key={index}>{part}</span>
                : <span className={part[1]} key={index}>{part[0]}</span>))}
            </div>
          )
          : null}
        {notice.meta ? <div className="chatnoticemeta">{notice.meta}</div> : null}
        {notice.label === 'Schedule' && notice.badge === 'Awaiting approval' && agentId ? <ScheduleAskActions agentId={agentId} /> : null}
        {opens ? <div className="chatnoticedoor">{door}</div> : null}
      </div>
    </div>
  );
  // A frame is for news that ARRIVED, or a decision waiting on the reader
  // (note #481). A generic receipt is neither: it is the platform narrating
  // what it just did on the reader's own behalf — "Sent to Alex: …", "A new
  // briefing was written", "Alex finished without sending a reply here" — and
  // in the Workspace Agent's conversation that narration is most of the
  // column. Bordered and full-bleed, it out-shouted the replies it was
  // annotating, which is the report this fixes: three voices drawn as one
  // stack of grey rectangles, with the least important of them the heaviest.
  //
  // So the plain receipt keeps every word and gives up its box: a margin note
  // against the transcript, marked by a rule down its left edge. The receipts
  // a recogniser CLAIMED — a proposal awaiting a decision, a merged change, a
  // deleted site — keep the card, and that is now what the card means.
  const className = `chatmsg platform${plain ? ' aside' : ''}${notice.kind === 'knowledge' ? ' knowledge' : ''}${row.arriving ? ' arriving' : ''}`;
  if (!opens) {
    return <div className={className} title={row.at ? new Date(row.at).toLocaleString() : undefined}>{card}</div>;
  }
  return (
    <button
      className={className}
      type="button"
      title={row.at ? new Date(row.at).toLocaleString() : undefined}
      // Without this the accessible name is the whole receipt read aloud.
      aria-label={`${door}: ${notice.title}`}
      onClick={() => (row.href ? navigate(row.href) : toNote ? notes.open(noteNumber) : onOpenProposal(open))}
    >
      {card}
    </button>
  );
}

/**
 * Who is speaking in a peer's bubble: the sender's picture, then their name
 * (note #353).
 *
 * The picture answers a pointer the way the same picture does in the decision
 * queue — the compact card, with that agent's runtime, whether it is working
 * right now and what it last did — and it is the door onto the agent behind
 * it. A transcript is where one agent's work is most often NAMED by another,
 * and until this the reader had a face they could neither question nor
 * follow: the fleet list was the only way from "Oscar rebased slice 4" to
 * what Oscar is.
 *
 * Both halves need the same one thing — WHICH agent this is — and the row
 * does not carry it: a peer's message is stored as its sender's name, so the
 * fleet is asked for the agent that goes by it. An unresolvable name (an
 * agent since erased, or two agents answering to it) keeps the picture it
 * always had, with no card and no door, which is the honest answer to "who
 * exactly is this?".
 *
 * The NAME is deliberately left as text. Note #339 took the accent off it
 * because blue reads as something to tap and a speaker's name is not a link;
 * making the words themselves a door now would put that affordance back
 * without the colour, which is worse than either.
 */
function PeerFrom({ from, avatarUrl }: { from: string; avatarUrl?: string }) {
  const { agents } = useWorkspace();
  const agent = agentNamed(agents, from);
  const to = agent ? toFor({ kind: 'agent', id: agent.id }) : null;
  return (
    <div className="chatfrom">
      {avatarUrl
        ? (
          <AgentHover id={agent?.id} name={from} avatarUrl={avatarUrl}>
            {to
              ? (
                <Link className="facebtn" to={to} aria-label={`Open ${from}`}>
                  <img className="face" src={avatarUrl} alt="" />
                </Link>
              )
              : <img className="face" src={avatarUrl} alt="" />}
          </AgentHover>
        )
        : null}
      <span>{from}</span>
    </div>
  );
}

/**
 * A peer's report, folded (note #744): on the Chief of Staff's chat only,
 * where an agent's report is written for the Chief of Staff and answered to
 * the reader in its own short words straight after. The sender stands as
 * always — the face still opens the agent — then two lines of what it says,
 * and the whole of those lines is the button that opens it IN PLACE.
 * Open, the report is drawn in full, links and all; a tap on its words
 * (not on a link, and not one that ended a text selection) or on "Show
 * less" folds it again. Short reports never fold: nothing would be hidden.
 * Open or folded is the reader's for as long as the screen is up.
 */
function PeerReport({ from, avatarUrl, text, notes, workspaceLinks }: {
  from: string;
  avatarUrl?: string;
  text: string;
  notes: NoteRefs;
  workspaceLinks: boolean;
}) {
  const [open, setOpen] = useState(false);
  const preview = reportPreview(text);
  const close = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('a, button, input, textarea, summary, video, audio, img')) return;
    if (window.getSelection?.()?.toString()) return;
    setOpen(false);
  };
  return (
    <>
      <PeerFrom from={from} avatarUrl={avatarUrl} />
      {open
        ? (
          <>
            <div className="peerreportbody" onClick={close}>
              <Markdown source={text} className="chatmarkdown" notes={notes} workspaceLinks={workspaceLinks} />
            </div>
            <button className="peerfold open" type="button" aria-expanded="true" onClick={() => setOpen(false)}>Show less</button>
          </>
        )
        : (
          <button className="peerfold" type="button" aria-expanded="false" aria-label={`Read ${from}'s whole report: ${preview}`} onClick={() => setOpen(true)}>
            <span className="peerpreview">{preview}</span>
            <span className="peerfoldmore" aria-hidden="true">Read all</span>
          </button>
        )}
    </>
  );
}

/**
 * Memoised, because the screen above re-renders on every poll and a row's
 * Markdown is parsed in render: five hundred rows re-parsed every three
 * seconds is work a phone can feel, for a transcript that did not change.
 * Everything a row is given is stable across polls — the row object itself is
 * kept by the merge, and the screen holds its callbacks — so this is free.
 */
export const ChatMessageRow = memo(function ChatMessageRow({ row, agentId, onOpenProposal, onOpenFile, onPictureLoaded, workspaceLinks = false, foldReports = false }: {
  row: TranscriptRow;
  agentId: string;
  /** A long report from another agent stands folded to two lines and opens
   *  in place (note #744) — the Chief of Staff's chat, where the reports are
   *  written for it and answered to the reader in short straight after. */
  foldReports?: boolean;
  /** Render `[#430](/workspace/notes/430?room=…)` as the door it names. On
   *  only on surfaces where an agent's registered Workspace destinations
   *  belong. The renderer still refuses unsafe and unregistered paths. */
  workspaceLinks?: boolean;
  onOpenProposal: (open: { pr?: string; kp?: string }) => void;
  /** Out of the Workspace, with a URL minted at the tap: the path for a file
   *  that is not a picture on screen. A picture opens in the shared viewer
   *  instead, which this row does itself. */
  onOpenFile: (file: WorkspaceChatFile) => void;
  onPictureLoaded: () => void;
}) {
  // Note #137's fresh-chat marker is punctuation, not a platform event. Test
  // the structured kind BEFORE the generic platform renderer; otherwise its
  // intentionally wordless rule becomes a card titled "Platform update".
  const notes = useNoteRefs();
  const viewer = useImageViewer();
  const documents = usePdfViewer();
  const gallery = useChatGallery();
  // The URL of every picture this row has actually PAINTED, handed up as each
  // one lands. Held on the ROW rather than fetched again at the tap, exactly
  // as a note's files card holds its own: the picture is already on screen,
  // and opening it full screen should cost nothing.
  const [urls, setUrls] = useState<Record<string, string>>({});
  const onShown = useCallback((id: string, url: string) => {
    setUrls((was) => (was[id] === url ? was : { ...was, [id]: url }));
  }, []);
  // A Markdown file opens as a page of its own words (note #677), with the
  // screen's save path as its Download, as a page's is. The card that read
  // the words is the one that hands them over, at the tap: held up here,
  // they would reach this row a render after the card could be tapped.
  const openPage = useCallback((file: WorkspaceChatFile, text: string) => {
    documents({ text, name: file.fileName, kind: 'markdown', save: () => onOpenFile(file) });
  }, [documents, onOpenFile]);
  if (row.kind === 'new-chat-divider') {
    return (
      <div className={`chatmsg newchatdivider${row.arriving ? ' arriving' : ''}`} role="separator" title={row.at ? new Date(row.at).toLocaleString() : undefined}>
        {/* A rule with its words (note #725): the stored row is thirty
            dashes, which drew a line that said nothing about what it
            divides. */}
        <span>New conversation</span>
      </div>
    );
  }

  if (row.mailApprovalId) {
    return <MailApprovalCard id={row.mailApprovalId} approval={row.mailApproval} at={row.at} fallback={row.text} />;
  }

  // Proposals the Chief of Staff forwarded (note #724): the cards, as they
  // stand now. A row past the freshly-read window has none and falls through
  // to its own words below.
  if (row.forwarded?.length) {
    return <ForwardedProposals forwarded={row.forwarded} at={row.at} arriving={row.arriving} />;
  }

  const role = row.role === 'owner' ? 'owner' : row.role === 'agent' ? 'agent' : 'platform';
  const peer = role === 'platform' ? peerChatMessage(row.text) : null;
  // An AGENT speaks on the page; only the reader wears a bubble (note #481).
  // Carried as its own class rather than written against `.chatmsg.agent`,
  // because that class is also the other PERSON in a direct message and the
  // held turn a loading transcript draws — both of which are bubbles and stay
  // bubbles. Only a row this component renders is an agent talking.
  const flat = role === 'agent' || Boolean(peer) ? ' flat' : '';
  const arriving = row.arriving ? ' arriving' : '';
  const title = row.at ? new Date(row.at).toLocaleString() : undefined;
  const time = row.at ? clockOf(row.at) : undefined;

  if (role === 'platform' && !peer) return <PlatformNotice row={row} notes={notes} onOpenProposal={onOpenProposal} agentId={agentId} />;

  const files = filesOf(row);
  /**
   * A tap on a file (note #294). A picture opens where every other picture in
   * the Workspace opens — the shared full-screen viewer — and the message's
   * OTHER pictures are its gallery, because one message carries as many
   * files as were picked (note #672) and the second of them is otherwise
   * reachable only by closing this and finding it again.
   *
   * A PDF opens in the document viewer beside it (note #403), alone rather
   * than in a gallery: it is read, not glanced at past its neighbours. An
   * HTML page opens in the same viewer, sandboxed (note #557), with the
   * screen's own save path as its Download — the viewer shows the preview
   * link it was handed, and saving mints a link signed for saving at the
   * press, exactly as a picture's Download does.
   *
   * A Markdown file whose words its card has read opens in that viewer too,
   * as a page drawn from them (note #677) — from the card, which holds them.
   *
   * Everything else leaves for the browser's own handler, and so does a
   * picture whose bytes never arrived: that row is showing its NAME, and a
   * viewer opened on a URL this screen never got would be a black screen with
   * a filename on it.
   */
  const openFile = (file: WorkspaceChatFile) => {
    const held = urls[file.id];
    if (held && isInlinePdf(file.contentType, file.fileName)) {
      documents({ url: held, name: file.fileName });
      return;
    }
    if (held && isInlineHtml(file.contentType, file.fileName)) {
      documents({ url: held, name: file.fileName, kind: 'html', save: () => onOpenFile(file) });
      return;
    }
    // The gallery is the whole CONVERSATION's painted pictures when the
    // screen keeps that register (note #544), and this message's own where
    // it does not. Either way only pictures on screen are in it.
    const photos = gallery
      ? gallery.pictures().map((entry) => ({ file: entry.file, url: entry.url }))
      : files
        .filter((entry) => isInlineImage(entry.contentType) && urls[entry.id])
        .map((entry) => ({ file: entry, url: urls[entry.id]! }));
    const at = photos.findIndex((photo) => photo.file.id === file.id);
    if (at < 0) { onOpenFile(file); return; }
    // Each picture carries its own Download (note #552): the viewer shows
    // the preview it was handed, and saving goes back through the screen,
    // which mints a URL signed for saving at the press — exactly the path an
    // archive takes from its row.
    viewer(photos.map((photo) => ({
      url: photo.url,
      name: photo.file.fileName,
      save: () => onOpenFile(photo.file),
    })), at);
  };
  let body: ReactNode;
  let extra = '';
  if (peer && foldReports && peer.from !== CHIEF_OF_STAFF && foldsReport(peer.text)) {
    extra = ' rich report';
    body = <PeerReport from={peer.from} avatarUrl={row.fromAvatarUrl} text={peer.text} notes={notes} workspaceLinks={workspaceLinks} />;
  } else if (peer) {
    // Their words go through the same renderer this agent's own replies use —
    // an agent wrote them, and the only thing that differs is which agent.
    // The face comes from the backend or not at all: only the server knows
    // whether the pool has a picture for that name. What that face ANSWERS
    // to is `PeerFrom` above.
    extra = ' rich';
    body = (
      <>
        {/* The Chief of Staff has no face (note #715): its name alone. */}
        <PeerFrom from={peer.from} avatarUrl={peer.from === CHIEF_OF_STAFF ? undefined : row.fromAvatarUrl} />
        <Markdown source={peer.text} className="chatmarkdown" notes={notes} workspaceLinks={workspaceLinks} />
      </>
    );
  } else if (files.length) {
    // The words first, in a bubble of their own, and the files under it
    // standing outside that bubble rather than inside it (note #160).
    extra = ' chatfile';
    body = (
      <>
        {row.text ? <div className="chatfilecaption" data-time={time}><NoteLinked text={row.text} notes={notes} /></div> : null}
        {files.map((file, index) => {
          const item = {
            agentId, file, seq: row.seq, index, onOpen: openFile, onPictureLoaded, onShown,
          };
          if (agentId && isMarkdown(file.contentType, file.fileName)) return <MarkdownFileItem key={file.id} {...item} onOpenPage={openPage} />;
          if (agentId && (isVideo(file.contentType, file.fileName) || isAudio(file.contentType, file.fileName))) {
            return <MediaFileItem key={file.id} {...item} />;
          }
          return <FileItem key={file.id} {...item} />;
        })}
      </>
    );
  } else if (role === 'agent') {
    extra = ' rich';
    body = <Markdown source={row.text} className="chatmarkdown" notes={notes} workspaceLinks={workspaceLinks} />;
  } else {
    // The owner's own words are not agent-authored Markdown. Preserve them
    // exactly as typed, including any punctuation that resembles formatting —
    // a note they named is the one thing that gains anything, and it gains a
    // door rather than a different word.
    body = <NoteLinked text={row.text} notes={notes} />;
  }

  // The clock goes with the words: on a file row the message's last line is
  // the caption, so the row itself gives the attribute up.
  const rowTime = files.length && row.text ? undefined : time;
  return (
    <div
      className={`chatmsg ${peer ? 'peer' : role}${flat}${extra}${arriving}`}
      data-time={rowTime}
      data-gallery={files.length ? 'chat-message-files' : undefined}
      title={title}
    >
      {body}
    </div>
  );
});

/**
 * A message on its way (note #658): in the conversation from the moment Send
 * is pressed, in the reader's own bubble, with "Sending…" where its clock
 * will be. It stands until its row is read, which takes its place in the
 * same commit — or until it is refused, when its words go back to the box.
 *
 * Its files are NAMED, not drawn. The row that replaces it draws a picture
 * from the server's copy, and a preview painted here from the local file
 * would blink out and back in as the two swapped.
 *
 * It rises in the way a send always has (note #157); the dimming that says
 * it is still going waits a second in the stylesheet, so a send the server
 * answers at once never flashes pale.
 */
export function OutgoingMessageRow({ message }: { message: OutgoingMessage }) {
  // The words exactly as their row will draw them, a named note a door
  // already, so the swap changes the clock and nothing else.
  const notes = useNoteRefs();
  // A big file going up in parts says how far it has got (note #943).
  const time = message.percent !== undefined && message.state === 'sending' ? `Sending… ${message.percent}%` : 'Sending…';
  if (!message.files.length) {
    return (
      <div className="chatmsg owner sending arriving" data-time={time} aria-busy="true">
        <NoteLinked text={message.text} notes={notes} />
      </div>
    );
  }
  return (
    <div className="chatmsg owner chatfile sending arriving" data-time={message.text ? undefined : time} aria-busy="true">
      {message.text ? <div className="chatfilecaption" data-time={time}><NoteLinked text={message.text} notes={notes} /></div> : null}
      {message.files.map((file, index) => {
        const kind = fileIcon(file.name);
        const name = safeFileName(file.name);
        return (
          <div className="chatfileitem" key={`${name}:${index}`}>
            <div className="chatfileline">
              <TypeIcon glyph={kind.glyph} tint={kind.tint} />
              <span>{name} · {bytes(file.size)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
