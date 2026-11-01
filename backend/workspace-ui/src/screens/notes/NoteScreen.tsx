/**
 * One quick note, whole.
 *
 * The note's own HTML, rebuilt node by node through the page's allowlist —
 * the same renderer, and the same typography, a knowledge page is read in.
 * Nothing an agent wrote ever becomes markup.
 *
 * The order on the screen is an argument: what the note SAYS — its words and
 * then what it CARRIES, because a file on a note is part of what the note
 * says — then who could take it on, then what has been said ABOUT it, then
 * what can be DONE to it. The hand-off row follows the whole of the note
 * because the note is read and the next question is who does it; the delete
 * sits at the bottom because a destructive button at the top would be the
 * first thing the eye lands on. Copy is the one exception to that last part,
 * and stands in the corner of the WORDS: it is the only action here that
 * changes nothing, and it is about the prose rather than about the note as a
 * thing the account holds.
 *
 * Two transient leaves keep this address underneath them (knowledge page
 * "miniapp-navigation"): the message to an agent, and the edit. Back closes
 * either rather than spending a history entry, which is what lets the reader
 * come back to the note at the line they left.
 *
 * A note is the WORKPLACE's (note #843). While notes were a room's this
 * screen read the number in the room the address named, said "in <room>"
 * under the title, corrected an address that named the wrong room, and
 * offered Move note to send it to another room; none of that is left.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  WorkspaceMarginComment,
  WorkspaceNoteAttachment,
  WorkspaceNoteDetailAnswer,
  WorkspaceNoteHandoffRequest,
  WorkspaceNoteRecord,
} from '../../../../src/shared/workspace-api.js';
import { useReturnToParent } from '../../chrome/history.js';
import { useBanner } from '../../chrome/useBanner.js';
import { KnowledgeHtml } from '../../render/KnowledgeHtml.js';
import { useNoteRefs } from '../../render/useNoteRefs.js';
import { toFor, workspaceScope } from '../../routes.js';
import { useSession } from '../../session/useSession.js';
import { AgentFace } from '../../ui/AgentFace.js';
import { AskToConfirm } from '../../ui/Ask.js';
import { HandRow } from '../../ui/HandRow.js';
import { HandoffSend } from '../../ui/HandoffSend.js';
import { copyFromTap } from '../../ui/format.js';
import { noteHandoffText } from '../../ui/handoff.js';
import { Icon } from '../../ui/icons.js';
import { SeatStrip } from '../../ui/SeatStrip.js';
import { readOrSayWhy, worthAskingAgain } from '../../ui/read.js';
import { useNow } from '../../ui/time.js';
import { useWait } from '../../ui/wait.js';
import type { HomeAgent } from '../../workspace/live.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { MarginThread } from '../decisions/MarginThread.js';
import { NoteComposer } from './NoteComposer.js';
import { useNoteFiles } from './NoteFilesCard.js';
import { forgetNote, heldNote, holdNote } from './note-cache.js';
import { noteClipboardText } from './note-clipboard.js';
import { sendNoteHandoff } from './note-handoff.js';
import {
  ARCHIVED_NOTE_HINT, noteAlreadyOwned, noteBodyTitle, noteEditHint, noteNotYoursHint,
  noteSubLine, noteSubParts, noteWorkAgentId,
} from './note-words.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Whether a fresh read said anything new.
 *
 * A note is opened with TWO reads and returned to with a third, and the usual
 * answer to all three is the same note. Setting state for that costs a render
 * — and `KnowledgeHtml` REBUILDS the words on one, tearing the note's own DOM
 * down and putting an identical copy back. Keeping the object the screen
 * already has is what makes "refetch silently" (note #306) true of the DOM and
 * not only of the pixels.
 *
 * Compared as text because that is what it is: both sides come off the wire
 * through the same serializer on the server, so their key order agrees, and a
 * note is small enough that this is cheaper than the render it saves.
 */
