/**
 * What the signed-in Workspace knows, and how it keeps it current.
 *
 * The legacy page's `load()` / `pollLive()` / `refreshNotifications()` trio,
 * with the same three refresh rules (knowledge page
 * "workspace-miniapp-refresh"):
 *
 *  - The FULL read (`api/state`) happens on open, when an action asks for it, when Home's Workplace window opens (note #717 — it
 *    is no route arrival, so nothing else would re-read what it shows), and
 *    re-arms itself every five seconds only while something is visibly
 *    mid-transition — an agent being set up, a check still running. It
 *    reads a dozen stores; nothing turn-shaped rides it.
 *  - The LIVE tick (`api/agents/live`) runs every five seconds while the
 *    page is visible. While the working set holds still it patches the
 *    tail of each row; when a turn starts or ends it buys one full read.
 *  - Notifications refresh after every full read and every thirty seconds.
 *
 * Both timers stop while the document is hidden and catch up the moment it
 * is shown again. A workplace switch is guarded by a monotonic serial, so a
 * slow answer for the workplace just left can never paint over the one
 * selected after it.
 *
 * There was a VIEWED ROOM here too — state that rode every call as
 * `?room=`, started at the room Home's address named, and switched by the
 * room tabs — until rooms left the product (note #843). Every read is the
 * whole workplace's now, and no request names a room.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { matchPath, useLocation } from 'react-router-dom';
import { routerPathFor } from '../routes.js';
import type {
  WorkspaceAgentsLiveAnswer,
  WorkspaceNotificationRow,
  WorkspaceNotificationsAnswer,
  WorkspaceNotificationsReadRequest,
  WorkspaceStateAnswer,
} from '../../../src/shared/workspace-api.js';
import type { WorkspaceRecapAnswer, WorkspaceRecapSettingsAnswer } from '../../../src/shared/workspace-recap.js';
import { jsonBody, WorkspaceApiError, type WorkspaceApi } from '../api/client.js';
import { WorkspaceContext, type WorkspaceHomeOverview, type WorkspaceValue } from './context.js';
import {
  applyLiveNoteClaims, applyLiveTeamWorking, applyLiveTick, carryAgentRecapArrivals, unreadChatAgentId,
} from './live.js';
import { standInWorkplace, standingWorkplace } from './standing-workplace.js';
import {
  heldWorkplace, holdWorkplace, type HeldWorkplace, type WorkspaceLoaded,
} from './workspace-cache.js';

export const LIVE_POLL_MS = 5000;
export const NOTIFICATION_POLL_MS = 30_000;
export const TRANSITION_POLL_MS = 5000;

/** Statuses that move on their own within a minute or two; a full read every
 *  five seconds is what lets the row change without a reopen. */
