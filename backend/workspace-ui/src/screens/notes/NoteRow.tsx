/**
 * One note as a row — home draws the recent few, and the list, the archive
 * and a search result draw them all. The same component in all four places,
 * because a note opened from one of them has to be the same note opened from
 * any other.
 *
 * Every note leads with WHO, then what it says. An agent's note has worn its
 * face and name this way since 2026-08-17 — the name is who KEEPS the note,
 * which is the actionable half of the row. A human's note now wears the same
 * line (note #60): their face and their name, the viewer's own included —
 * "you wrote this" said nothing anyone could recognise at a glance.
 *
 * The row deliberately has no leading icon: the mark it carries is the
 * glimpse of what is ATTACHED, inside the main cell beside the file's name.
 */

import { useEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type PointerEvent } from 'react';
import type {
  WorkspaceNoteAttachmentPreview,
  WorkspaceNoteRow as NoteRowData,
} from '../../../../src/shared/workspace-api.js';
import { CommentPreview } from '../../render/CommentPreview.js';
import { useNoteRefs } from '../../render/useNoteRefs.js';
import { AgentLine } from '../../ui/AgentLine.js';
import { useSession } from '../../session/useSession.js';
import { fileIcon, isInlineImage } from '../../ui/file-kind.js';
import { Icon, TypeIcon } from '../../ui/icons.js';
import { relative, useNow } from '../../ui/time.js';
import { PressableRow } from '../home/PressableRow.js';
import { heldNotePreviewUrl, notePreviewKey, notePreviewUrl } from './note-previews.js';
import { personName } from '../../ui/chief-of-staff.js';
import {
  SWIPE_SLOP, commentSignerName, noteAuthorName, noteWorkBadgeClass, noteWorkLabel, swipeThreshold,
} from './note-words.js';

/** The row's own element, as the swipe wrapper needs to dress it. Typed on
 *  `HTMLElement`: a note row is an anchor when it has an address to carry
 *  (note #284), and the swipe rides the same element either way. */
export interface RowExtras {
  className?: string;
  attrs?: Omit<HTMLAttributes<HTMLElement>, 'className' | 'onClick' | 'onKeyDown' | 'role' | 'tabIndex'>;
}

/** The dot every faceless person wears. */
function PersonDot() {
  return <Icon name="user" size={11} className="face dot" />;
}

/**
 * A file glimpse inside the row's main cell — what the note CARRIES.
 *
 * A photograph that has already been minted goes back WITH the row: the
 * browser holds those bytes against that exact URL, so there is no request
 * and no frame of file glyph in place of a picture that never changed. Only a
 * picture with no URL yet waits for the viewport, because the mint is the
 * only thing the observer exists to avoid.
 */
function NoteFilePreviewMark({ note, file }: {
  note: NoteRowData;
  file: WorkspaceNoteAttachmentPreview;
}) {
  const { api } = useSession();
  const number = note.number;
  const fileId = file.id;
  const inline = isInlineImage(file.contentType);
  const [url, setUrl] = useState(() => (inline ? heldNotePreviewUrl(notePreviewKey(note, file)) : null));
  const [loaded, setLoaded] = useState(false);
  const host = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!inline || url) return;
    let alive = true;
    const load = () => {
      notePreviewUrl(api, { number }, { id: fileId })
        // A row can be rebuilt while its mint is out; that copy is detached,
        // and an <img> in it would decode bytes for nobody.
        .then((minted) => { if (alive && minted) setUrl(minted); })
        // The typed file glyph is already the truthful fallback. A list should
        // not grow an error banner because one decorative glimpse failed.
        .catch(() => {});
    };
    const node = host.current;
    if (!node || typeof window.IntersectionObserver !== 'function') { load(); return () => { alive = false; }; }
    const observer = new window.IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      load();
    }, { rootMargin: '160px 0px' });
    observer.observe(node);
    return () => { alive = false; observer.disconnect(); };
  }, [api, inline, url, number, fileId]);

  const kind = fileIcon(file.fileName);
  return (
    <span className="notepeek" title={file.fileName} aria-hidden="true" ref={host}>
      {/* The glyph stands until the pixels land, then goes — exactly as the
          legacy mark removes it on load, so nothing flashes empty. */}
      {loaded ? null : <TypeIcon glyph={kind.glyph} tint={kind.tint} />}
      {url ? <img alt="" decoding="async" src={url} onLoad={() => setLoaded(true)} onError={() => setUrl(null)} /> : null}
    </span>
  );
}

/** A file preview in the main cell: its visual mark and exact name. Byte size
 *  is noise at list level; when a note has more, the short remainder still
 *  says so without turning a five-file note into a five-line row. */
function NoteFileLine({ note }: { note: NoteRowData }) {
  const file = note.attachmentPreview;
  if (!file) return null;
  const more = Math.max(0, (note.files ?? 1) - 1);
  return (
    <div className="cline nfile">
      <NoteFilePreviewMark note={note} file={file} />
      <span className="ctext">{file.fileName}</span>
      {more ? <span className="badge mut">+{more} more</span> : null}
    </div>
  );
}

