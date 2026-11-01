/**
 * The words a note is described in, and the two pure decisions underneath the
 * rows: what a remark's glimpse shows, and what a file is refused for.
 *
 * Held here rather than through a screen because each of these is a sentence
 * somebody argued about once — "Handed to", not "Working by"; the reset that
 * leads a hand-off only when there is a context to reset — and a sentence
 * asserted through a rendered tree is a sentence one refactor away from
 * silence.
 */

import { describe, expect, it } from 'vitest';
import { buildCommentPreview } from '../../render/comment-preview.js';
import {
  changeProposalHandoffText, handoffLead, knowledgeProposalHandoffText, noteHandoffText,
} from '../../ui/handoff.js';
import type { WorkspaceNoteWork } from '../../../../src/shared/workspace-api.js';
import {
  ARCHIVED_NOTE_HINT, NOTE_FILE_MAX_BYTES, NOTE_TITLE_HELD_WHOLE, NOTE_WORK_STATES, archiveDoorLine,
  archiveScreenSub, noteAlreadyOwned, noteAuthorName, noteBodyTitle, noteEditHint, noteFileRefusal,
  noteFilterChips, noteFilterSub, noteInFilter, noteNotYoursHint, noteSubLine,
  noteSubParts, noteWorkAgentId,
  noteWorkBadgeClass, noteWorkChip, noteWorkLabel, notesEmptyState, notesScreenSub, searchSubText,
  swipeThreshold,
} from './note-words.js';
import type { NoteFacts, NoteWorkState } from './note-words.js';

const NOW = Date.parse('2026-09-02T12:00:00Z');

// A note said which room it stood in under its title (note #556) until rooms
// left the product (note #843): there is one list of notes, the workplace's.

describe('what a note’s state is called', () => {
  it('says an agent HAS the note before it says anything is happening', () => {
    expect(noteWorkLabel({ state: 'handed', agentName: 'Kai' })).toBe('Handed to Kai');
    expect(noteWorkLabel({ state: 'working', agentName: 'Kai' })).toBe('Working by Kai');
    expect(noteWorkLabel({ state: 'handed' })).toBe('Handed to an agent');
    expect(noteWorkLabel({ state: 'working' })).toBe('Working by another agent');
  });

  it('names the proposal, and says when it has stopped moving', () => {
    expect(noteWorkLabel({ state: 'proposal', proposalNumber: 9 })).toBe('PR #9');
    expect(noteWorkLabel({ state: 'proposal', proposalNumber: 9, proposalStatus: 'conflict' }))
      .toBe('PR #9 · conflict');
    // Quiet (note #293): the PR is real and the fence holds, but the agent
    // has not asked for a decision — the badge must not read as one waiting.
    expect(noteWorkLabel({ state: 'proposal', proposalNumber: 9, proposalStatus: 'draft' }))
      .toBe('PR #9 · being prepared');
    expect(noteWorkLabel({ state: 'merged', proposalNumber: 9 })).toBe('Merged');
    expect(noteWorkLabel({ state: 'live', proposalNumber: 9 })).toBe('Live');
    expect(noteWorkLabel({ state: 'unclaimed' })).toBe('Unclaimed');
    expect(noteWorkLabel(undefined)).toBe('');
  });

  it('wears the agent tint for both states an agent holds it in', () => {
    expect(noteWorkBadgeClass({ state: 'handed' })).toBe('badge agent');
    expect(noteWorkBadgeClass({ state: 'working' })).toBe('badge busy');
    expect(noteWorkBadgeClass({ state: 'live', proposalNumber: 1 })).toBe('badge ok');
    expect(noteWorkBadgeClass({ state: 'proposal', proposalNumber: 1, proposalStatus: 'conflict' }))
      .toBe('badge warn');
    expect(noteWorkBadgeClass({ state: 'unclaimed' })).toBe('badge mut');
  });

  it('treats a conflicted proposal as work that has stopped, so the note is offered again', () => {
    expect(noteAlreadyOwned({ state: 'unclaimed' })).toBe(false);
    expect(noteAlreadyOwned({ state: 'handed', agentName: 'Kai' })).toBe(true);
    expect(noteAlreadyOwned({ state: 'proposal', proposalNumber: 4 })).toBe(true);
    expect(noteAlreadyOwned({ state: 'proposal', proposalNumber: 4, proposalStatus: 'conflict' })).toBe(false);
  });
});

