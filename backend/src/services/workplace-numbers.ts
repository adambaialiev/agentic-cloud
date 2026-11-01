/**
 * One number series per WORKPLACE (note #741).
 *
 * Notes and knowledge proposals were numbered per room: Platform and Growth
 * each had a "#205", a link carried the room beside the number, and a link
 * with the wrong room opened the wrong note or none. Since note #741 a new
 * note or proposal takes its number from one counter for the whole
 * workplace, so a number names exactly one thing anywhere in it.
 *
 * Existing numbers were kept — renumbering would have broken every link,
 * commit message and chat line already written — which is why a reader
 * still has to cope with a shared LEGACY number. The rule every surface
 * follows is {@link pickNumbered}: the room the caller stood in or the link
 * named wins when it holds the number; otherwise the number is looked for in
 * every room, and only a number that matches more than one asks for a room.
 */

/** The counter a workplace's notes and proposals draw from. A personal
 *  account (no workplace) keeps its own namespace as the series, exactly as
 *  before. */
export function workplaceNumberSeries(orgId: string | null | undefined, namespaceId: string): string {
  return orgId ? `org:${orgId}` : namespaceId;
}

/**
 * Where a new number comes from: the series it is issued by, and every
 * namespace whose existing numbers the series must start above. The
 * namespaces are the whole workplace's, because the series is seeded the
 * first time it is asked for and nothing below the seed may ever be issued
 * again.
 */
export interface NumberSeries {
  series: string;
  namespaces: readonly string[];
}

/** An earlier address of a moved document: the room it stood in and the
 *  number it held there (`previousLocations` on a note). */
export interface NumberedLocation {
  userId: string;
  number: number;
}

export interface Numbered {
  userId: string;
  number: number;
  previousLocations?: NumberedLocation[];
}

export type NumberedPick<T> =
  | { kind: 'one'; doc: T; /** True when the number was found only as an earlier address of a moved document. */ moved: boolean }
  | { kind: 'none' }
  | { kind: 'many'; docs: T[] };

/**
 * Which of the documents answering to a number the caller meant.
 *
 * `preferred` is the namespace the request stood in — the agent's own room,
 * or the room a link named. A document numbered there wins outright, which
 * is what keeps a legacy shared number working for everybody who already
 * addresses it from its own room. Failing that, a number held by exactly one
 * document anywhere is that document; a number two rooms both hold, neither
 * of them the preferred one, cannot be guessed and is returned as `many`.
 *
 * Earlier addresses are the last resort: a note moved between rooms keeps
 * `{ room, number }` of where it was, so a link written before the move
 * still arrives — but only when no document holds that number now, because
 * the number a note left behind may since have been given to another.
 */
export function pickNumbered<T extends Numbered>(
  matches: readonly T[],
  number: number,
  preferred: string | null | undefined,
): NumberedPick<T> {
  const current = matches.filter((doc) => doc.number === number);
  const own = preferred ? current.find((doc) => doc.userId === preferred) : undefined;
  if (own) return { kind: 'one', doc: own, moved: false };
  if (current.length === 1) return { kind: 'one', doc: current[0]!, moved: false };
  if (current.length > 1) return { kind: 'many', docs: current };

  const earlier = matches.filter((doc) => (doc.previousLocations ?? [])
    .some((location) => location.number === number));
  const ownEarlier = preferred
    ? earlier.find((doc) => (doc.previousLocations ?? [])
      .some((location) => location.number === number && location.userId === preferred))
    : undefined;
  if (ownEarlier) return { kind: 'one', doc: ownEarlier, moved: true };
  if (earlier.length === 1) return { kind: 'one', doc: earlier[0]!, moved: true };
  if (earlier.length > 1) return { kind: 'many', docs: earlier };
  return { kind: 'none' };
}

/** The highest number any of these documents holds or ever held — what a
 *  series is seeded from, so that nothing it issues collides with a number
 *  already in use anywhere in the workplace. */
export function highestNumber(docs: readonly Numbered[]): number {
  return docs.reduce((max, doc) => Math.max(
    max,
    doc.number,
    ...(doc.previousLocations ?? []).map((location) => location.number),
  ), 0);
}
