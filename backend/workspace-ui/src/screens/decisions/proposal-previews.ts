/**
 * Every signed URL this session holds for a proposal's picture, by proposal
 * and file (note #825) — the proposal sheet's copy of the notes screen's
 * register (notes/note-previews.ts), kept for the same reason.
 *
 * A picture is drawn from a URL signed for fifteen minutes. The proposal's
 * own answer now carries that URL for every picture it has, so the first
 * paint asks nobody; but the sheet is rebuilt whenever its detail is re-read
 * (a poll, a decision, Back and forward), and an `<img>` handed a src it
 * has not seen downloads again. The backend keeps one signature stable for
 * most of its life, so the carried URL usually IS the one already drawn —
 * and this map is what lets a rebuilt sheet put the picture straight back
 * when the answer carries none (an older backend, a picture whose mint
 * failed) rather than show a grey frame while it asks.
 *
 * Module state on purpose: the register outlives any one screen.
 */

import type { WorkspaceFileAccessAnswer } from '../../../../src/shared/workspace-api.js';
import type { WorkspaceApi } from '../../api/client.js';

interface Held { asked: Promise<string | null>; url: string | null; expiresAt: number }

const urls = new Map<string, Held>();

/**
 * How much of a signed URL's life must remain for it to be worth drawing.
 * An expired signature renders as a BROKEN picture rather than a slow one,
 * so a URL within a minute of its end is minted afresh instead.
 */
export const PREVIEW_URL_MARGIN_MS = 60_000;

export function proposalPreviewKey(proposalId: string, file: { id: string }): string {
  return `${proposalId}/${file.id}`;
}

/** Whether a dated URL still has enough life in it to hand to an <img>. */
export function previewStillGood(expiresAt: string | number | undefined): boolean {
  const at = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt ?? '');
  return at - Date.now() > PREVIEW_URL_MARGIN_MS;
}

/** The URL already held for this picture, if enough of its signature is left. */
export function heldProposalPreviewUrl(key: string): string | null {
  const held = urls.get(key);
  if (!held || !held.url) return null;
  if (!previewStillGood(held.expiresAt)) {
    urls.delete(key);
    return null;
  }
  return held.url;
}

/** Remember a URL the proposal's answer carried, so a rebuilt sheet finds
 *  it without asking. A URL that cannot be dated is drawn once, never held. */
export function holdProposalPreview(key: string, preview: { url: string; expiresAt: string }): void {
  const expiresAt = Date.parse(preview.expiresAt);
  if (!(expiresAt > 0) || !previewStillGood(expiresAt)) return;
  const held = urls.get(key);
  if (held?.url === preview.url) return;
  urls.set(key, { asked: Promise.resolve(preview.url), url: preview.url, expiresAt });
}

/** Mint a preview URL for one picture, or join the mint already in flight.
 *  Resolves to null when there is nothing to show. */
export function proposalPreviewUrl(
  api: WorkspaceApi,
  proposalId: string,
  file: { id: string },
): Promise<string | null> {
  const key = proposalPreviewKey(proposalId, file);
  const held = urls.get(key);
  if (held && (!held.url || heldProposalPreviewUrl(key))) return held.asked;
  const entry: Held = { asked: Promise.resolve(null), url: null, expiresAt: 0 };
  entry.asked = api
    .api<WorkspaceFileAccessAnswer>(
      `api/prs/${encodeURIComponent(proposalId)}/files/${encodeURIComponent(file.id)}?preview=1`,
      undefined,
    )
    .then((access) => {
      const url = access?.url ? String(access.url) : null;
      const expiresAt = Date.parse(access?.expiresAt ?? '');
      if (urls.get(key) === entry) {
        if (url && expiresAt > 0) { entry.url = url; entry.expiresAt = expiresAt; }
        else urls.delete(key);
      }
      return url;
    })
    .catch(() => {
      if (urls.get(key) === entry) urls.delete(key);
      return null;
    });
  urls.set(key, entry);
  return entry.asked;
}

/** Where early-read.ts looks for the picture store's address; repeated
 *  rather than imported, and pinned by early-read.test.ts. */
export const MEDIA_ORIGIN_KEY = 'acc.mediaOrigin';

/** Remember which origin proposal pictures come from, so the next proposal
 *  opened — from a link or inside the app — can warm the connection to it
 *  before its answer lands. */
export function rememberMediaOrigin(url: string): void {
  let origin = '';
  try { origin = new URL(url).origin; } catch { return; }
  if (!origin.startsWith('https://')) return;
  try {
    if (window.localStorage.getItem(MEDIA_ORIGIN_KEY) !== origin) window.localStorage.setItem(MEDIA_ORIGIN_KEY, origin);
  } catch { /* private mode: nothing remembered, nothing warmed */ }
}

const warmed = new Set<string>();

/**
 * Open the connection to the picture store before the proposal's answer
 * lands (follow-up to note #825). Inside the app at phone size the first
 * picture arrived ~0.6 s after the words; part of that is opening a fresh
 * connection to the store, which a phone pays in real round trips. Warmed
 * while the proposal is being read, that part is done before the picture is
 * asked for. How much it saves is NOT measured: Chrome's network throttle
 * adds latency per request rather than per connection, so the harness cannot
 * show a handshake saved. Once per origin per page: the browser keeps the
 * connection, and a second hint would do nothing.
 */
export function warmMediaOrigin(): void {
  let origin = '';
  try { origin = window.localStorage.getItem(MEDIA_ORIGIN_KEY) ?? ''; } catch { return; }
  if (!/^https:\/\/[^/]+$/.test(origin) || warmed.has(origin)) return;
  warmed.add(origin);
  if (document.head.querySelector(`link[rel="preconnect"][href="${origin}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'preconnect';
  link.href = origin;
  document.head.appendChild(link);
}

/** Tests only: a fresh register. */
export function forgetProposalPreviewUrls(): void {
  urls.clear();
  warmed.clear();
}
