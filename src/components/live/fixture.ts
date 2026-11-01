import { useState, useSyncExternalStore } from 'react';
import type { HomeAgent } from '../../../backend/workspace-ui/src/workspace/live';
import type { WorkspaceOrgMember, WorkspaceOrgMemberAgent } from '../../../backend/src/shared/workspace-api';

/**
 * The Workspace, live on the landing: one fixture and the providers that
 * stand in for the app's own.
 *
 * The data half; LiveWorkspace.tsx is the providers. Every live panel on the
 * page (LiveFleet, LiveDecisions, LiveNotes) renders
 * a REAL component from backend/workspace-ui — the same file the product
 * ships — under the contexts it expects, filled from here instead of the API.
 * Nothing in the app is edited for the landing's sake; when a row changes in
 * the product it changes on the page at the next build, which is what a
 * screenshot cannot do.
 *
 * The fixture is the team the captures show: Northstar's workplace, with
 * Ruby and Milo on Claude Code and Otis on Codex, James reading, and Ada on
 * Codex in the four-agent panels.
 *
 * THE STORY IS THE AMBITION (the owner, 2026-09-15: a few people, a fleet
 * of agents, huge output, insanely ambitious work). Northstar is James
 * building a dispatch and routing platform for delivery fleets — a routing
 * engine, an API with billing, a dispatcher web app, a driver app for two
 * phone platforms and a pipeline for the vans' GPS pings — and running it
 * with a full workplace of agents (seventy-odd until note #664, 2026-09-25,
 * held a workplace on our cloud to twenty agents; eighteen now, see JAMES).
 * It was four people until inviting was switched off (note #206): a
 * workplace is one person's today. Until this date the same four agents
 * built a one-page website, a headline and a contact form, and the page
 * read as a studio making small sites: the headings did not say small, the
 * jobs did. So every job on the page is now a piece of that platform, and
 * every panel tells the same one: the batch route optimiser Ruby just
 * shipped (2,000 stops, 40 vans, 38 seconds), the driver app's offline
 * queue she is on now, Milo's usage-based invoicing, Otis's partitioned
 * pings table, Ada's dispatcher interviews. The states are the ones a
 * workplace is actually in — three agents mid-turn, one ready, a note being
 * worked, a note merged.
 *
 * Two rules keep it prerenderable. Time-relative words ("2h ago") are
 * computed from offsets at render time, so the build's HTML and the
 * client's first paint say the same words. Anything that must not be in
 * the server's HTML at all — a running clock — waits for `useHydrated()`.
 */

export const ORG = {
  orgId: 'org_northstar',
  name: 'Northstar',
  role: 'admin',
  members: 2,
  seats: 2,
  seatProviders: ['claude', 'codex'],
};

export const FACES = {
  ada: '/agent-avatars/ada.jpg',
  ruby: '/agent-avatars/ruby.jpg',
  milo: '/agent-avatars/milo.jpg',
  otis: '/agent-avatars/otis.jpg',
  // Nora wears the white pomeranian and Mia the black poodle (swapped
  // 2026-09-16, the owner): Nora sits in the row the hero and the social
  // card fade out, and a black face fading to nothing read as an empty
  // plate. Mia is in the row past it, which nobody sees.
  nora: '/agent-avatars/mia.jpg',
  theo: '/agent-avatars/theo.jpg',
  mia: '/agent-avatars/nora.jpg',
  finn: '/agent-avatars/leo.jpg',
  jamesPerson: '/agent-avatars/james.svg',
  leoPerson: '/agent-avatars/leo.svg',
  priyaPerson: '/agent-avatars/priya.svg',
  tomPerson: '/agent-avatars/tom.svg',
} as const;

