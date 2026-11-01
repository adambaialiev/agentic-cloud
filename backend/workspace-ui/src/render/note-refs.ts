/**
 * "note #284", found in a run of written words, so the reader can tap it.
 *
 * A note number is how everyone here — the owner, an agent, a proposal's
 * write-up — points at a piece of work, and until now every one of those
 * mentions was ink: the reader read the number, went to the notes list and
 * found it by hand (notes #263 and #284).
 *
 * ANCHORED ON THE WORD, never on the `#` alone, and that is the whole design.
 * The same chat carries "PR #560", "Proposal #12" and "note #284", and a link
 * that opens the wrong record is worse than no link at all — so a bare number
 * stays text unless the words themselves say `note`. The one exception is a
 * LIST the anchor already opened ("notes #234 and #258"): those numbers were
 * named by that anchor, so they are linked too.
 *
 * Pure and shared on purpose: the Markdown renderer and the allowlisted-HTML
 * renderer both split text with this, so a mention reads the same whether it
 * was written in a chat message, a quick note or a margin remark.
 */

/** Where a note reference leads, and what following one does. Built by
 *  `useNoteRefs()`; a renderer is given one only by a screen that wants
 *  mentions to be doors. */
export interface NoteRefs {
  /**
   * The note's two addresses, or null when there is nothing to link to yet
   * (a workspace still loading has no organization).
   *
   * Both, because a mention is a REAL link: `href` is the address the browser
   * copies, opens in another tab and long-presses, and `to` is the router's
   * own relative form of the same place, which is what a tap follows.
   */
  link: (number: number) => { href: string; to: string } | null;
  /** Follow one from a tap, without reloading the shell. */
  open: (number: number) => void;
}

/** One piece of a split run: plain words, or the words that name a note. */
export interface NoteRefPart {
  /** Exactly the source's own characters — nothing is added or dropped. */
  text: string;
  /** Set when those characters name a note. */
  number?: number;
}

/** "note #284", "Note #284", "quick note #284", "notes #234". The whole
 *  phrase is the link: on a phone the number alone is a 20px target. */
const ANCHOR = /\b(?:quick\s+)?notes?\s+#(\d{1,9})\b/i;

/** The rest of a list the anchor opened: "notes #234 and #258", "note #12,
 *  #13". Only a comma or an "and" continues one — anything else has moved on
 *  to a different subject, where a bare `#` is anybody's number. */
const ALSO = /^(\s*,\s*and\s+|\s*,\s*|\s+and\s+)#(\d{1,9})\b/i;

/** A run of text as plain pieces and note references, in the order written.
 *  Joining every part's `text` gives back the input exactly. */
export function splitNoteRefs(text: string): NoteRefPart[] {
  const parts: NoteRefPart[] = [];
  const add = (piece: string, number?: number) => {
    if (piece) parts.push(number === undefined ? { text: piece } : { text: piece, number });
  };
  let rest = String(text ?? '');
  while (rest) {
    const match = ANCHOR.exec(rest);
    if (!match) { add(rest); break; }
    add(rest.slice(0, match.index));
    add(match[0], Number(match[1]));
    rest = rest.slice(match.index + match[0].length);
    for (let more = ALSO.exec(rest); more; more = ALSO.exec(rest)) {
      add(more[1]!);
      add(`#${more[2]}`, Number(more[2]));
      rest = rest.slice(more[0].length);
    }
  }
  return parts;
}