/** The human counterpart of the agent line (note #60): their face — or the
 *  dot every faceless person wears — then their name, then the words. */
function PersonLine({ note, tail }: { note: NoteRowData; tail: string }) {
  return (
    <>
      {note.authorPhotoUrl ? <img className="face" src={note.authorPhotoUrl} alt="" /> : <PersonDot />}
      <span className="ctext keep">{noteAuthorName(note)}</span>
      {tail ? <><span className="csep">·</span><span className="ctext">{tail}</span></> : null}
    </>
  );
}

/**
 * The face and the name for the newest remark: the mark first, then who made
 * it, and never a door — the whole row already opens the note, and a second
 * destination inside it would make one tap mean two things.
 *
 * The face slot is ALWAYS filled, which is the point of the dot: on the
 * user's own notes — nearly all of them — this is the only mark on the row,
 * and it is what says these are somebody else's words ABOUT the note rather
 * than more of the note (note #177).
 */
function CommentLine({ comment }: { comment: NonNullable<NoteRowData['lastComment']> }) {
  if (comment.byPerson) {
    return (
      <>
        {comment.userPhotoUrl ? <img className="face" src={comment.userPhotoUrl} alt="" /> : <PersonDot />}
        {comment.userName ? <span className="ctext keep">{comment.userName}</span> : null}
      </>
    );
  }
  return (
    <>
      {/* A retired agent keeps the dot it always had: the remark still
          stands, there is simply nobody left to point at. */}
      {comment.agentAvatarUrl
        ? <img className="face" src={comment.agentAvatarUrl} alt="" />
        : <PersonDot />}
      {comment.agentName ? <span className="ctext keep">{personName(comment.agentName)}</span> : null}
    </>
  );
}

/** The visible words of a remark's glimpse, for the one decision the row
 *  makes about it: whether there is anything to separate from the name. */
function previewWords(comment: NonNullable<NoteRowData['lastComment']>): string {
  return (comment.text ?? '').replace(/<[^>]*>/g, '').trim();
}

export function NoteRow({ note, saysArchived, onOpen, rowProps }: {
  note: NoteRowData;
  /** Only a search result wears this (note #242). On the archive's own screen
   *  every row is archived and the badge would be wallpaper; in a result list
   *  mixing both, it is the one fact that says why the row will not be on the
   *  notes screen the reader searched from. */
  saysArchived?: boolean;
  onOpen: (number: number) => void;
  /** What the swipe wrapper hangs on the row itself: its class, its
   *  transform, and the pointer handlers that drive both. */
  rowProps?: RowExtras;
}) {
  const now = useNow(false);
  // The row IS a link to the note (note #284). Nothing about it looks
  // different; what it gains is everything a browser does with a real
  // address — open in a new tab, copy the link, long-press it.
  const to = useNoteRefs().link(note.number);
  const said = note.lastComment;
  // The count is dropped when the line below is about to say the whole of it:
  // "1 comment" over the comment itself is the row telling the reader twice.
  // From two up it earns its place again.
  const commentBadge = note.comments && !(said && note.comments === 1)
    ? (note.comments === 1 ? '1 comment' : `${note.comments} comments`)
    : '';
  // Older backends supplied only a count. Keep that honest fallback while the
  // current one replaces it with the named preview line below.
  const fileBadge = note.files && !note.attachmentPreview
    ? (note.files === 1 ? '1 file' : `${note.files} files`)
    : '';
  const tail = note.preview || '';
  const person = Boolean(note.byUser || note.byMember);
  const hasAuthorLine = person || Boolean(note.agentName) || Boolean(tail);
  const archivedBadge = Boolean(saysArchived && note.archivedAt);
  // Nothing left to put on it: a note the reader wrote themselves, carrying no
  // files, whose line has just been handed to the remark below. An empty 18px
  // gap between the title and that remark reads as a fault.
  const hasLine = hasAuthorLine || Boolean(note.work) || archivedBadge
    || Boolean(fileBadge) || Boolean(commentBadge);
  // An archived row says when it was PUT AWAY, not when it was last written:
  // that is the order the archive is sorted in, and a column disagreeing with
  // the order it sits in reads as a broken sort.
  const when = note.archivedAt || note.updatedAt;
  return (
    <PressableRow
      className={rowProps?.className ? `crow open ${rowProps.className}` : 'crow open'}
      {...(to ? { href: to.href } : {})}
      onPress={() => onOpen(note.number)}
      {...(rowProps?.attrs ?? {})}
    >
      <div className="main">
        <div className="name plain">{note.title}</div>
        {hasLine ? (
          <div className="cline">
            {person ? <PersonLine note={note} tail={tail} /> : <AgentLine subject={note} tail={tail} />}
            {note.work ? <span className={noteWorkBadgeClass(note.work)}>{noteWorkLabel(note.work)}</span> : null}
            {archivedBadge ? <span className="badge mut">Archived</span> : null}
            {fileBadge ? <span className="badge mut">{fileBadge}</span> : null}
            {commentBadge ? <span className="badge mut">{commentBadge}</span> : null}
          </div>
        ) : null}
        <NoteFileLine note={note} />
        {said ? (
          <div className="cline said">
            <CommentLine comment={said} />
            {commentSignerName(said) && previewWords(said) ? <span className="csep">·</span> : null}
            {previewWords(said) ? <CommentPreview comment={said} /> : null}
          </div>
        ) : null}
      </div>
      {/* The note's NUMBER, over the time it was last touched. It is the name
          every other surface calls this note by — the CLI prints "#16", an
          agent's remark refers to "note #10" — and the one screen where all
          the notes are in front of you was the only place that never said it
          (note #19). Mono, in the right-hand column, exactly as a proposal's
          number is. */}
      <div className="cside stack">
        <div className="num">#{note.number}</div>
        {when ? <div className="cwhen">{relative(when, now)}</div> : null}
      </div>
    </PressableRow>
  );
}

