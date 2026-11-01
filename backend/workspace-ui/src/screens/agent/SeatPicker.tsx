/**
 * Which subscription this agent's turns use first (note #773) — the leaf
 * behind the Subscription row on its own screen.
 *
 * "Workplace default" heads the list: the agent follows whichever sign-in is
 * primary here, and moves with it when the primary changes. Below it, only
 * the owner's sign-ins for THIS agent's harness — a Claude Code agent cannot
 * spend a ChatGPT subscription, so offering one would be a door to a refusal.
 *
 * A choice is tried FIRST, not alone: when it runs out, the turn moves on to
 * the owner's next sign-in (note #772's hop) and comes back to the chosen one
 * once it has room again — the lease puts the pin at the front every time.
 * The sub line says so, because "use this one" otherwise reads as "only".
 *
 * Transient like the model picker: the current choice is a state, not a
 * button, and — as there (note #237) — the leaf stays open and raises no
 * toast: the `current` badge landing on the row that was tapped IS the
 * confirmation, and a refusal is the banner's. A write lands at the agent's
 * next turn, so it is not refused while the agent works.
 */

import { useCallback, useState } from 'react';
import type { WorkspaceAgentSeatAnswer, WorkspaceSeatUsage } from '../../../../src/shared/workspace-api.js';
import { jsonBody } from '../../api/client.js';
import { useBackClaim } from '../../chrome/useBack.js';
import { useBanner } from '../../chrome/useBanner.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { useSession } from '../../session/useSession.js';
import { seatHasCurrentUsage, seatShortName, seatStatusWords } from '../../ui/seat-words.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { chosenSeat, WORKPLACE_DEFAULT_SEAT } from './agent-facts.js';

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The route takes a sign-in that can run a turn now or after its rest. */
function seatPickable(seat: WorkspaceSeatUsage): boolean {
  return seatHasCurrentUsage(seat);
}

/** One line under a sign-in's name: its fullest window, else why it has none. */
function seatLine(seat: WorkspaceSeatUsage): string {
  const parts = [seat.label];
  if (!seatHasCurrentUsage(seat)) {
    parts.push(seatStatusWords(seat).text);
  } else {
    const worst = seat.windows.length ? seat.windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a)) : null;
    if (worst) parts.push(`${worst.trackText || 'usage'} ${worst.percentText}%`);
    if (seat.status === 'cooldown') parts.push('resting');
  }
  return parts.join(' · ');
}

export function SeatPicker({ agent, onClose }: {
  agent: { id: string; name: string; cli: string; seatId?: string };
  onClose: () => void;
}) {
  const { api } = useSession();
  const { state, reload } = useWorkspace();
  const banner = useBanner();
  const [writing, setWriting] = useState(false);
  // The pin as the write answered it, until the state read catches up: the
  // badge moves the moment the server agrees, not a poll later.
  const [written, setWritten] = useState<{ seatId: string | null } | null>(null);
  useBackClaim(onClose);

  const all = state?.org?.seatUsage ?? [];
  const seats = all.filter((seat) => seat.provider === agent.cli);
  const chosen = chosenSeat(written ? { seatId: written.seatId ?? undefined } : agent, all);
  const primary = seats.find((seat) => seat.selected) ?? null;

  const choose = useCallback(async (seat: WorkspaceSeatUsage | null) => {
    setWriting(true);
    try {
      const answer = await api.api<WorkspaceAgentSeatAnswer>(
        `api/agents/${encodeURIComponent(agent.id)}/seat`,
        jsonBody({ seatId: seat?.seatId ?? '' }),
      );
      setWritten({ seatId: answer.seatId });
    } catch (error) {
      banner.show(errorMessage(error));
    } finally {
      setWriting(false);
    }
    // The agent's row, its header and the subscription plates all read the
    // state's copy of the pin, so it is refreshed behind the leaf.
    void reload().catch(() => { /* the next poll confirms the choice */ });
  }, [agent.id, api, banner, reload]);

  const defaultBody = (
    <div className="main">
      <div className="name plain">{WORKPLACE_DEFAULT_SEAT}</div>
      <div className="cline">
        <span className="ctext">
          {primary ? `Follows your primary — now ${seatShortName(primary, all)}` : 'Follows your primary subscription'}
        </span>
      </div>
    </div>
  );

  return (
    <div className="screen" id="screenSeatPicker">
      <ScreenTitle titleId="seatPickerTitle" title={<>Subscription for {agent.name}</>} />
      <div className="sub" id="seatPickerSub">
        {agent.name} uses this subscription first. If it runs out, {agent.name} moves on to your next one and
        comes back once it has room again. The change lands on its next turn.
      </div>
      <div className="card" id="seatPickerList">
        {chosen
          ? (
            <button className="crow open" type="button" data-seat-id="" disabled={writing} onClick={() => { void choose(null); }}>
              {defaultBody}
            </button>
          )
          : (
            <div className="crow current" data-seat-id="" aria-current="true">
              {defaultBody}
              <span className="badge">current</span>
            </div>
          )}
        {seats.map((seat) => {
          const current = chosen?.seatId === seat.seatId;
          const body = (
            <div className="main">
              <div className="name plain">{seatShortName(seat, all)}</div>
              <div className="cline">
                <span className="ctext">{seatLine(seat)}</span>
              </div>
            </div>
          );
          if (current) {
            return (
              <div className="crow current" key={seat.seatId} data-seat-id={seat.seatId} aria-current="true">
                {body}
                <span className="badge">current</span>
              </div>
            );
          }
          return (
            <button
              className="crow open"
              key={seat.seatId}
              type="button"
              data-seat-id={seat.seatId}
              disabled={writing || !seatPickable(seat)}
              onClick={() => { void choose(seat); }}
            >
              {body}
            </button>
          );
        })}
      </div>
      <div className="formhint" id="seatPickerHint">
        Which subscription is primary for the whole workplace is set on the subscription’s own page.
      </div>
    </div>
  );
}