describe('narrowing the notes to one state (note #307)', () => {
  const held = (state: NoteWorkState, n = 1) => Array.from({ length: n }, () => ({
    work: (state === 'proposal' || state === 'merged' || state === 'live'
      ? { state, proposalNumber: 7 }
      : state === 'unclaimed' ? { state } : { state, agentName: 'Kai' }) as WorkspaceNoteWork,
  }));

  it('names a state in the badge\u2019s own word, minus the half that is one note\u2019s own', () => {
    // The badge says "Handed to Kai" about ONE note; the chip has to name what
    // every note under it shares, and stay the same word doing it.
    expect(NOTE_WORK_STATES.map(noteWorkChip))
      .toEqual(['Unclaimed', 'Handed over', 'Working', 'Proposed', 'Merged', 'Live']);
    expect(noteWorkChip('merged')).toBe(noteWorkLabel({ state: 'merged', proposalNumber: 1 }));
    expect(noteWorkChip('live')).toBe(noteWorkLabel({ state: 'live', proposalNumber: 1 }));
    expect(noteWorkChip('unclaimed')).toBe(noteWorkLabel({ state: 'unclaimed' }));
  });

  it('keeps a note under All and under its own state, and nowhere else', () => {
    const work: WorkspaceNoteWork = { state: 'handed', agentName: 'Kai' };
    expect(noteInFilter(work, 'all')).toBe(true);
    expect(noteInFilter(work, 'handed')).toBe(true);
    expect(noteInFilter(work, 'working')).toBe(false);
  });

  it('claims no state for a row that wears no badge', () => {
    // An older backend sends no `work` at all, and `noteWorkLabel` gives that
    // row no badge. A chip that swept it up would be filtering by a state the
    // row does not admit to being in.
    expect(noteInFilter(undefined, 'all')).toBe(true);
    expect(noteInFilter(undefined, 'unclaimed')).toBe(false);
    expect(noteFilterChips(Array.from({ length: 9 }, () => ({})), 'all')).toEqual([]);
  });

  it('offers the states this list actually holds, in the order a note lives through them', () => {
    const notes = [...held('live'), ...held('unclaimed', 4), ...held('working'), ...held('handed')];
    expect(noteFilterChips(notes, 'all')).toEqual(['unclaimed', 'handed', 'working', 'live']);
  });

  it('offers nothing while the list is short, or while every note is in one state', () => {
    expect(noteFilterChips([...held('unclaimed', 3), ...held('merged', 2)], 'all')).toEqual([]);
    expect(noteFilterChips(held('unclaimed', 9), 'all')).toEqual([]);
  });

  it('leaves the chosen state standing after the last note leaves it', () => {
    // A five-second read can empty it under the reader's hands. Without its
    // own chip they are looking at an empty list with no way back to the rest.
    expect(noteFilterChips(held('unclaimed', 9), 'merged')).toEqual(['unclaimed', 'merged']);
    expect(noteFilterChips(held('unclaimed', 2), 'merged')).toEqual(['unclaimed', 'merged']);
  });

  it('counts what the chosen state is showing, in the words the chip used', () => {
    expect(noteFilterSub(7, 46, 'unclaimed')).toBe('7 of 46 notes are unclaimed.');
    expect(noteFilterSub(1, 46, 'proposal')).toBe('One of 46 notes is in a proposal.');
    expect(noteFilterSub(1, 1, 'live')).toBe('One note, live.');
    expect(noteFilterSub(9, 9, 'handed')).toBe('All 9 notes are handed to an agent.');
    expect(noteFilterSub(0, 46, 'working')).toBe('Nothing here is being worked on now.');
  });
});