export const FLEET: HomeAgent[] = [
  {
    id: 'agent_ruby',
    name: 'Ruby',
    cli: 'claude',
    model: 'opus',
    effort: 'high',
    status: 'ready',
    avatarUrl: FACES.ruby,
    machineSize: { cpuKind: 'performance', cpus: 4, memoryMb: 8192 },
    working: true,
    now: 'Build the driver app’s offline queue for GPS pings',
    recap: 'Built the batch route optimiser — 2,000 stops for 40 vans in 38 seconds — and opened the proposal; now on the driver app’s offline queue.',
    context: { usedPercent: 58, tokens: 116_000, window: 200_000, at: '2026-09-06T08:40:00.000Z' },
  },
  {
    id: 'agent_milo',
    name: 'Milo',
    cli: 'claude',
    model: 'opus',
    effort: 'high',
    status: 'ready',
    avatarUrl: FACES.milo,
    machineSize: { cpuKind: 'performance', cpus: 2, memoryMb: 4096 },
    working: true,
    now: 'Move invoicing to usage-based metering in Stripe',
    activity: 'Editing invoices.ts',
    recap: 'Moved invoicing to usage: completed stops per account, metered nightly in Stripe, with the old flat plans kept until the pilot ends.',
    context: { usedPercent: 34, tokens: 68_000, window: 200_000, at: '2026-09-06T08:40:00.000Z' },
  },
  {
    id: 'agent_otis',
    name: 'Otis',
    cli: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'medium',
    status: 'ready',
    avatarUrl: FACES.otis,
    machineSize: { cpuKind: 'performance', cpus: 2, memoryMb: 4096 },
    recap: 'Partitioned the GPS pings table by month — last week’s queries run 40 times faster — and wrote the on-call runbook for the pipeline.',
    context: { usedPercent: 12, tokens: 24_000, window: 200_000, at: '2026-09-06T08:40:00.000Z' },
  },
];

/** Note #57 is the team's handoff scene before Ruby accepts it. The hero keeps
 * the same three agents in their present two-working/one-ready state, while
 * this earlier moment makes all three valid choices in the real HandRow. */
export const NOTE_HANDOFF_FLEET: HomeAgent[] = FLEET.map((agent) => ({
  ...agent,
  working: false,
}));

/** The hero's fleet: the three the page introduces, and Ada beside them.
 *
 * It was three until 2026-09-14, which left the fourth cell of a two-column
 * grid empty — room for more at poster size on the front page, a rendering
 * fault once the same panel was cropped onto the social card. Ada fills it,
 * and Otis stays READY: a fleet where every agent is always busy is a picture
 * of a demo, and "Ready" is half of what the state line on these cards is for.
 */
export const HERO_FLEET: HomeAgent[] = [
  FLEET[0]!,
  FLEET[1]!,
  FLEET[2]!,
  {
    id: 'agent_ada',
    name: 'Ada',
    cli: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
    status: 'ready',
    avatarUrl: FACES.ada,
    machineSize: { cpuKind: 'performance', cpus: 2, memoryMb: 4096 },
    working: true,
    now: 'Turn the six dispatcher interviews into a research recap',
    activity: 'Reading interview notes',
    recap: 'Compared six dispatcher interviews and wrote the product team’s research recap.',
    context: { usedPercent: 21, tokens: 42_000, window: 200_000, at: '2026-09-06T08:40:00.000Z' },
  },
];

/** The hero's fleet, continued: the four the page introduces and four more
 * of the workplace's agents (the owner, 2026-09-15: a fleet of four is a team; a
 * fleet that keeps going is the narrative — a few people, many agents). The
 * hero drew them fading out past the fold until 2026-10-08; they pass in its
 * moving row now (LiveMarquee, note #185), and the social card still draws
 * them fading out. Each is on a real piece of the platform, so a reader who
 * leans in finds work, not filler. */
