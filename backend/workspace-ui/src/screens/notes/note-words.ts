/**
 * What the notes screens SAY, as pure functions — ported sentence for
 * sentence from the legacy page so both shells word a note the same way.
 *
 * Kept beside the components rather than inside them because every one of
 * these is a decision somebody argued about once: which state a badge claims,
 * whether "Handed to" or "Working by", when a hand-off message asks for a
 * fresh chat first. A sentence in a component is a sentence no test reads
 * directly.
 */

import { personName } from '../../ui/chief-of-staff.js';
import type { WorkspaceNoteRow, WorkspaceNoteWork } from '../../../../src/shared/workspace-api.js';
import { bytes, safeFileName } from '../../ui/file-kind.js';
import { agentSignature } from '../decisions/proposal-words.js';
import { relative } from '../../ui/time.js';

/** Home's card is a GLIMPSE: the recent few, then a row onto the screen that
 *  holds all of them. Every note on home made it the tallest section by far. */
export const NOTES_SHOWN = 6;

/** Whether this account has enough notes — live and put away together — to be
 *  worth hunting through with a keyboard rather than with your eyes. */
export const NOTE_SEARCH_AT = 6;

/** QUICK_NOTE_MAX_TEXT_LENGTH, the number the route refuses past. Held here
 *  so the box simply stops rather than taking a paste it will then hand back
 *  as an error. (The hand-off box's own cap lives with its sentences, in
 *  `ui/handoff.ts`.) */
export const NOTE_MAX_TEXT = 50_000;

/* QUICK_NOTE_ATTACHMENT_MAX_BYTES and QUICK_NOTE_MAX_ATTACHMENTS, the two the
   route refuses past. The server still checks both; these are the cheap half,
   so a phone can be told no INSTANTLY rather than after spending its upload. */
export const NOTE_FILE_MAX_BYTES = 100 * 1024 * 1024;
export const NOTE_MAX_FILES = 5;

/** How far a row has to travel before releasing it means Archive. jsdom has
 *  no layout, so the fallback is also the phone-sized value the behaviour
 *  tests exercise; a real row always supplies its rendered width. */
export const SWIPE_SLOP = 8;
export const SWIPE_MIN = 84;
export const SWIPE_SHARE = 0.28;

export function swipeThreshold(width: number): number {
  return Math.max(SWIPE_MIN, (width || 320) * SWIPE_SHARE);
}

/**
 * What the row's badge says. "Handed to", not "Working by": nothing is
 * happening yet and the row should not claim it is — what is true is that
 * this note is somebody's now (notes #234/#258).
 */
export function noteWorkLabel(work: WorkspaceNoteWork | undefined): string {
  if (!work) return '';
  if (work.state === 'handed') return `Handed to ${work.agentName || 'an agent'}`;
  if (work.state === 'working') return `Working by ${work.agentName || 'another agent'}`;
  if (work.state === 'proposal') {
    // A quiet proposal (note #293) is a PR the agent is still preparing: the
    // number is real and the fence holds, but nobody has been asked yet.
    return `PR #${work.proposalNumber}${
      work.proposalStatus === 'conflict' ? ' · conflict'
        : work.proposalStatus === 'draft' ? ' · being prepared'
          : ''}`;
  }
  if (work.state === 'merged') return 'Merged';
  if (work.state === 'live') return 'Live';
  return 'Unclaimed';
}

/** Working is the one state where something is HAPPENING right now, and it
 *  wears yellow so it can be found in a list at a glance (note #286). Handed
 *  stays in the quiet agent grey: the note is somebody's, but nothing has
 *  started, and a colour that says "busy" would be a claim the row cannot
 *  keep. */
export function noteWorkBadgeClass(work: WorkspaceNoteWork | undefined): string {
  if (work && work.state === 'live') return 'badge ok';
  if (work && work.state === 'proposal' && work.proposalStatus === 'conflict') return 'badge warn';
  if (work && work.state === 'working') return 'badge busy';
  if (work && work.state === 'handed') return 'badge agent';
  return 'badge mut';
}

