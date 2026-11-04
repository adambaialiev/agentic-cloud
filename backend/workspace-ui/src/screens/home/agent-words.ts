/**
 * The words an agent row says, ported from the legacy page's helpers of the
 * same names so both shells describe the same agent the same way. Pure
 * functions over the row the server sent; the components draw them.
 */

import type { WorkspaceOrgSummary } from '../../../../src/shared/workspace-api.js';
import type { WorkspaceAgentState } from '../../../../src/shared/workspace-recap.js';
import { harnessName, subscriptionName } from '../../../../src/shared/harness-clis.js';
import { machineSizeParts, machineSizeWords } from '../agent/machine-words.js';
import { relative } from '../../ui/time.js';
import type { HomeAgent } from '../../workspace/live.js';

export function providerLabel(provider: string): string {
  return harnessName(provider);
}

/** The concrete harness, model and effort this agent will use next turn. */
export function agentRuntimeLine(agent: Pick<HomeAgent, 'cli' | 'model' | 'effort'>): string {
  return [providerLabel(agent.cli), agent.model, agent.effort].filter(Boolean).join(' · ');
}

/**
 * What this agent runs ON — its machine's shape (note #356), in the same
 * words the machine screen uses, so the row and the picker behind it cannot
 * describe one machine two ways.
 *
 * '' when nothing has looked at that machine yet. The server sends the last
 * OBSERVED shape and omits it otherwise rather than filling in the fleet
 * default, so an empty line here means "not known", never "standard" — and a
 * row says nothing rather than something plausible and wrong.
 */
export function agentMachineLine(agent: Pick<HomeAgent, 'machineSize'>): string {
  return agent.machineSize ? machineSizeWords(agent.machineSize) : '';
}

/**
 * The same two identity lines, as the facts they are made of, for a card too
 * narrow to promise either one fits on a single line (note #396). A fleet
 * plate is half a phone wide; measured across every supported width, BOTH
 * lines were ellipsised on every agent on every phone — the model came out
 * `opus…`, the effort never appeared at all, and under 350px the machine
 * line was hidden outright. The parts let the card fold a line instead of
 * cutting it, which is the difference between a fact that is small and a
 * fact that is gone.
 *
 * THE HARNESS IS LEFT OUT of the runtime facts, and that is what buys the
 * room: it is the widest word on the line ("Claude Code" is 40% of it), it
 * is the tab the reader has just chosen directly above the grid, and the
 * model beside it already names it — `opus` and `fable` are Claude's, every
 * `gpt-…` is Codex's. Everywhere with a full row to spend it, the line still
 * says all three: `agentRuntimeLine` above is untouched, and the proposal
 * head, the margin and the hover card go on using it.
 */
export function agentRuntimeFacts(agent: Pick<HomeAgent, 'cli' | 'model' | 'effort'>): string[] {
  const facts = [agent.model, agent.effort].filter((word): word is string => Boolean(word));
  // A harness this product no longer runs sends no model and no effort at
  // all. Its plate still names the harness, because on a retired row that
  // name IS the explanation — and a card that says nothing about what an
  // agent runs is not the improvement this note asked for.
  return facts.length ? facts : [providerLabel(agent.cli)].filter(Boolean);
}

export function agentMachineFacts(agent: Pick<HomeAgent, 'machineSize'>): string[] {
  return agent.machineSize ? machineSizeParts(agent.machineSize) : [];
}

/**
 * What a founding agent's row says while it waits (note #144): the ONE
 * thing the workplace still lacks before its computer can be built — the
 * cloud, then a subscription — or, with both in, that its build has not
 * started yet. Founding starts the whole batch together; a planned record
 * left afterwards is waiting for a retry, never for another agent's turn.
 */
export function plannedAgentLine(org: WorkspaceOrgSummary | null): string {
  if (!org || !(org.seatProviders?.length)) return 'Waiting for a subscription';
  return 'Computer waiting to be built';
}

/** The session limit a ready, idle agent is standing behind, if any. A
 *  running turn outranks it: the limit is what the NEXT turn will hit. */
export function agentSessionLimited(agent: Pick<HomeAgent, 'status' | 'working' | 'sessionLimit'>) {
  return agent.status === 'ready' && !agent.working ? agent.sessionLimit : undefined;
}

/**
 * The state line under an agent's name on a fleet plate, whatever state it
 * is in — and the long form the agents switcher's peek repeats (note #713),
 * so the two cannot describe one agent two ways. `going` is an agent being
 * erased right now (`useFleet().departing`).
 */
