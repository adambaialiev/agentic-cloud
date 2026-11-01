import { describe, expect, it } from 'vitest';
import { splitNoteRefs } from './note-refs.js';

/**
 * What counts as naming a note, and — the half that matters more — what does
 * not. The same sentence carries "PR #560" and "note #284"; a mention that
 * guessed from the `#` alone would open the wrong record, which is worse for
 * the reader than the plain number they had before.
 */

const linked = (text: string) => splitNoteRefs(text).filter((part) => part.number !== undefined);

describe('a note named in written words', () => {
  it('links the whole phrase, not the number alone', () => {
    expect(splitNoteRefs('Picking up note #242')).toEqual([
      { text: 'Picking up ' },
      { text: 'note #242', number: 242 },
    ]);
  });

  it('reads every way this platform writes one', () => {
    for (const [source, number] of [
      ['note #7', 7], ['Note #7', 7], ['NOTE #7', 7], ['quick note #7', 7],
      ['notes #7', 7], ['note  #7', 7], ['pick up the note #7 please', 7],
    ] as const) {
      expect(linked(source), source).toEqual([{ text: source.match(/(?:quick )?notes?\s+#\d+/i)![0], number }]);
    }
  });

  it('keeps the rest of a list the anchor opened', () => {
    expect(linked('notes #234 and #258 are one feature')).toEqual([
      { text: 'notes #234', number: 234 },
      { text: '#258', number: 258 },
    ]);
    expect(linked('note #12, #13, #14')).toEqual([
      { text: 'note #12', number: 12 },
      { text: '#13', number: 13 },
      { text: '#14', number: 14 },
    ]);
    expect(linked('note #12, and #13')).toEqual([
      { text: 'note #12', number: 12 },
      { text: '#13', number: 13 },
    ]);
  });

  it('leaves every number the words did not call a note', () => {
    for (const source of [
      'PR #560 is merged', 'Proposal #12 was approved', 'issue #4', 'commit #9',
      '#284 on its own', 'note that #284 is open', 'note #284abc', 'v#3',
    ]) {
      expect(linked(source), source).toEqual([]);
    }
  });

  it('does not read a proposal that follows a note as part of its list', () => {
    expect(linked('note #284, PR #560')).toEqual([{ text: 'note #284', number: 284 }]);
  });

  it('gives back every character it was handed', () => {
    for (const source of [
      'note #242', 'see notes #234 and #258.', "Note #234's picture is clear",
      'nothing here', '', 'PR #560 closes note #12',
    ]) {
      expect(splitNoteRefs(source).map((part) => part.text).join(''), source).toBe(source);
    }
  });

  it('finds a mention anywhere in a paragraph', () => {
    expect(linked('the work landed; note #279 is live')).toEqual([{ text: 'note #279', number: 279 }]);
  });
});
