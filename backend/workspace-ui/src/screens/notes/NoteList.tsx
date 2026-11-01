/**
 * The pieces the notes screen and the archive both draw: the search field,
 * what a search puts in place of the list, the empty state and the door onto
 * the archive.
 *
 * The field sits in a holder of its OWN above the rows for the reason the
 * legacy page discovered the hard way: the rows are replaced by every poll,
 * and a field replaced with them loses the focus, the keyboard and the tail
 * of what was being typed. React keeps a stable element for as long as it is
 * not remounted, which is the same guarantee stated a different way — so it
 * stays outside the box that rebuilds.
 */

import type { WorkspaceNoteRow } from '../../../../src/shared/workspace-api.js';
import { EmptyState } from '../../ui/EmptyState.js';
import { Icon, TypeIcon } from '../../ui/icons.js';
import { VoiceField } from '../../voice/VoiceField.js';
import { NoteRow } from './NoteRow.js';
import { archiveDoorLine, noteWorkChip, notesEmptyState } from './note-words.js';
import type { NoteWorkFilter, NoteWorkState } from './note-words.js';
import type { NoteSearch } from './useNoteSearch.js';

export function NoteSearchField({ search, holderId, earned }: {
  search: NoteSearch;
  holderId: string;
  /** Enough notes — live and put away together — to be worth hunting through
   *  with a keyboard rather than with your eyes. */
  earned: boolean;
}) {
  if (!earned) return <div id={holderId} hidden />;
  return (
    <div id={holderId}>
      <div className="filter">
        <Icon name="search" size={16} />
        <VoiceField onTranscript={(value) => search.type(value)}>
          <input
            type="search"
            placeholder="Search notes"
            aria-label="Search notes"
            value={search.query}
            onChange={(event) => search.type(event.target.value)}
          />
        </VoiceField>
      </div>
    </div>
  );
}

/**
 * The states this list holds, as a row of chips that narrow it to one of them
 * (note #307).
 *
 * A FILTER over the rows already in hand, where the search beside it is its
 * own fetch — because the two reasons search cannot be a filter both fail
 * here. The state is on every row (`work`), so nothing is being guessed from
 * a title and a glimpse; and this screen's list is every live note the
 * account has, not a page of them, so narrowing it cannot under-count. The
 * archive is the one thing outside these chips' reach, which is why the
 * subtitle they write counts THIS list and says nothing about that one.
 *
 * The same tab the rooms row is made of: a state the reader is standing in is
 * text and a rule, not one more button competing with the rest.
 */
export function NoteFilterChips({ chips, chosen, onChoose }: {
  chips: readonly NoteWorkState[];
  chosen: NoteWorkFilter;
  onChoose: (filter: NoteWorkFilter) => void;
}) {
  if (!chips.length) return null;
  const chip = (filter: NoteWorkFilter, label: string) => {
    const here = chosen === filter;
    return (
      <button
        key={filter}
        className={`chip${here ? ' here' : ''}`}
        type="button"
        data-filter={filter}
        aria-current={here ? 'true' : undefined}
        onClick={here ? undefined : () => onChoose(filter)}
      >
        {label}
      </button>
    );
  };
  return (
    <div className="chiprow" id="notesFilter" role="group" aria-label="Show notes by state">
      {chip('all', 'All')}
      {chips.map((state) => chip(state, noteWorkChip(state)))}
    </div>
  );
}

/**
 * The results, or the honest reason there are none.
 *
 * The SAME row every note list draws, with two differences. A result from the
 * archive says so — it is the one row on the screen that does not lead where
 * the screen's name promises. And no swipe on any of them: a result is a way
 * to FIND a note, and the swipe that files one away belongs to the list where
 * the whole note is in front of you.
 */
export function NoteSearchRows({ search, onOpen }: {
  search: NoteSearch;
  onOpen: (number: number) => void;
}) {
  if (search.error) return <div className="empty">{search.error}</div>;
  if (search.results === null) return <div className="empty">Searching…</div>;
  if (search.results.length === 0) {
    return <div className="empty">Nothing matches “{search.query.trim()}”.</div>;
  }
  return (
    <>
      {search.results.map((note) => (
        <NoteRow note={note} key={note.id} saysArchived onOpen={onOpen} />
      ))}
    </>
  );
}

/** A real zero state: a small typed mark, a useful title, and the explanation
 *  a first-time reader needs before the action beneath the card makes sense.
 *  The block itself is the shared one — three nodes the stylesheet sizes
 *  together — and only the words are the notes screen's own. */
export function NotesEmpty({ archived }: { archived: number }) {
  const words = notesEmptyState(archived);
  return <EmptyState glyph="note" tint="note" title={words.title} body={words.body} />;
}

/**
 * The row onto the archive, drawn only when something is in there — a door
 * onto an empty room is a tap that gives nothing back.
 *
 * Offered on BOTH note screens, exactly as "Write a note" is, and for a
 * sharper reason than symmetry: home's card only grows a door onto the notes
 * screen past six notes, so an archive reachable solely from there would be
 * invisible to every account with five notes and something put away.
 *
 * Icon-free on purpose: Archive is a destination, not one more note, and its
 * own name says what is behind the door.
 */
export function ArchiveDoorRow({ archived, onOpen }: { archived: number; onOpen: () => void }) {
  return (
    <button className="crow open" type="button" onClick={onOpen}>
      <div className="main">
        <div className="name plain">Archive</div>
        <div className="cline"><span className="ctext">{archiveDoorLine(archived)}</span></div>
      </div>
      <Icon name="chev" size={17} className="icon chev" />
    </button>
  );
}

/**
 * The row onto the notes screen: how many there are, in the words that say
 * the screen holds ALL of them.
 *
 * "All 9 notes" rather than "3 more": the screen behind this row is the whole
 * list, the six above it included, and a row promising only the unseen ones
 * would be describing a screen that does not exist. No time in the right-hand
 * column either — every row above carries the time IT last moved, and one
 * here would be read as another note's.
 */
export function NotesDoorRow({ notes, onOpen }: { notes: readonly WorkspaceNoteRow[]; onOpen: () => void }) {
  return (
    <button className="crow open" type="button" onClick={onOpen}>
      <TypeIcon glyph="note" tint="note" />
      <div className="main"><div className="name plain">All {notes.length} notes</div></div>
      <Icon name="chev" size={17} className="icon chev" />
    </button>
  );
}

/** The way to write one, at the foot of the card it writes into. */
export function WriteNoteRow({ id, onPress }: { id?: string; onPress: () => void }) {
  return (
    <button className="addrow" id={id} type="button" onClick={onPress}>
      Write a note
    </button>
  );
}