const sameNote = (a: WorkspaceNoteRecord, b: WorkspaceNoteRecord): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The face of the agent that HAS this note, on the words that say so —
 * "Working by Noah", "Handed to Noah" (note #236).
 *
 * A note names two agents at once and only one of them had a face: the one
 * that last WROTE it, at the head of the line. The one actually doing the
 * work was a name in the middle of a sentence, and the reader who wanted to
 * ask it how it was getting on had nowhere to tap. So the door goes exactly
 * where the fact is, rather than a second portrait at the head of the line
 * where it would be read as another author.
 *
 * Only for an agent the workplace still has: the work record carries an id
 * under that rule (note #640 — a teammate's agent has a screen of its own
 * now), and a face here without one would be a tap that leads nowhere.
 */
function NoteHolderFace({ holder, onAgentId }: {
  holder: { id: string; name?: string; avatarUrl?: string };
  onAgentId: (id: string) => void;
}) {
  return (
    <button
      className="facebtn workface"
      type="button"
      aria-label={holder.name ? `Open ${holder.name}` : 'Open this agent'}
      onClick={() => onAgentId(holder.id)}
    >
      <AgentFace agent={{ avatarUrl: holder.avatarUrl }} />
    </button>
  );
}

/**
 * Who to ask about this note, and when it last moved — the two things the
 * body itself cannot say.
 *
 * The agent comes first because it is the actionable half: the only way an
 * agent's note changes is a message to the agent that keeps it. Which is why
 * the face is a door, exactly as a proposal's is. An agent the fleet no longer
 * has keeps its picture and gets no button — a tap leading nowhere is worse
 * than a picture that was never offered as one.
 *
 * A note the reader wrote themselves has no agent, no face and no door: it
 * names them, because the person to ask about it is the one holding the phone.
 *
 * An agent HOLDING the note wears its own face beside the words that say so,
 * unless it is the same agent as the one at the head of the line — two
 * portraits of one agent is a duplicate, not a second fact, and the leading
 * face is already its door.
 */
function NoteWho({ note, onAgentId, onPerson }: {
  note: WorkspaceNoteRecord;
  onAgentId: (id: string) => void;
  onPerson: () => void;
}) {
  const { agents } = useWorkspace();
  const now = useNow(false);
  const line = noteSubLine(note, now);
  const parts = noteSubParts(note, now);
  const holderId = noteWorkAgentId(note.work);
  const holderWork = note.work?.state === 'handed' || note.work?.state === 'working'
    ? note.work
    : undefined;
  // The live fleet row first for an agent of the reader's own — its picture
  // moves when the agent is renamed, where the work record's was written
  // when the note was claimed — and the record's own face for a teammate's,
  // which stands in no fleet this reader holds (note #640).
  const holderRow = holderId ? (agents ?? []).find((row) => row.id === holderId) : undefined;
  const holder = holderId && holderId !== note.agentId
    ? {
      id: holderId,
      name: holderRow?.name ?? holderWork?.agentName,
      avatarUrl: holderRow?.avatarUrl ?? holderWork?.agentAvatarUrl,
    }
    : undefined;
  let face: React.ReactNode = null;
  if (note.agentAvatarUrl) {
    const picture = <img className="face" src={note.agentAvatarUrl} alt="" />;
    face = note.agentId
      ? (
        <button
          className="facebtn"
          type="button"
          aria-label={note.agentName ? `Open ${note.agentName}` : 'Open this agent'}
          onClick={() => onAgentId(note.agentId!)}
        >
          {picture}
        </button>
      )
      : picture;
  } else if (note.byUser || note.byMember) {
    // The human who wrote it, face first (note #60) — and the face is a door
    // to their page (note #61), exactly as an agent's is to its own.
    face = (
      <button
        className="facebtn"
        type="button"
        aria-label={note.authorName ? `Open ${note.authorName}` : 'Open their page'}
        onClick={onPerson}
      >
        {note.authorPhotoUrl
          ? <img className="face" src={note.authorPhotoUrl} alt="" />
          : <Icon name="user" size={11} className="face dot" />}
      </button>
    );
  }
  return (
    <div className="sub who" id="noteSub" hidden={!line}>
      {face}
      {/* The same sentence either way — the pieces are joined with the
          separator the whole line uses, and the face is slipped in front of
          the words it belongs to rather than added to them. */}
      <span>
        {parts.lead}
        {parts.work
          ? (
            <>
              {parts.lead ? ' · ' : null}
              {holder ? <NoteHolderFace holder={holder} onAgentId={onAgentId} /> : null}
              {parts.work}
            </>
          )
          : null}
        {parts.tail ? `${parts.lead || parts.work ? ' · ' : ''}${parts.tail}` : null}
      </span>
    </div>
  );
}

/**
 * What can be done with the note on screen — a different pair depending on
 * which side of the archive it is on (note #23), and nothing at all when the
 * note is a teammate's (note #637).
 *
 * LIVE: Edit (the reader's own hand only) and Archive. Archive is on every
 * note of THEIRS, an agent's included — a store you can fill but not empty
 * only ever grows, and filing one destroys nothing, while rewriting an
 * agent's words leaves it contradicting a note it is still working from. The
 * hint says so, and says who to ask instead — a button that is simply absent
 * teaches nobody why.
 *
 * ARCHIVED: Restore, and Delete — the only place in the product a note can be
 * deleted at all. No Edit either way.
 *
 * A NOTE THAT IS NOT THE READER'S: one sentence and no buttons. Archive,
 * Restore and Delete all take a note off the desk of the member who
 * wrote it or whose agent keeps it, and the server refuses every one of them
 * — so the card says whose note it is and points at the margin above, which
 * is the thing a reader can actually do here.
 */
function NoteActions({ note, onEdit, onArchive, onRestore, onDelete, busy }: {
  note: WorkspaceNoteRecord;
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const archived = Boolean(note.archivedAt);
  const yours = Boolean(note.yours);
  const hint = !yours
    ? noteNotYoursHint(note)
    : archived ? ARCHIVED_NOTE_HINT : note.byUser ? '' : noteEditHint(note);
  return (
    <div className="card" id="noteActionsCard">
      {yours ? (
        <div className="actions" id="noteActions">
          {archived ? (
            <button className="btn ghost" type="button" disabled={busy} onClick={onRestore}>Restore note</button>
          ) : note.byUser ? (
            <button className="btn ghost" type="button" onClick={onEdit}>Edit note</button>
          ) : null}
          {archived ? (
            // Bare, like the agent's and the repository's delete and for their
            // reason: a destructive action needs no fill — the red is the whole
            // of the warning it has to carry, and a filled button at the foot of
            // the screen reads as the screen's main offer.
            <button className="btn danger bare" type="button" disabled={busy} onClick={onDelete}>Delete for good</button>
          ) : (
            // Ghost, not danger: archiving loses nothing, and a red button
            // teaches the reader to be afraid of the safe verb.
            <button className="btn ghost" type="button" disabled={busy} onClick={onArchive}>Archive note</button>
          )}
        </div>
      ) : null}
      {hint ? <div className="hintblock" id="noteHint">{hint}</div> : null}
    </div>
  );
}

/**
 * What the screen holds while a COLD read is out — one it has no copy of to
 * put up first, which is a pasted link or the reader's first visit of the
 * session. Coming back to a note already read draws nothing at all: the note
 * itself is already on the page (note #306).
 *
 * Three held lines standing where the words will, rather than the one word
 * "Loading" in the middle of an empty screen. They sit inside `.kpage`, the
 * same container the note's own prose is rendered into, so nothing moves
 * sideways when the read lands.
 *
 * And once an attempt has plainly timed out, the held lines give way to a
 * SENTENCE. A skeleton means "this is arriving"; after eight seconds that is
 * no longer true, and continuing to imply it is how a reader ends up staring
 * at a screen that will never change (note #308).
 */
function NoteWait({ again }: { again: boolean }) {
  if (again) {
    return <div className="empty" id="noteSlow">The server is not answering. Trying again…</div>;
  }
  return (
    <div className="kpage" id="noteWait" aria-hidden="true">
      {['92%', '84%', '46%'].map((width, at) => (
        <div key={width}>
          <span
            className="skel skel-inline"
            style={{ width, height: '11px', animationDelay: `${(at * 0.12).toFixed(2)}s` }}
          />
        </div>
      ))}
    </div>
  );
}

export function NoteScreen() {
  const { id = '' } = useParams();
  const number = Number(id);
  const { state, reload, noteClaims } = useWorkspace();
  const { api } = useSession();
  const banner = useBanner();
  const navigate = useNavigate();
  const returnToParent = useReturnToParent();
  // A note that names another note (they cite each other constantly) hands
  // the reader straight over rather than making them go and find it.
  const notes = useNoteRefs();

  // Seeded from whatever this tab last read at this address. `App.tsx` keys
  // this screen on the note's number, so Back REBUILDS it — and a rebuild that
  // starts from nothing is the flash of loading UI note #306 is about.
  const [note, setNote] = useState<WorkspaceNoteRecord | null>(() => heldNote(id));
  // A failure, and whether asking again could do anything about it: a server
  // that did not answer earns a button, "No such note." does not.
  const [failed, setFailed] = useState<{ said: string; retry: boolean } | null>(null);
  // An attempt has timed out and another is going out. The reader is owed a
  // sentence at that point; up to it, silence is the honest report.
  const [again, setAgain] = useState(false);
  const [leaf, setLeaf] = useState<'send' | 'edit' | null>(null);
  const [handing, setHanding] = useState<HomeAgent | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const parked = useRef(0);
  const missingClaimRead = useRef('');

  /**
   * What the reader has changed since a read went out.
   *
   * A note can be read more than once while it is open — on arrival, on a
   * Try again, when its lease ends under it. (It was read TWICE on arrival
   * while the room it was looked up in had to travel from the workspace
   * state, until rooms left the product — note #843.) Each answer is the note
   * as it stood when that read was ASKED, so a slower one could land after a
   * remark had been posted and paint the thread without it: the reader
   * watched their own comment vanish, until the next read put it back.
   *
   * Every local change stamps this counter. A read carries the stamp it went
   * out with and drops its answer if the stamp has moved — what the reader
   * just did is newer than anything already in flight, and that change's own
   * answer is the fresher copy of the note.
   */
  const changed = useRef(0);
  const patch = useCallback((change: (current: WorkspaceNoteRecord) => WorkspaceNoteRecord) => {
    changed.current += 1;
    setNote((current) => {
      if (!current) return current;
      const next = change(current);
      // The local change is the freshest copy there is, so it replaces what is
      // held: coming back to this note must not undo, on screen, the remark
      // the reader just posted.
      holdNote(id, next);
      return next;
    });
  }, [id]);

  const read = useCallback(async () => {
    const stamp = changed.current;
    // The copy this tab already holds goes up FIRST, and the read below
    // refreshes it underneath — which is the whole of note #306.
    const kept = heldNote(id);
    if (kept) setNote((current) => current ?? kept);
    try {
      const answer = await readOrSayWhy<WorkspaceNoteDetailAnswer>(
        (init) => api.api(`api/notes/${encodeURIComponent(id)}`, init),
        { onAgain: () => { if (changed.current === stamp) setAgain(true); } },
      );
      if (changed.current !== stamp) return;
      setNote((current) => (current && sameNote(current, answer.note) ? current : answer.note));
      holdNote(id, answer.note);
      setFailed(null);
      setAgain(false);
    } catch (failure) {
      if (changed.current !== stamp) return;
      setAgain(false);
      // A REFRESH that failed for a reason another attempt could fix leaves
      // the note standing: the reader asked for nothing, and taking the words
      // off the screen to report a hiccup they did not cause is the worse of
      // the two answers. A refusal is different — the note in front of them is
      // no longer the truth, and saying so is the point.
      if (kept && worthAskingAgain(failure)) return;
      // A failed OPEN has nothing to leave standing, so it says why.
      setFailed({ said: errorMessage(failure), retry: worthAskingAgain(failure) });
    }
  }, [api, id]);

  // A claim is taken inside an already-running turn, after this screen's
  // opening read and without another working-set transition to buy a reload.
  // The live tick carries just that lease. Fold it into the open record too,
  // not only the list row behind this screen. If a lease disappears, reread
  // once: only the server can say whether Unclaimed, a conflict, or a PR was
  // underneath it.
  useEffect(() => {
    if (!note || noteClaims === undefined) return;
    const active = noteClaims.find((row) => row.id === note.id);
    if (active) {
      missingClaimRead.current = '';
      if (note.work && ['proposal', 'merged', 'live'].includes(note.work.state)) return;
      if (JSON.stringify(note.work ?? null) === JSON.stringify(active.work)) return;
      void Promise.resolve().then(() => patch((current) => (
        current.work && ['proposal', 'merged', 'live'].includes(current.work.state)
          ? current
          : { ...current, work: active.work }
      )));
      return;
    }
    if (note.work?.state !== 'working') {
      missingClaimRead.current = '';
      return;
    }
    const version = `${note.id}\0${note.work.expiresAt ?? ''}`;
    if (missingClaimRead.current === version) return;
    missingClaimRead.current = version;
    void Promise.resolve().then(read);
  }, [note, noteClaims, patch, read]);

  /** Ask once more, by hand. Clearing the failure first is what puts the wait
   *  back on screen, so the tap visibly does something. */
  const askAgain = useCallback(() => { setFailed(null); setAgain(false); void read(); }, [read]);

  // Started off the effect's own tick: the read is asynchronous by nature,
  // and that keeps this effect a subscription rather than a state write
  // (`WorkspaceProvider` opens the same way).
  useEffect(() => { void Promise.resolve().then(read); }, [read]);

  // A transient leaf covers this screen rather than replacing it, so the
  // reader lands back on the row they came from rather than at the top.
  useLayoutEffect(() => {
    if (leaf) return;
    window.scrollTo(0, parked.current);
  }, [leaf]);
  const openLeaf = (which: 'send' | 'edit') => { parked.current = window.scrollY; setLeaf(which); };
  const closeLeaf = useCallback(() => { setLeaf(null); setHanding(null); }, []);

  const scope = workspaceScope(state?.org?.orgId);
  const openAgent = (agent: HomeAgent) => navigate(toFor({ kind: 'agent', id: agent.id })!);
  // By id, for the faces the server marks as doors (note #640): the agent
  // behind one may be a teammate's, and no row for it stands in this fleet.
  const openAgentId = (agentId: string) => navigate(toFor({ kind: 'agent', id: agentId })!);

  const archive = async () => {
    setBusy(true);
    try {
      await api.api(`api/notes/${encodeURIComponent(number)}/archive`, { method: 'POST' });
    } catch (failure) {
      // No confirm dialog in front of this: asking "are you sure?" about a
      // reversible thing trains the reader to tap through the question that
      // will one day matter. A refusal, though, has to be said.
      banner.show(errorMessage(failure));
      setBusy(false);
      return;
    }
    // What is held is the note as it stood BEFORE, and serving that on the way
    // back would put an Archive button on a note already in the archive.
    forgetNote(number);
    await reload().catch(() => { /* the list catches up on the next read */ });
    // Back where the note was read FROM — the notes list, home's card, or
    // whatever else held the row (note #283). Archiving does not move the
    // reader's place in the app, it only empties the screen they are standing
    // on, and a fresh Home in place of the list they were working down is the
    // one thing they did not ask for. The destination shows the row gone, so
    // there is no toast over it either.
    returnToParent();
  };

  /**
   * The note's words onto the clipboard, inside the tap that asked for them —
   * Safari honours no clipboard write that starts later (`ui/format.ts`).
   *
   * The receipt is a toast because the screen itself cannot show this one:
   * nothing about the note changes, and a copy that says nothing is a copy the
   * reader cannot tell from a dead button.
   */
  const copy = (words: string) => {
    void copyFromTap(async () => words)
      .then(() => banner.show('Note copied.', true))
      .catch(() => banner.show('Could not reach the clipboard — try again.'));
  };

  const restore = async () => {
    setBusy(true);
    try {
      await api.api(`api/notes/${encodeURIComponent(number)}/archive`, { method: 'DELETE' });
    } catch (failure) {
      banner.show(errorMessage(failure));
      setBusy(false);
      return;
    }
    banner.show(`“${note?.title ?? 'That note'}” is back in your notes.`, true);
    forgetNote(number);
    await reload().catch(() => { /* the list catches up on the next read */ });
    // The notes, not back to the archive: the note is not in the archive any
    // more, and the screen the reader came from no longer holds it. The
    // notes list is where it now IS — top of it, most recently touched. (It
    // was the room's notes shelf, while there were rooms — note #843.)
    navigate(toFor({ kind: 'notes', ...scope })!);
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.api(`api/notes/${encodeURIComponent(number)}`, { method: 'DELETE' });
    } catch (failure) {
      banner.show(errorMessage(failure));
      setBusy(false);
      return;
    }
    banner.show(`Deleted “${note?.title ?? 'that note'}”.`, true);
    forgetNote(number);
    // Back onto the archive, where the row was — unless that was its last
    // row, in which case the archive is gone and so is the door onto it. The
    // count read BEFORE the reload is the right one to ask: it still counts
    // the note just deleted.
    const lastOne = (state?.notesArchived ?? 0) <= 1;
    await reload().catch(() => { /* the list re-reads itself on arrival */ });
    navigate(toFor(lastOne ? { kind: 'notes', ...scope } : { kind: 'noteArchive', ...scope })!);
  };

  /**
   * A note goes through its OWN door, which records the handoff in the same
   * request that admits the turn (notes #234/#258) — that is the one thing a
   * note's Send does that a knowledge page's does not.
   *
   * The new state is written here, while the Send is still on top of this
   * screen: it is what the reader is about to be put back on, and a flash of
   * the word Unclaimed under a note they have just dealt out is the whole of
   * what note #258 objects to.
   */
  const handOver = useCallback(async (agentId: string, message: string) => {
    const result = await sendNoteHandoff(
      api, number, { agentId, message } satisfies WorkspaceNoteHandoffRequest,
    );
    if (result.work) patch((current) => ({ ...current, work: result.work }));
    return result;
  }, [api, number, patch]);

  // Nothing is drawn for a read that answers quickly, and nothing already
  // drawn is snatched away inside its hold (`ui/wait.ts`).
  const wait = useWait(!note && !failed);
  // The best name for this note the screen can honestly give, at any moment:
  // the note itself once it is in hand, else the row the reader tapped — which
  // is already in the state the shell holds — else the bare word. So a note
  // being waited on says WHICH note, and the heading neither resizes nor
  // changes what it says when the words finally arrive.
  const heldTitle = note?.title
    ?? (state?.notes ?? []).find((row) => row.number === number)?.title
    ?? 'Note';

  // What a copy of this note would carry, read ahead of the tap rather than
  // inside it: the button is absent on a note with nothing to copy, and the
  // clipboard write has to START in the gesture, with the words already in
  // hand. Held against the note itself, which a refetch that says nothing new
  // hands back unchanged — the screen renders on every poll, and a note is
  // parsed once per note and not once per render.
  const words = useMemo(() => (note ? noteClipboardText(note) : ''), [note]);
  const noteFiles = useNoteFiles({
    note,
    onChanged: (attachments: WorkspaceNoteAttachment[]) => patch((current) => ({ ...current, attachments })),
  });

  if (failed) {
    return (
      <div className="screen" id="screenNote">
        <ScreenTitle titleId="noteTitle" titleClass="clamped" title={heldTitle} />
        <div id="noteBody"><div className="empty">{failed.said}</div></div>
        {/* Only where another attempt could plausibly do better. "No such
            note." is the same answer however many times it is asked for, and a
            button under it invites the reader to disbelieve a true sentence. */}
        {failed.retry ? (
          <div className="card" id="noteAgainCard">
            <div className="actions" id="noteAgainActions">
              <button className="btn ghost" type="button" onClick={askAgain}>Try again</button>
            </div>
          </div>
        ) : null}
      </div>
    );
  }
  // `wait === 'drawn'` KEEPS this branch for the rest of the hold even once the
  // note is in hand: a skeleton snatched away ten milliseconds after it
  // appeared is the same flicker the word "Loading…" used to be (note #287).
  // A failure is exempt — it is checked above, and an answer the reader has to
  // act on should never be held back.
  if (!note || wait === 'drawn') {
    return (
      <div className="screen" id="screenNote" aria-busy="true">
        {/* The title from the row the reader tapped, when the list is already
            in hand: the header of a note being waited on says which note, and
            the heading does not change size when the read lands. */}
        <ScreenTitle titleId="noteTitle" titleClass="clamped" title={heldTitle} />
        <div id="noteBody">
          <span className="sr-only">Loading…</span>
          {/* Nothing at all for a read that answers inside a quarter second,
              and nothing snatched away inside a hold — a wait seen only as it
              leaves is the flash of note #287. */}
          {wait === 'drawn' ? <NoteWait again={again} /> : null}
        </div>
      </div>
    );
  }

  if (leaf === 'send' && handing) {
    return (
      <HandoffSend
        agent={handing}
        prefill={noteHandoffText(handing, note.number)}
        onClose={closeLeaf}
        send={(message) => handOver(handing.id, message)}
      />
    );
  }
  if (leaf === 'edit') {
    return <NoteComposer editing={note} onClose={closeLeaf} onSaved={() => { void read(); }} />;
  }

  return (
    <div className="screen" id="screenNote">
      {/* A note's title is prose, not a name, so the header holds it to two
          lines rather than letting a first sentence run to three. */}
      <ScreenTitle titleId="noteTitle" titleClass="clamped" title={note.title} />
      <NoteWho
        note={note}
        onAgentId={openAgentId}
        onPerson={() => {
          const to = toFor({ kind: 'organizationMember', id: note.authorUserId ?? '', ...workspaceScope(state?.org?.orgId) });
          if (to) navigate(to);
        }}
      />
      <div id="noteBody">
        {/* A note's title IS its first line, so the renderer drops a repeated
            opening line — a heading OR a paragraph, since a note typed in the
            Workspace has no headings at all. Only while the header is showing
            that line WHOLE, though: past `NOTE_TITLE_HELD_WHOLE` the two-line
            clamp above may be cutting it, and the body is where the rest of
            it survives. */}
        <KnowledgeHtml source={note.html} empty="This note is empty." dropTitle={noteBodyTitle(note.title)} titleIsFirstLine noteRefs={notes} />
        {/* In the corner where the words END, and inside them rather than in
            the card of actions at the foot of the screen: a copy is a thing
            done to THESE words, and the reader who wants one is looking at
            them. A glyph and no label — the drawing is the word "copy" in
            every app on the phone, and a note is not made longer by a button
            that says so again. The name is in `aria-label`, which is what a
            control with no words owes a reader who cannot see it.
            Nothing at all on a note with nothing in it to take.
            The paperclip shares the row (note #604): attaching is also a
            thing done to these words, and a glyph beside Copy costs the
            screen nothing where a full-width "Attach a file" card cost it a
            whole card on every note with no files. */}
        {words || noteFiles.attachButton ? (
          <div className="notetools">
            {noteFiles.attachButton}
            {words ? (
              <button type="button" aria-label="Copy note" title="Copy note" onClick={() => copy(words)}>
                <Icon name="copy" size={18} />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {/* Directly under the words, because the file is part of them: the menu
          photo is what the note about the menu is FOR, and a reader who has
          just finished the sentence that mentions it should not have to pass
          the agents and the whole margin to reach it (note #397). */}
      {noteFiles.card}
      {/* The same sideways row of subscriptions Home carries (note #348),
          standing where Home stands it: directly above the agents, because a
          seat is what the agent about to take this note will spend. A note
          is where work is DEALT OUT, so "which sign-in has room left" is
          part of the choice made two inches below it — and the plate is also
          the door to signing another one in, which is the answer when the
          create-an-agent tile refuses for want of a seat.

          It keeps its place on a note nobody can be handed — an archived one,
          or one an agent already holds. On the second of those the row is
          answering a live question: how fast the agent that HAS this note is
          spending. */}
      <SeatStrip ids={{ head: 'noteSeatsHead', section: 'noteSeatsSection', row: 'noteSeats' }} head="Subscriptions" />
      {/* The archive gets nothing, and neither does a note an agent already
          holds: handing over a note the account has finished with, or one
          that is somebody else's job, is not a thing to offer. */}
      <HandRow
        ids={{ head: 'noteHandsHead', card: 'noteHandsCard', row: 'noteHands', hint: 'noteHandsHint' }}
        noun="note"
        closed={Boolean(note.archivedAt) || noteAlreadyOwned(note.work)}
        onOpen={(agent) => { setHanding(agent); openLeaf('send'); }}
        onDetail={openAgent}
      />
      <MarginThread
        ids={{ head: 'noteCommentsHead', card: 'noteCommentsCard', box: 'noteComments' }}
        comments={note.comments ?? []}
        // Writable on a live note, read-only in the archive like everything
        // else there.
        canWrite={!note.archivedAt}
        path={`api/notes/${encodeURIComponent(note.number)}/comments`}
        onPosted={(comments: WorkspaceMarginComment[]) => patch((current) => ({ ...current, comments }))}
        onAgentId={openAgentId}
        onPerson={(comment) => {
          const to = toFor({ kind: 'organizationMember', id: comment.authorUserId ?? '', ...workspaceScope(state?.org?.orgId) });
          if (to) navigate(to);
        }}
        onSay={(sentence) => banner.show(sentence, true)}
      />
      <NoteActions
        note={note}
        busy={busy}
        onEdit={() => openLeaf('edit')}
        onArchive={() => { void archive(); }}
        onRestore={() => { void restore(); }}
        onDelete={() => setAsking(true)}
      />
      {asking ? (
        // The title is in the question: a delete that asks "are you sure?"
        // about nothing in particular is one you answer without reading. And
        // the second line is the one this dialog exists for — everything else
        // about a note can be undone, and this cannot.
        <AskToConfirm
          title={`Delete “${note.title}” for good?`}
          message="Its comments and files go with it, and this cannot be undone."
          verb="Delete for good"
          danger
          onAnswer={(confirmed) => { setAsking(false); if (confirmed) void remove(); }}
        />
      ) : null}
    </div>
  );
}