/**
 * A live note row with the one action a right swipe reveals — on the reader's
 * OWN notes.
 *
 * Pointer events cover touch, pen and a trackpad/mouse drag with the same
 * path. A horizontal gesture consumes the tap it ends with, so archiving can
 * never also open the note underneath it — the legacy row does that with a
 * capture-phase click handler; here the flag is read where the press is
 * decided, which is the same answer with one less listener.
 *
 * The server has the final say. Once it accepts the archive, the list updates
 * immediately and the ordinary state read reconciles behind it; a refusal
 * puts the row back where it was and says why.
 *
 * A teammate's note is drawn as the plain row instead (note #637): filing one
 * is theirs to do, the server refuses it, and a gesture whose every ending is
 * a red banner is worse than a row that never offered it.
 */
export function NoteSwipeRow({ note, onOpen, onArchive }: {
  note: NoteRowData;
  onOpen: (number: number) => void;
  /** True once the server has taken it. False puts the row back. */
  onArchive: (note: NoteRowData) => Promise<boolean>;
}) {
  const [dragging, setDragging] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [x, setX] = useState(0);
  // Measured when the gesture starts, not while rendering: a render must not
  // read layout, and the row cannot change width under a finger anyway.
  const [width, setWidth] = useState(0);
  const gesture = useRef<{ id: number; x: number; y: number; dx: number; axis: 'x' | 'y' | null } | null>(null);
  const suppress = useRef(false);
  const suppressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const row = useRef<HTMLElement | null>(null);

  useEffect(() => () => clearTimeout(suppressTimer.current), []);

  // After the hooks, never before them: which row is drawn changes with the
  // note, and the ones above have to run on every one of them.
  if (!note.yours) return <NoteRow note={note} onOpen={onOpen} />;

  // jsdom has no layout, so the fallback is also the phone-sized value the
  // behaviour tests exercise; a real row always supplies its rendered width.
  const measured = width || 320;
  const ready = x >= swipeThreshold(measured);

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (archiving || event.isPrimary === false) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    row.current = event.currentTarget;
    setWidth(event.currentTarget.getBoundingClientRect().width);
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, axis: null };
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const held = gesture.current;
    if (!held || held.id !== event.pointerId) return;
    const dx = event.clientX - held.x;
    const dy = event.clientY - held.y;
    if (!held.axis) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_SLOP) return;
      held.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      // A vertical drag is the reader scrolling. Let go of it entirely.
      if (held.axis === 'y') { gesture.current = null; return; }
      setDragging(true);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    if (held.axis !== 'x') return;
    if (event.cancelable) event.preventDefault();
    held.dx = Math.max(0, dx);
    setX(Math.max(0, Math.min(held.dx, measured)));
  };

  const finish = (event: PointerEvent<HTMLElement>, cancelled: boolean) => {
    const held = gesture.current;
    if (!held || held.id !== event.pointerId) return;
    const horizontal = held.axis === 'x';
    const commit = !cancelled && horizontal && held.dx >= swipeThreshold(measured);
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (horizontal) {
      suppress.current = true;
      clearTimeout(suppressTimer.current);
      suppressTimer.current = setTimeout(() => { suppress.current = false; }, 0);
    }
    setDragging(false);
    if (!commit) { setX(0); return; }
    setArchiving(true);
    setX(measured);
    void onArchive(note).then((ok) => {
      // A refusal is the only path back: on success this row is about to
      // leave the list entirely, and settling it first would be a flash of a
      // note that is already gone.
      if (!ok) { setArchiving(false); setX(0); }
    });
  };

  const shell = ['noteswipe', dragging ? 'dragging' : '', ready ? 'ready' : '', archiving ? 'archiving' : '']
    .filter(Boolean).join(' ');
  return (
    <div className={shell}>
      <div className="noteswipeaction" aria-hidden="true">
        <Icon name="archive" size={18} />
        <span>Archive</span>
      </div>
      <NoteRow
        note={note}
        onOpen={(number) => { if (!suppress.current) onOpen(number); }}
        rowProps={{
          className: 'noteswiperow',
          attrs: {
            style: { '--note-swipe-x': `${x}px` } as CSSProperties,
            'aria-description': 'Swipe right to archive this note.',
            onPointerDown,
            onPointerMove,
            onPointerUp: (event) => finish(event, false),
            onPointerCancel: (event) => finish(event, true),
          },
        }}
      />
    </div>
  );
}
