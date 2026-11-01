import { describe, expect, it } from 'vitest';
import { compactTokens } from '../../ui/file-kind.js';
import { tokenProviderLine, tokenWeekLabel, weekStartOf } from './token-usage-words.js';

describe('the token section’s words', () => {
  const saturday = Date.parse('2026-10-10T15:00:00Z');

  it('names this week, last week, and then the Monday', () => {
    expect(weekStartOf(saturday)).toBe('2026-10-05');
    expect(tokenWeekLabel('2026-10-05', saturday)).toBe('This week');
    expect(tokenWeekLabel('2026-09-28', saturday)).toBe('Last week');
    expect(tokenWeekLabel('2026-09-21', saturday)).toMatch(/^Week of .*21/);
  });

  it('leads with output, shows Codex reasoning as part of it, and folds the cache into one figure', () => {
    const line = (row: Parameters<typeof tokenProviderLine>[0]) => tokenProviderLine(row).replace(/\u00a0/g, ' ');
    expect(line({
      provider: 'claude', input: 340_000, output: 1_200_000, cacheRead: 44_000_000, cacheWrite: 1_000_000, reasoning: 0, models: [],
    })).toBe('Claude Code · 1.2M output · 340k input · 45M cache');
    expect(line({
      provider: 'codex', input: 1_100_000, output: 800_000, cacheRead: 0, cacheWrite: 0, reasoning: 210_000, models: [],
    })).toBe('Codex · 800k output (210k reasoning) · 1.1M input');
  });

  it('never splits a number from what it counts', () => {
    const text = tokenProviderLine({
      provider: 'codex', input: 1, output: 2, cacheRead: 3, cacheWrite: 0, reasoning: 1, models: [],
    });
    expect(text.split(' · ').every((part) => !part.includes(' '))).toBe(true);
  });

  it('says billions as billions', () => {
    expect(compactTokens(1_530_000_000)).toBe('1.5B');
    expect(compactTokens(12_000_000_000)).toBe('12B');
    expect(compactTokens(999_000_000)).toBe('999M');
  });
});
