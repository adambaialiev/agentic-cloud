import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceOrgCloudAnswer } from '../../../src/shared/workspace-api.js';
import { useSession } from '../session/useSession.js';
import { readOrSayWhy, worthAskingAgain } from '../ui/read.js';
import { errorMessage } from '../ui/format.js';
import { forgetCloud, heldCloud, holdCloud } from './cloud-cache.js';

export const CLOUD_REFRESH_MS = 15_000;

/** A small org-scoped read; hidden pages pause, and late answers cannot cross orgs. */
export function useCloud(orgId: string, inventory = true) {
  const { api } = useSession();
  const [result, setResult] = useState<{ orgId: string; data: WorkspaceOrgCloudAnswer | null; error: string } | null>(null);
  const serial = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++serial.current;
    try {
      const data = await readOrSayWhy((init) => api.api<WorkspaceOrgCloudAnswer>(`api/org/cloud${inventory ? '' : '?inventory=0'}`, init, { org: orgId }));
      // Held and shown together, so what is kept is exactly what was last put
      // on the screen. A superseded answer — the workplace was switched, or
      // the card was left — is not held either: nothing accepted it, and
      // writing it now could put an older reading over a newer one.
      if (mine === serial.current) {
        holdCloud(orgId, inventory, data);
        setResult({ orgId, data, error: '' });
      }
      return data;
    } catch (error) {
      if (mine === serial.current) {
        // Nobody asked for this read — it is the fifteen-second refresh, or
        // the one a rebuilt screen makes over a card already drawn from cache.
        // A failure another attempt could fix (`readOrSayWhy` has already made
        // three over half a minute, so this is a network genuinely down) is
        // therefore ours to absorb: the card stays exactly as it was, and the
        // `checked HH:MM:SS` stamp on it stops advancing, which is the honest
        // report and needs no words of its own. The next poll tries again.
        if (worthAskingAgain(error) && heldCloud(orgId, inventory)) return null;
        // A REFUSAL is different, and so is a first read with nothing behind
        // it: one means what is held is no longer true, the other has nothing
        // to leave standing. Both say so.
        forgetCloud(orgId, inventory);
        setResult({ orgId, data: null, error: errorMessage(error) });
      }
      return null;
    }
  }, [api, orgId, inventory]);
  useEffect(() => {
    let alive = true;
    let polling = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      clearTimeout(timer);
      if (!alive || document.hidden || polling) return;
      polling = true;
      await refresh();
      polling = false;
      if (alive && !document.hidden) timer = setTimeout(() => { void poll(); }, CLOUD_REFRESH_MS);
    };
    const onVisible = () => { if (!document.hidden) void poll(); else clearTimeout(timer); };
    const onConnected = (event: Event) => { if ((event as CustomEvent<string>).detail === orgId) void refresh(); };
    window.addEventListener('workspace-cloud-connected', onConnected);
    void poll();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      serial.current += 1;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('workspace-cloud-connected', onConnected);
    };
  }, [refresh, orgId]);
  const current = result?.orgId === orgId ? result : null;
  // The copy this tab already holds is what goes up while the read above is
  // out — on a rebuilt screen, and on a workplace switched back to. Read
  // here rather than seeded into state so that it is picked up on the render
  // that needs it, including the one straight after `orgId` changes under a
  // hook that is not being remounted.
  const data = current?.data ?? heldCloud(orgId, inventory);
  // One or the other, never both: a card that can be drawn is the answer, and
  // a failure worth reporting is one with nothing left to draw.
  return { data, error: data ? '' : current?.error ?? '', refresh };
}
