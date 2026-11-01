import { describe, expect, it } from 'vitest';
import { addressHalf, carriesHomeShown, overviewTo } from './home-address.js';
import { overviewArrival } from './home-sheet.js';

/**
 * Home's address (note #524): the parameters that say what Home is showing,
 * read and written in one place. It named a room as well — and wrote it,
 * with the shelf, back into the address as the reader moved — until rooms
 * left the product (note #843); `room` and `content` are only read now, from
 * old links.
 */

const params = (search: string) => new URLSearchParams(search);

describe('the half an address names', () => {
  it('reads the word the tab says, and nothing else', () => {
    expect(addressHalf(params('half=workplace'))).toBe('workplace');
    expect(addressHalf(params('half=agents'))).toBe('agents');
    // The old word for the same half, from before note #843.
    expect(addressHalf(params('half=rooms'))).toBe('agents');
    // Not a guess, not an empty parameter: an address that does not name a
    // half leaves the choice to the reader's own.
    expect(addressHalf(params('half=room'))).toBeNull();
    expect(addressHalf(params('half='))).toBeNull();
    expect(addressHalf(params('content=notes'))).toBeNull();
  });
});

describe('the overview\'s address (2026-10-10)', () => {
  it('writes the half onto the overview, and never a room or a shelf (note #843)', () => {
    expect(overviewTo('o1')).toBe('/overview?org=o1');
    expect(overviewTo('o1', { half: 'agents' })).toBe('/overview?org=o1&half=agents');
    expect(overviewTo('o1', { half: 'workplace' })).toBe('/overview?org=o1&half=workplace');
    // No workplace known yet: the bare address, which the shell reads in the active one.
    expect(overviewTo(null, { half: 'agents' })).toBe('/overview?half=agents');
    expect(overviewTo(undefined)).toBe('/overview');
  });

  it('knows an old Home address by the words it carries', () => {
    expect(carriesHomeShown(params('half=rooms'))).toBe(true);
    expect(carriesHomeShown(params('room=r1'))).toBe(true);
    expect(carriesHomeShown(params('content=notes'))).toBe(true);
    expect(carriesHomeShown(params('org=o1'))).toBe(false);
    expect(carriesHomeShown(params(''))).toBe(false);
  });
});

describe('what the overview\'s address opens', () => {
  it('opens the window or the picker by the half it names', () => {
    expect(overviewArrival(params('half=workplace'))).toEqual({ homeSheet: [{ kind: 'workplace' }] });
    expect(overviewArrival(params('half=agents'))).toEqual({ homeSheet: [], agentSwitch: {} });
    expect(overviewArrival(params(''))).toEqual({ homeSheet: [{ kind: 'workplace' }] });
  });

  it('opens an old room link as the whole picker, and an old notes shelf as the notes (note #843)', () => {
    // The room it names is not read: there is one list of agents now.
    expect(overviewArrival(params('half=rooms&room=r2'))).toEqual({ homeSheet: [], agentSwitch: {} });
    expect(overviewArrival(params('room=r2'))).toEqual({ homeSheet: [], agentSwitch: {} });
    expect(overviewArrival(params('half=rooms&room=r2&content=agents'))).toEqual({ homeSheet: [], agentSwitch: {} });
    // A room's notes shelf was the room's own notes; they are the workplace's one list.
    expect(overviewArrival(params('half=rooms&room=r2&content=notes'))).toEqual({ homeSheet: [], notes: true });
    expect(overviewArrival(params('content=notes'))).toEqual({ homeSheet: [], notes: true });
    // The Workplace half is still the window, whatever shelf an old link names.
    expect(overviewArrival(params('half=workplace&content=notes'))).toEqual({ homeSheet: [{ kind: 'workplace' }] });
  });
});
