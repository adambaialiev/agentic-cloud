import { describe, expect, it } from 'vitest';
import {
  counted, limitWords, notesLine, repositoriesLine, seatSentence, sitesLine, storageLine, subscriptionsLine,
} from './workplace-index-words.js';

describe('the Workplace window’s index lines (note #960)', () => {
  it('counts in words, one and many', () => {
    expect(counted(1, 'note')).toBe('1 note');
    expect(counted(4, 'repository', 'repositories')).toBe('4 repositories');
  });

  it('says how many notes and how many nobody picked up', () => {
    expect(notesLine(0, 0)).toBe('No notes yet');
    expect(notesLine(2, 0)).toBe('2 notes');
    expect(notesLine(3, 1)).toBe('3 notes · 1 unclaimed');
  });

  it('says how many repositories and the shelf they share', () => {
    expect(repositoriesLine(null)).toBe('Not available right now');
    expect(repositoriesLine(0, { userUsedBytes: 0, userMaxBytes: 5 * 1024 ** 3 })).toBe('None yet');
    expect(repositoriesLine(2, { userUsedBytes: 266 * 1024, userMaxBytes: 5 * 1024 ** 3 })).toBe('2 repositories · 266 KB of 5.00 GB');
  });

  it('names the domain every site is a name on, in place of a footer explaining it', () => {
    expect(sitesLine(['https://bookface-2006.agents.bookface.site', 'https://clay-and-kiln.agents.bookface.site'])).toBe('2 sites on agents.bookface.site');
    expect(sitesLine([''])).toBe('1 site');
  });

  it('says whether any bucket is readable by its link', () => {
    expect(storageLine([{ public: false }])).toBe('1 bucket · private');
    expect(storageLine([{ public: true }, { public: false }])).toBe('2 buckets · 1 public');
  });

  it('puts a subscription’s windows in plain words (finding 10)', () => {
    expect(limitWords({ usedPercent: 7, percentText: '7', trackText: 'this week' })).toBe('this week’s limit');
    expect(limitWords({ usedPercent: 0, percentText: '0', trackText: '5 hours' })).toBe('the 5-hour limit');
    expect(limitWords({ usedPercent: 12, percentText: '12' })).toBe('its limit');
    const claude = {
      seatId: 's', provider: 'claude', label: 'Claude', planText: 'Max', status: 'active', selected: true,
      windows: [{ usedPercent: 0, percentText: '0', trackText: '5 hours' }, { usedPercent: 7, percentText: '7', trackText: 'this week' }],
    };
    expect(seatSentence(claude)).toBe('Claude Max: 7% of this week’s limit used, 0% of the 5-hour limit');
    expect(subscriptionsLine([claude])).toBe('Claude Max · 7% of this week’s limit used');
    expect(subscriptionsLine([])).toBe('None signed in yet');
  });
});
