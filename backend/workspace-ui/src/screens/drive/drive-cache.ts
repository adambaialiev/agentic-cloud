/**
 * The last thing this tab read about Drive: every listing, file detail and
 * preview it has taken delivery of.
 *
 * Note #520, in the user's own words: "Refine drive caching and refetching. It
 * should not flickr when user traverses the drive." It is the fourth time the
 * same complaint has been made about a different screen — note #306 about a
 * note, #354 and #368 about the cloud, and the mail list after them — and it
 * gets the same answer as all three: the answer outlives the screen, a visit
 * opens on the held copy, and the read goes out underneath it.
 *
 * Drive earns it more than any of them, because Drive is the only part of the
 * Workspace a reader WALKS. `App.tsx` keys the Drive screens on the workplace,
 * the item and whether this is Trash, so every step in or out REBUILDS the
 * screen from nothing — which is right, since one folder's search box and
 * half-open Manage sheet must never survive into the next. It is wrong to have
 * nothing to start from: without this file, tapping a folder and coming
 * straight back put a blank card where a list had been a second earlier, twice
 * per round trip.
 *
 * Keyed by the READ PATH, not by an item id. `driveApi` builds one string out
 * of the workplace, the parent, Trash and the search term, and that string is
 * exactly the question asked — so two questions with two different answers can
 * never share an entry, and a workplace switch cannot serve one workplace's
 * folder under another's name.
 *
 * Per TAB, like its three siblings, and for the same reason: this is a live
 * reading of a shared library rather than a document, and a copy serialised
 * into `sessionStorage` would come back after a reload older than the fifteen
 * seconds the list promises. It is emptied by `SessionProvider` on sign-out,
 * by the test setup between tests, and by every Drive WRITE — see
 * `forgetDrives` for why a write takes the whole of it.
 */

import type { DriveItem, DriveListing } from '../../../../src/shared/drive.js';

/** How many reads are worth keeping. A reader walks down a few folders and
 *  back up, opening files on the way; past that this is holding answers
 *  nobody is returning to, and a listing is not a small object. */
export const DRIVE_READS_KEPT = 24;

interface HeldRead { answer: unknown; at: number }

const held = new Map<string, HeldRead>();

/** What this tab last read at this path, if it has ever read it. Read
 *  synchronously during a render, which is what lets a rebuilt screen put the
 *  list straight back instead of asking again in front of the reader. */
export function heldDrive<T>(path: string): T | null {
  return (held.get(path)?.answer as T | undefined) ?? null;
}

/** Keep what was just read. */
export function holdDrive(path: string, answer: unknown): void {
  // Re-inserted rather than updated, so the map's own insertion order is a
  // least-recently-used list and the eviction below needs nothing else.
  held.delete(path);
  held.set(path, { answer, at: Date.now() });
  while (held.size > DRIVE_READS_KEPT) {
    const oldest = held.keys().next();
    if (oldest.done) break;
    held.delete(oldest.value);
  }
}

/** Forget one answer: the server has REFUSED this read, or the copy has aged
 *  out of usefulness. Either way what is held here describes a Drive this
 *  reader may no longer be looking at, and showing it on the way back would
 *  draw a file that is gone or a signature that has expired. */
export function forgetDrive(path: string): void {
  held.delete(path);
}

/**
 * The whole of it, gone.
 *
 * Sign-out asks, the test setup asks — and so does every Drive WRITE, which is
 * the one that needs explaining. A write is never local to the listing it was
 * made from: a move empties one folder and fills another, a rename changes a
 * row in every search that matched it, and an upload, a trash and a permanent
 * delete each move `totalBytes` and `trashCount`, which are drawn on EVERY
 * listing including Trash's. Picking those apart precisely would mean tracking
 * descendants and search terms to get right, and getting it wrong means a
 * reader tapping Back onto a file they just deleted.
 *
 * So a write takes all of it, and that costs nothing where it would be felt:
 * the screen the write was made from keeps drawing its OWN last answer (the
 * hook prefers that to the cache) and refreshes underneath, so the list the
 * reader is looking at never blinks. Only a LATER visit to some other folder
 * pays a read for it, which is the visit that most needs the true numbers.
 */
export function forgetDrives(): void {
  held.clear();
}

/** A listing path — `driveApi(orgId)` with no id suffix — is the only kind
 *  worth scanning for an outline, and only when it is a plain folder read:
 *  the server answers a search or a Trash listing with no folder and no
 *  breadcrumbs at all, so an item found in one carries no path with it. */
function plainListing(path: string, orgId: string): boolean {
  const [route, query = ''] = path.split('?', 2);
  if (route !== 'api/drive') return false;
  const asked = new URLSearchParams(query);
  return asked.get('org') === orgId && !asked.get('q') && asked.get('trash') !== '1';
}

/**
 * What this tab already knows about one item, from the listing it was last
 * seen in — everything about the screen it opens EXCEPT that screen's own
 * contents.
 *
 * This is the other half of not flickering, and the half a cache cannot do. A
 * folder opened for the FIRST time has no held answer to draw, but its name,
 * the trail of folders above it and Drive's own totals were all in the listing
 * the reader just tapped. Without this the heading falls back to the word
 * "Drive", the breadcrumbs collapse to a single segment and the Trash count
 * disappears — for the tenth of a second the read takes, on a screen whose
 * frame was never in doubt.
 *
 * `breadcrumbs` is the path to the item's PARENT, which is what a file screen
 * draws as it stands; a folder screen appends the item itself, exactly as the
 * server's own answer for that folder would.
 */
export interface DriveOutline {
  item: DriveItem;
  breadcrumbs: DriveItem[];
  canDeleteForever: boolean;
  totalBytes: number;
  trashCount: number;
  maxFileBytes: number;
}

export function heldDriveItem(orgId: string, id: string): DriveOutline | null {
  if (!orgId || !id) return null;
  // Newest first: insertion order is least-recently-used, so the listing the
  // reader has most recently been looking at is the one its rows are trusted
  // from.
  for (const [path, entry] of [...held].reverse()) {
    if (!plainListing(path, orgId)) continue;
    const listing = entry.answer as DriveListing;
    if (!Array.isArray(listing?.items)) continue;
    const item = listing.items.find((row) => row.id === id && !row.trashedAt);
    if (!item) continue;
    return { item, breadcrumbs: listing.breadcrumbs ?? [], canDeleteForever: listing.canDeleteForever,
      totalBytes: listing.totalBytes, trashCount: listing.trashCount, maxFileBytes: listing.maxFileBytes };
  }
  return null;
}