// `planned` too (2026-09-18): a founding agent whose computer is queued is
// one the arriving screen is watching for, and only the full read moves it.
const WAITING_STATUSES = new Set(['planned', 'setting-up', 'needs-seat', 'needs-bot', 'needs-sign-in']);

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A read refused BECAUSE of the workplace this tab named: the membership
 *  behind it is gone (note #628). */
const refusedAsStanding = (error: unknown): boolean => (
  error instanceof WorkspaceApiError && error.status === 403 && standingWorkplace() !== null
);

type Loaded = WorkspaceLoaded;

const EMPTY_HOME_OVERVIEW: WorkspaceHomeOverview = {
  status: 'idle', blockHome: false, orgId: null, recap: null, recapSettings: null,
};

export function WorkspaceProvider({ api, sessionId, initialOrgId, children }: {
  api: WorkspaceApi; sessionId: string; initialOrgId?: string; children: ReactNode;
}) {
  const location = useLocation();
  // Home again since note #715: the Workplace window and the agents picker
  // stand over it, so an arrival there is what re-reads the workplace and
  // its briefing batch. The overview's old address counts too — it hands
  // over to Home with the window it names.
  const onHome = location.pathname === '/' || Boolean(matchPath(routerPathFor('recapAgent'), location.pathname));
  const [openingCopy] = useState<HeldWorkplace | null>(() => heldWorkplace(api, sessionId, initialOrgId));
  const [loaded, setLoaded] = useState<Loaded | null>(() => openingCopy?.loaded ?? null);
  const [error, setError] = useState('');
  const [notifications, setNotifications] = useState<WorkspaceNotificationRow[]>(() => openingCopy?.notifications ?? []);
  const [homeOverview, setHomeOverview] = useState<WorkspaceHomeOverview>(() => {
    const overview = openingCopy?.overview;
    return overview && overview.orgId === (initialOrgId ?? null)
      ? { ...overview, blockHome: false }
      : { ...EMPTY_HOME_OVERVIEW, blockHome: onHome && Boolean(initialOrgId), orgId: initialOrgId ?? null };
  });

  // The truth the async work reads: what the page is standing in RIGHT NOW,
  // not what it stood in when a request was sent.
  const activeOrgRef = useRef<string | null>(loaded?.state.org?.orgId ?? initialOrgId ?? null);
  const serialRef = useRef(0);
  const loadedRef = useRef<Loaded | null>(loaded);
  const homeRouteRef = useRef(onHome);
  const homeRefreshInFlight = useRef<Promise<boolean> | null>(null);
  const homeOverviewInFlight = useRef<{ orgId: string | null; promise: Promise<void> } | null>(null);
  const homeOverviewGeneration = useRef(0);
  const alive = useRef(true);
  const claimed = useRef(new Set<string>());
  const claimOnce = useCallback((key: string) => {
    if (claimed.current.has(key)) return false;
    claimed.current.add(key);
    return true;
  }, []);
  const timers = useRef<{ live?: ReturnType<typeof setTimeout>; notifications?: ReturnType<typeof setTimeout>; transition?: ReturnType<typeof setTimeout> }>({});

  /**
   * Home used to begin these only after api/state removed the page skeleton.
   * Its 250ms drawn-wait branch therefore painted a normal Agent card with
   * no answer yet; AgentFace correctly interpreted the absent URL as "no
   * face" and briefly drew the robot. Start the reads beside api/state
   * instead. Each answer is independent: one failed settings read must not
   * throw away a recap. Two since note #656: the Workspace Agent's own
   * settings were a third, for the card Home no longer draws.
   */
  const readHomeOverview = useCallback((orgId?: string): Promise<void> => {
    const requestedOrg = orgId ?? activeOrgRef.current;
    // A tab standing in no workplace — the one it stood in was deleted
    // beneath it (note #628) — has no briefing to read: the recap routes
    // belong to a workplace, and asking with none is three refusals.
    if (!requestedOrg) {
      homeOverviewGeneration.current += 1;
      setHomeOverview(EMPTY_HOME_OVERVIEW);
      return Promise.resolve();
    }
    if (homeOverviewInFlight.current?.orgId === requestedOrg) return homeOverviewInFlight.current.promise;
    const generation = ++homeOverviewGeneration.current;
    const copy = heldWorkplace(api, sessionId, requestedOrg)?.overview;
    setHomeOverview((current) => (
      copy?.status === 'ready'
        ? { ...copy, blockHome: false }
        : current.status === 'ready' && (!requestedOrg || current.orgId === requestedOrg)
        ? current
        : {
            status: 'loading',
            blockHome: current.blockHome || Boolean(requestedOrg && current.orgId && current.orgId !== requestedOrg),
            orgId: requestedOrg, recap: null, recapSettings: null,
          }
    ));
    const scope = requestedOrg ? { org: requestedOrg } : undefined;
    // The workplace's one briefing (note #843): it was the viewed room's
    // (note #688), asked for by the room the page stood in.
    const pending = Promise.allSettled([
      api.api<WorkspaceRecapAnswer>('api/recap', undefined, scope),
      api.api<WorkspaceRecapSettingsAnswer>('api/recap/settings', undefined, scope),
    ]).then(([recap, recapSettings]) => {
      if (!alive.current || generation !== homeOverviewGeneration.current) return;
      const answerOrg = recap.status === 'fulfilled' ? recap.value.orgId
        : recapSettings.status === 'fulfilled' ? recapSettings.value.orgId : requestedOrg;
      const next: WorkspaceHomeOverview = {
        status: 'ready', blockHome: false, orgId: answerOrg,
        recap: recap.status === 'fulfilled' ? recap.value : null,
        recapSettings: recapSettings.status === 'fulfilled' ? recapSettings.value : null,
      };
      if (answerOrg) holdWorkplace(api, sessionId, answerOrg, { overview: next });
      setHomeOverview(next);
    }).finally(() => {
      if (homeOverviewInFlight.current?.promise === pending) homeOverviewInFlight.current = null;
    });
    homeOverviewInFlight.current = { orgId: requestedOrg, promise: pending };
    return pending;
  }, [api, sessionId]);

  const commit = useCallback((next: Loaded | null) => {
    loadedRef.current = next;
    if (next) {
      activeOrgRef.current = next.state.org?.orgId ?? null;
      if (activeOrgRef.current) holdWorkplace(api, sessionId, activeOrgRef.current, { loaded: next });
    }
    setLoaded(next);
  }, [api, sessionId]);

  const refreshNotifications = useCallback(async (): Promise<WorkspaceNotificationRow[]> => {
    const requestedOrg = activeOrgRef.current;
    try {
      const answer = await api.api<WorkspaceNotificationsAnswer>('api/notifications', undefined, { org: standingWorkplace() });
      const rows = answer.notifications ?? [];
      if (alive.current && activeOrgRef.current === requestedOrg) {
        setNotifications(rows);
        if (requestedOrg) holdWorkplace(api, sessionId, requestedOrg, { notifications: rows });
      }
      return rows;
    } catch {
      // A failed refresh says nothing on screen; the next one retries — and
      // a refusal of the tab's own workplace is settled by the live tick's
      // full read within seconds, which this poll then follows.
      return [];
    }
  }, [api, sessionId]);

  /** The receipt a conversation owes its completion notifications. */
  const markAgentNotificationsRead = useCallback(async (agentId: string): Promise<boolean> => {
    const origin = window.location.origin;
    const rows = await refreshNotifications();
    const pending = rows.filter((row) => unreadChatAgentId(row, origin) === agentId);
    if (!pending.length) return false;
    try {
      await api.api('api/notifications/read', jsonBody({
        notificationIds: pending.map((row) => row.notificationId),
      } satisfies WorkspaceNotificationsReadRequest));
    } catch {
      // Reading the conversation is the primary action. A failed receipt
      // stays visible and the next poll retries instead of breaking the chat.
      return false;
    }
    if (!alive.current) return true;
    const readAt = new Date().toISOString();
    const acknowledged = new Set(pending.map((row) => row.notificationId));
    setNotifications((current) => {
      const next = current.map((row) => (
        acknowledged.has(row.notificationId) ? { ...row, readAt } : row
      ));
      const orgId = activeOrgRef.current;
      if (orgId) holdWorkplace(api, sessionId, orgId, { notifications: next });
      return next;
    });
    return true;
  }, [api, refreshNotifications, sessionId]);

  // Callbacks that re-arm themselves, or re-arm each other, read the newest
  // version through a ref rather than the closure they were created in.
  const scheduleNotificationsRef = useRef<() => void>(() => {});
  const loadRef = useRef<() => Promise<boolean>>(async () => false);
  const pollLiveRef = useRef<() => Promise<void>>(async () => {});

  const scheduleNotifications = useCallback(() => {
    clearTimeout(timers.current.notifications);
    if (document.hidden) return;
    timers.current.notifications = setTimeout(() => {
      void refreshNotifications().then(() => scheduleNotificationsRef.current());
    }, NOTIFICATION_POLL_MS);
  }, [refreshNotifications]);

  /** The full read. False when a newer request owns the screen. */
  const load = useCallback(async (): Promise<boolean> => {
    const sequence = serialRef.current;
    // The three reads name the workplace THIS TAB stands in (note #628), so
    // a switch made in another tab never answers them.
    let answer: WorkspaceStateAnswer;
    try {
      answer = await api.api<WorkspaceStateAnswer>('api/state', undefined, { org: standingWorkplace() });
    } catch (error) {
      // The workplace this tab stood in no longer has this person — deleted
      // for good, or left from elsewhere. Only then does the tab follow the
      // account to wherever the server puts it next, exactly as a new tab
      // would; any other refusal is the caller's to show. Standing nowhere
      // now, a second refusal is not this branch's, so it cannot loop.
      if (!refusedAsStanding(error) || !alive.current || sequence !== serialRef.current) throw error;
      standInWorkplace(null);
      serialRef.current += 1;
      return loadRef.current();
    }
    if (!alive.current || sequence !== serialRef.current) return false;
    // A tab standing nowhere that was answered from a workplace it belongs
    // to now stands there, so its next read names it rather than asking again.
    if (!standingWorkplace() && answer.org && (answer.organizations ?? []).some((row) => row.orgId === answer.org!.orgId)) {
      standInWorkplace(answer.org.orgId);
    }
    const agents = carryAgentRecapArrivals(answer.agents ?? [], loadedRef.current?.agents ?? null);
    commit({ state: answer, agents });
    setError('');
    void refreshNotifications();
    clearTimeout(timers.current.transition);
    const checksRunning = (answer.prs ?? []).some((pr) => pr.checks && pr.checks.pending > 0);
    // An agent being brought in (the Chief of Staff's first run, note #726,
    // or the person's own New agent): its row in the chat's progress card
    // and in the roster moves only with the full read.
    const agentWaiting = (answer.agents ?? []).some((agent) => WAITING_STATUSES.has(agent.status));
    if (checksRunning || agentWaiting) {
      timers.current.transition = setTimeout(() => { loadRef.current().catch(() => { /* next poll retries */ }); }, TRANSITION_POLL_MS);
    }
    return true;
  }, [api, commit, refreshNotifications]);

  const scheduleLive = useCallback(() => {
    clearTimeout(timers.current.live);
    if (document.hidden) return;
    timers.current.live = setTimeout(() => { void pollLiveRef.current(); }, LIVE_POLL_MS);
  }, []);

  const pollLive = useCallback(async () => {
    try {
      const current = loadedRef.current;
      if (current) {
        const live = await api.api<WorkspaceAgentsLiveAnswer>('api/agents/live', undefined, { org: standingWorkplace() });
        if (!alive.current) return;
        const result = applyLiveTick(current.agents, {
          agents: live.agents ?? [], recaps: live.recaps ?? [], sessionLimits: live.sessionLimits ?? [],
          // Passed through only when the answer HAS it: on a backend from
          // before note #588 the plates keep whatever the last full read
          // said, rather than every count being wiped by its silence.
          ...(live.jobs ? { jobs: live.jobs } : {}),
          // The same for the finished verdict (note #707).
          ...(live.finished ? { finished: live.finished } : {}),
        });
        const team = applyLiveTeamWorking(current.state.teamAgents, live.teamWorking);
        // One list of notes, the workplace's (note #843). The state still
        // carries the Chief of Staff's door copy as `workspace.notes`;
        // nothing reads it, so the tick leaves it as the read drew it.
        const workplaceNotes = applyLiveNoteClaims(current.state.notes, live.noteClaims);
        // An admin asked to delete the workplace, or kept it (2026-09-22):
        // only the full state carries the lock screen's facts.
        const lockMoved = live.workplaceDeleting !== undefined
          && live.workplaceDeleting !== Boolean(current.state.org?.deletion);
        if (result.moved || workplaceNotes.reload || lockMoved) {
          // A turn starting or ending is more than a line: working agents lead
          // the list and the job line flips. A note claim ENDING also exposes
          // a state the live answer cannot infer (unclaimed, conflict or PR).
          // Only the full state says all of it.
          const loaded = await load();
          // `load()` deliberately clears live-only facts. Restore this tick's
          // complete claim answer afterwards so an open note can see that its
          // lease ended and perform its own narrow authoritative read.
          if (loaded && live.noteClaims !== undefined && loadedRef.current) {
            commit({ ...loadedRef.current, noteClaims: live.noteClaims });
          }
        } else if (loadedRef.current === current) {
          let state = current.state;
          // The private briefing and Workspace Agent do not appear among the
          // fleet's rows. Their actual seat leases still need to reach the
          // subscription strip while this page stays open (note #648).
          if (live.activeSeatIds && state.org
            && live.activeSeatIds.join('|') !== (state.org.activeSeatIds ?? []).join('|')) {
            state = { ...state, org: { ...state.org, activeSeatIds: live.activeSeatIds } };
          }
          if (team.changed) state = { ...state, teamAgents: team.teamAgents };
          if (workplaceNotes.changed) state = { ...state, notes: workplaceNotes.notes! };
          commit({
            ...current,
            state,
            agents: result.agents,
            noteClaims: live.noteClaims === undefined ? current.noteClaims : live.noteClaims,
          });
        } else if (live.noteClaims !== undefined && loadedRef.current) {
          // A full read landed while this tick was out. Its own answer is
          // newer for everything it carries, so the tick's rows are dropped;
          // but it CLEARS the note claims (a live-only fact), so this tick's
          // claims are the only ones there are, and they go onto it. With
          // anything mid-transition the full read runs on the same five
          // seconds as this tick and lands just before it, so dropping them
          // could miss a claim on every tick for minutes (note #1075).
          commit({ ...loadedRef.current, noteClaims: live.noteClaims });
        }
      }
    } catch (error) {
      // A failed tick says nothing on screen; the next one retries. A
      // refusal of the tab's own workplace is the full read's to settle:
      // it follows the account to the next workplace, once.
      if (refusedAsStanding(error) && alive.current) await load().catch(() => { /* the next tick retries */ });
    }
    if (alive.current) scheduleLive();
  }, [api, commit, load, scheduleLive]);

  // Refs are written after render, never during it.
  useEffect(() => {
    scheduleNotificationsRef.current = scheduleNotifications;
    loadRef.current = load;
    pollLiveRef.current = pollLive;
  });

  /**
   * The answer to a runtime change, folded into the fleet the moment it
   * lands (note #296).
   *
   * A model or effort change is not turn-shaped, so it does not ride the live
   * tick — and the full read it does ask for is the heaviest one this app
   * makes, roughly a dozen storage reads. Until that answered, every already
   * painted copy of the agent still said the old model: the title over the
   * picker the reader had just used, the runtime line under it, the fleet row
   * behind, and, once one model started wearing a crown, a mark that took a
   * second to arrive on a choice that was already made.
   *
   * So the row is corrected here from the server's OWN answer — not a guess
   * at what it will say — and `reload()` still follows to confirm it and to
   * bring everything else that answer implies. Narrow on purpose: this takes
   * a runtime, not an arbitrary patch, because the rule that everything
   * turn-shaped rides the tick is worth keeping hard to break.
   */
  const patchAgentRuntime = useCallback((agentId: string, runtime: { model: string; effort: string }) => {
    const current = loadedRef.current;
    if (!current) return;
    commit({
      ...current,
      agents: current.agents.map((agent) => (agent.id === agentId ? { ...agent, ...runtime } : agent)),
    });
  }, [commit]);

  const reload = useCallback(async (): Promise<boolean> => {
    try {
      return await load();
    } catch (err) {
      if (!loadedRef.current) setError(errorMessage(err));
      return false;
    }
  }, [load]);

  /**
   * The active-workplace POST has already succeeded when this is called.
   * Restore the target's whole last-good copy before the route moves Home,
   * then ask for current truth without taking that copy off the glass.
   */
  const switchWorkplace = useCallback((orgId: string): Promise<boolean> => {
    const copy = heldWorkplace(api, sessionId, orgId);
    serialRef.current += 1;
    activeOrgRef.current = orgId;
    // This tab moves; the read below, and every one after it, asks as this
    // workplace. Other tabs stand where they stood (note #628).
    standInWorkplace(orgId);
    setError('');
    setNotifications(copy?.notifications ?? []);
    commit(copy?.loaded ?? null);
    setHomeOverview(copy?.overview?.orgId === orgId
      ? { ...copy.overview, blockHome: false }
      : { ...EMPTY_HOME_OVERVIEW, status: 'loading', blockHome: true, orgId });
    clearTimeout(timers.current.transition);

    const refreshState = async (): Promise<boolean> => {
      try {
        return await load();
      } catch (cause) {
        if (!loadedRef.current) setError(errorMessage(cause));
        return false;
      }
    };
    const pending = refreshState().finally(() => {
      if (homeRefreshInFlight.current === pending) homeRefreshInFlight.current = null;
    });
    // Home's route-arrival effect shares this request rather than buying a
    // second full state read the moment the restored screen mounts.
    homeRefreshInFlight.current = pending;
    return Promise.all([pending, readHomeOverview(orgId)]).then(([fresh]) => fresh);
  }, [api, commit, load, readHomeOverview, sessionId]);

  /** A Home focus/load re-reads its state, while overlapping browser focus
   *  and visibility events share one request. The server decides whether the
   *  usage snapshot inside that read is stale enough to probe providers. */
  const refreshHome = useCallback((): Promise<boolean> | null => {
    if (!homeRouteRef.current || document.hidden) return null;
    if (homeRefreshInFlight.current) return homeRefreshInFlight.current;
    const pending = loadRef.current().catch(() => false).finally(() => {
      if (homeRefreshInFlight.current === pending) homeRefreshInFlight.current = null;
    });
    homeRefreshInFlight.current = pending;
    return pending;
  }, []);

  // A route arrival after the app's first load is another Home load. On the
  // initial arrival `loadedRef` is still empty here; the open effect below
  // owns that first read, so it is never doubled.
  useEffect(() => {
    homeRouteRef.current = onHome;
    if (onHome && loadedRef.current) {
      void refreshHome();
      // `api/state` can carry the legacy personal organization card on a
      // backend with no workplace layer. The signed-in session's active id
      // is the capability boundary: only then do recap routes exist.
      if (initialOrgId) {
        void Promise.resolve().then(() => readHomeOverview(loadedRef.current?.state.org?.orgId));
      }
    }
  }, [initialOrgId, onHome, readHomeOverview, refreshHome]);

  // A workplace switch changes the scope under a mounted provider. Its Home
  // remains on the shared skeleton until the new workplace's overview lands.
  useEffect(() => {
    const orgId = loaded?.state.org?.orgId;
    if (initialOrgId && onHome && orgId && homeOverview.orgId !== orgId
      && homeOverviewInFlight.current?.orgId !== orgId) {
      void Promise.resolve().then(() => readHomeOverview(orgId));
    }
  }, [homeOverview.orgId, initialOrgId, loaded?.state.org?.orgId, onHome, readHomeOverview]);

  // Open: one full read, then the live tick and the notification poll.
  useEffect(() => {
    alive.current = true;
    // The read is asynchronous by nature; starting it off the effect's own
    // tick keeps the effect a subscription, not a state write.
    void Promise.resolve().then(() => Promise.all([
      reload(),
      ...(homeRouteRef.current && initialOrgId ? [readHomeOverview(initialOrgId)] : []),
    ])).then(() => { if (alive.current) { scheduleLive(); scheduleNotifications(); } });
    const onVisibility = () => {
      clearTimeout(timers.current.live);
      clearTimeout(timers.current.notifications);
      // Coming back is a catch-up, not a wait: the tail is stale by however
      // long the page was away.
      if (!document.hidden) {
        void refreshHome();
        void pollLiveRef.current();
        void refreshNotifications().then(scheduleNotifications);
      }
    };
    const onFocus = () => { void refreshHome(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    const held = timers.current;
    return () => {
      alive.current = false;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
      clearTimeout(held.live);
      clearTimeout(held.notifications);
      clearTimeout(held.transition);
    };
  }, [initialOrgId, readHomeOverview, reload, refreshHome, refreshNotifications, scheduleLive, scheduleNotifications]);

  const value = useMemo<WorkspaceValue>(() => ({
    status: loaded ? 'ready' : error ? 'error' : 'loading',
    error,
    state: loaded?.state ?? null,
    agents: loaded?.agents ?? null,
    noteClaims: loaded?.noteClaims,
    notifications,
    homeOverview,
    refreshHomeOverview: readHomeOverview,
    switchWorkplace,
    reload,
    refreshHome,
    patchAgentRuntime,
    markAgentNotificationsRead,
    claimOnce,
  }), [loaded, error, notifications, homeOverview, readHomeOverview, switchWorkplace, reload, refreshHome, patchAgentRuntime, markAgentNotificationsRead, claimOnce]);

  return <WorkspaceContext value={value}>{children}</WorkspaceContext>;
}