export function agentPlateLine(
  agent: HomeAgent,
  org: WorkspaceOrgSummary | null,
  now: number,
  going = false,
): string {
  // A retired agent's machine may be long gone already — don't narrate
  // erasing one. Everything else is having its machine torn down right now.
  if (going) return agent.status === 'retired' ? 'Removing it…' : 'Erasing its machine…';
  switch (agent.status) {
    case 'ready': {
      const limited = agentSessionLimited(agent);
      if (limited) return limited.resumeReady ? 'Ready to resume' : 'Session limit';
      return agentStatusLine(agent, now);
    }
    case 'retired': return 'Retired — it can no longer run';
    case 'needs-sign-in': return 'Finishing sign-in…';
    case 'payment-required':
      return `Paused — ${subscriptionName(agent.cli)} subscription needs attention`;
    case 'needs-seat':
      return hasExistingSeatForAgent(agent, org)
        ? 'Paused — choose a subscription'
        : `Paused — ${signInWords(agent.cli)}`;
    case 'planned': return plannedAgentLine(org);
    default: return 'Setting up — a minute or two';
  }
}

/** What a paused agent with no seat of its kind asks for, lower-case: the
 *  tail of its plate line, and (capitalised) its own screen's door to it. */
export function signInWords(cli: string): string {
  return cli === 'opencode' ? 'add your OpenCode key' : `sign in ${subscriptionName(cli)}`;
}

export function agentStatusLine(agent: HomeAgent, now = Date.now()): string {
  if (agent.working) return 'Now';
  const doing = agent.doing;
  if (doing?.kind === 'proposal') {
    return doing.count > 1 ? `${doing.count} proposals waiting on you` : `Proposed #${doing.number} — waiting on you`;
  }
  if (agent.lastActiveAt) {
    // "Active 4m ago", "Active 15h ago" — the age a person's row says too
    // (note #574); a calendar "today" hid whether that was a minute or a
    // morning ago.
    const when = relative(agent.lastActiveAt, now);
    if (when) return `Active ${when}`;
  }
  return 'Ready';
}

/**
 * Whether any card on this list says something that MOVES — a running turn's
 * stopwatch or an idle agent's "Active 4m ago" — and so whether the shared
 * clock should tick behind it. A stamp that stops counting is a stamp that
 * lies (the same rule as `peopleClockMoves`).
 */
export function agentClockMoves(agents: Array<Pick<HomeAgent, 'working' | 'activitySince' | 'lastActiveAt'>>): boolean {
  return agents.some((agent) => agent.working ? Boolean(agent.activitySince) : Boolean(agent.lastActiveAt));
}

/** The durable half: the summarizer's latest-work recap, or a fact off the
 *  agent's records, or nothing rather than filler. */
export function agentRecapLine(agent: Pick<HomeAgent, 'recap' | 'doing'>): string {
  if (agent.recap) return agent.recap;
  const doing = agent.doing;
  if (doing?.kind === 'site') return `Runs ${doing.host}${doing.count > 1 ? ` and ${doing.count - 1} more` : ''}`;
  if (doing?.kind === 'preview') return 'Serving a live page';
  return '';
}

export function agentNowLine(agent: Pick<HomeAgent, 'working' | 'now'>): string {
  return agent.working && agent.now ? agent.now : '';
}

/** Whether this agent already has a signed-in subscription it can choose. A
 *  paused agent with one is a SELECTION problem, not a sign-in problem. */
export function hasExistingSeatForAgent(agent: Pick<HomeAgent, 'cli'>, org: WorkspaceOrgSummary | null): boolean {
  return Boolean(org?.seatProviders?.includes(agent.cli));
}

/** A signed-in grant exists, but its provider has paused access. */
export function hasPaymentRequiredSeatForAgent(
  agent: Pick<HomeAgent, 'cli'>,
  org: WorkspaceOrgSummary | null,
): boolean {
  return Boolean(org?.paymentRequiredSeatProviders?.includes(agent.cli));
}

/** One question, asked the same way whoever draws it. */
export const NEW_AGENT_QUESTION =
  'It gets a conversation in this Workspace and its own cloud machine, and keeps this choice for life. What should it run?';

export const NEW_AGENT_CLIS = [
  { id: 'claude', label: 'Claude Code', hint: 'Runs on your Claude subscription' },
  { id: 'codex', label: 'Codex', hint: 'Runs on your ChatGPT subscription' },
  { id: 'opencode', label: 'OpenCode', hint: 'Runs on your OpenCode Go subscription' },
] as const;

/**
 * Why this workplace cannot start that agent yet, or '' when it can. The
 * server refuses the same request; saying it here walks the reader to the
 * sign-in rather than bouncing them off a refusal.
 */
