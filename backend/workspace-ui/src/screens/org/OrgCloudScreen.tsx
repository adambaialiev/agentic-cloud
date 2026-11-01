/**
 * Cloud (`/workplace/cloud`): the workplace's cloud, in detail — what
 * every new agent is built on, what the account runs, and what it costs.
 * An admin's view, and its money is honest estimates.
 *
 * IT WAS "CLOUD SPENDING", AND THE NOTE THAT RENAMED IT SAID WHY (#355): a
 * screen called spending is a screen you visit when you are worried about a
 * bill, and the cloud needed a place you visit to DECIDE something. The
 * machines and their money did not move; a choice moved in above them, and
 * the doors and the address followed the name.
 *
 * The two reads are deliberately separate. What new agents are built on is
 * the workplace's own record and answers in a millisecond; the machine
 * list is a call into Fly and takes seconds. Folded together, the fast half
 * would wait behind the slow one — so the choice is on the screen while the
 * machines are still arriving, and the wait below holds their shape.
 *
 * AND THE ACCOUNT ITSELF STANDS OVER BOTH (note #372, "I should be able to
 * replace my cloud"). The slug was already in the machine answer and never
 * said; now it is the first card, with the one tap that swaps it — see
 * `cloud/CloudAccount.tsx` for why the token box is a sheet and not a form
 * left open on the screen.
 *
 * BOTH ARE HELD BETWEEN VISITS (note #368: "Cloud details page data should be
 * cached and refetch silently"). This screen is a route, so leaving it
 * unmounts it and Back used to rebuild it from nothing — two seconds of
 * skeleton over a bill that had been on the glass a second earlier. Now the
 * answer outlives the screen in `cloud/cloud-cache.ts`, `useCloudRead` puts
 * it up on the first render and refreshes underneath, and the wait below is
 * reached only on a visit with nothing held. Nothing about the wait changed:
 * it is gated, not deleted, because a FIRST visit still waits.
 */

import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type {
  WorkspaceOrgAgentMachineAnswer, WorkspaceOrgFlyAnswer, WorkspaceOrgMachineRemoved,
  WorkspaceOrgSpendAnswer, WorkspaceOrgSpendMachine,
} from '../../../../src/shared/workspace-api.js';
import { useOrgApi, useOrgId } from './useOrgApi.js';
import { cloudMachineList, cloudNewAgentMachine, forgetCloud } from '../../cloud/cloud-cache.js';
import { useCloudRead } from '../../cloud/useCloudRead.js';
import { CloudAccount } from '../../cloud/CloudAccount.js';
import { AskToConfirm } from '../../ui/Ask.js';
import { useBanner } from '../../chrome/useBanner.js';
import { errorMessage } from '../../ui/format.js';
import { toFor } from '../../routes.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { AgentFace } from '../../ui/AgentFace.js';
import { AgentHover } from '../../ui/AgentHover.js';
import { Icon, TypeIcon } from '../../ui/icons.js';
import { useWait } from '../../ui/wait.js';
import { machinePriceWords, machineSizeWords } from '../agent/machine-words.js';
import { NewAgentMachine } from './NewAgentMachine.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';

