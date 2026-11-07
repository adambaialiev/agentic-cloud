import {
  HARNESS_CLI_VERSIONS_COLLECTION,
  HARNESS_CLI_VERSIONS_DOCUMENT,
  isValidCliVersion,
  type PinnedCliVersions,
} from './harness-cli-versions.js';

/**
 * A private copy follows our CLI pin unless its admin set one (note #1052,
 * Adam, 7 Nov 2026: "private copies follow our pin by default").
 *
 * A copy's backend has its own config/harnessCliVersions. Nothing on our side
 * can write it, so without this a copy's fleet is a fleet nobody updates: its
 * pre-sleep updater has no pin and leaves every CLI as its release image
 * baked it. This reads the pin we publish (GET /api/cli-pins on our backend,
 * unsigned, cacheable, the same three numbers our own fleet runs) once a day
 * and, when it differs, writes it into the copy's own document. From there
 * the copy's own HarnessCliUpdater moves each machine before it sleeps,
 * exactly as on our fleet.
 *
 * The copy's IMAGE does not move with it: a copy builds no images, it runs
 * what its release carried (our agent image by digest). So a new machine
 * boots the release's CLIs and is moved at its first sleep, and the image
 * itself catches up at the copy's next upgrade.
 *
 * Held: a pin the copy's admin set (scripts/harness-cli-versions.mjs `set`
 * or `bump` on a copy) carries `hold`, and while it does nothing here writes.
 * `harness-cli-versions.mjs follow` clears it, and the next check adopts ours.
 *
 * The question carries nothing about the copy: a plain GET, no sign-in, no
 * query, no cookie (the same rule as the release check). COPY_PINS_URL points
 * it elsewhere (a mirror); COPY_PINS_URL=off stops it.
 */

export const DEFAULT_PINS_URL = 'https://api.agenticcloudcomputer.com/api/cli-pins';
const DAY_MS = 86_400_000;
/** The first check, a little after start, so a boot is not slowed by it. */
const FIRST_CHECK_MS = 120_000;

/** What a copy's admin wrote when they held a pin of their own. */
export interface PinHold {
  at: string;
  by?: string;
}

export interface PinFollowerDocs {
  read(): Promise<Record<string, unknown> | undefined>;
  /** Merge-write of the pin document. */
  write(updates: Record<string, unknown>): Promise<void>;
}

export type PinFollowOutcome =
  | { outcome: 'off' }
  | { outcome: 'held'; hold: PinHold; published: Required<PinnedCliVersions> }
  | { outcome: 'current'; pins: Required<PinnedCliVersions> }
  | { outcome: 'adopted'; from: PinnedCliVersions; to: Required<PinnedCliVersions> }
  | { outcome: 'unreachable'; error: string };

export interface PinFollowerOptions {
  /** Where the published pin is; null turns following off. */
  url: string | null;
  docs: PinFollowerDocs;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  everyMs?: number;
  firstCheckMs?: number;
  timeoutMs?: number;
  log?: (line: string) => void;
  /** Called after a write, so cached readers (the updater's 60 s cache) see it now. */
  onAdopted?: () => void;
}

/** COPY_PINS_URL: unset means ours; off, none, false, 0 or no turn following off. */
export function pinsUrlFrom(value: string | undefined): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return DEFAULT_PINS_URL;
  if (['off', 'none', 'false', '0', 'no'].includes(raw.toLowerCase())) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.href;
  } catch {
    return null;
  }
}

/** The published answer, only when it names an exact version for every CLI. A half answer is not a pin. */
export function parsePublishedPins(body: unknown): Required<PinnedCliVersions> | null {
  if (!body || typeof body !== 'object') return null;
  const { claude, codex, opencode } = body as Record<string, unknown>;
  if (!isValidCliVersion(claude) || !isValidCliVersion(codex) || !isValidCliVersion(opencode)) return null;
  return { claude, codex, opencode };
}

/** A hold the admin set, if the document carries one. */
export function readHold(doc: Record<string, unknown> | undefined): PinHold | null {
  const hold = doc?.hold as { at?: unknown; by?: unknown } | undefined;
  if (!hold || typeof hold !== 'object' || typeof hold.at !== 'string') return null;
  return { at: hold.at, ...(typeof hold.by === 'string' ? { by: hold.by } : {}) };
}

