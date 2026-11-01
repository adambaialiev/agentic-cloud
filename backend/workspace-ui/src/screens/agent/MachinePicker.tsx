/**
 * The agent's machine (note #268): what it is made of, and the sizes it can
 * move onto — shared or dedicated cores, and how many.
 *
 * Transient, like the other two leaves on this screen: it keeps the agent's
 * address underneath it, so Back lands on the Machine row that opened it.
 *
 * FOUR RULES, all of which cost the reader something when broken:
 *
 *  - ONE TAP IS ONE CHANGE. A resize is a machine config write and Fly
 *    reboots a running machine on any successful one, so the two halves of
 *    the question — shared vs dedicated, and how big — are not two lists to
 *    tap in turn. Every row here is a whole answer, grouped under the kind it
 *    belongs to, and picking one spends at most one restart.
 *  - THE SLEEPING CASE IS THE FREE ONE. Agent machines stop when idle, and a
 *    stopped machine is resized with nothing running on it and nobody
 *    interrupted — so the question is asked only when the machine is AWAKE,
 *    where the restart really does cost the reader something.
 *  - THE ROW THAT WAS TAPPED CARRIES THE ANSWER, AND THE SCREEN FOLLOWS THE
 *    MACHINE UNTIL IT ARRIVES. Fly reports a resized machine neither started
 *    nor stopped for a few seconds — and a read inside that window still
 *    says the OLD shape. The first version of this screen read once, right
 *    after the write, and so painted "Restarting" in the facts card, the old
 *    size in the Processor row, the `current` badge on the old rung and a
 *    "Saved" line off the bottom of the phone; and then, told to wait for
 *    the sizes to "come back", never read again. Now the tapped rung says
 *    "changing…" where the thumb already is, the facts card says which of
 *    the two things is happening in words this screen knows to be true, and
 *    the screen re-reads every few seconds until Fly reports the new shape —
 *    at which point the badge lands on the tapped rung, which IS the
 *    confirmation (the runtime picker's rule), and one line under that card
 *    says what happened.
 *  - SHARED IS OFFERED AND WARNED ABOUT IN THE SAME BREATH. It is a tenth of
 *    the price and genuinely right for an agent that mostly waits, and it is
 *    also what the whole fleet moved OFF in 2026-08 because it throttles
 *    exactly the load a coding agent makes. Both are said, with the
 *    measurement, rather than presenting an even choice.
 *
 * The rungs themselves are drawn by `MachineLadders`, shared with the
 * workplace's choice of what new agents are built on (note #355) — so the
 * last rule above is kept in ONE place. What a tap COSTS is this screen's own
 * business, which is why the three rules before it live here.
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  WorkspaceAgentMachineAnswer,
  WorkspaceAgentMachineWritten,
  WorkspaceMachineSize,
} from '../../../../src/shared/workspace-api.js';
import { jsonBody } from '../../api/client.js';
import { useBackClaim } from '../../chrome/useBack.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { AskToConfirm } from '../../ui/Ask.js';
import { errorMessage } from '../../ui/format.js';
import { useSession } from '../../session/useSession.js';
import { MachineLadders, type MachineRungState } from './MachineLadders.js';
import {
  machineSizeWords, machineStateWords, resizeOutcome, resizeUnconfirmed,
} from './machine-words.js';

/**
 * How often the screen asks again while the machine is between shapes.
 * Measured on Fly: a sleeping machine reports its new shape one to two
 * seconds after the write, a running one four to five on a tiny image and
 * longer on a real one — so the first re-read usually lands the answer, and
 * the cost of each is two cheap control-plane calls.
 */
export const RESIZE_POLL_MS = 2500;
/**
 * How long it keeps asking before saying it cannot confirm the change. Two
 * minutes is several times the longest restart seen; past it, something is
 * wrong that another read will not fix, and a screen that polls a machine
 * forever is the trap the refresh notes warn about.
 */
export const RESIZE_FOLLOW_MS = 120_000;

/**
 * A change under way, from this screen's point of view: the rung it asked
 * for and where the badge was before, kept until Fly reports the machine
 * there — or, with no `move`, a change this screen found already in
 * progress when it opened, which it follows until the machine settles.
 */
interface Follow {
  move: { size: WorkspaceMachineSize; from?: string; restarted: boolean } | null;
  since: number;
}

/** Fly reports the machine settled on the shape this screen is waiting for —
 *  or, when it is only waiting for a change it did not make, settled at all. */
function arrived(read: WorkspaceAgentMachineAnswer, follow: Follow | null): boolean {
  if (read.restarting) return false;
  return !follow?.move || read.current === follow.move.size.id;
}