export function missingSeatRefusal(cli: string, org: WorkspaceOrgSummary | null): string {
  if (!org || !Array.isArray(org.seatProviders) || org.seatProviders.includes(cli)) return '';
  if (org.paymentRequiredSeatProviders?.includes(cli)) {
    return `${subscriptionName(cli)} access needs attention before a new ${harnessName(cli)} agent can start. Open the paused subscription to restore access.`;
  }
  if (cli === 'opencode') return 'An OpenCode agent runs on your OpenCode subscription — add your OpenCode key here first, then create it.';
  return cli === 'codex'
    ? 'A Codex agent runs on your ChatGPT subscription — sign it in here first, then create it.'
    : 'A Claude Code agent runs on your Claude subscription — sign it in here first, then create it.';
}

/**
 * Whether there is a conversation to open at all: any agent that can take a
 * turn can be chatted with. Shared by the agent's own screen and by the door
 * on a proposal, so an agent offered a chat in one place is offered it in the
 * other.
 */
export function agentChattable(agent: Pick<HomeAgent, 'status' | 'working'> | null | undefined): boolean {
  return Boolean(agent) && (agent!.status === 'ready' || Boolean(agent!.working));
}

/**
 * The one-word answer to "is this agent working right now?", in the words
 * Home's own fleet counter already uses ("12 total · 3 active · 9 idle").
 *
 * Only a `ready` agent is idle in the sense that matters — it can take a
 * message. An agent still setting up, signing in, paused or retired is not
 * working and is not available either, so it says which of those it is
 * rather than borrowing a word that would invite a message it cannot answer.
 *
 * `tone` is what the indicator is DRAWN from, kept apart from the label so a
 * translation or a shorter word never changes the colour of the dot.
 */
export interface AgentPresence {
  tone: 'active' | 'idle' | 'waiting';
  label: string;
}

export function agentPresence(agent: Pick<HomeAgent, 'status' | 'working'>): AgentPresence {
  // A running turn first: it is the fact the reader came to check, and it
  // outranks whatever the record says the agent's standing state is.
  if (agent.working) return { tone: 'active', label: 'Active' };
  switch (agent.status) {
    // "Ready", not "Idle" (note #439, the owner): the same state said from
    // the reader's end of it — this agent can take a message — rather than
    // the app announcing that nothing is happening. The tone keeps the word
    // `idle`, which is what the DOT is drawn from and nobody reads.
    case 'ready': return { tone: 'idle', label: 'Ready' };
    case 'setting-up':
    case 'needs-bot': return { tone: 'waiting', label: 'Setting up' };
    case 'needs-sign-in': return { tone: 'waiting', label: 'Signing in' };
    case 'retired': return { tone: 'waiting', label: 'Retired' };
    // needs-seat and payment-required: a machine that is ready and a
    // subscription that is not. The screen's own Status row says which.
    default: return { tone: 'waiting', label: 'Paused' };
  }
}

/**
 * The Workspace Agent's state line, in the words an agent's plate uses for
 * the same states. Its conversation and details screens wear it; Home
 * stopped drawing the agent's own card when the agent was hidden (note
 * #656), and what follows is why each word was chosen for that card.
 *
 * ALWAYS a word (note #439, the owner): the line held the
 * card's height whether or not it had anything in it, and an empty one just
 * looked like a card missing its last line. "Ready" is what it says when
 * there is nothing else to say — the same word before its first message
 * ever and between requests all afternoon, because from the reader's side
 * those are the same fact: it is waiting for them.
 *
 * "Idle" is what it must NOT say, which is where this started: a card
 * announcing that nothing is happening, in the app's own voice. "Ready" is
 * the same state told from the reader's end of it.
 *
 * "Working" keeps its live dot and loses the phase it used to trail: a dot,
 * the word, and "Thinking…" were three ways of saying one thing, and the
 * phase changed under the reader every few seconds while it said it. And
 * "Ready" alone, not "Ready — send it a message": the whole card is the door
 * to that message box now, so the sentence instructed a thumb already on it,
 * and it was the one state too long to sit on this line at 320px.
 *
 * Here since note #843 took the room briefing card it was written beside
 * (`WorkspaceRecap`) out with the rooms.
 */
export function agentStateLine(agent: WorkspaceAgentState | undefined): { text: string; live: boolean } {
  if (agent?.working) return { text: 'Working', live: true };
  if (agent?.waiting.length) return { text: `Waiting for ${agent.waiting.join(', ')}`, live: false };
  return { text: 'Ready', live: false };
}