export function createPinFollower(options: PinFollowerOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 10_000;
  let last: (PinFollowOutcome & { checkedAt: string }) | null = null;
  let inFlight: Promise<PinFollowOutcome> | null = null;
  let timers: Array<ReturnType<typeof setTimeout>> = [];

  async function check(): Promise<PinFollowOutcome> {
    if (!options.url) return { outcome: 'off' };
    let published: Required<PinnedCliVersions> | null;
    try {
      // Nothing about this copy goes with it.
      const answer = await fetchImpl(options.url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!answer.ok) return { outcome: 'unreachable', error: `answered ${answer.status}` };
      published = parsePublishedPins(await answer.json().catch(() => null));
    } catch (error) {
      return {
        outcome: 'unreachable',
        error: error instanceof Error && error.name === 'TimeoutError' ? `no answer in ${Math.round(timeoutMs / 1000)} s` : 'not reachable',
      };
    }
    if (!published) return { outcome: 'unreachable', error: 'answered with something that is not a pin for every CLI' };

    const doc = await options.docs.read();
    const hold = readHold(doc);
    if (hold) return { outcome: 'held', hold, published };
    const local: PinnedCliVersions = {
      ...(isValidCliVersion(doc?.claude) ? { claude: doc.claude } : {}),
      ...(isValidCliVersion(doc?.codex) ? { codex: doc.codex } : {}),
      ...(isValidCliVersion(doc?.opencode) ? { opencode: doc.opencode } : {}),
    };
    if (local.claude === published.claude && local.codex === published.codex && local.opencode === published.opencode) {
      return { outcome: 'current', pins: published };
    }
    const at = now().toISOString();
    await options.docs.write({ ...published, updatedAt: at, followed: { from: options.url, at } });
    options.onAdopted?.();
    return { outcome: 'adopted', from: local, to: published };
  }

  /** Check now (one at a time). Never throws. */
  function refresh(): Promise<PinFollowOutcome> {
    if (inFlight) return inFlight;
    inFlight = check()
      .catch((error): PinFollowOutcome => ({ outcome: 'unreachable', error: error instanceof Error ? error.message : String(error) }))
      .then((result) => {
        const previous = last;
        last = { ...result, checkedAt: now().toISOString() };
        const words = describe(result);
        // Adoption always; the rest only when it changes, so a daily "current" is not a daily log line.
        if (result.outcome === 'adopted' || !previous || describe(previous) !== words) options.log?.(`[cli-pins] ${words}`);
        return result;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  function start(): void {
    if (!options.url || timers.length) return;
    const first = setTimeout(() => { void refresh(); }, options.firstCheckMs ?? FIRST_CHECK_MS);
    const every = setInterval(() => { void refresh(); }, options.everyMs ?? DAY_MS);
    first.unref?.();
    every.unref?.();
    timers = [first, every];
  }

  function stop(): void {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
  }

  return { refresh, start, stop, state: () => last, url: options.url };
}

function describe(result: PinFollowOutcome): string {
  switch (result.outcome) {
    case 'off': return 'following is off';
    case 'held': return `held by this copy's admin since ${result.hold.at}; published pin claude ${result.published.claude}, codex ${result.published.codex}, opencode ${result.published.opencode} not adopted`;
    case 'current': return `on the published pin: claude ${result.pins.claude}, codex ${result.pins.codex}, opencode ${result.pins.opencode}`;
    case 'adopted': return `adopted the published pin: claude ${result.from.claude ?? '—'} → ${result.to.claude}, codex ${result.from.codex ?? '—'} → ${result.to.codex}, opencode ${result.from.opencode ?? '—'} → ${result.to.opencode}`;
    case 'unreachable': return `published pin not read: ${result.error}`;
  }
}

/** The pin document as the follower needs it, over the copy's own config store. */
export function pinFollowerDocs(store: {
  collection: (name: string) => { doc: (id: string) => { get(): Promise<{ data(): Record<string, unknown> | undefined }> } };
  setConfigDoc: (docId: string, updates: Record<string, unknown>) => void;
}): PinFollowerDocs {
  return {
    read: async () => (await store.collection(HARNESS_CLI_VERSIONS_COLLECTION).doc(HARNESS_CLI_VERSIONS_DOCUMENT).get()).data(),
    write: async (updates) => store.setConfigDoc(`${HARNESS_CLI_VERSIONS_COLLECTION}/${HARNESS_CLI_VERSIONS_DOCUMENT}`, updates),
  };
}
