import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PINS_URL,
  createPinFollower,
  parsePublishedPins,
  pinFollowerDocs,
  pinsUrlFrom,
} from '../../services/harness-cli-pin-follower.js';
import { HarnessCliVersionService } from '../../services/harness-cli-versions.js';

/**
 * Note #1052: a private copy follows the pin we publish unless its admin set
 * one of their own.
 */
const OURS = { claude: '2.1.316', codex: '0.166.0', opencode: '1.19.5' };
const NOW = new Date('2026-11-07T15:00:00.000Z');

/** The copy's config store, in memory, with the merge-write the real one has. */
function store(initial?: Record<string, unknown>) {
  const docs = new Map<string, Record<string, unknown>>();
  if (initial) docs.set('config/harnessCliVersions', initial);
  return {
    docs,
    collection: (name: string) => ({
      doc: (id: string) => ({ get: async () => ({ data: () => docs.get(`${name}/${id}`) }) }),
    }),
    setConfigDoc: (docId: string, updates: Record<string, unknown>) => {
      docs.set(docId, { ...(docs.get(docId) ?? {}), ...updates });
    },
  };
}

function published(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

function follower(s: ReturnType<typeof store>, fetchImpl: ReturnType<typeof vi.fn>, extra: { onAdopted?: () => void } = {}) {
  return createPinFollower({
    url: DEFAULT_PINS_URL,
    docs: pinFollowerDocs(s),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => NOW,
    ...extra,
  });
}

describe('pin follower', () => {
  it('adopts the published pin into the copy\'s own document', async () => {
    const s = store({ claude: '2.1.310', codex: '0.164.0', opencode: '1.19.3', image: { keep: true } });
    const onAdopted = vi.fn();
    const result = await follower(s, published(OURS), { onAdopted }).refresh();

    expect(result).toEqual({
      outcome: 'adopted',
      from: { claude: '2.1.310', codex: '0.164.0', opencode: '1.19.3' },
      to: OURS,
    });
    expect(s.docs.get('config/harnessCliVersions')).toEqual({
      ...OURS,
      image: { keep: true },
      updatedAt: NOW.toISOString(),
      followed: { from: DEFAULT_PINS_URL, at: NOW.toISOString() },
    });
    expect(onAdopted).toHaveBeenCalledOnce();
  });

  it('adopts into a copy that has never had a pin — the fleet nobody updates', async () => {
    const s = store();
    expect((await follower(s, published(OURS)).refresh()).outcome).toBe('adopted');
    expect(s.docs.get('config/harnessCliVersions')).toMatchObject(OURS);
  });

  it('what it writes is what the copy\'s updater reads', async () => {
    const s = store();
    const versions = new HarnessCliVersionService(s);
    expect(await versions.getPinnedVersions()).toEqual({});
    await follower(s, published(OURS), { onAdopted: () => versions.clearCache() }).refresh();
    expect(await versions.getPinnedVersions()).toEqual(OURS);
  });

  it('holds when the copy\'s admin set a pin of their own, and writes nothing', async () => {
    const own = { claude: '2.1.300', codex: '0.162.1', opencode: '1.19.3', hold: { at: '2026-11-01T09:00:00.000Z', by: 'harness-cli-versions.mjs' } };
    const s = store(own);
    const onAdopted = vi.fn();
    const result = await follower(s, published(OURS), { onAdopted }).refresh();

    expect(result).toEqual({ outcome: 'held', hold: own.hold, published: OURS });
    expect(s.docs.get('config/harnessCliVersions')).toEqual(own);
    expect(onAdopted).not.toHaveBeenCalled();
  });

  it('follows again once the hold is cleared (the script writes hold: null)', async () => {
    const s = store({ claude: '2.1.300', codex: '0.162.1', opencode: '1.19.3', hold: null });
    expect((await follower(s, published(OURS)).refresh()).outcome).toBe('adopted');
  });

  it('writes nothing when the copy is already on the pin', async () => {
    const s = store({ ...OURS, updatedAt: 'earlier' });
    const result = await follower(s, published(OURS)).refresh();
    expect(result).toEqual({ outcome: 'current', pins: OURS });
    expect(s.docs.get('config/harnessCliVersions')).toEqual({ ...OURS, updatedAt: 'earlier' });
  });

  it('adopts nothing from a half answer, a dist-tag or a failed request', async () => {
    for (const fetchImpl of [
      published({ claude: '2.1.316', codex: '0.166.0', opencode: null }),
      published({ ...OURS, claude: 'latest' }),
      published(OURS, 503),
      vi.fn(async () => { throw new TypeError('fetch failed'); }),
    ]) {
      const s = store({ claude: '2.1.310', codex: '0.164.0', opencode: '1.19.3' });
      const result = await follower(s, fetchImpl).refresh();
      expect(result.outcome).toBe('unreachable');
      expect(s.docs.get('config/harnessCliVersions')).toEqual({ claude: '2.1.310', codex: '0.164.0', opencode: '1.19.3' });
    }
  });

  it('asks with nothing about the copy: a plain GET to the published address', async () => {
    const fetchImpl = published(OURS);
    await follower(store(), fetchImpl).refresh();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(DEFAULT_PINS_URL);
    expect(init.method ?? 'GET').toBe('GET');
    expect(Object.keys(init.headers as Record<string, string>)).toEqual(['accept']);
  });

  it('does nothing at all when following is off', async () => {
    const fetchImpl = published(OURS);
    const s = store();
    const off = createPinFollower({ url: null, docs: pinFollowerDocs(s), fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await off.refresh()).toEqual({ outcome: 'off' });
    off.start();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(s.docs.size).toBe(0);
  });

  it('checks a little after start and then once a day', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = published(OURS);
      const f = createPinFollower({
        url: DEFAULT_PINS_URL, docs: pinFollowerDocs(store()), fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      f.start();
      await vi.advanceTimersByTimeAsync(119_000);
      expect(fetchImpl).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(86_400_000);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      f.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('pinsUrlFrom', () => {
  it('defaults to ours, takes a mirror, and turns off', () => {
    expect(pinsUrlFrom(undefined)).toBe(DEFAULT_PINS_URL);
    expect(pinsUrlFrom('  ')).toBe(DEFAULT_PINS_URL);
    expect(pinsUrlFrom('https://mirror.example/pins.json')).toBe('https://mirror.example/pins.json');
    for (const off of ['off', 'OFF', 'none', 'false', '0', 'no', 'ftp://x', 'not a url']) {
      expect(pinsUrlFrom(off), off).toBeNull();
    }
  });
});

describe('parsePublishedPins', () => {
  it('takes exact versions for every CLI and nothing else', () => {
    expect(parsePublishedPins({ ...OURS, extra: 1 })).toEqual(OURS);
    expect(parsePublishedPins({ claude: '2.1.316', codex: '0.166.0' })).toBeNull();
    expect(parsePublishedPins('2.1.316')).toBeNull();
    expect(parsePublishedPins(null)).toBeNull();
  });
});
