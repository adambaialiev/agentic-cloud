/**
 * Every signed preview URL this session has minted, by caller-chosen key.
 *
 * The generic form of the notes screen's `note-previews.ts` (note #198), for
 * the surfaces that draw a picture off a short-lived signed URL inside a list
 * that is rebuilt on every poll: a URL minted at each paint is a URL the
 * browser's cache has never seen, so the same thumbnail is downloaded again
 * every five seconds. The entry holds the REQUEST as well as its answer, so
 * two painters of one picture share one mint.
 *
 * Module state on purpose: the cache outlives any one screen, which is what
 * lets a row rebuilt by a poll put its picture straight back rather than show
 * the file glyph again while it asks.
 */

/** What a mint answers with: the URL, when it stops working, and a picture's
 *  measured size when the read could say it (the chat's preview read does). */
export interface PreviewAccess { url?: string; expiresAt?: string; width?: number; height?: number }

export interface HeldPreview { url: string; width?: number; height?: number }

interface Held { asked: Promise<HeldPreview | null>; held: HeldPreview | null; expiresAt: number }

const previews = new Map<string, Held>();

/**
 * How much of a signed URL's life must remain for it to be worth reusing: the
 * URL is handed to an `<img>` that fetches it a moment later, and an expired
 * signature renders as a BROKEN picture rather than a slow one — strictly
 * worse than the re-download this map exists to avoid.
 */
export const PREVIEW_URL_MARGIN_MS = 60_000;

/** The preview already minted under this key, if enough of its signature is
 *  left. Synchronous, so a rebuilt row paints its picture on the first pass. */
export function heldPreview(key: string): HeldPreview | null {
  const entry = previews.get(key);
  if (!entry?.held) return null;
  if (!(entry.expiresAt - Date.now() > PREVIEW_URL_MARGIN_MS)) {
    previews.delete(key);
    return null;
  }
  return entry.held;
}

/** Mint a preview under `key`, or join the mint already in flight for it.
 *  Resolves to null when there is nothing to show. */
export function mintPreview(key: string, ask: () => Promise<PreviewAccess | null>): Promise<HeldPreview | null> {
  const existing = previews.get(key);
  if (existing && (!existing.held || heldPreview(key))) return existing.asked;
  const entry: Held = { asked: Promise.resolve(null), held: null, expiresAt: 0 };
  entry.asked = ask()
    .then((access) => {
      const url = access?.url ? String(access.url) : null;
      const expiresAt = Date.parse(access?.expiresAt ?? '');
      const held: HeldPreview | null = url
        ? { url, ...(access?.width && access?.height ? { width: access.width, height: access.height } : {}) }
        : null;
      // Only this mint fills in its OWN entry: a prune while the request was
      // out can have started a newer one, and that is the one to keep.
      if (previews.get(key) === entry) {
        // A URL that cannot be dated is used once and never held — the next
        // paint mints its own, which beats the broken picture an expired
        // signature would draw.
        if (held && expiresAt > 0) { entry.held = held; entry.expiresAt = expiresAt; }
        else previews.delete(key);
      }
      return held;
    })
    .catch(() => {
      // Storage said no once. Forgetting the attempt lets the next paint ask
      // again; remembering it would blank this picture for the whole session.
      if (previews.get(key) === entry) previews.delete(key);
      return null;
    });
  previews.set(key, entry);
  return entry.asked;
}

/** Forget every held preview whose key is not in `keep` — what a screen calls
 *  with the pictures its payload still carries, so the map measures what the
 *  account HAS rather than everything this session has ever painted. */
export function prunePreviews(keep: Iterable<string>): void {
  const carried = new Set(keep);
  for (const key of [...previews.keys()]) if (!carried.has(key)) previews.delete(key);
}

/** For the tests, which must not inherit another test's mints. */
export function forgetPreviews(): void {
  previews.clear();
}