export const HERO_FLEET_BEYOND: HomeAgent[] = [
  ...HERO_FLEET,
  {
    id: 'agent_nora',
    name: 'Nora',
    cli: 'claude',
    model: 'opus',
    effort: 'high',
    status: 'ready',
    avatarUrl: FACES.nora,
    machineSize: { cpuKind: 'performance', cpus: 2, memoryMb: 4096 },
    working: true,
    now: 'Write the contract tests for the routing API',
    activity: 'Editing routing.test.ts',
    recap: 'Wrote the contract tests the API runs against the routing service on every push.',
    context: { usedPercent: 44, tokens: 88_000, window: 200_000, at: '2026-09-06T08:40:00.000Z' },
  },
  {
    id: 'agent_theo',
    name: 'Theo',
    cli: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'medium',
    status: 'ready',
    avatarUrl: FACES.theo,
    machineSize: { cpuKind: 'performance', cpus: 2, memoryMb: 4096 },
    working: true,
    now: 'Load test the dispatcher app at five times the pilot’s traffic',
    activity: 'Bash: k6 run',
    recap: 'Load tested the API at five times traffic and fixed the two slow queries it found.',
    context: { usedPercent: 27, tokens: 54_000, window: 200_000, at: '2026-09-06T08:40:00.000Z' },
  },
  {
    id: 'agent_mia',
    name: 'Mia',
    cli: 'claude',
    model: 'opus',
    effort: 'high',
    status: 'ready',
    avatarUrl: FACES.mia,
    machineSize: { cpuKind: 'performance', cpus: 2, memoryMb: 4096 },
    recap: 'Set up alerting for the pings pipeline; every alert is on the on-call page.',
    context: { usedPercent: 9, tokens: 18_000, window: 200_000, at: '2026-09-06T08:40:00.000Z' },
  },
  {
    id: 'agent_finn',
    name: 'Finn',
    cli: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
    status: 'ready',
    avatarUrl: FACES.finn,
    machineSize: { cpuKind: 'performance', cpus: 2, memoryMb: 4096 },
    working: true,
    now: 'Build the weekly kilometres PDF, one per depot',
    activity: 'Rendering the PDF',
    recap: 'Built the depot map for the dispatcher screen, with every van’s last ping on it.',
    context: { usedPercent: 31, tokens: 62_000, window: 200_000, at: '2026-09-06T08:40:00.000Z' },
  },
];

/** The balanced four-card team shown in the anatomy section: the same four,
 * all of them mid-job, on their next piece of work rather than this one. The
 * hero above it carries Otis idle, so the two panels are never the same
 * picture twice. */
export const TEAM_FLEET: HomeAgent[] = [
  {
    ...FLEET[0]!,
    now: 'Build the batch route optimiser and run its benchmark',
    activity: 'Bash: cargo bench',
  },
  {
    ...FLEET[1]!,
    doing: undefined,
    working: true,
    now: 'Move invoicing to usage-based metering in Stripe',
    activity: 'Editing invoices.ts',
  },
  {
    ...FLEET[2]!,
    working: true,
    now: 'Partition the GPS pings table by month',
    activity: 'Running the migration',
  },
  {
    id: 'agent_ada',
    name: 'Ada',
    cli: 'codex',
    model: 'gpt-6-astra',
    effort: 'high',
    status: 'ready',
    avatarUrl: FACES.ada,
    machineSize: { cpuKind: 'performance', cpus: 2, memoryMb: 4096 },
    working: true,
    now: 'Compare six dispatcher interviews and write the research recap',
    activity: 'Reading interview notes',
    recap: 'Compared six dispatcher interviews and wrote the product team’s research recap.',
    context: { usedPercent: 21, tokens: 42_000, window: 200_000, at: '2026-09-06T08:40:00.000Z' },
  },
];

/**
 * An ISO time this long before the page was rendered. Called at render, on
 * both sides — but from ONE base, read when this module loads rather than on
 * every call.
 *
 * Two renders of the same page have to be byte-identical
 * (src/entry-server.test.tsx), and reading the clock per call meant a render
 * pass that straddled a second boundary produced two different pages. It
 * passes on a fast machine and fails on a busy one, which is the worst shape
 * a check can have. One base per process is also what the client already sees:
 * module load there is page load.
 */