function activeTime(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function hourlyRate(usd: number): string {
  return usd < 0.01 ? usd.toFixed(4) : usd.toFixed(3);
}

/**
 * An agent's face on its machine's row: the way IN to that agent, and the
 * card a pointer resting on it raises (note #359).
 *
 * The face is the only door here and the name stays plain text. A name in
 * this app is set in the reading colour with no affordance on it (note #339),
 * and the row is a fact about money rather than a link — so the picture is
 * what says "this belongs to somebody you can go and see", and it says it in
 * exactly the shape the chat's peer face and the proposal head already use.
 * A row with no agent behind it wears a glyph and is not a door: there is
 * nowhere for a site or the check lane to go.
 *
 * The picture is `AgentFace`, so an agent with none is a bot glyph and the
 * glyph is the door too — an agent that never got a portrait is still an
 * agent, and the alternative is a row where the way in silently disappears.
 *
 * `AgentHover` needs no read of its own: the id is already on the row, and
 * the card looks the agent up in the live fleet the whole shell shares, so
 * an agent mid-turn turns Active under the pointer. Another member's agent
 * in this workplace is a door too (2026-09-23): since note #640 it has a
 * read-only page of its own, where it once led only to "That agent is not
 * here" (note #380). Anything else — a member's private Workspace Agent,
 * which has no page for anybody but its person — keeps the card with the
 * name and face this row already knows, and no door.
 *
 * THE TRAP, paid for twice already (notes #295 and #353): `.facehover::after`
 * is how that card grows its hover target, and it is a pseudo-element of the
 * WRAPPER — painted after the wrapper's children, and hit testing follows
 * paint order, so it covers the link inside it and swallows every tap. The
 * stylesheet gives this door `position: relative; z-index: 1` for that
 * reason. Hovering a face proves the CARD and never the DOOR; the harness
 * asks the page what is under the thumb and then clicks it for real.
 */
function AgentDoor({ agent }: { agent: NonNullable<WorkspaceOrgSpendMachine['agent']> }) {
  const { agents, state } = useWorkspace();
  const face = <AgentFace agent={{ avatarUrl: agent.avatarUrl, status: 'ready' }} />;
  const known = Boolean(agents?.some((candidate) => candidate.id === agent.id))
    || Boolean(state?.teamAgents?.some((candidate) => candidate.id === agent.id));
  const to = known ? toFor({ kind: 'agent', id: agent.id }) : null;
  return (
    <AgentHover id={agent.id} name={agent.name} avatarUrl={agent.avatarUrl}>
      {to
        ? <Link className="facebtn" to={to} aria-label={`Open ${agent.name}`}>{face}</Link>
        : face}
    </AgentHover>
  );
}

/**
 * What a row is called, and what stands before its name (note #319).
 *
 * An agent's machine is named for the agent and wears the agent's face — the
 * same `AgentFace` its fleet row wears, so the two read as one thing, and
 * that face is the door onto the agent (`AgentDoor` above, note #359). The
 * other kinds have no face of their own and wear a glyph in the same slot,
 * so every name in the card starts in the same column.
 *
 * A machine in the CI lane is NOT an agent's, although its app wears the
 * agent prefix: it is created for one check and destroyed minutes later
 * when the check ends. It was the "Agent machine" with no name that the note
 * asked about — the honest name is what it is for.
 *
 * THE LAST NAMELESS ROW IS THE ONE THIS SCREEN COULD NOT EXPLAIN (note #375,
 * "why I have a lot of agent machines that are without name, without agent
 * name, just without avatar"). A machine in an agent's app that no agent
 * record claims was called "Agent machine" too, which reads as an agent whose
 * name failed to load — three of those in a list is a screen that looks
 * broken rather than a fact. No agent is on it and nothing runs there, so it
 * is named for what it is, and the hint under the list says how one comes to
 * exist and what it costs. The app slug stays on the line below either way:
 * it is the only handle a reader has for looking that machine up.
 *
 * A machine its agent's setup has not finished claiming is NOT one of these:
 * the report names it for that agent (`settingUp`, note #375), because the
 * minute a machine is being born is the minute its owner is most likely to
 * be watching this screen, and calling it a leftover then would be a lie
 * about the thing they just asked for.
 *
 * An agent's row also names the HUMAN it works for, in parentheses (note
 * #336). Agents are named for themselves and a workplace's fleet can run
 * a dozen of them, so on a bill "Ada" answers what is spending and not whose
 * it is — the two facts the person reading a cost belongs to. It rides in the
 * name rather than on the line below because that line is already the
 * machine's own description, and because a driver is part of WHO this row is.
 */
function rowName(m: WorkspaceOrgSpendMachine): { face: ReactNode; name: string; driver?: string } {
  if (m.agent) {
    return {
      face: <AgentDoor agent={m.agent} />,
      name: m.agent.name,
      ...(m.agent.driver ? { driver: m.agent.driver } : {}),
    };
  }
  if (m.kind === 'ci') return { face: <TypeIcon glyph="check" />, name: 'CI checks' };
  if (m.kind === 'site') return { face: <TypeIcon glyph="globe" />, name: 'Site' };
  if (isLeftover(m)) return { face: <TypeIcon glyph="bot" />, name: 'Leftover machine' };
  return { face: <TypeIcon glyph="box" />, name: m.app };
}

/**
 * A machine in an agent's app that belongs to no agent (note #375).
 *
 * ONE definition, because the row's name and the sentence under the list have
 * to agree: a list that calls three rows leftovers over a hint that counts two
 * is worse than either alone. `kind` is the app's naming scheme and `agent` is
 * the record that claims the machine — a machine mid-setup carries the second,
 * so it is not one of these.
 */
function isLeftover(m: WorkspaceOrgSpendMachine): boolean {
  return m.kind === 'agent' && !m.agent;
}

/**
 * The account again, without the machine that has just been destroyed.
 *
 * The alternative is re-reading it, and that read is a call into Fly: seconds
 * of held screen to be told about a row that is already gone. Every figure
 * this screen shows is derivable from the rows themselves — the month so far
 * is their month-to-date added up, the counts are the rows counted — so the
 * same arithmetic `org-spend.ts` does happens here, and the next real read
 * confirms it.
 *
 * Filtered by APP, not by machine: what the button destroys is the whole app,
 * so every row that named it goes with it.
 */
function withoutApp(answer: WorkspaceOrgSpendAnswer, app: string): WorkspaceOrgSpendAnswer {
  const machines = answer.machines.filter((m) => m.app !== app);
  const sum = (of: (m: WorkspaceOrgSpendMachine) => number) => Math.round(
    machines.reduce((total, m) => total + of(m), 0) * 100,
  ) / 100;
  return {
    ...answer,
    machines,
    totals: {
      estimatedMonthlyUsd: sum((m) => m.estimatedMonthlyUsd),
      runningMonthlyUsd: sum((m) => m.runningMonthlyUsd),
      spentThisMonthUsd: sum((m) => m.totalMonthlyUsd ?? 0),
      unmeasured: machines.filter((m) => m.totalMonthlyUsd === undefined).length,
      running: machines.filter((m) => m.state === 'started').length,
      stopped: machines.filter((m) => m.state === 'stopped').length,
    },
  };
}

/**
 * The line under the name — what kind of machine, its state, its size — in
 * parts, because the STATE is the half that also wears a mark (note #336).
 *
 * `awake` is the only thing the mark reads: a machine bills compute while it
 * is started and nothing worth the word while it is not, so every other state
 * a machine can be in — stopping, suspended, an app holding volumes and no
 * machine at all — is grey with the rest.
 */
function rowLine(m: WorkspaceOrgSpendMachine): { lead: string; state: string; awake: boolean; size: string } {
  const awake = m.state === 'started';
  if (m.kind === 'ci') {
    // The lane is one row for the month; its machine exists only during a
    // check, so its state is whether one is running at this moment.
    const runs = m.runs ?? 0;
    return {
      lead: `${runs} ${runs === 1 ? 'check' : 'checks'} this month`,
      state: awake ? 'one running now' : 'none running now',
      awake,
      size: m.size,
    };
  }
  return {
    // A machine whose agent has not recorded it yet says so where the kind of
    // machine goes: it is that agent's, and it is not finished (note #375).
    lead: m.settingUp ? 'Being set up'
      : m.agent ? 'Agent machine'
      // A machine no agent record claims is named by its app, which is the one
      // handle the reader can look it up by.
      : m.kind === 'agent' ? m.app
      : '',
    state: awake ? 'running' : m.state === 'stopped' ? 'asleep' : m.state,
    awake,
    size: m.size,
  };
}

/**
 * That line, drawn: the state word with its dot in front of it.
 *
 * BLUE FOR AWAKE, GREY FOR ASLEEP, and the word kept either way (note #336,
 * our owner's own wording). The dot is what makes a long list scannable —
 * which of a dozen machines is burning money right now is a question the eye
 * should answer without reading — and the word is what makes it legible to
 * anyone who cannot see the colour, which is why the mark is `aria-hidden`
 * and adds nothing to what a screen reader says.
 *
 * There is deliberately NO space between the mark and its word: this line
 * wraps on a phone, and a space is the one place a browser is allowed to
 * break, which would leave a dot stranded at the end of a line above the
 * state it belongs to. The gap you see is the dot's own margin. It also
 * keeps `.ctext`'s own text nodes reading exactly as the sentence does.
 */
function SpendLine({ m }: { m: WorkspaceOrgSpendMachine }) {
  const { lead, state, awake, size } = rowLine(m);
  return (
    <div className="cline">
      <span className="ctext">
        {lead ? `${lead} · ` : ''}
        <span className={awake ? 'statedot awake' : 'statedot'} aria-hidden="true" />{state}
        {size ? ` · ${size}` : ''}
      </span>
    </div>
  );
}

/**
 * When the machines below were read, in the reader's own clock.
 *
 * A cached screen owes this. Home's card holds two numbers and no clock at
 * all (note #541 took its caption off): they re-read every fifteen seconds,
 * and a count that is one refresh behind costs a reader nothing. A bill
 * served from a copy with no age on it is the one kind of stale a money
 * screen must not be. So the stamp is the moment this tab took delivery —
 * and when a refresh nobody asked for fails, it simply stops advancing,
 * which is the honest report and needs no words.
 *
 * To the minute, not the second: this screen reads on a visit, and a second
 * hand on a number that moves when you arrive claims a precision it has not
 * got.
 */
function readClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** "7 Aug" — the day a site went up, for the fact that says its awake time counts from there. */
function dayOf(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/**
 * What the money in the right-hand column IS, said under it.
 *
 * Wherever the awake time is known the figure is what the machine has cost
 * so far this month: an agent's from the five-minute sweep, a site's from
 * when Fly last started it, the check lane's from the length of each run
 * (note #319: "let's not predict, let's state facts"). Only a machine
 * nothing measures — an app this platform did not create — is still
 * projected at its current state, and the words under the number say so.
 */
function totalLabel(m: WorkspaceOrgSpendMachine): string {
  if (m.totalMonthlyUsd !== undefined) return 'so far this month';
  return m.state === 'started' ? 'per month if left on' : 'per month asleep';
}

/**
 * What the total at the top owes the reader when the list holds a row it
 * could not add up.
 *
 * A machine nothing measures has no month-to-date figure at all, so the sum
 * leaves it out and its own row says what a month would cost instead. Unsaid,
 * the total looks like it covers every row and quietly does not — and this is
 * a screen whose whole job is to be believed. It is said HERE, under the
 * list, rather than in the line itself: the reader who wants the number gets
 * the number, and the reader who wants to know what is inside it reads on.
 */
function unmeasuredNote(unmeasured: number): string {
  if (unmeasured <= 0) return '';
  return unmeasured === 1
    ? ' One machine nothing measures is not in the total at the top; its row says what a month at its current state would cost instead.'
    : ` ${unmeasured} machines nothing measures are not in the total at the top; their rows say what a month at their current state would cost instead.`;
}

/**
 * What a row called "Leftover machine" IS — the question this screen was
 * asked (note #375), answered where the reader is already reading.
 *
 * Naming the row honestly stops it looking like a bug, and raises the next
 * question immediately: how does a machine end up with no agent, and am I
 * paying for it? Both answers are short and both are owed. The causes are
 * given as the two that happen — a setup that died between making the machine
 * and recording it, and a machine that outlived the agent it was made for —
 * because "something went wrong somewhere" tells a bill-payer nothing they
 * can act on.
 *
 * The cost is said in the same breath, and deliberately not dramatised: a
 * stopped machine bills its storage and no compute, which is cents a month,
 * and the row's own figure is already there beside it. Nothing here offers to
 * remove it: no screen in this app can do that yet, and an explanation that
 * implies a button the reader then cannot find is worse than the silence.
 */
function leftoverNote(leftovers: number): string {
  if (leftovers <= 0) return '';
  return leftovers === 1
    ? ' One machine here belongs to no agent — left over from a setup that never finished, or from an agent that is gone. Nothing runs on it, and asleep it costs only its storage.'
    : ` ${leftovers} machines here belong to no agent — left over from setups that never finished, or from agents that are gone. Nothing runs on them, and asleep they cost only their storage.`;
}

/**
 * The machines this account runs for OTHER workplaces, as one count at the
 * foot of the list (note #635: "let's not display machines from another
 * workplace. But display how much machines are out of this workplace").
 *
 * Two workplaces can connect one cloud account, and a site that moved to
 * another workplace keeps its machine where it was built — so the account
 * this screen reads can hold another team's agents, named, with the people
 * they work for. Those are that workplace's to read, and the server no longer
 * sends them (`org-spend.ts`). But a list holding silently less than the
 * account does is the lie this screen exists not to tell: the Fly dashboard
 * would show machines this screen never mentioned. So their number stands
 * where the rows would have been, in a row's own shape, and its line says
 * why they are not above it and not in the total.
 *
 * No money column, on purpose: what another workplace spends is the other
 * half of what this screen stopped showing.
 *
 * "Outside this workplace", not "of other workplaces": the count does not
 * say how many workplaces there are, and three machines of ONE workplace are
 * not "other workplaces'".
 */
function ElsewhereRow({ count }: { count: number }) {
  return (
    <div className="crow spendrow" id="orgSpendElsewhere">
      <div className="main">
        <div className="name plain spendname">
          <TypeIcon glyph="lock" />
          <span className="nametext">{count === 1 ? '1 machine outside this workplace' : `${count} machines outside this workplace`}</span>
        </div>
        <div className="cline">
          <span className="ctext">In this cloud account too · not listed here or in the total</span>
        </div>
      </div>
    </div>
  );
}

/**
 * What the hint owes the row above: whose those machines are, and that the
 * account's own bill still carries them.
 */
function elsewhereNote(count: number): string {
  if (count <= 0) return '';
  return count === 1
    ? ' The machine outside this workplace runs in this cloud account but belongs to another workplace, so it is only counted: it is not in the total at the top, though this account’s bill includes it.'
    : ` The ${count} machines outside this workplace run in this cloud account but belong to other workplaces, so they are only counted: they are not in the total at the top, though this account’s bill includes them.`;
}

/**
 * What every new agent is built on, and the door to change it (note #355).
 *
 * ABOVE THE MACHINE LIST, not below it: this is the one thing on the screen a
 * reader can decide, and a decision under thirty rows of a bill is a decision
 * nobody finds. It is one row deep for the same reason — the ladder itself,
 * with its prices and its shared-core measurement, is a screenful, and this
 * screen's job is to say what the answer IS and get out of the way.
 *
 * ONE COMPONENT FOR BOTH STATES of the screen around it. The machine list
 * takes seconds and this read does not, so the card is on the screen while
 * that list is still a wait — and it must be the SAME card, or the answer
 * landing would redraw a row the reader has already read.
 *
 * A row nobody may tap is not a button: a member reading this screen gets the
 * fact without an affordance that would only refuse them.
 */
function NewAgentMachineCard({ info, error, onOpen }: {
  info: WorkspaceOrgAgentMachineAnswer | null;
  error: string;
  onOpen: () => void;
}) {
  const size = info?.sizes.find((rung) => rung.id === info.current);
  const body = info && size
    ? (
      <>
        <TypeIcon glyph="sliders" />
        <div className="main">
          <div className="name plain">{machineSizeWords(size)}</div>
          {/* Marked "standard" only while nobody has chosen: the word answers
              where this value came from, which is the difference between a
              decision this workplace made and the one it inherited. Once
              it IS their choice the mark would say nothing they did not
              already know, and would leave them wondering what else it could
              have been. */}
          <div className="cline">
            <span className="ctext">{machinePriceWords({ ...size, standard: !info.chosen })}</span>
          </div>
        </div>
      </>
    )
    : null;
  return (
    <>
      <h2>New agents</h2>
      <div className="card" id="orgNewAgentCard">
        {!info || !body
          ? <div className="empty">{error || 'Reading what new agents are built on…'}</div>
          : info.canChoose
            ? (
              <button className="crow open" type="button" id="orgNewAgentRow" onClick={onOpen}>
                {body}
                <Icon name="chev" size={17} className="icon chev" />
              </button>
            )
            : <div className="crow" id="orgNewAgentRow">{body}</div>}
      </div>
      <div className="formhint" id="orgNewAgentHint">
        What every new agent’s machine is built on. Agents already here keep the size they run on —
        their owners change that from the agent’s own screen.
      </div>
    </>
  );
}

/**
 * The same card, while its own read is still out.
 *
 * Held at ONE row, because this read has one answer whatever the account
 * holds — unlike the machine list, whose length is the thing it cannot know.
 * The bars are the widths of the words they stand in for: "4 dedicated cores
 * · 8 GB" and "about $0.17 an hour awake" at this type size.
 */
function NewAgentMachineWait() {
  return (
    <>
      <h2>New agents</h2>
      <div className="card" id="orgNewAgentCard" aria-hidden="true">
        <div className="crow">
          <span className="skel" style={{ width: '20px', height: '20px', borderRadius: '6px', flex: 'none' }} />
          <div className="main">
            <div className="name plain">
              <span className="skel skel-inline" style={{ width: '154px', height: '11px' }} />
            </div>
            <div className="cline">
              <span className="ctext"><span className="skel skel-inline" style={{ width: '138px', height: '10px' }} /></span>
            </div>
          </div>
        </div>
      </div>
      <div className="formhint" id="orgNewAgentHint" aria-hidden="true">
        <span className="skel skel-inline" style={{ width: '96%', height: '10px' }} />
        <span className="skel skel-inline" style={{ width: '62%', height: '10px' }} />
      </div>
    </>
  );
}

/**
 * How many machines are held while the account is being read.
 *
 * The count is the one thing this screen cannot know before its answer: an
 * workplace has as many machines as it has agents and sites. Three is the
 * number that reads as "a list is coming" without promising a long one — the
 * same judgement the repository overview makes for its own sections. Being a
 * little wrong costs a short settle at the BOTTOM of the card, where nothing
 * the reader is looking at moves; drawing one row would have read as an
 * answer, and drawing ten would push the hint off a phone and pull it back.
 */
const HELD_ROWS = 3;

/**
 * One machine, in the shape the real row has.
 *
 * The classes are the shell's shared wait vocabulary (`.skel*` in
 * workspace.css), named for the shape rather than for the screen — the point
 * of that naming is that this screen does NOT invent a second idea of what a
 * wait looks like. What is local is only the arrangement, because a spend row
 * is its own arrangement: a name, the state-and-size line under it, two facts
 * in small type, and the month's money in the right-hand column.
 *
 * Widths vary by row on purpose. Rows of one width read as a graphic; these
 * read as a list waiting to fill, and the stagger keeps three bars from
 * pulsing as one block.
 */
function SpendRowWait({ at }: { at: number }) {
  const delay = `${(at * 0.12).toFixed(2)}s`;
  const shape = [
    { name: '34%', line: '88%', total: '54px' },
    { name: '26%', line: '72%', total: '44px' },
    { name: '41%', line: '94%', total: '61px' },
  ][at % 3]!;
  return (
    <div className="crow spendrow" aria-hidden="true">
      <div className="main">
        {/* Every bar sits INSIDE the element whose words it stands in for, so
            it takes that element's line box and the held row comes out
            exactly as tall as the answered one. A bar put in place of the
            `.name` would stand at its own 11px where the name stands at a
            whole line of 14px type, and three rows of that is a card that
            jumps when the read lands. The two `.spendfacts` bars are wrapped
            for the same reason once removed: that block is a FLEX row, so a
            bare bar would be a flex item at its own height rather than a
            line of 11px text.

            The name line carries the FACE's 20px too, because every row has
            one — an agent's portrait, or the glyph for CI, a site, a leftover
            or a bare app (`rowName` has no branch without a face). Without it
            the held line was a 14px line of type where the answered one is a
            20px flex box, and every row grew 3px as the read landed: the
            exact thing the paragraph above exists to prevent, missed because
            the face arrived after the wait was drawn. */}
        <div className="name plain spendname">
          <span className="skel" style={{ width: '20px', height: '20px', borderRadius: '999px', animationDelay: delay }} />
          <span className="nametext">
            <span className="skel skel-inline" style={{ width: shape.name, height: '11px', animationDelay: delay }} />
          </span>
        </div>
        {/* ONE bar, and a percentage rather than a measurement. This line
            held TWO before — 96% and a second bar that could not share the
            row with it — because "Agent machine · running · performance-4x
            8GB" wraps at some widths. It does not wrap at all of them, and a
            hold that is taller than its answer pulls the page UP when the
            read lands, which the note at the top of `CloudWait` says must
            never happen. Under-drawing is the allowed direction: where the
            answer does take two lines, the row grows and the page settles
            downward, which `place-scroll` already handles.
            `flex: 1` is what makes the percentage mean anything: the real
            `.ctext` is a flex item sized by the words in it, and a bar carries
            no intrinsic width, so the item first collapsed to nothing and drew
            the bar as a 1px sliver. */}
        <div className="cline">
          <span className="ctext" style={{ flex: 1 }}>
            <span className="skel skel-inline" style={{ width: shape.line, height: '10px', animationDelay: delay }} />
          </span>
        </div>
        {/* PERCENTAGES, NOT MEASURED PIXELS, and that is the fix rather than
            the shortcut. These were 155px and 110px, written down as the
            widths of "10h 27m awake this month" and "$0.172/hour awake" — so
            that the hold would wrap exactly where the answer wraps. A string's
            width is not a constant: those two measure 143px + 102px in
            Liberation Sans and 130px + 92px in DejaVu. The bars, being fixed,
            needed 275px of the 274px a 420px screen leaves beside the money
            and so wrapped on EVERY machine, while the words they stand in for
            fitted on one line on most. That is the 33px this row was standing
            too tall by, and no set of pixels can be right for every font.
            A percentage cannot out-wrap its own container, so this holds one
            line everywhere and grows downward where the answer needs two. */}
        <div className="spendfacts">
          <span><span className="skel skel-inline" style={{ width: '52%', height: '9px', animationDelay: delay }} /></span>
          <span><span className="skel skel-inline" style={{ width: '34%', height: '9px', animationDelay: delay }} /></span>
        </div>
      </div>
      <div className="cside spendtotal">
        <strong><span className="skel skel-inline" style={{ width: shape.total, height: '13px', animationDelay: delay }} /></strong>
        {/* 76px is `.spendtotal span`'s own max-width, which is what the
            words under the money are allowed to take. This column's width
            is what the main column does NOT get, so holding it narrow made
            the held row wider than the answered one — the same 18px, from
            the other side. */}
        <span><span className="skel skel-inline" style={{ width: '76px', height: '9px', animationDelay: delay }} /></span>
      </div>
    </div>
  );
}

/**
 * The whole screen, while the cloud account is being read (note #314: "Cloud
 * spending screen should have skeleton loading Ui").
 *
 * It holds every block the answer fills — the summary line above the card,
 * the choice between them (note #355), the machines, and the disclaimer below
 * — and not just the card. Holding only the middle is what makes a page
 * settle twice: the summary line appearing pushes the card down just as the
 * reader starts reading it, and the hint appearing changes how far the screen
 * scrolls. Every one of them is on every answer this screen has ever drawn,
 * which is the test for whether a wait is allowed to hold a box at all. The
 * choice is the exception that proves it: it is held only in the rare case
 * its OWN read is late too, and drawn for real otherwise.
 *
 * WHERE A HEIGHT CANNOT BE KNOWN, IT IS HELD SHORT. The summary line is the
 * month's total and the count, one line here and wrapping to two on a narrow
 * phone; the hint is five lines here and runs to six. Both could have been
 * guessed longer, and the reason not to is `place-scroll.ts`: a screen
 * returned to on Back is placed by holding the ask until the document has
 * GROWN tall enough to take it. A wait that over-draws and then shrinks moves
 * the page the one direction nothing is watching for, and the line the reader
 * was on is clamped away. Under-drawing settles downward, which that observer
 * already handles.
 */
function CloudWait({ drawn, machine, machineError, onOpenMachine }: {
  drawn: boolean;
  machine: WorkspaceOrgAgentMachineAnswer | null;
  machineError: string;
  onOpenMachine: () => void;
}) {
  return (
    <div className="screen" id="screenOrgCloud" aria-busy="true">
      <ScreenTitle title="Cloud" />
      {/* The words a screen reader needs; everything held below is decoration
          and says so with `aria-hidden`. */}
      <span className="sr-only">Loading the cloud account…</span>
      {/* Nothing at all for a read that answers inside a quarter second, and
          nothing snatched away inside a hold — a wait seen only as it leaves
          is the flash of note #287. */}
      {drawn
        ? <CloudHeld machine={machine} machineError={machineError} onOpenMachine={onOpenMachine} />
        : null}
    </div>
  );
}

/**
 * The held blocks themselves, drawn once the read is plainly late.
 *
 * The choice at the top is NOT one of them wherever its own read has landed —
 * which, being a record read against a Fly call, is nearly always. It is
 * drawn for real, in the card it will keep, and the machines below it are
 * what the reader waits for.
 */
function CloudHeld({ machine, machineError, onOpenMachine }: {
  machine: WorkspaceOrgAgentMachineAnswer | null;
  machineError: string;
  onOpenMachine: () => void;
}) {
  return (
    <>
      <div className="sub" id="orgSpendSub" aria-hidden="true">
        <span className="skel skel-inline" style={{ width: '70%', height: '12px' }} />
      </div>
      {/* The account's card, held at its own height: the slug rides the SLOW
          answer, so a first visit has nothing to name it with, and letting the
          card appear when that answer lands would push the whole screen down
          by a card at the moment the reader starts reading it. Its button is
          held as a bar rather than drawn for real — a Replace that could be
          tapped before the account it replaces has a name is a tap into the
          dark. */}
      <div className="card" id="orgCloudAccount" aria-hidden="true">
        <div className="crow">
          <TypeIcon glyph="globe" />
          <div className="main">
            <div className="name plain">
              <span className="skel skel-inline" style={{ width: '38%', height: '11px' }} />
            </div>
            <div className="cline">
              <span className="ctext"><span className="skel skel-inline" style={{ width: '62%', height: '10px' }} /></span>
            </div>
          </div>
        </div>
        <div className="addrow">
          {/* Wrapped, by the same rule the rows below are held under: the bar
              inside a span takes the row's own 15px line box, where a bare
              bar would stand at its own 11px and the held card would come out
              shorter than the answered one. */}
          <span><span className="skel skel-inline" style={{ width: '104px', height: '11px' }} /></span>
        </div>
      </div>
      {machine || machineError
        ? <NewAgentMachineCard info={machine} error={machineError} onOpen={onOpenMachine} />
        : <NewAgentMachineWait />}
      <h2>Machines</h2>
      <div className="card">
        <div id="orgSpendList">
          {Array.from({ length: HELD_ROWS }, (_, at) => <SpendRowWait key={at} at={at} />)}
        </div>
      </div>
      <div className="formhint" id="orgSpendHint" aria-hidden="true">
        {['98%', '93%', '99%', '90%', '52%'].map((width, at) => (
          <div key={at}>
            <span className="skel skel-inline" style={{ width, height: '10px', animationDelay: `${(at * 0.09).toFixed(2)}s` }} />
          </div>
        ))}
      </div>
    </>
  );
}

export function OrgCloudScreen() {
  const orgId = useOrgId();
  // The one write this screen makes on its own (note #375), beside the two
  // reads below: removing a machine is a DELETE of its own, and its receipt
  // goes in the shell's banner.
  const api = useOrgApi();
  const banner = useBanner();
  // Two reads, still separate and still started in the same breath — the
  // second answers from the workplace's record while the first is out to
  // Fly. Each is served from what this tab last read for this workplace
  // and refreshed underneath (note #368).
  const machines = useCloudRead<WorkspaceOrgSpendAnswer>(orgId, 'api/org/spend', cloudMachineList);
  const newAgent = useCloudRead<WorkspaceOrgAgentMachineAnswer>(orgId, 'api/org/agent-machine', cloudNewAgentMachine);
  const report = machines.answer;
  const error = machines.error;
  const machine = newAgent.answer;
  const machineError = newAgent.error;
  /** The ladder, open over this screen — transient, so Back closes it and
   *  the address underneath stays this one. */
  const [picking, setPicking] = useState(false);
  /** The leftover a reader has asked to remove, and the one being removed
   *  (note #375). Both are the app, which is what the row is destroying. */
  const [asking, setAsking] = useState<WorkspaceOrgSpendMachine | null>(null);
  const [removing, setRemoving] = useState('');

  /**
   * The cloud has been replaced (note #372) — and the two things that can
   * mean are two different jobs for this screen.
   *
   * A ROTATION changed a credential and nothing else: the same account, the
   * same machines, the same bill. Re-reading would spend a Fly walk to redraw
   * what is already right, so the screen says what happened and stands still.
   *
   * A MOVE makes everything held here a reading of an account this
   * workplace no longer uses. It is thrown away rather than refreshed
   * underneath: a refresh takes the seconds a walk of the whole account
   * takes, and for every one of them the old account's machines would sit on
   * the glass under the new account's name. Home's own copy goes with it, for
   * exactly the same reason — it holds the old slug and the old counts, and
   * Back would put them straight back up.
   */
  const replaced = (answer: WorkspaceOrgFlyAnswer) => {
    if (!answer.moved) {
      banner.show(`Cloud token replaced. ${answer.orgSlug} is still your cloud.`, true);
      return;
    }
    machines.drop();
    forgetCloud(orgId ?? '', true);
    forgetCloud(orgId ?? '', false);
    void machines.refresh();
    // Named, not congratulated: the account left behind is still running and
    // still billing, and the receipt is the last place that is said.
    // …and the tunnel is reported as what it actually is (note #642). This
    // said "still coming up" for every outcome that was not `up`, including
    // the route conflict — where nothing is coming up, because nothing needs
    // to: the machines in that account are already reachable.
    const moved = `Your cloud is now ${answer.orgSlug}. Everything in ${answer.previousSlug} is still there, on that account’s bill.`;
    banner.show(
      answer.peer === 'up' ? moved
        : answer.peer === 'route-conflict'
          ? `${moved} Its machines are already reachable, so no separate tunnel was made.`
          : `${moved} The private tunnel into it is not up — connecting again retries it.`,
      true,
    );
  };

  /**
   * Destroy a machine no agent is on (note #375).
   *
   * The account is not re-read afterwards, and that is not only about the two
   * seconds a Fly walk costs: what changed is one row of an answer this
   * screen is already holding, and every figure it shows is derivable from
   * the rows (`withoutApp`). It goes back through `put`, so the copy this tab
   * KEEPS loses the row too — otherwise Back would bring the machine back on
   * screen, and `put` is also what stops a read already in flight from
   * landing on top of it (note #368's cache).
   *
   * The receipt goes in the shell's banner rather than into the list, where a
   * removed row has nowhere left to say anything.
   */
  const remove = async (target: WorkspaceOrgSpendMachine) => {
    setAsking(null);
    setRemoving(target.app);
    try {
      await api.api<WorkspaceOrgMachineRemoved>(
        `api/org/machines/${encodeURIComponent(target.app)}`,
        { method: 'DELETE' },
      );
      if (report) machines.put(withoutApp(report, target.app));
      banner.show('Machine removed.', true);
    } catch (failure) {
      banner.show(errorMessage(failure));
    } finally {
      setRemoving('');
    }
  };

  // Nothing is drawn for a read that answers quickly, and nothing already
  // drawn is snatched away inside its hold (`ui/wait.ts`, note #287). A visit
  // that opens on a held answer is `pending: false` from its first render, so
  // no wait is ever started — which is the whole of note #368 at this end.
  const wait = useWait(!report && !error);
  const openMachine = () => setPicking(true);
  if (picking && machine) {
    return (
      <NewAgentMachine
        info={machine}
        onClose={() => setPicking(false)}
        // The server's own answer, folded straight in: the row underneath
        // says the size that was just chosen without a second read — and it
        // replaces what is HELD too, so Back does not undo the choice on
        // screen while a stale copy is refreshed away.
        onChosen={newAgent.put}
      />
    );
  }
  // `wait === 'drawn'` keeps the held screen for the rest of that hold even
  // once the answer is in hand. A FAILURE is exempt and falls straight
  // through: a reader who has to act on an answer should never be held back.
  if (!error && (!report || wait === 'drawn')) {
    return (
      <CloudWait
        drawn={wait === 'drawn'}
        machine={machine}
        machineError={machineError}
        onOpenMachine={openMachine}
      />
    );
  }

  const t = report?.totals;
  /**
   * Whether a row may offer to remove itself.
   *
   * `namesRead` is the whole of it: every name on this screen comes from one
   * read of the agent records, and when that read fails EVERY row looks
   * unclaimed. The button would then stand on machines that are somebody's,
   * and though the server refuses those (it re-checks the records itself, and
   * a failed check refuses), offering the tap at all is the part that must
   * not happen.
   */
  const removable = Boolean(report?.namesRead);
  // Absent on an answer from a backend older than note #635, which listed them.
  const elsewhere = report?.machinesElsewhere ?? 0;
  return (
    <div className="screen" id="screenOrgCloud">
      <ScreenTitle title="Cloud" />
      {/* The month so far, added up, over the column it adds up (note #342).
          It wears the SAME four words its rows wear — a reader should be able
          to see that this figure is that column summed, and nothing else.

          This is deliberately not the figure that used to stand here. That
          one was `totals.estimatedMonthlyUsd`, a projection assuming every
          machine keeps its current state all month — which the machine a
          check runs on never does — so the number at the top was larger than
          any bill, and the owner had it removed. The one figure a reader
          takes from a screen is the one at the top, which is the argument
          both times: it was the wrong number to put there, and the month's
          real spend is the right one. `spentThisMonthUsd` sums only rows
          that state a fact, so no projection can reach this line. */}
      <div className="sub" id="orgSpendSub">
        {t ? <><strong>~${t.spentThisMonthUsd.toFixed(2)}</strong> total so far this month · {t.running} running, {t.stopped} asleep</> : ''}
      </div>
      {/* Over everything, because everything below is a reading of it, and
          first, because it is the one thing on this screen that can be
          exchanged for something else (note #372). Drawn only against a real
          answer: the slug comes from the machine read, and a failed read
          leaves the screen with an account it cannot name. */}
      {report
        ? (
          <CloudAccount
            orgId={orgId ?? ''}
            orgSlug={report.orgSlug}
            rows={report.machines.length}
            onReplaced={replaced}
          />
        )
        : null}
      <NewAgentMachineCard info={machine} error={machineError} onOpen={openMachine} />
      {/* The list has a name now that it is not the only thing on the screen.
          Before this it was the screen, and a heading over it would have been
          a label on the whole page. */}
      <h2>Machines</h2>
      <div className="card">
        <div id="orgSpendList">
          {!report ? <div className="empty">{error}</div> : null}
          {/* "Nothing runs in the account" would be false with the row below
              standing under it, so the empty list says whose nothing it is. */}
          {report && report.machines.length === 0
            ? <div className="empty">{elsewhere > 0 ? 'Nothing of this workplace runs in the cloud account yet.' : 'Nothing runs in the cloud account yet.'}</div>
            : null}
          {/* In the order the answer came in, which `org-spend.ts` orders by
              what each machine has cost — the biggest spender first (note
              #336), so the column of money reads straight down. */}
          {report?.machines.map((m) => {
            const named = rowName(m);
            return (
              <div className="crow spendrow" key={`${m.app}:${m.machineId}`}>
                <div className="main">
                  <div className="name plain spendname">
                    {named.face}
                    <span className="nametext">{named.name}{named.driver ? <span className="namedriver"> ({named.driver})</span> : null}</span>
                  </div>
                  <SpendLine m={m} />
                  <div className="spendfacts">
                    {m.activeMs !== undefined ? <span><strong>{activeTime(m.activeMs)}</strong> awake this month</span> : null}
                    {m.awakeSince ? <span>up since <strong>{dayOf(m.awakeSince)}</strong></span> : null}
                    <span><strong>${hourlyRate(m.hourlyUsd)}</strong>/hour awake</span>
                  </div>
                  {/* The one thing a reader can DO about a leftover (note
                      #375). It sits under the row's own facts rather than
                      beside the money: the money column is 76px on a phone,
                      and a button in that column would take the width the
                      name needs. Nothing else in this list is actionable, so
                      the button appears only where there is something to
                      act on. */}
                  {removable && isLeftover(m)
                    ? (
                      <button
                        className="btn danger bare spendremove"
                        type="button"
                        disabled={removing === m.app}
                        onClick={() => setAsking(m)}
                      >
                        {removing === m.app ? 'Removing…' : 'Remove'}
                      </button>
                    )
                    : null}
                </div>
                <div className="cside spendtotal">
                  <strong>~${m.totalMonthlyUsd ?? m.estimatedMonthlyUsd}</strong>
                  <span>{totalLabel(m)}</span>
                </div>
              </div>
            );
          })}
          {/* Last, under the rows it is not part of: the list above is this
              workplace's, ordered by what it has cost, and this row has no
              cost to be ordered by (note #635). */}
          {elsewhere > 0 ? <ElsewhereRow count={elsewhere} /> : null}
        </div>
        {/* What a held answer wears instead of a wait: its age. The second
            half is there because the first half raises the question — a
            reader who sees 12:03 at 12:19 should not be left wondering
            whether the screen has stopped working. */}
        {report
          ? <div className="cloudread" id="orgSpendRead">Checked at {readClock(machines.at)} · read again each visit</div>
          : null}
      </div>
      {/* Destroying it is not undoable and the card says so in the words the
          row already uses. It is `AskToConfirm` rather than the typed
          confirmation an agent's deletion asks for: what is being removed is
          a machine nobody is on, holding a setup that never finished, and
          asking a reader to type `ia-40b405ae58a07ded` on a phone is a toll,
          not a safeguard. */}
      {asking
        ? (
          <AskToConfirm
            title="Remove this machine?"
            message={`${asking.app} and everything on it are destroyed, for good. No agent is on it, so nothing you can open today lives there.`}
            verb="Remove"
            danger
            onAnswer={(confirmed) => { if (confirmed) void remove(asking); else setAsking(null); }}
          />
        )
        : null}
      <div className="formhint" id="orgSpendHint">{report ? `${report.disclaimer} Each row says what its machine has cost so far this month: its awake time at the hourly price, plus its storage. The figure at the top is those rows added up. An agent’s awake time is observed by the five-minute machine sweep; a site’s counts from when it was last started; CI checks add up the length of every run this month, each at the shape of the machine that ran it.${unmeasuredNote(t?.unmeasured ?? 0)}${leftoverNote(report.machines.filter(isLeftover).length)}${elsewhereNote(elsewhere)} Asleep machines cost almost nothing — agents sleep on their own when idle.` : ''}</div>
    </div>
  );
}