/**
 * The states a note passes through, in the order it passes through them:
 * nobody has it, somebody was given it, an agent is on it, a change was
 * proposed, that change landed, it is out there (note #307).
 *
 * The same six `noteWorkLabel` badges a row, listed once so a screen can
 * offer them as a CHOICE. A seventh for `conflict` was deliberately not
 * added: it is a proposal's status, not a note's state, and the row says so
 * inside the proposal's own badge.
 */
export const NOTE_WORK_STATES = ['unclaimed', 'handed', 'working', 'proposal', 'merged', 'live'] as const;
export type NoteWorkState = (typeof NOTE_WORK_STATES)[number];
/** What a list is showing: every note, or the one state the reader chose. */
export type NoteWorkFilter = 'all' | NoteWorkState;

/**
 * A state in two registers: the word on the chip, and the same state inside a
 * sentence about how many notes are in it.
 *
 * The chip is the BADGE's word with the note-specific half taken off — a
 * badge says "Handed to Oscar" about one note, and a chip has to name what
 * every note under it shares. They must stay recognisably the same word or
 * the buttons and the rows they filter will read as two vocabularies.
 */
const NOTE_WORK_WORDS: Record<NoteWorkState, { chip: string; phrase: string }> = {
  unclaimed: { chip: 'Unclaimed', phrase: 'unclaimed' },
  handed: { chip: 'Handed over', phrase: 'handed to an agent' },
  working: { chip: 'Working', phrase: 'being worked on' },
  proposal: { chip: 'Proposed', phrase: 'in a proposal' },
  merged: { chip: 'Merged', phrase: 'merged' },
  live: { chip: 'Live', phrase: 'live' },
};

export function noteWorkChip(state: NoteWorkState): string {
  return NOTE_WORK_WORDS[state].chip;
}

/** Whether a row belongs under the chosen chip. A note with no state at all —
 *  an older backend's answer — wears no badge, so no chip may claim it: it
 *  appears under All and nowhere else. */
export function noteInFilter(work: WorkspaceNoteWork | undefined, filter: NoteWorkFilter): boolean {
  return filter === 'all' || work?.state === filter;
}

/** Enough notes on the screen to be worth narrowing. Counted over the LIVE
 *  list alone, unlike the search field's threshold: a state filter narrows
 *  the rows in front of the reader, and the archive is behind its own door
 *  where these chips cannot reach. */
export const NOTE_FILTER_AT = 6;

/**
 * Which chips this list gets — and the reasons any of them are missing.
 *
 * A state no note is in is not offered: it is a tap that gives nothing back,
 * the same rule that keeps the archive door shut on an empty archive. A list
 * with only one state left is not a choice either, so it gets no row at all.
 *
 * The exception is the state the reader has ALREADY chosen. Its chip stands
 * even after the last note leaves it — a poll can empty it under their hands
 * — because a narrowed list whose chips have gone is a reader with no way
 * back to the rest of their notes.
 */
export function noteFilterChips(
  notes: readonly { work?: WorkspaceNoteWork }[],
  chosen: NoteWorkFilter,
): NoteWorkState[] {
  const present = new Set(notes.map((note) => note.work?.state));
  const offered = NOTE_WORK_STATES.filter((state) => present.has(state) || state === chosen);
  if (chosen !== 'all') return offered;
  return notes.length >= NOTE_FILTER_AT && offered.length > 1 ? offered : [];
}

/** What the subtitle says while a state is standing in for the whole list:
 *  how many of them there are, in the words the chip above it used. */
export function noteFilterSub(shown: number, total: number, state: NoteWorkState): string {
  const { phrase } = NOTE_WORK_WORDS[state];
  if (shown === 0) return `Nothing here is ${phrase} now.`;
  if (shown === total) {
    return shown === 1 ? `One note, ${phrase}.` : `All ${total} notes are ${phrase}.`;
  }
  return shown === 1
    ? `One of ${total} notes is ${phrase}.`
    : `${shown} of ${total} notes are ${phrase}.`;
}