const RENDERED_AT = Date.now();
export const ago = (ms: number) => new Date(RENDERED_AT - ms).toISOString();
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const subscribeNever = () => () => {};
/** False in prerendered HTML and while it is being adopted; true once this is
 *  the client's own render — the moment a clock can be shown without the
 *  server's copy and the client's disagreeing. */
export const useHydrated = () => useSyncExternalStore(subscribeNever, () => true, () => false);

const RUNNING_FOR_MS: Record<string, number> = {
  agent_ruby: 4 * MINUTE + 12_000,
  agent_milo: 2 * MINUTE + 37_000,
  agent_otis: 6 * MINUTE + 48_000,
  agent_ada: MINUTE + 23_000,
  agent_nora: 3 * MINUTE + 5_000,
  agent_theo: 8 * MINUTE + 31_000,
  agent_finn: 41_000,
};
const ACTIVITY = 'Bash: npm test -- offline-queue';

/** The fleet with its running clocks attached — once hydrated, never in the
 *  prerendered HTML (a turn that started at build time would be days old).
 *  Each agent mid-job has its own elapsed time, so no two clocks agree. */
export function useRunningFleet(fleet: HomeAgent[]): HomeAgent[] {
  const hydrated = useHydrated();
  const [clockBase] = useState(() => Date.now());
  return fleet.map((agent, index) => (
    agent.working && hydrated
      ? {
          ...agent,
          activitySince: new Date(
            clockBase - (RUNNING_FOR_MS[agent.id] ?? ((index + 1) * MINUTE)),
          ).toISOString(),
          activity: agent.activity ?? ACTIVITY,
        }
      : agent
  ));
}

const face = (agent: HomeAgent): WorkspaceOrgMemberAgent => ({ id: agent.id, name: agent.name, avatarUrl: agent.avatarUrl });
const faces = (...ids: string[]): WorkspaceOrgMemberAgent[] => ids.map((id) => face(HERO_FLEET_BEYOND.find((agent) => agent.id === id)!));

const pool = (...names: string[]): WorkspaceOrgMemberAgent[] => names.map((name) => ({
  id: `agent_${name.toLowerCase()}`, name, avatarUrl: `/agent-avatars/${name.toLowerCase()}.jpg`,
}));

/**
 * The one person of the workplace, wearing the faces of the agents he
 * drives. A workplace is one person's while inviting is switched off (notes
 * #205 and #206), so Northstar is James and eighteen agents: until then it
 * was four people (James, Leo, Priya and Tom, 4 + 6 + 3 + 5 agents), drawn as
 * the team page's People deck and the moving row's four small teams. Every
 * count has its faces (the owner, 2026-10-05): the eight of the hero's fleet,
 * and the rest from the product's own avatar pool (backend/assets/
 * agent-avatars), copied into public/agent-avatars for the page. The role is
 * still in the data, as it is in the app; the row draws it the way the app
 * does while inviting is off, without it.
 */
export const JAMES: WorkspaceOrgMember = {
  userId: 'user_james',
  name: 'James',
  photoUrl: FACES.jamesPerson,
  you: true,
  role: 'admin',
  joinedAt: ago(41 * DAY),
  agents: 18,
  workedMs: 412 * 3_600_000,
  here: true,
  recap: 'Messaged Ruby',
  recapAt: ago(3 * MINUTE),
  agentFaces: [
    ...faces('agent_ruby', 'agent_milo', 'agent_otis', 'agent_theo', 'agent_ada', 'agent_mia', 'agent_nora', 'agent_finn'),
    ...pool('Iris', 'Hugo', 'Kai', 'Juno', 'Felix', 'Zoe', 'Hazel', 'Oscar', 'Willow', 'Toby'),
  ],
};
