import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { DriveArchiveSummary } from '../../../../src/shared/drive.js';
import type { WorkspaceApi } from '../../api/client.js';
import { useSession } from '../../session/useSession.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { readOrSayWhy, worthAskingAgain } from '../../ui/read.js';
import { errorMessage } from '../../ui/format.js';
import { saveFile } from '../../ui/save-file.js';
import { forgetDrive, heldDrive, holdDrive } from './drive-cache.js';
import { driveBrowserUrl } from './drive-links.js';

export function useDriveOrg() {
  const [search] = useSearchParams();
  const { state } = useWorkspace();
  return search.get('org') || state?.org?.orgId || '';
}
export function driveApi(orgId: string, suffix = '', query: Record<string, string> = {}) {
  return `api/drive${suffix}?${new URLSearchParams({ org: orgId, ...query })}`;
}

/**
 * Save a folder — or all of Drive, for `null` — as one .zip (note #694).
 *
 * Asked about first, through the session, so a folder with nothing in it or
 * one too large to send is a sentence on the screen rather than a download
 * that fails on the shelf. Then the browser follows the address itself: the
 * bytes stream to its downloads with their real size, never through this tab.
 */
export async function saveDriveFolder(api: WorkspaceApi, orgId: string, id: string | null): Promise<void> {
  const suffix = `/${encodeURIComponent(id ?? 'root')}/archive`;
  const archive = await api.api<DriveArchiveSummary>(driveApi(orgId, suffix, { check: '1' }));
  saveFile(driveBrowserUrl(orgId, suffix), archive.fileName);
}

export interface DriveReadOptions<T> {
  /** Re-read every fifteen seconds and whenever the tab comes back to the
   *  front. True for anything a reader watches change; false for a preview,
   *  which is a photograph of one file rather than a live list. */
  poll?: boolean;
  /**
   * Whether a HELD answer is still exactly right — in which case it is shown
   * and NOT asked for again.
   *
   * Given only where a second read could not produce a better answer but could
   * produce a visibly different one. That is the preview: a file's bytes never
   * change under its own id, so re-reading returns the same picture behind a
   * FRESH fifteen-minute signature, and swapping the `src` of an image the
   * reader is already looking at reloads it in front of them. Where it is
   * given, an answer it rejects is not shown either: an expired signature is
   * not a stale answer, it is a broken one.
   *
   * Must be stable across renders — module scope, not an inline arrow.
   */
  stillTrue?: (answer: T) => boolean;
}

type DriveResult<T> = { path: string; data: T | null; error: string };

/**
 * One Drive read: served from what this tab already holds, refreshed
 * underneath it, and bounded so it cannot wait forever (note #520; the bound
 * is note #308's, in `ui/read.ts`).
 *
 * Three rules, and they are the ones the cloud screens already keep:
 *
 *  HELD FIRST   what this tab last read at this path is picked up during the
 *               render that needs it, never seeded into state — so a folder
 *               walked back into draws its own list on the very first render,
 *               with no wait drawn over it at all.
 *  ABSORBED     a refresh NOBODY ASKED FOR that fails for a reason another
 *               attempt could fix leaves the answer standing and says nothing.
 *               The fifteen-second poll is ours, not the reader's, and on a
 *               phone it fails often enough that its failures must not be
 *               theirs to look at.
 *  REFUSED      a refusal is different, and so is a first read with nothing
 *               behind it. One means what is held is no longer true — a folder
 *               an agent has just trashed — and the other has nothing to leave
 *               standing. Both forget the copy and say so, beside Try again.
 */
export function useDriveRead<T>(path: string | null, { poll = true, stillTrue }: DriveReadOptions<T> = {}) {
  const { api } = useSession();
  const [result, setResult] = useState<DriveResult<T> | null>(null);
  const [version, setVersion] = useState(0);
  const shown = useRef<DriveResult<T> | null>(null);
  const forcedAt = useRef(0);
  const serial = useRef(0);
  const put = useCallback((next: DriveResult<T>) => { shown.current = next; setResult(next); }, []);
  const reload = useCallback(() => { serial.current += 1; setVersion((value) => value + 1); }, []);

  useEffect(() => {
    if (!path) return;
    let alive = true;
    let pending = false;
    const drawing = () => heldDrive(path) !== null || (shown.current?.path === path && shown.current.data !== null);
    const read = async () => {
      if (pending) return;
      pending = true;
      const stamp = ++serial.current;
      // A read with nothing on the screen behind it is one the reader is
      // waiting on, and it gets the whole ladder — three attempts across the
      // width of a backend release (note #308). A refresh over an answer they
      // can already see gets one bounded attempt and, failing that, silence.
      const under = drawing();
      try {
        const data = await readOrSayWhy((init) => api.api<T>(path, init), under ? { again: [] } : {});
        if (stamp !== serial.current) return;
        holdDrive(path, data);
        if (alive) put({ path, data, error: '' });
      } catch (error) {
        if (stamp !== serial.current) return;
        if (worthAskingAgain(error) && drawing()) return;
        forgetDrive(path);
        if (alive) put({ path, data: null, error: errorMessage(error) });
      } finally { pending = false; }
    };
    // A held answer that `stillTrue` rejects is not an answer: it goes before
    // anything can draw it, and the read below replaces it. One this screen
    // CAN draw is recorded as what it is drawing — a REF, not state, so no
    // render is forced for a value the render below already found. It is what
    // makes the glass stop depending on the cache: a write empties the whole
    // cache (see `forgetDrives`), and the list the reader is looking at must
    // not go with it.
    const kept = heldDrive<T>(path);
    const settled = kept !== null && stillTrue !== undefined && stillTrue(kept);
    if (kept !== null && stillTrue !== undefined && !settled) forgetDrive(path);
    else if (kept !== null && shown.current?.path !== path) shown.current = { path, data: kept, error: '' };
    // `reload` is a demand — after a write, or from Try again — so it asks
    // even for an answer that would otherwise have been left alone.
    const demanded = version !== forcedAt.current;
    forcedAt.current = version;
    if (demanded || !settled) void read();
    if (!poll) return () => { alive = false; };
    const refresh = () => { if (document.visibilityState !== 'hidden') void read(); };
    window.addEventListener('focus', refresh);
    const timer = window.setInterval(refresh, 15_000);
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [api, path, version, poll, stillTrue, put]);

  // Read HERE rather than seeded into state, so the copy this tab holds is
  // picked up on the render that needs it — including the first render after a
  // step into a folder this reader has already been in.
  const current = path && result?.path === path ? result : null;
  const kept = path ? heldDrive<T>(path) : null;
  const usable = kept !== null && (stillTrue === undefined || stillTrue(kept)) ? kept : null;
  // Last of the three: what this hook has already drawn for this path. It is
  // the same answer as the cache's until a write empties the cache, and that
  // is precisely when it earns its place — the reader's own list must not be
  // taken away by their own upload.
  const drawn = shown.current?.path === path ? shown.current.data : null;
  const data = current?.data ?? usable ?? drawn;
  return { data, error: data !== null ? '' : current?.error ?? '', reload };
}