describe('the line under a note’s title', () => {
  it('leads with the number, then who wrote it and when it moved', () => {
    expect(noteSubLine({ number: 12, byUser: true, authorName: 'Owner Example', updatedAt: '2026-09-02T11:00:00Z' }, NOW))
      .toBe('Note #12 · Written by Owner Example · updated 1h ago');
  });

  it('signs an agent’s note with the human driving it', () => {
    expect(noteSubLine({ number: 3, agentName: 'Kai', userName: 'Owner Example' }, NOW))
      .toBe('Note #3 · Written by Kai (Owner Example)');
  });

  it('says "Archived" before who wrote it — it is what changes the buttons below', () => {
    const line = noteSubLine({
      number: 8, archivedAt: '2026-09-01T12:00:00Z', byUser: true, authorName: 'Owner Example',
    }, NOW);
    expect(line.indexOf('Archived')).toBeLessThan(line.indexOf('Written by'));
  });

  it('keeps only the half that is still true when the agent is gone', () => {
    expect(noteSubLine({ number: 5, updatedAt: '2026-09-02T11:00:00Z' }, NOW))
      .toBe('Note #5 · updated 1h ago');
  });

  it('splits into pieces that join back into exactly the same line (note #236)', () => {
    // The screen draws the pieces so the WORK words can carry the face of the
    // agent doing that work. Whatever it puts between them, the sentence the
    // reader ends up with is this one.
    const facts: NoteFacts = {
      number: 12, byUser: true, authorName: 'Owner Example', updatedAt: '2026-09-02T11:00:00Z',
      work: { state: 'working', agentName: 'Kai', agentId: 'kai' },
    };
    const parts = noteSubParts(facts, NOW);
    expect(parts).toEqual({
      lead: 'Note #12', work: 'Working by Kai', tail: 'Written by Owner Example · updated 1h ago',
    });
    expect([parts.lead, parts.work, parts.tail].filter(Boolean).join(' · ')).toBe(noteSubLine(facts, NOW));
  });

  it('leaves no piece for a note nothing is happening to', () => {
    const parts = noteSubParts({ number: 5, updatedAt: '2026-09-02T11:00:00Z' }, NOW);
    expect(parts.work).toBe('');
    expect(noteSubLine({ number: 5, updatedAt: '2026-09-02T11:00:00Z' }, NOW)).toBe('Note #5 · updated 1h ago');
  });

  it('offers a door only to the agent HOLDING the note, and only when it is the reader\u2019s own', () => {
    expect(noteWorkAgentId({ state: 'working', agentName: 'Kai', agentId: 'kai' })).toBe('kai');
    expect(noteWorkAgentId({ state: 'handed', agentName: 'Kai', agentId: 'kai' })).toBe('kai');
    // A teammate's agent is named on the line and has no screen to land on.
    expect(noteWorkAgentId({ state: 'working', agentName: 'Noah' })).toBeUndefined();
    // Past the claim there is a proposal to open instead, and no agent id.
    expect(noteWorkAgentId({ state: 'proposal', proposalNumber: 9 })).toBeUndefined();
    expect(noteWorkAgentId(undefined)).toBeUndefined();
  });

  it('falls back to a generic name only where the directory cannot say', () => {
    expect(noteAuthorName({ number: 1, id: 'n1', title: '', preview: '', createdAt: '', updatedAt: '', byUser: true }))
      .toBe('You');
    expect(noteAuthorName({
      number: 1, id: 'n1', title: '', preview: '', createdAt: '', updatedAt: '',
      byMember: true, memberName: 'Aisha Karimova',
    })).toBe('Aisha Karimova');
  });
});

describe('what each list says about itself', () => {
  it('counts the notes in the words of the screen they are on', () => {
    expect(notesScreenSub(1)).toBe('One note, shared with the workplace and its agents.');
    expect(notesScreenSub(4)).toBe('4 notes, shared with the workplace and its agents.');
    expect(archiveScreenSub(1)).toContain('One note, out of the list and still here');
    expect(archiveScreenSub(0)).toBe('');
    expect(archiveDoorLine(1)).toBe('One note put away');
    expect(archiveDoorLine(3)).toBe('3 notes put away');
  });

  it('offers the archive as the way on when everything has been put away', () => {
    expect(notesEmptyState(2).title).toBe('No active notes');
    expect(notesEmptyState(2).body).toContain('archive below');
    expect(notesEmptyState(0).title).toBe('Keep quick context here');
  });

  it('says what a search is doing, and what it found', () => {
    expect(searchSubText(null, false)).toBe('Searching your notes and your archive…');
    expect(searchSubText([], false)).toBe('Nothing in your notes or your archive matches.');
    expect(searchSubText([{}], false)).toBe('One match across your notes and your archive.');
    expect(searchSubText([{}, {}], false)).toBe('2 matches across your notes and your archive.');
    // A failure is still "searching" to the subtitle; the list itself says why.
    expect(searchSubText([{}], true)).toBe('Searching your notes and your archive…');
  });
});

