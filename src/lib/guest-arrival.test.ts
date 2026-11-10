import { describe, expect, it } from 'vitest';
import { arrivalOf, GUEST_ARRIVAL_KEY, readArrival, rememberArrival, type ArrivalBrowser } from './guest-arrival';

/** Note #1139: how a visitor arrived, noted from the first page of the visit, for the tab only. */
function tab(search: string, referrer: string): ArrivalBrowser & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); } },
    document: { referrer },
    location: { search, hostname: 'agenticcloudcomputer.com' },
  };
}

describe('the guest arrival record (note #1139)', () => {
  it('keeps the five utm tags of the address and the referring site, and nothing else', () => {
    expect(arrivalOf('?utm_source=outreach&utm_medium=email&utm_campaign=cold-email&utm_content=test-co&gclid=x&s=1', 'https://mail.google.com/mail/u/0/', 'agenticcloudcomputer.com'))
      .toEqual({ utm: { utm_source: 'outreach', utm_medium: 'email', utm_campaign: 'cold-email', utm_content: 'test-co' }, referrerHost: 'mail.google.com' });
    expect(arrivalOf('', 'https://www.agenticcloudcomputer.com/product', 'agenticcloudcomputer.com')).toEqual({ utm: {}, referrerHost: null });
    expect(arrivalOf('', '', 'agenticcloudcomputer.com')).toEqual({ utm: {}, referrerHost: null });
  });

  it('notes the FIRST page of the visit only, in sessionStorage, and reads it back for Start guest agent', () => {
    const first = tab('?utm_source=newsletter', 'https://t.co/abc');
    rememberArrival(first);
    expect(JSON.parse(first.store.get(GUEST_ARRIVAL_KEY)!)).toEqual({ utm: { utm_source: 'newsletter' }, referrerHost: 't.co' });
    // A later page in the same tab (our own link, no tags) does not overwrite it.
    first.location.search = '';
    first.document.referrer = 'https://agenticcloudcomputer.com/';
    rememberArrival(first);
    expect(readArrival(first)).toEqual({ utm: { utm_source: 'newsletter' }, referrerHost: 't.co' });
  });

  it('answers nothing when nothing was noted or storage is broken', () => {
    expect(readArrival(tab('', ''))).toBeUndefined();
    const broken = tab('', '');
    broken.sessionStorage.getItem = () => { throw new Error('blocked'); };
    expect(() => rememberArrival(broken)).not.toThrow();
    expect(readArrival(broken)).toBeUndefined();
  });
});
