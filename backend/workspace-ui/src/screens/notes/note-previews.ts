/**
 * Every preview URL this session has minted, by note and file (note #198).
 *
 * A note's file is fetched through a URL signed for fifteen minutes, and the
 * backend signs a NEW one on every ask — so two mints of one unchanged
 * photograph are two different URLs, and a browser caches bytes against the
 * URL it fetched them from. The rows are rebuilt whenever anything in the
 * notes payload changes, which handed every `<img>` a src the cache had never
 * seen: eight photo notes with the notes screen open re-downloaded all
 * fourteen thumbnails because a comment landed on one of them.
 *
 * The entry holds the REQUEST as well as its answer. Home's glimpse and the
 * notes screen draw the same note in a single pass, so the second painter
 * joins the first one's mint rather than starting a second.
 *
 * Module state on purpose, exactly as the legacy page keeps it: the cache
 * outlives any one screen, which is the whole point — a row rebuilt by a poll
 * must put its picture straight back rather than show the file glyph again
 * while it asks.
 */

import type { WorkspaceFileAccessAnswer } from '../../../../src/shared/workspace-api.js';
import type { WorkspaceApi } from '../../api/client.js';

interface Held { asked: Promise<string | null>; url: string | null; expiresAt: number }

const urls = new Map<string, Held>();

/**
 * How much of a signed URL's life must remain for it to be worth reusing.
 *
 * The URL is handed to an `<img>` that fetches it a moment later, and an
 * expired signature renders as a BROKEN picture rather than a slow one —
 * strictly worse than the re-download this map exists to avoid. A minute
 * covers that gap with room to spare against a slow phone and a clock a
 * little out of step with the server's.
 */
export const PREVIEW_URL_MARGIN_MS = 60_000;

/** What identifies the picture: the file, on the note it hangs off. A file
 *  taken off and put back gets a new id, so it gets a new URL too. */
export function notePreviewKey(note: { number: number }, file: { id: string }): string {
  return `${note.number}/${file.id}`;
}

/** The URL already minted for this file, if enough of its signature is left.
 *  Reading it synchronously is what lets a rebuilt row put its picture
 *  straight back, instead of showing the file glyph again while it asks. */
export function heldNotePreviewUrl(key: string): string | null {
  const held = urls.get(key);
  if (!held || !held.url) return null;
  if (!(held.expiresAt - Date.now() > PREVIEW_URL_MARGIN_MS)) {
    urls.delete(key);
    return null;
  }
  return held.url;
}

/** Mint a preview URL for one note file, or join the mint already in flight
 *  for it. Resolves to null when there is nothing to show. */
export function notePreviewUrl(
  api: WorkspaceApi,
  note: { number: number },
  file: { id: string },
): Promise<string | null> {
  const key = notePreviewKey(note, file);
  const held = urls.get(key);
  // Still in flight, or minted and still comfortably signed: either way this
  // picture already has a request and does not need a second one.
  if (held && (!held.url || heldNotePreviewUrl(key))) return held.asked;
  const entry: Held = { asked: Promise.resolve(null), url: null, expiresAt: 0 };
  entry.asked = api
    .api<WorkspaceFileAccessAnswer>(
      `api/notes/${encodeURIComponent(note.number)}/files/${encodeURIComponent(file.id)}`,
    )
    .then((access) => {
      const url = access?.url ? String(access.url) : null;
      const expiresAt = Date.parse(access?.expiresAt ?? '');
      // Only this mint fills in its OWN entry: a prune while the request was
      // out can have started a newer one, and that is the one to keep.
      if (urls.get(key) === entry) {
        // A URL that cannot be dated is used once and never held — the next
        // paint mints its own, which beats the broken picture an expired
        // signature would draw.
        if (url && expiresAt > 0) { entry.url = url; entry.expiresAt = expiresAt; }
        else urls.delete(key);
      }
      return url;
    })
    .catch(() => {
      // Storage said no once. Forgetting the attempt lets the next paint ask
      // again; remembering it would blank this glimpse for the whole session.
      if (urls.get(key) === entry) urls.delete(key);
      return null;
    });
  urls.set(key, entry);
  return entry.asked;
}

/** Forget the URLs of pictures the notes payload no longer carries — a note
 *  archived, deleted, or with its file taken off. The map then measures what
 *  the account HAS, not everything this session has ever painted. */
export function pruneNotePreviewUrls(
  notes: ReadonlyArray<{ number: number; attachmentPreview?: { id: string } }> | null | undefined,
): void {
  const carried = new Set<string>();
  for (const note of notes ?? []) {
    if (note?.attachmentPreview) carried.add(notePreviewKey(note, note.attachmentPreview));
  }
  for (const key of [...urls.keys()]) if (!carried.has(key)) urls.delete(key);
}

/** For the tests, which must not inherit another test's mints. */
export function forgetNotePreviewUrls(): void {
  urls.clear();
}