/** Is this note still the reader's to hand over? A note an agent already
 *  holds is somebody else's job — except a proposal in conflict, which is
 *  work that has stopped. */
export function noteAlreadyOwned(work: WorkspaceNoteWork | undefined): boolean {
  return Boolean(work && work.state !== 'unclaimed'
    && !(work.state === 'proposal' && work.proposalStatus === 'conflict'));
}

/** Who signs the newest remark on a compact row: the agent that made it, or —
 *  since a person writes in these margins too (note #64) — the member. Their
 *  names live in different fields on purpose, and `byPerson` is the only thing
 *  that says which one this remark is; an agent's carries a human name as
 *  well, the driver behind it. */
export function commentSignerName(comment: { byPerson?: true; userName?: string; agentName?: string }): string {
  return (comment.byPerson ? comment.userName : comment.agentName && personName(comment.agentName)) ?? '';
}

/**
 * The line under a note's title: what it is CALLED, what state it is in, who
 * wrote it, and when it last moved.
 *
 * "Archived" leads the facts about this note's STATE, before who wrote it: it
 * is the one thing on the screen that changes what the buttons below offer.
 * "Written" on its own says nothing, so a note whose agent is gone keeps only
 * the half that is still true — and a human signs with their NAME (note #60),
 * because "Written by you" told the one person who already knew.
 */
/** Everything the line reads, and nothing it does not: a note's number, plus
 *  whichever of the optional facts this one happens to carry. */
export type NoteFacts = Pick<WorkspaceNoteRow, 'number'> & Partial<Pick<
  WorkspaceNoteRow,
  'archivedAt' | 'work' | 'byUser' | 'byMember' | 'authorName' | 'memberName' | 'agentName' | 'userName' | 'updatedAt'
>>;

/**
 * The same line in three pieces, so the WORK words can carry the face of the
 * agent doing that work (note #236) without a second copy of the sentence
 * living in the component. Joined with ' · ', these ARE `noteSubLine`.
 */
export interface NoteSubParts {
  /** Which note it is, and — leading every fact about its state — whether it
   *  has been put away. */
  lead: string;
  /** What is happening to it, empty on a note nothing is happening to. */
  work: string;
  /** Who wrote it, and when it last moved. */
  tail: string;
}

export function noteSubParts(note: NoteFacts, now = Date.now()): NoteSubParts {
  const when = note.updatedAt ? `updated ${relative(note.updatedAt, now)}` : '';
  const author = note.byUser
    ? `Written by ${note.authorName || 'you'}`
    : note.byMember
      ? `Written by ${note.authorName || note.memberName || 'another member'}`
      : note.agentName
        ? `Written by ${agentSignature(note.agentName, note.userName)}`
        : '';
  return {
    lead: [
      `Note #${note.number}`,
      note.archivedAt ? `Archived ${relative(note.archivedAt, now)}` : '',
    ].filter(Boolean).join(' · '),
    work: note.work ? noteWorkLabel(note.work) : '',
    tail: [author, when].filter(Boolean).join(' · '),
  };
}

export function noteSubLine(note: NoteFacts, now = Date.now()): string {
  const { lead, work, tail } = noteSubParts(note, now);
  return [lead, work, tail].filter(Boolean).join(' · ');
}

/**
 * Which agent HAS this note — the one that claimed it, or the one it was
 * handed to — when that agent is the reader's own to open (note #236).
 *
 * Not the same fact as the note's `agentId`, which is whoever last WROTE it:
 * a note is usually handed to an agent other than the one that typed it, and
 * "Working by Noah" was the one name on that line with no way to reach it.
 * The id rides the work record exactly when the viewer owns that agent, which
 * is what makes a face here a door rather than a picture.
 */
export function noteWorkAgentId(work: WorkspaceNoteWork | undefined): string | undefined {
  if (!work) return undefined;
  return work.state === 'handed' || work.state === 'working' ? work.agentId : undefined;
}

