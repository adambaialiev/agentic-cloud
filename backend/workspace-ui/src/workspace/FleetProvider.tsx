/**
 * Making an agent and erasing one — the two things that change the FLEET
 * rather than one screen, which is why they live above both the screen that
 * starts them and Home, where their rows are.
 *
 * The legacy page kept `deleteState` and `pendingCreates` as page globals for
 * exactly this reason: a delete begins on the agent's own
 * screen and finishes as a row leaving Home, and a create begins on Home and
 * is answered by a record that arrives several reads later. Both are ported
 * here whole, including the two rules that are easy to lose:
 *
 *  - A created agent's record is reserved just AFTER the response lands, so
 *    the first reload can still come back without it. The pending plate stays
 *    and the state is re-read until the real row shows up — dropping it early
 *    reads as "nothing happened" on the flow that takes the longest. What
 *    ends it is the ROW, seen where React sees it, because the row draws the
 *    same setup meter: a plate still standing beside it is one agent shown
 *    twice, which is what note #315 reported.
 *  - A deleted agent is dropped LOCALLY first. A delete that succeeded must
 *    never look like it did not because a refresh was slow.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  WorkspaceAgentCreateRequest,
  WorkspaceAgentCreatedAnswer,
  WorkspaceAgentDeletedAnswer,
} from '../../../src/shared/workspace-api.js';
import type { WorkspaceApi } from '../api/client.js';
import { jsonBody } from '../api/client.js';
import { useBanner } from '../chrome/useBanner.js';
import { FleetContext, type AgentDeparture, type FleetValue } from './fleet-context.js';
import type { HomeAgent } from './live.js';
import { useWorkspace } from './useWorkspace.js';

/** How long the row spends leaving. The stylesheet's own `.leaving` timing. */
export const LEAVING_MS = 200;
/** How long to keep looking for the new agent's record, and how far apart. */
export const CREATE_TRIES = 8;
export const CREATE_FIRST_WAIT_MS = 1200;
export const CREATE_WAIT_MS = 2500;

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function FleetProvider({ api, children }: { api: WorkspaceApi; children: ReactNode }) {
  const { agents, reload } = useWorkspace();
  const banner = useBanner();
  const [departing, setDeparting] = useState<Map<string, AgentDeparture>>(new Map());
  const [departingRows, setDepartingRows] = useState<Map<string, HomeAgent>>(new Map());
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [pendingCreates, setPendingCreates] = useState(0);
  const alive = useRef(true);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const agentsRef = useRef(agents);
  // Creates still waiting for their row: the ids the fleet already had at the
  // tap. A row that is not in that baseline IS the record being waited for.
  // (The baseline was one room's, while an agent was made in a room — note
  // #843 took rooms out of the product, and the fleet is one list now.)
  const waiting = useRef(new Map<number, { known: Set<string> }>());
  const nextToken = useRef(0);

  /** End one create's plate. Idempotent, because the arrival below and the
   *  create's own `finally` both reach for it and only the first counts. */
  const settle = useCallback((token: number) => {
    if (!waiting.current.delete(token)) return;
    setPendingCreates(waiting.current.size);
  }, []);

  // The arrival, in the one place that cannot be a render behind the fleet.
  // Reading it inside the create loop instead — right after its own reload,
  // off a ref written by an effect that has not run yet — misses the read
  // that brought the record and leaves the plate up beside the real row for
  // another turn of the loop. This settles on WHICHEVER read brings it: the
  // loop's own, the five-second transition poll, or a live tick that bought
  // a full read.
  useEffect(() => {
    agentsRef.current = agents;
    if (!waiting.current.size) return;
    const claimed = new Set<string>();
    const landed: number[] = [];
    for (const [token, create] of waiting.current) {
      // One row answers one create: two plates need two new rows.
      const row = (agents ?? [])
        .find((candidate) => !create.known.has(candidate.id) && !claimed.has(candidate.id));
      if (!row) continue;
      claimed.add(row.id);
      landed.push(token);
    }
    for (const token of landed) settle(token);
  });

  useEffect(() => {
    alive.current = true;
    const held = timers.current;
    return () => {
      alive.current = false;
      for (const timer of held) clearTimeout(timer);
      held.clear();
    };
  }, []);

  const sleep = useCallback((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(() => { timers.current.delete(timer); resolve(); }, ms);
    timers.current.add(timer);
  }), []);

  const mark = useCallback((id: string, state: AgentDeparture | null) => {
    setDeparting((current) => {
      const next = new Map(current);
      if (state) next.set(id, state); else next.delete(id);
      return next;
    });
    // The row as it last stood, kept for as long as the departure runs: a
    // state read that lands meanwhile — Home re-reads on arrival — has
    // already dropped it, and the row must still be there to leave.
    const row = agentsRef.current?.find((candidate) => candidate.id === id);
    setDepartingRows((current) => {
      const next = new Map(current);
      if (state && row && !next.has(id)) next.set(id, row);
      if (!state) next.delete(id);
      return next;
    });
  }, []);

  const deleteAgent = useCallback(async (agent: { id: string; name: string }) => {
    mark(agent.id, 'working');
    let answer: WorkspaceAgentDeletedAnswer;
    try {
      // By id, and by id alone: a delete is not room-scoped, and the route
      // proves the agent is this account's own before it acts.
      answer = await api.api<WorkspaceAgentDeletedAnswer>(
        `api/agents/${encodeURIComponent(agent.id)}`,
        { method: 'DELETE' },
      );
    } catch (error) {
      mark(agent.id, null);
      banner.show(errorMessage(error));
      // The teardown may have got further than the error says — re-read
      // rather than leave a row that might already be gone.
      await reload().catch(() => { /* the banner already said what failed */ });
      return { ok: false, name: agent.name };
    }
    // The row is on screen for the moment it leaves, and only then is it
    // dropped: this is why the caller navigates Home between the two.
    mark(agent.id, 'leaving');
    void sleep(LEAVING_MS).then(async () => {
      if (!alive.current) return;
      mark(agent.id, null);
      setRemoved((current) => new Set(current).add(agent.id));
      banner.show(`Deleted ${answer.name} — its machine and everything on it are gone.`, true);
      await reload().catch(() => { /* the list already matches the server */ });
    });
    return { ok: true, name: answer.name };
  }, [api, banner, mark, reload, sleep]);

  const createAgent = useCallback(async (cli: string) => {
    // The baseline is taken at the tap — the last moment nothing of this
    // create can be in the fleet, since the record is reserved only after the
    // response lands — and in an event handler, where the ref is current.
    const token = (nextToken.current += 1);
    waiting.current.set(token, {
      known: new Set((agentsRef.current ?? []).map((row) => row.id)),
    });
    setPendingCreates(waiting.current.size);
    let started = false;
    try {
      // The harness pick and nothing else (note #843): the body named the
      // room the tap happened in while agents were made in rooms, and the
      // server files a new one where it belongs now.
      await api.api<WorkspaceAgentCreatedAnswer>(
        'api/agents',
        jsonBody({ cli } satisfies Pick<WorkspaceAgentCreateRequest, 'cli'>),
      );
      started = true;
      banner.show('Creating your agent — its row shows each step, ready in a minute or two.', true);
      for (let tries = 0; tries < CREATE_TRIES; tries += 1) {
        await sleep(tries === 0 ? CREATE_FIRST_WAIT_MS : CREATE_WAIT_MS);
        // The arrival may have answered this create already, in which case
        // the re-reading is the transition poll's job now, not this loop's.
        if (!alive.current || !waiting.current.has(token)) break;
        // A missed reload just costs one more try.
        await reload().catch(() => false);
      }
    } catch (error) {
      banner.show(errorMessage(error));
    } finally {
      // The last word: a record that never showed up gives the reader the
      // fleet as it really is, rather than a plate that waits forever.
      if (alive.current) settle(token);
    }
    return started;
  }, [api, banner, reload, settle, sleep]);

  const value = useMemo<FleetValue>(() => ({
    departing, departingRows, removed, pendingCreates, createAgent, deleteAgent,
  }), [departing, departingRows, removed, pendingCreates, createAgent, deleteAgent]);

  return <FleetContext value={value}>{children}</FleetContext>;
}
