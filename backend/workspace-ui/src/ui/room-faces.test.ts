import { describe, expect, it } from 'vitest';
import { ROOM_FACES_SHOWN, roomFaceParts } from './room-faces.js';

/**
 * The one rule behind every overlapping stack of faces in this shell. (A
 * room's row put a line of names under its stack, which had to agree with it
 * — `roomWhoLine` — until rooms left the product, note #843.)
 */

const fleet = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `A${index + 1}` }));

describe('a stack that counts — a census, as of a workplace’s people', () => {
  it('draws everyone while they fit', () => {
    const { shown, rest } = roomFaceParts(fleet(ROOM_FACES_SHOWN));
    expect(shown).toHaveLength(ROOM_FACES_SHOWN);
    expect(rest).toBe(0);
  });

  it('gives the last place to the count once they do not', () => {
    const { shown, rest } = roomFaceParts(fleet(9));
    // Two faces and a `+7`, never three faces and a `+6`: the disc takes a
    // place in the stack rather than standing beside it.
    expect(shown).toHaveLength(ROOM_FACES_SHOWN - 1);
    expect(rest).toBe(7);
    expect(shown.length + rest).toBe(9);
  });
});

describe('a stack that does not count — a door (note #581)', () => {
  it('spends every place on a face', () => {
    const { shown, rest } = roomFaceParts(fleet(9), false);
    expect(shown.map((one) => one.name)).toEqual(['A1', 'A2', 'A3']);
    expect(rest).toBe(0);
  });

  it('is the same stack when everyone fits anyway', () => {
    expect(roomFaceParts(fleet(2), false)).toEqual(roomFaceParts(fleet(2)));
  });
});