/**
 * How much of a title the note's header is CERTAIN to print whole.
 *
 * The header holds its title to two lines (`.phead h1.clamped`, note #300),
 * and a clamp cuts SILENTLY: no ellipsis in the markup, and nothing under it
 * to fall back on, so words past the second line would simply be gone. The
 * body's opening line is that fallback, and it is kept for every title longer
 * than this — which is what a long note already looks like today, and reads
 * as a title over a note rather than as a fault.
 *
 * The number is measured rather than guessed. The screenshot on note #300
 * fixes this header's type: forty characters of it filled 353 of that phone's
 * 398px column. Scaling a browser's own font to that measurement and wrapping
 * four thousand sentences per length through the real rule, the longest title
 * that never reaches a third line is 48 characters on a 320px screen — 60 at
 * 375px, 68 at 430px. The narrowest wins: a note is its heading and nothing
 * else only while EVERY phone can show all of that heading.
 */
export const NOTE_TITLE_HELD_WHOLE = 48;

/** The line the body strikes as already said above it: the header's own
 *  words, and only while the header is certainly showing all of them. */
export function noteBodyTitle(title: string): string | undefined {
  return title.length <= NOTE_TITLE_HELD_WHOLE ? title : undefined;
}

/** The name a human-written note's row leads with. The old generic is the
 *  fallback only when the directory cannot say. */
export function noteAuthorName(note: WorkspaceNoteRow): string {
  return note.authorName || (note.byUser ? 'You' : note.memberName || 'Another member');
}

export function notesScreenSub(count: number): string {
  return count === 1
    ? 'One note, shared with the workplace and its agents.'
    : `${count} notes, shared with the workplace and its agents.`;
}

// The Chief of Staff's own room's notes had a title, a door line and a
// subtitle of their own (note #487), and a note said which room it stood in
// under its title (note #556), until rooms left the product (note #843):
// there is one list of notes, the workplace's.

/** What the archive IS, said once at the top: these are notes that are still
 *  here, and this is the only screen they can be deleted from. */
export function archiveScreenSub(count: number): string {
  if (count === 0) return '';
  return count === 1
    ? 'One note, out of the list and still here. Open it to restore or delete it.'
    : `${count} notes, out of the list and still here. Open one to restore or delete it.`;
}

export function archiveDoorLine(archived: number): string {
  return archived === 1 ? 'One note put away' : `${archived} notes put away`;
}

/** What a screen's subtitle says while a search is standing in for it. */
export function searchSubText(results: readonly unknown[] | null, failed: boolean): string {
  if (failed || results === null) return 'Searching your notes and your archive…';
  const n = results.length;
  if (n === 0) return 'Nothing in your notes or your archive matches.';
  return `${n === 1 ? 'One match' : `${n} matches`} across your notes and your archive.`;
}

/** The same sentence, read off the search itself. */
export function noteSearchSub(search: { results: readonly unknown[] | null; error: string }): string {
  return searchSubText(search.results, Boolean(search.error));
}

export interface NotesEmptyState { title: string; body: string }

/** Not a dead end even here: everything may have been put away rather than
 *  never written, and the archive door below says so and leads there. */
export function notesEmptyState(archived: number): NotesEmptyState {
  return archived
    ? {
      title: 'No active notes',
      body: 'Your saved notes are still in the archive below. Write a new one when your agents need fresh context.',
    }
    : {
      title: 'Keep quick context here',
      body: 'Use notes primarily to describe tasks for your agents. They can also hold reminders, lists, and files, shared with the workplace immediately and without approval.',
    };
}

/**
 * What this page can refuse without spending the upload, in the server's own
 * order — duplicate before count, because a re-attach of a name the note
 * already has is a duplicate whether or not there is room, and "take one off"
 * is the wrong advice for it. `existingNames` are already tamed names, which
 * is what the server compares against.
 */
