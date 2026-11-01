import { describe, expect, it } from 'vitest';
import { formatResetHint } from '../../agent/platform-turn-policy.js';

const NOW = new Date('2026-07-30T15:30:00.000Z');

describe('formatResetHint', () => {
  it('scales the relative phrasing to the wait', () => {
    const at = (iso: string) => formatResetHint(new Date(iso), NOW);
    expect(at('2026-07-30T15:31:00.000Z')).toBe('in a moment');
    expect(at('2026-07-30T16:00:00.000Z')).toBe('within 30 minutes');
    expect(at('2026-07-30T16:30:00.000Z')).toBe('within an hour');
    expect(at('2026-07-30T18:30:00.000Z')).toBe('within 3 hours');
    expect(at('2026-08-06T15:30:00.000Z')).toBe('within 7 days');
  });

  it('never sends the user back before the reset', () => {
    // Rounding is UP, always. Rounding to nearest was up to 30 min early, which
    // earns the user a SECOND refusal — the exact frustration being fixed.
    const waitMinutes = [1, 2, 7, 33, 59, 60, 61, 89, 90, 119, 149, 150, 269, 300, 1500];
    for (const minutes of waitMinutes) {
      const resetAt = new Date(NOW.getTime() + minutes * 60_000);
      const hint = formatResetHint(resetAt, NOW);

      const quoted = /within (\d+|an|a) (minutes|minute|hour|hours|day|days)/.exec(hint);
      if (!quoted) {
        // Only the sub-minute case has no number, and it promises nothing.
        expect(hint, `${minutes} min`).toBe('in a moment');
        continue;
      }
      const count = quoted[1] === 'an' || quoted[1] === 'a' ? 1 : Number(quoted[1]);
      const unitMinutes = quoted[2].startsWith('minute') ? 1 : quoted[2].startsWith('hour') ? 60 : 1440;
      expect(count * unitMinutes, `"${hint}" must cover a ${minutes} min wait`)
        .toBeGreaterThanOrEqual(minutes);
    }
  });

  it('never quotes a reset in the past, however stale the deadline', () => {
    expect(formatResetHint(new Date('2026-07-30T15:00:00.000Z'), NOW)).toBe('in a moment');
  });
});
