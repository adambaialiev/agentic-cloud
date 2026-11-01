import { useState } from 'react';
import type { WorkspaceSeatUsage, WorkspaceSeatWindow } from '../../backend/src/shared/workspace-api';
import { SeatStrip } from '../../backend/workspace-ui/src/ui/SeatStrip';
import { UsageWindowRow } from '../../backend/workspace-ui/src/ui/Usage';
import { LivePanel, LiveWorkspace } from './live/LiveWorkspace';
import { HERO_FLEET_BEYOND, HOUR, MINUTE, useHydrated } from './live/fixture';

/**
 * The subscriptions, live: Home's seat strip (SeatStrip) over the FOUR
 * sign-ins this workplace holds — two Claude Max 20x and two ChatGPT Pro 5x
 * — and under it the Usage card of the first Claude seat's own screen
 * (UsageWindowRow), whose pace mark compares spend with the time gone by in
 * each window.
 *
 * FOUR of them because that is the section's claim (the owner, note #143):
 * model time is the limit that stacks, so the picture beside "Add a
 * subscription, add a fleet." has to be a workplace that has stacked some.
 * (Since note #664 a workplace also holds at most twenty agents.)
 * Two sign-ins of the same plan are what the app itself expects — the plate
 * titles both Claude and both ChatGPT, told apart by their readings and by
 * the live dot — and Home's strip wraps them into its own vertical flow
 * rather than a sideways scroller.
 *
 * At TILE zoom, the scale the panels beside prose use everywhere else on the
 * page (the owner, note #143: normalise it to the other sections). It stood
 * at `face`, a poster of one strip and one card, which made this the tallest
 * thing in its stretch of the page and read a size above its neighbours.
 *
 * It was three tiles under two headings — a hand-copied New agent chooser
 * with a Cancel button, the strip at 13px with its second label clipped,
 * and the usage card third. The chooser went: the fleet already shows agents
 * on Claude Code and Codex side by side. The strip's Add sub door is hidden
 * in the fence; the section is about the seats a workplace already has.
 *
 * The countdown under each window is a clock, so the rows wait for
 * hydration.
 */

const SEATS: WorkspaceSeatUsage[] = [
  {
    seatId: 'seat_claude_a',
    provider: 'claude',
    label: 'Claude',
    planText: 'Max 20x',
    status: 'active',
    selected: true,
    windows: [
      { usedPercent: 46, percentText: '46', trackText: '5 hours' },
      { usedPercent: 68, percentText: '68', trackText: 'this week' },
    ],
  },
  {
    seatId: 'seat_claude_b',
    provider: 'claude',
    label: 'Claude',
    planText: 'Max 20x',
    status: 'active',
    selected: false,
    windows: [
      { usedPercent: 27, percentText: '27', trackText: '5 hours' },
      { usedPercent: 51, percentText: '51', trackText: 'this week' },
    ],
  },
  {
    seatId: 'seat_codex_a',
    provider: 'codex',
    label: 'ChatGPT',
    planText: 'Pro 5x',
    status: 'active',
    selected: true,
    windows: [
      { usedPercent: 33, percentText: '33', trackText: '5 hours' },
      { usedPercent: 57, percentText: '57', trackText: 'this week' },
    ],
  },
  {
    seatId: 'seat_codex_b',
    provider: 'codex',
    label: 'ChatGPT',
    planText: 'Pro 5x',
    status: 'active',
    selected: false,
    windows: [
      { usedPercent: 11, percentText: '11', trackText: '5 hours' },
      { usedPercent: 39, percentText: '39', trackText: 'this week' },
    ],
  },
];

/**
 * Which sign-in each agent's turns spend. The live dot on a plate is the
 * app's own join (`seatForAgent`): an agent's pin first, then whichever seat
 * of its harness is primary. Without pins the two unselected plates could
 * never carry a mark, and a workplace that keeps a second subscription
 * nobody works on is the opposite of what this section says. So the
 * workplace's Claude agents are split across the two Max seats and its Codex agents
 * across the two Pro ones — and the dots that light are the ones whose
 * agents are mid-turn in the fixture, counted by the app, not painted on.
 */
const ON_SEAT: Record<string, string> = {
  agent_ruby: 'seat_claude_a',
  agent_mia: 'seat_claude_a',
  agent_milo: 'seat_claude_b',
  agent_nora: 'seat_claude_b',
  agent_ada: 'seat_codex_a',
  agent_otis: 'seat_codex_a',
  agent_theo: 'seat_codex_b',
  agent_finn: 'seat_codex_b',
};
const SEATED_FLEET = HERO_FLEET_BEYOND.map((agent) => (
  ON_SEAT[agent.id] ? { ...agent, seatId: ON_SEAT[agent.id]! } : agent
));

export default function LiveSubscriptions({ className = '' }: { className?: string }) {
  const hydrated = useHydrated();
  const [windows] = useState<WorkspaceSeatWindow[]>(() => {
    const now = Date.now();
    return [
      {
        label: '5 hours',
        usedPercent: 46,
        percentText: '46',
        trackText: '5 hours',
        resetAt: new Date(now + 4 * HOUR).toISOString(),
        windowMins: 300,
      },
      {
        label: '7 days',
        usedPercent: 68,
        percentText: '68',
        trackText: 'this week',
        resetAt: new Date(now + 4 * 24 * HOUR + 7 * HOUR + 12 * MINUTE).toISOString(),
        windowMins: 10_080,
      },
    ];
  });
  return (
    <LivePanel
      size="tile"
      className={`landing-seats ${className}`}
      says="Subscriptions: the four sign-ins this workplace holds — two Claude Max 20x seats and two ChatGPT Pro 5x seats — each with its usage in the current five-hour and weekly windows, and a mark on the ones agents are working on right now. Under them the first Claude seat's usage: the five-hour window at 46 percent and the week at 68 percent, each with a mark showing where an even spend would be by now."
    >
      <LiveWorkspace agents={SEATED_FLEET} seatUsage={SEATS}>
        <div className="screen" id="screenSeat">
          <SeatStrip ids={{ head: 'seatsHead', section: 'seatsHomeSection', row: 'seatsHome' }} head="Subscriptions" />
          <h2 id="seatUsageTitle">Usage</h2>
          <div className="card" id="seatUsageCard">
            {hydrated ? windows.map((w) => <UsageWindowRow key={w.label} window={w} />) : null}
          </div>
        </div>
      </LiveWorkspace>
    </LivePanel>
  );
}
