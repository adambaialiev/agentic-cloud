/**
 * The workplace's people, for every list that draws them — Home's people
 * section and the People page (note #328).
 *
 * Two reads, the same split the fleet keeps: `api/org/people` when the list
 * opens, for the rows themselves — names, faces, roles, agent counts — and
 * `api/org/people/live` on a tick, for the only two facts that move while
 * somebody is looking (whether a person is here right now, and their latest
 * line). The tick patches rows in place and never re-reads the heavy record.
 *
 * It runs only when there is SOMEBODY ELSE to watch. In a workplace of
 * one the single row is the reader's own, and "Here now" is true because
 * they are here reading it — a poll every five seconds could only ever
 * confirm that. A person joining is a new row, which no tick could add
 * anyway: that arrives with the next full read.
 *
 * A visit opens on what this tab last read of the workplace (note #612,
 * `people-cache.ts`): the cards stand at once and the read refreshes them
 * underneath, with no skeleton drawn over people the reader just saw.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type {
  WorkspaceOrgMember,
  WorkspacePeopleAnswer,
  WorkspacePeopleLiveAnswer,
} from '../../../../src/shared/workspace-api.js';
import { WorkspaceApiError } from '../../api/client.js';
import { useSession } from '../../session/useSession.js';
import { errorMessage } from '../../ui/format.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { forgetPeopleOf, heldPeople, holdPeople } from './people-cache.js';
import { applyPeopleLive, peopleInOrder } from './people-words.js';

/** The same cadence as the fleet's live line: quick enough that "here now"
 *  and a fresh recap land while the reader is still looking. */
export const PEOPLE_POLL_MS = 5000;

/**
 * The reader is no longer allowed to see this workplace's people —
 * removed from it, demoted out of it, or looking at one they never belonged
 * to. Distinct from a failed request, which says nothing about membership:
 * a dropped connection or a 500 must leave the rows exactly where they are
 * and let the next tick retry.
 */
function lostAccess(error: unknown): boolean {
  return error instanceof WorkspaceApiError && (error.status === 403 || error.status === 404);
}

export interface PeopleRead {
  /** The workplace the rows belong to; null until the read lands. */
  org: WorkspacePeopleAnswer['org'] | null;
  /** Here now first, then most recently seen — as working agents lead the fleet. */
  people: WorkspaceOrgMember[];
  /** True until the first read has answered, so a list can hold its shape. */
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
}

export function usePeople(): PeopleRead {
  const { api } = useSession();
  const { state } = useWorkspace();
  const [search] = useSearchParams();
  const orgId = search.get('org') || state?.org?.orgId || null;
  const [read, setRead] = useState<WorkspacePeopleAnswer | null>(() => heldPeople(orgId));
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(() => !heldPeople(orgId));
  // What the tick has said since the rows were read, folded over them at
  // render so a re-read never paints older facts than the last tick did.
  const [live, setLive] = useState<WorkspacePeopleLiveAnswer['people'] | null>(null);
  // A stale answer — one that arrives after a newer read was asked for —
  // never paints (the legacy `kToken` guard).
  const token = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++token.current;
    if (!orgId) { setRead(null); setLoading(false); return; }
    try {
      const answer = await api.api<WorkspacePeopleAnswer>('api/org/people', undefined, { org: orgId });
      if (mine !== token.current) return;
      holdPeople(orgId, answer);
      setRead(answer);
      setError('');
    } catch (err) {
      if (mine !== token.current) return;
      setError(errorMessage(err));
      // Access is gone, so the rows on screen are not "the last known
      // truth" — they are a membership this reader no longer has, and the
      // page must stop showing it. Dropping the read also stops the tick and
      // lets the screen draw the server's own sentence in its place.
      if (lostAccess(err)) { forgetPeopleOf(orgId); setRead(null); setLive(null); }
    } finally {
      if (mine === token.current) setLoading(false);
    }
  }, [api, orgId]);

  useEffect(() => {
    // Another workplace's people are not this one's: open on what this tab
    // holds for it, and wait visibly only when it holds nothing.
    const kept = heldPeople(orgId);
    setRead(kept);
    setLive(null);
    setLoading(!kept);
    // Off the effect's own tick: the read is asynchronous, the effect only subscribes.
    void Promise.resolve().then(refresh);
    return () => { token.current += 1; };
  }, [refresh, orgId]);

  const rows = read?.people;
  const watching = (rows?.length ?? 0) > 1;
  useEffect(() => {
    if (!watching) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (document.hidden) return;
      timer = setTimeout(() => { void tick(); }, PEOPLE_POLL_MS);
    };
    const tick = async () => {
      try {
        const answer = await api.api<WorkspacePeopleLiveAnswer>('api/org/people/live', undefined, { org: orgId });
        if (!alive) return;
        const ticked = answer.people ?? [];
        setLive(ticked);
        // Fold the tick into the held copy, so the next visit opens on the
        // freshest "here now" this tab has seen rather than the last full read's.
        const kept = orgId ? heldPeople(orgId) : null;
        if (kept) holdPeople(orgId!, { ...kept, people: applyPeopleLive(kept.people, ticked).people });
      } catch (err) {
        // A failed tick says nothing on screen; the next one retries — unless
        // it failed because this reader is no longer a member, which is the
        // one thing a tick can learn that the rows on screen contradict.
        if (alive && lostAccess(err)) {
          if (orgId) forgetPeopleOf(orgId);
          setError(errorMessage(err));
          setRead(null);
          setLive(null);
          return;
        }
      }
      if (alive) schedule();
    };
    const onVisibility = () => { if (!document.hidden) void tick(); else clearTimeout(timer); };
    document.addEventListener('visibilitychange', onVisibility);
    schedule();
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [api, orgId, watching]);

  const people = useMemo(() => {
    const known = rows ?? [];
    return peopleInOrder(live ? applyPeopleLive(known, live).people : known);
  }, [rows, live]);

  return { org: read?.org ?? null, people, loading, error, refresh };
}
