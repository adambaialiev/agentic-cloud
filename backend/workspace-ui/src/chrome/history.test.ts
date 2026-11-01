import { describe, expect, it } from 'vitest';
import { hasEntryBeneath } from './history.js';

describe('browser entries beneath the current Workspace screen', () => {
  it('does not mistake a replacement key for another history entry', () => {
    expect(hasEntryBeneath({ key: 'replacement' }, { key: 'replacement', idx: 0 })).toBe(false);
  });

  it('spends an actual Workspace entry beneath the current one', () => {
    expect(hasEntryBeneath({ key: 'child' }, { key: 'child', idx: 1 })).toBe(true);
  });

  it('recognises the untouched browser-session root', () => {
    expect(hasEntryBeneath({ key: 'default' }, { idx: 0 })).toBe(false);
  });

  it('keeps MemoryRouter tests on their own location keys', () => {
    expect(hasEntryBeneath({ key: 'memory-child' }, undefined)).toBe(true);
    expect(hasEntryBeneath({ key: 'memory-child' }, { key: 'another-router', idx: 0 })).toBe(true);
  });

  // Note #742: the owner's iPhone, on a proposal page whose Back did nothing
  // while Safari's own back arrow was grey. The entry's router state counted
  // pages under it; the browser had none.
  it('believes the browser when it says this page is the first of the tab, whatever the router counted', () => {
    expect(hasEntryBeneath({ key: 'counted' }, { key: 'counted', idx: 3 }, { currentEntry: { index: 0 } })).toBe(false);
  });

  it('still spends an entry of ours that the browser confirms is there', () => {
    expect(hasEntryBeneath({ key: 'child' }, { key: 'child', idx: 1 }, { currentEntry: { index: 1 } })).toBe(true);
  });

  it('never takes the browser\'s list as proof the entry under it is ours', () => {
    // An earlier same-origin page (the landing site, a sign-in) is in the
    // browser's list too; only the router's count knows our own entries.
    expect(hasEntryBeneath({ key: 'default' }, { idx: 0 }, { currentEntry: { index: 2 } })).toBe(false);
  });

  it('reads a browser without that list exactly as before', () => {
    expect(hasEntryBeneath({ key: 'counted' }, { key: 'counted', idx: 3 }, undefined)).toBe(true);
    expect(hasEntryBeneath({ key: 'counted' }, { key: 'counted', idx: 3 }, { currentEntry: null })).toBe(true);
  });
});