describe('the message a note hands an agent', () => {
  const carrying = (usedPercent: number) => ({
    context: { usedPercent, tokens: 1, window: 2, at: '2026-09-02T09:00:00Z' },
  });

  it('asks the agent to pick up the note by number', () => {
    expect(noteHandoffText({}, 42)).toBe('pick up the note #42');
  });

  it('asks for a fresh chat first when the agent carries a measured fill', () => {
    expect(handoffLead(carrying(61))).toBe('reset chat and ');
    expect(noteHandoffText(carrying(61), 42)).toBe('reset chat and pick up the note #42');
  });

  it('asks for no reset when there is nothing to throw away', () => {
    expect(handoffLead(carrying(0))).toBe('');
    expect(handoffLead({})).toBe('');
  });

  it('addresses each kind of proposal by the number its CLI can read', () => {
    expect(changeProposalHandoffText({}, 'infinite-agents', 12, 'Move the checkout'))
      .toBe('review change proposal #12 in infinite-agents, “Move the checkout”');
    expect(knowledgeProposalHandoffText({}, 4, 'How deploys work'))
      .toBe('review knowledge proposal #4, “How deploys work”');
  });

  it('uses the same fresh-chat lead when a proposal review is a new job', () => {
    expect(changeProposalHandoffText(carrying(61), 'infinite-agents', 12))
      .toBe('reset chat and review change proposal #12 in infinite-agents');
    expect(knowledgeProposalHandoffText(carrying(61), 4))
      .toBe('reset chat and review knowledge proposal #4');
  });
});

describe('what a note refuses before spending the upload', () => {
  it('names the size in the units the reader sees', () => {
    expect(noteFileRefusal({ name: 'big.png', size: NOTE_FILE_MAX_BYTES + 1 }, []))
      .toContain('Files here are up to 100 MB');
  });

  it('says duplicate before it says full — "take one off" is the wrong advice for a repeat', () => {
    const full = ['a.png', 'b.png', 'c.png', 'd.png', 'e.png'];
    expect(noteFileRefusal({ name: 'a.png', size: 10 }, full)).toContain('already has a file named a.png');
    expect(noteFileRefusal({ name: 'f.png', size: 10 }, full)).toContain('at most 5 files');
  });

  it('compares the name the server will compare, not the phone’s', () => {
    // "фото от мамы (1).jpg" tames to "1.jpg" — which is what the note will
    // hold, so it is what the duplicate check has to compare.
    expect(noteFileRefusal({ name: 'фото от мамы (1).jpg', size: 10 }, ['menu.jpg'])).toBeNull();
    expect(noteFileRefusal({ name: 'фото от мамы (1).jpg', size: 10 }, ['1.jpg']))
      .toContain('already has a file named 1.jpg');
  });

  it('lets an ordinary file through', () => {
    expect(noteFileRefusal({ name: 'menu.png', size: 1024 }, [])).toBeNull();
  });
});

describe('the swipe that files a note away', () => {
  it('asks for a share of the row, with a floor a narrow row cannot fall under', () => {
    expect(swipeThreshold(400)).toBeCloseTo(112);
    expect(swipeThreshold(200)).toBe(84);
    // jsdom has no layout; the fallback is the phone-sized value.
    expect(swipeThreshold(0)).toBeCloseTo(89.6);
  });
});

describe('the newest remark, clipped to what the server chose', () => {
  it('keeps the emphasis inside the sentence it is showing', () => {
    const preview = buildCommentPreview({
      html: '<p>Called them, <strong>closed Mondays</strong> — I will try Tuesday.</p>',
      text: 'Called them, closed Mondays — I will try Tuesday.',
    });
    expect(preview.textContent).toBe('Called them, closed Mondays — I will try Tuesday.');
    expect(preview.querySelector('strong')?.textContent).toBe('closed Mondays');
    // A row is one line: page-shaped elements are flattened, their full
    // layout kept for the note's own screen.
    expect(preview.querySelector('p')?.classList.contains('cinline')).toBe(true);
    expect(preview.classList.contains('commenthtml')).toBe(true);
  });

  it('cuts at exactly the words the backend chose, ellipsis and all', () => {
    const preview = buildCommentPreview({
      html: '<p>One sentence.</p><p>A second nobody asked for.</p>',
      text: 'One sentence.…',
    });
    expect(preview.textContent).toBe('One sentence.…');
    expect(preview.textContent).not.toContain('nobody asked for');
  });

  it('never leaves a link live inside a row that already opens the note', () => {
    const preview = buildCommentPreview({
      html: '<p>See <a href="https://example.com">this</a>.</p>',
      text: 'See this.',
    });
    const link = preview.querySelector('a');
    expect(link?.textContent).toBe('this');
    expect(link?.getAttribute('href')).toBeNull();
  });

  it('drops a picture: a glimpse is words', () => {
    const preview = buildCommentPreview({ html: '<p><img src="https://x/y.png">Look</p>', text: 'Look' });
    expect(preview.querySelector('img')).toBeNull();
    expect(preview.textContent).toBe('Look');
  });

  it('falls back to the plain sentence rather than showing different words', () => {
    const preview = buildCommentPreview({ html: '<p>Something else entirely.</p>', text: 'Not in there.' });
    expect(preview.textContent).toBe('Not in there.');
  });

  it('reads a legacy remark that is still markup in the text field', () => {
    const preview = buildCommentPreview({ text: '<p>Plain old <em>words</em>.</p>' });
    expect(preview.textContent).toBe('Plain old words.');
  });
});

