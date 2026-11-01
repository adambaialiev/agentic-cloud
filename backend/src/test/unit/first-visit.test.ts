import { describe, expect, it } from 'vitest';
import {
  FIRST_VISIT_KEY,
  cleanFirstVisit,
  firstVisitOf,
  readFirstVisit,
  rememberFirstVisit,
  type FirstVisitBrowser,
} from '../../shared/first-visit.js';

/**
 * Where a person first came from (Growth, 2026-10-08): one record per
 * browser, written on its first page load on either app and never again, and
 * cleaned by the backend before it is kept with a new account.
 */

const NOW = new Date('2026-10-09T08:00:00.000Z');
const OWN = 'agenticcloudcomputer.com';

function browser(referrer: string, pathname: string, stored: Record<string, string> = {}): FirstVisitBrowser & { stored: Record<string, string> } {
  return {
    stored,
    localStorage: {
      getItem: (key) => stored[key] ?? null,
      setItem: (key, value) => { stored[key] = value; },
    },
    document: { referrer },
    location: { pathname, hostname: OWN },
  };
}

describe('firstVisitOf', () => {
  it('names the site that sent the browser, by host alone and without www', () => {
    expect(firstVisitOf('https://t.co/', '/', OWN, NOW)).toEqual({ from: 't.co', page: '/', at: '2026-10-09T08:00:00.000Z' });
    expect(firstVisitOf('https://www.google.com/', '/docs/agents', OWN, NOW).from).toBe('google.com');
    expect(firstVisitOf('https://news.ycombinator.com/item?id=1', '/', OWN, NOW).from).toBe('news.ycombinator.com');
  });

  it('names nobody when the browser said nothing, or when the link was our own', () => {
    expect(firstVisitOf('', '/', OWN, NOW).from).toBe('');
    expect(firstVisitOf('https://www.agenticcloudcomputer.com/docs', '/workspace', OWN, NOW).from).toBe('');
    expect(firstVisitOf('not a url', '/', OWN, NOW).from).toBe('');
  });

  it('keeps the first page as a path, and falls back to / for one it cannot keep', () => {
    expect(firstVisitOf('', '/claude-code-in-the-cloud', OWN, NOW).page).toBe('/claude-code-in-the-cloud');
    expect(firstVisitOf('', `/${'x'.repeat(300)}`, OWN, NOW).page).toBe('/');
  });
});

describe('rememberFirstVisit', () => {
  it('writes once, on the first page load, and never overwrites it', () => {
    const first = browser('https://t.co/', '/');
    rememberFirstVisit(first, NOW);
    expect(JSON.parse(first.stored[FIRST_VISIT_KEY]!)).toEqual({ from: 't.co', page: '/', at: NOW.toISOString() });

    // The same browser, later, from somewhere else: the first answer stands.
    const later = browser('https://google.com/', '/workspace', first.stored);
    rememberFirstVisit(later, new Date('2026-10-12T00:00:00.000Z'));
    expect(readFirstVisit(later)).toEqual({ from: 't.co', page: '/', at: NOW.toISOString() });
  });

  it('does nothing, and breaks nothing, when storage is blocked', () => {
    const blocked = browser('https://t.co/', '/');
    blocked.localStorage.getItem = () => { throw new Error('SecurityError'); };
    expect(() => rememberFirstVisit(blocked, NOW)).not.toThrow();
    expect(readFirstVisit(blocked)).toBeUndefined();
  });
});

describe('cleanFirstVisit', () => {
  it('keeps a well-formed record', () => {
    expect(cleanFirstVisit({ from: '', page: '/', at: '2026-10-09T08:00:00Z' })).toEqual({ from: '', page: '/', at: '2026-10-09T08:00:00.000Z' });
  });

  it('drops anything malformed whole', () => {
    for (const raw of [
      null, 'x', [], { from: 't.co' },
      { from: '<script>', page: '/', at: '2026-10-09T08:00:00Z' },
      { from: 't.co', page: 'relative', at: '2026-10-09T08:00:00Z' },
      { from: 't.co', page: '/a b', at: '2026-10-09T08:00:00Z' },
      { from: 't.co', page: '/', at: 'yesterday' },
      { from: 7, page: '/', at: '2026-10-09T08:00:00Z' },
    ]) {
      expect(cleanFirstVisit(raw)).toBeUndefined();
    }
  });
});