export function noteFileRefusal(
  file: { name: string; size: number },
  existingNames: readonly string[],
): string | null {
  const name = safeFileName(file.name);
  if (file.size > NOTE_FILE_MAX_BYTES) {
    return `Files here are up to 100 MB — this one is ${bytes(file.size)}. Put it in Drive instead.`;
  }
  if (existingNames.includes(name)) {
    return `This note already has a file named ${name} — take that one off first, or rename this one.`;
  }
  if (existingNames.length >= NOTE_MAX_FILES) {
    return `A note carries at most ${NOTE_MAX_FILES} files. Take one off first, or start another note.`;
  }
  return null;
}

/**
 * Why there is no Edit button on a note of the reader's OWN that an agent
 * keeps, said where the missing button would be.
 *
 * The two facts first — whose note, and that only an agent edits it — because
 * they answer the question this text exists for. The why stays, but as the
 * tail: an agent edits its own note so it KNOWS what it now says.
 *
 * A TEAMMATE's note has its own sentence (`noteNotYoursHint`), and needs one:
 * "ask Kai in its chat" is the right advice for an agent of the reader's own
 * and useless for somebody else's, whose chat they cannot open.
 *
 * WITH NO NAME TO ASK (note #638), the agent that wrote it has been deleted —
 * that is the only way a note of the reader's own reaches this card unnamed,
 * and it is nearly half of the agent-written notes on an account this old. The
 * sentence that used to stand here said "only its owner's agents can edit it",
 * which told the owner their own note belonged to somebody else: it was
 * written for a teammate's note, back when this card was drawn on those too.
 * So: say the author is gone, then say what is actually left — any of their
 * agents, or nobody at all on a legacy note with no human stamp behind it.
 */
export function noteEditHint(note: Pick<WorkspaceNoteRow, 'agentName' | 'agentsCanEdit'>): string {
  if (note.agentName) {
    return `This note was created by ${note.agentName}, and only an agent can edit it. To change what it says, ask `
      + `${note.agentName} in its chat — then it knows what the note now says.`;
  }
  if (note.agentsCanEdit) {
    return 'The agent that wrote this note is no longer in this workplace, so there is nobody to ask for it by '
      + 'name. The note is still yours: any of your agents can change what it says.';
  }
  return 'The agent that wrote this note is no longer in this workplace, and its words cannot be rewritten now — '
    + 'not by you and not by your agents. The note is still yours to archive, and the comments above stay open.';
}

/**
 * Why a teammate's note offers NOTHING to do with it, said where the whole row
 * of buttons would have been (note #637).
 *
 * A note stands with the member who wrote it, or with the member whose agent
 * keeps it. Moving it to another room, filing it, bringing it back and
 * deleting it are all theirs — so on their note this card is one sentence and
 * no buttons at all, rather than an Archive the server would refuse.
 *
 * Whose it is, then what the reader has instead: the margin is directly above
 * these words, which is the whole of the answer to "then how do I say this
 * should be archived?".
 */
export function noteNotYoursHint(
  note: Pick<WorkspaceNoteRow, 'byMember' | 'memberName' | 'agentName' | 'userName' | 'archivedAt'>,
): string {
  // Named, both of them, when the workplace knows who (2026-09-23): a
  // teammate and their agents are never hidden from the rest of it.
  const whose = note.byMember
    ? `${note.memberName || 'Another workplace member'} wrote this note`
    : note.agentName
      ? `${note.agentName}, ${note.userName ? `${note.userName}’s agent` : 'another workplace member’s agent'}, keeps this note`
      : 'Another workplace member’s agent keeps this note';
  return note.archivedAt
    ? `${whose}, and it is in their archive. Only they and their agents can bring it back or delete it.`
    : `${whose}. Only they and their agents can edit, move or archive it — say what you need to in the comments above.`;
}

/** An archived note has no Edit button whoever wrote it, so the hint is on
 *  every one of them: the missing button is explained by the state, not by
 *  whose note it is, and the way out is the button right beside the words. */
export const ARCHIVED_NOTE_HINT =
  'This note is archived, so it cannot be changed — not by you and not by your agents. Restore it to edit it again.';