describe('why there is no Edit button', () => {
  it('answers with whose note it is, then who to ask', () => {
    expect(noteEditHint({ agentName: 'Kai' })).toContain('created by Kai');
    expect(noteEditHint({ agentName: 'Kai' })).toContain('ask Kai in its chat');
  });

  // Note #638: the reader's own note, written by an agent they have since
  // deleted. There is no name to ask for, and the sentence that used to stand
  // here — "only its owner's agents can edit it" — read as somebody else's.
  it('says the author is gone, and that the note is still the reader’s', () => {
    const said = noteEditHint({ agentsCanEdit: true });
    expect(said).toContain('no longer in this workplace');
    expect(said).toContain('any of your agents can change what it says');
    expect(said).not.toContain('owner’s agents');
  });

  it('does not send the reader to an agent that would refuse them', () => {
    const said = noteEditHint({});
    expect(said).toContain('cannot be rewritten now');
    expect(said).toContain('still yours to archive');
    expect(said).not.toContain('ask');
  });

  it('explains an archived note by its state, whoever wrote it', () => {
    expect(ARCHIVED_NOTE_HINT).toContain('Restore it to edit it again.');
  });
});

// Note #637: the card on a teammate's note has no buttons in it at all, so
// this sentence is the whole of what the reader gets — whose note it is, and
// the margin they have instead.
describe('why there is nothing to do with a teammate’s note', () => {
  it('names the member who wrote it, and points at the margin', () => {
    const said = noteNotYoursHint({ byMember: true });
    expect(said).toContain('Another workplace member wrote this note');
    expect(said).toContain('edit, move or archive');
    expect(said).toContain('comments above');
  });

  it('names the member when the workplace knows them (2026-09-23)', () => {
    expect(noteNotYoursHint({ byMember: true, memberName: 'Dana Ives' })).toContain('Dana Ives wrote this note');
  });

  it('names the agent that keeps it when an agent does, and whose it is', () => {
    expect(noteNotYoursHint({ agentName: 'Kai', userName: 'Dana Ives' }))
      .toContain('Kai, Dana Ives’s agent, keeps this note');
    expect(noteNotYoursHint({ agentName: 'Kai' }))
      .toContain('Kai, another workplace member’s agent, keeps this note');
    // A retired agent has no name to give, and the sentence still has to say
    // whose note this is rather than trailing off.
    expect(noteNotYoursHint({})).toContain('Another workplace member’s agent keeps this note');
  });

  it('offers the archived pair instead once it is filed', () => {
    const said = noteNotYoursHint({ byMember: true, archivedAt: '2026-09-01T09:00:00Z' });
    expect(said).toContain('in their archive');
    expect(said).toContain('bring it back or delete it');
    // Nothing about editing or moving: neither is on an archived note for
    // anybody, and a refusal that lists verbs nobody has is noise.
    expect(said).not.toContain('move');
  });
});

describe('the line the body strikes as already said above it', () => {
  it('strikes a short title, which the header shows whole', () => {
    expect(noteBodyTitle('The wifi code is 4417')).toBe('The wifi code is 4417');
    expect(noteBodyTitle('x'.repeat(NOTE_TITLE_HELD_WHOLE))).toHaveLength(NOTE_TITLE_HELD_WHOLE);
  });

  it('keeps a long one, because the two-line header may be cutting it', () => {
    expect(noteBodyTitle('x'.repeat(NOTE_TITLE_HELD_WHOLE + 1))).toBeUndefined();
    // The server's own cut, at 90 characters: still nowhere near a header.
    expect(noteBodyTitle(`${'x'.repeat(89)}\u2026`)).toBeUndefined();
  });
});
