import { describe, expect, it } from 'vitest';
import { highestNumber, pickNumbered, workplaceNumberSeries } from '../../services/workplace-numbers.js';

/**
 * One number series per workplace (note #741): the rule every surface uses
 * to say which document a number means when rooms still hold the per-room
 * numbers issued before the series existed.
 */
describe('pickNumbered — which document a number means', () => {
  const platform = { userId: 'platform', number: 205 };
  const growth = { userId: 'growth', number: 205 };

  it('is the one document holding the number, whichever room it is in', () => {
    expect(pickNumbered([growth], 205, 'platform')).toEqual({ kind: 'one', doc: growth, moved: false });
    expect(pickNumbered([growth], 205, null)).toEqual({ kind: 'one', doc: growth, moved: false });
  });

  it('prefers the room the caller stood in when a legacy number is shared', () => {
    expect(pickNumbered([platform, growth], 205, 'growth')).toEqual({ kind: 'one', doc: growth, moved: false });
    expect(pickNumbered([platform, growth], 205, 'platform')).toEqual({ kind: 'one', doc: platform, moved: false });
  });

  it('refuses to guess between two rooms neither of which is the caller\'s', () => {
    expect(pickNumbered([platform, growth], 205, 'ops')).toEqual({ kind: 'many', docs: [platform, growth] });
    expect(pickNumbered([platform, growth], 205, null)).toEqual({ kind: 'many', docs: [platform, growth] });
    expect(pickNumbered([], 205, 'ops')).toEqual({ kind: 'none' });
  });

  it('falls back to a moved document\'s earlier address, and only then', () => {
    const moved = { userId: 'growth', number: 900, previousLocations: [{ userId: 'platform', number: 205 }] };
    expect(pickNumbered([moved], 205, 'platform')).toEqual({ kind: 'one', doc: moved, moved: true });
    // The number it left behind has since been given to another note: that
    // note is what #205 means now.
    expect(pickNumbered([moved, platform], 205, 'ops')).toEqual({ kind: 'one', doc: platform, moved: false });
  });

  it('seeds a series above every number a document holds or ever held', () => {
    expect(highestNumber([{ userId: 'a', number: 3, previousLocations: [{ userId: 'b', number: 41 }] }, { userId: 'c', number: 7 }])).toBe(41);
    expect(highestNumber([])).toBe(0);
  });

  it('names the workplace series, and a personal account its own namespace', () => {
    expect(workplaceNumberSeries('org-1', 'ns')).toBe('org:org-1');
    expect(workplaceNumberSeries(null, 'user-1')).toBe('user-1');
  });
});