export function MachinePicker({ agent, busy, orgId, onClose, onWritten }: {
  agent: { id: string; name: string };
  /** A turn is running. The route refuses a resize during one — a reboot
   *  would kill the answer the agent is in the middle of writing — so the
   *  rows say so rather than offering a tap that will be turned down. */
  busy: boolean;
  /** Workspace Agent is opened from an org-scoped route rather than a room
   *  fleet row; carry that immutable workplace explicitly on its reads. */
  orgId?: string;
  onClose: () => void;
  /** Called once a change has LANDED — Fly reports the new shape — so the
   *  Machine row on the screen underneath re-reads then, rather than inside
   *  the window where a read still says the old size. */
  onWritten: () => void;
}) {
  const { api } = useSession();
  const [info, setInfo] = useState<WorkspaceAgentMachineAnswer | null>(null);
  const [failure, setFailure] = useState('');
  /** An answer to the last tap, and which ladder it was tapped on — it is
   *  said under THAT card, where the reader is already looking. A message at
   *  the foot of the screen, below four lines about shared cores, is a
   *  message a reader who tapped a dedicated rung never scrolls to. */
  const [said, setSaid] = useState<{ kind: string; fail?: string; done?: string } | null>(null);
  const [writing, setWriting] = useState(false);
  /** The size a reader picked on an awake machine, held until they answer the
   *  restart question. Null when nothing is being asked. */
  const [asking, setAsking] = useState<WorkspaceMachineSize | null>(null);
  /** The change the screen is waiting on, or null when the machine is settled. */
  const [follow, setFollow] = useState<Follow | null>(null);
  /** The screen gave up waiting on a change it did not make. Said once, then
   *  the rows stay as the last read left them. */
  const [stalled, setStalled] = useState(false);
  /** Bumped when a re-read fails, so the next one is scheduled anyway. */
  const [retry, setRetry] = useState(0);

  useBackClaim(onClose);

  const read = useCallback(
    () => api.api<WorkspaceAgentMachineAnswer>(`api/agents/${encodeURIComponent(agent.id)}/machine`, undefined, orgId ? { org: orgId } : undefined),
    [agent.id, api, orgId],
  );

  useEffect(() => {
    let alive = true;
    void read()
      .then((result) => {
        if (!alive) return;
        setInfo(result);
        // A change already under way when the screen opened — from another
        // tab, another owner, or a tap a moment ago — is followed the same
        // way: the sizes come back by themselves rather than on a reopen.
        if (result.restarting) setFollow({ move: null, since: Date.now() });
      })
      .catch((error: unknown) => { if (alive) setFailure(errorMessage(error)); });
    return () => { alive = false; };
  }, [read]);

  // The follow itself. Each re-read that has not arrived stores what it saw
  // (which re-runs this effect and schedules the next read); the one that
  // has lands the badge, the outcome line and the row underneath.
  useEffect(() => {
    if (!follow) return;
    let alive = true;
    const timer = setTimeout(() => {
      void read()
        .then((result) => {
          if (!alive) return;
          setInfo(result);
          if (arrived(result, follow)) {
            setFollow(null);
            if (follow.move) {
              setSaid({ kind: follow.move.size.cpuKind, done: resizeOutcome(true, follow.move.restarted, follow.move.size) });
              onWritten();
            }
            return;
          }
          if (Date.now() - follow.since >= RESIZE_FOLLOW_MS) {
            setFollow(null);
            if (follow.move) {
              setSaid({ kind: follow.move.size.cpuKind, fail: resizeUnconfirmed(follow.move.size) });
              onWritten();
            } else {
              setStalled(true);
            }
          }
        })
        .catch(() => { if (alive) setRetry((count) => count + 1); });
    }, RESIZE_POLL_MS);
    return () => { alive = false; clearTimeout(timer); };
  }, [follow, info, retry, read, onWritten]);

  const choose = useCallback(async (size: WorkspaceMachineSize) => {
    setWriting(true);
    // Clear the last answer as the next attempt starts: neither a refusal nor
    // an outcome from the previous tap may stand under a newer one.
    setSaid(null);
    try {
      const result = await api.api<WorkspaceAgentMachineWritten>(
        `api/agents/${encodeURIComponent(agent.id)}/machine`,
        jsonBody({ size: size.id }),
        orgId ? { org: orgId } : undefined,
      );
      const from = info?.current;
      setInfo(result);
      if (!result.changed) {
        setSaid({ kind: size.cpuKind, done: resizeOutcome(false, false, size) });
        return;
      }
      const move = { size, from, restarted: result.restarted };
      const now: Follow = { move, since: Date.now() };
      if (arrived(result, now)) {
        // Fly had already settled by the time the write's own read-back ran
        // — nothing to wait for, so nothing is drawn as waiting.
        setSaid({ kind: size.cpuKind, done: resizeOutcome(true, move.restarted, size) });
        onWritten();
      } else {
        setFollow(now);
      }
    } catch (error) {
      setSaid({ kind: size.cpuKind, fail: errorMessage(error) });
    } finally {
      setWriting(false);
    }
  }, [agent.id, api, info, onWritten, orgId]);

  /** A sleeping machine is changed outright; an awake one is asked about
   *  first, because that is the tap that stops something running. */
  const pick = useCallback((size: WorkspaceMachineSize) => {
    if (info?.awake) setAsking(size);
    else void choose(size);
  }, [choose, info?.awake]);

  const sizes = info?.sizes ?? [];
  const move = follow?.move ?? null;
  // Nothing may be written to a machine Fly is still moving: a second config
  // change landing mid-change is refused by Fly at best, and at worst is a
  // second reboot the reader did not ask for.
  const locked = writing || busy || Boolean(follow) || Boolean(info?.restarting) || !(info?.canResize ?? false);
  // While a move is under way the badge stays where it WAS: a read inside
  // Fly's window can say the old shape, no shape, or the new one, and a badge
  // that hops between rungs for a few seconds is not a state anybody can read.
  const currentId = move ? move.from : info?.current;
  const state = (size: WorkspaceMachineSize): MachineRungState => (
    move?.size.id === size.id ? 'moving' : size.id === currentId ? 'current' : 'open'
  );

  /** Why nothing below is tappable, or null — said BEFORE the reader reaches
   *  for a row rather than after they have tried one. A move this screen
   *  made needs no line here: the rung itself says "changing…". */
  const blocked = busy
    ? { id: 'agentMachineBusy', text: `${agent.name} is working — the size can change as soon as this turn finishes.` }
    : move
      ? null
      : stalled
        ? { id: 'agentMachineSettling', text: 'The machine is still changing size. Reopen this screen in a minute to check.' }
        : follow || info?.restarting
          ? { id: 'agentMachineSettling', text: 'Its size is changing — the sizes below come back on their own in a moment.' }
          : info && !info.canResize
            ? { id: 'agentMachineFixed', text: 'This machine’s size cannot be changed from here.' }
            : null;

  /** What the last tap on THIS ladder answered, or nothing. */
  const answer = (kind: string) => (said?.kind !== kind
    ? null
    : said.fail
      ? <div className="formfail" id="agentMachineFail" role="alert">{said.fail}</div>
      : <div className="formhint" id="agentMachineDone" role="status">{said.done}</div>);

  const stateWords = info ? machineStateWords(info, move ? { to: move.size, restarted: move.restarted } : null) : null;
  // The shape the machine is on, and — while it moves — the one it is going
  // to, unless a read has already caught up and the two are the same line.
  const shapeNow = info ? machineSizeWords(info) : '';
  const shapeNext = move && machineSizeWords(move.size) !== shapeNow ? machineSizeWords(move.size) : '';

  return (
    <div className="screen" id="screenAgentMachine">
      <ScreenTitle titleId="agentMachineTitle" title={<>{agent.name}’s machine</>} />
      <div className="sub" id="agentMachineSub">
        {/* Where the money actually goes, said once at the top: it is the
            fact that makes every price below readable, and the one thing a
            reader would otherwise get wrong in the expensive direction. */}
        A machine costs processor and memory only while it is awake. Its files are kept whatever size it runs at.
        The rung marked standard is what new agents in this workplace are built on.
      </div>

      <div className="card" id="agentMachineFacts">
        {!info || !stateWords
          ? <div className="empty">{failure || 'Reading the machine…'}</div>
          : (
            <>
              <div className="drow">
                <div className="k">Processor</div>
                <div className="v">{shapeNow || 'Not known'}</div>
                {shapeNext ? <div className="v dim" id="agentMachineNext">Changing to {shapeNext}</div> : null}
              </div>
              {info.storageGb
                ? (
                  <div className="drow">
                    <div className="k">Storage</div>
                    <div className="v">{info.storageGb} GB</div>
                    <div className="v dim">Its home. A size change never touches it.</div>
                  </div>
                )
                : null}
              {info.regionName || info.region
                ? (
                  <div className="drow">
                    <div className="k">Runs in</div>
                    <div className="v">{info.regionName || info.region}</div>
                  </div>
                )
                : null}
              <div className="drow" id="agentMachineNow" aria-live="polite">
                <div className="k">Right now</div>
                <div className="v">{stateWords.state}</div>
                <div className="v dim">{stateWords.note}</div>
              </div>
            </>
          )}
      </div>

      {blocked ? <div className="formhint" id={blocked.id}>{blocked.text}</div> : null}

      <MachineLadders
        idPrefix="agentMachine"
        sizes={sizes}
        rungState={state}
        disabled={locked}
        onPick={pick}
        empty={failure || 'Reading the machine…'}
        answer={answer}
      />

      {info ? <div className="formhint" id="agentMachineDisclaimer">{info.disclaimer}</div> : null}

      {asking
        ? (
          <AskToConfirm
            title={`Restart ${agent.name}’s machine?`}
            message={`It moves to ${machineSizeWords(asking)} and restarts — anything running on it stops for about a minute. Its files are kept.`}
            verb="Change size"
            onAnswer={(confirmed) => {
              const size = asking;
              setAsking(null);
              if (confirmed) void choose(size);
            }}
          />
        )
        : null}
    </div>
  );
}
