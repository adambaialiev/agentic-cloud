import type { ReactNode } from 'react';
import { LiveSites } from '../components/LiveSurfaces';
import LiveFleet from '../components/LiveFleet';
import LiveNotes from '../components/LiveNotes';
import LiveDecisions from '../components/LiveDecisions';
import LiveChief from '../components/LiveChief';
import LiveProposal from '../components/LiveProposal';
import LiveRepoFiles from '../components/LiveRepoFiles';
import LiveKnowledgePage from '../components/LiveKnowledgePage';
import LiveSubscriptions from '../components/LiveSeats';
import { TEAM_FLEET } from '../components/live/fixture';
import { faqsFor, type Faq } from './product-copy';

/**
 * The entry pages: three addresses for three questions people arrive with,
 * each answered with the running product (note 139).
 *
 * What this is NOT is a second product tour. The front page is canonical and
 * says everything; these pages each answer ONE question a search brings
 * someone in with, using that page's own claims, its own live panels and its
 * own door — then send the reader to the front page for the rest. Every
 * sentence here is either the landing's or checkable against the product; the
 * FAQ answers are quoted from lib/product-copy.ts rather than rewritten, so
 * there is one copy of each answer on the whole site.
 *
 * Why these three, on 2026-09-07 evidence rather than a guess: the twelve
 * retired /guides articles are the only record we have of which doors we ever
 * opened (there is no analytics build-out and no Search Console — see
 * the go-to-market strategy, kept privately, "Measurement"). Their slugs cluster into
 * exactly two intents that this product honestly answers — running a coding
 * CLI on a machine that stays up (claude-code-in-the-cloud, -on-a-vps,
 * keep-claude-code-running, background-agents), and a company wanting agents
 * for its team (ai-agent-for-a-small-business, what-to-hand-an-ai-engineer).
 * Codex gets its own address because the h1 names it and its readers search
 * for it by name, not for Claude Code. The three guides that had to be
 * corrected or removed for lying (hire-an-ai-engineer's monthly fee,
 * openclaw-hosting's one-bot-per-agent) are deliberately NOT rebuilt.
 */

export interface EntryBlock {
  heading: string;
  body?: string;
  panel: ReactNode;
  /** The panel leads on wide screens; the words follow. */
  panelFirst?: boolean;
}

export interface EntrySpec {
  slug: string;
  h1: string;
  lead: string;
  blocks: EntryBlock[];
  /** Left off where the owner took a page's questions and answers away. */
  faqs?: Faq[];
  closing: string;
}

/* ── The three pages ───────────────────────────────────────────────────── */

export const CLAUDE_CODE_IN_THE_CLOUD: EntrySpec = {
  slug: 'claude_code_in_the_cloud',
  h1: 'Run Claude Code in the cloud, on the plan you already have.',
  lead:
    'Agentic Cloud Computer runs Claude Code in your own cloud account, with everything it needs built '
    + 'in: git with CI/CD, hosting, storage, email, notes and memory. Sign in to your Claude plan once and '
    + 'it becomes a seat: no API key, no per-token bill.',
  blocks: [
    {
      // Until note #787 (2026-10-25): "A computer of its own, not a session.",
      // the machine that keeps working when the laptop closes. Claude Code
      // does that itself now; what it does not have is somewhere to land.
      heading: 'It ends live, not at a pull request.',
      body:
        'Git made for agents, hosting, storage and email are already here. What your agent '
        + 'finishes goes live at its own address, with nothing for you to set up.',
      panel: <LiveSites />,
    },
    {
      heading: 'It runs on the subscription you already pay for.',
      body:
        'The official Claude Code, on a cloud machine of its own, signed in to the Claude plan you '
        + 'already have. Every agent on it runs on that plan, and the bill stays between you and Anthropic. Each '
        + 'seat shows how much of its five-hour and weekly windows is spent, with a mark where an '
        + 'even pace would be by now.',
      panel: <LiveSubscriptions />,
      panelFirst: true,
    },
    {
      heading: 'It can build and test. It cannot decide.',
      body:
        'Protected changes come back as a proposal with the exact diff and its checks. An agent '
        + 'can prepare the work; approving it is yours.',
      panel: <LiveProposal />,
    },
  ],
  faqs: faqsFor(['needs', 'cost', 'different', 'keys']),
  closing: 'Give Claude Code its first job today.',
};

export const CODEX_IN_THE_CLOUD: EntrySpec = {
  slug: 'codex_in_the_cloud',
  h1: 'Run Codex in the cloud, beside your Claude Code agents.',
  lead:
    'Each agent chooses its coding CLI when you create it — Claude Code, Codex or OpenCode — and it '
    + 'runs in your own cloud account, with git and CI/CD, hosting, storage, email, notes and memory built in. Sign in to the '
    + 'ChatGPT plan you already have and it becomes a seat. Every kind of agent works in the same '
    + 'Workspace, on the same repositories, at the same time.',
  blocks: [
    {
      heading: 'Both CLIs, one team.',
      body:
        'Otis and Ada run on Codex, Ruby and Milo on Claude Code — same workplace, same notes, same '
        + 'repositories. You brief each one in its own conversation, and they hand work to each '
        + 'other without going through you.',
      panel: (
        <LiveFleet
          size="tile"
          fleet={TEAM_FLEET}
          says="Four agents working in parallel: Ruby and Milo on Claude Code, Otis and Ada on Codex — building the batch route optimiser, moving invoicing to usage, partitioning the GPS pings table and comparing six dispatcher interviews."
        />
      ),
    },
    {
      heading: 'The work leaves a repository behind.',
      body:
        'Ordinary git, with every proposed change against it. Read it in the browser, or clone it '
        + 'to your own computer.',
      panel: <LiveRepoFiles />,
      panelFirst: true,
    },
    {
      heading: 'One plan, several agents, no API key.',
      body:
        'The official Codex CLI runs on each agent’s machine, signed in to your ChatGPT plan; the '
        + 'platform just runs it for you. A seat is yours alone, and several of your agents can share it.',
      panel: <LiveSubscriptions />,
    },
  ],
  faqs: faqsFor(['needs', 'cost', 'keys', 'where']),
  closing: 'Give Codex its first job today.',
};

/* A workplace is one person's while inviting is switched off (notes #205 and
   #206), so the team on this page is the agents, run by one person: no
   teammates joining, no People deck, no roles. No questions and answers
   either: the owner took them off this page (2026-10-12). */
export const AGENTS_FOR_YOUR_TEAM: EntrySpec = {
  slug: 'ai_agents_for_your_team',
  h1: 'A whole team of AI agents, run by one person.',
  lead:
    'Named agents, one company memory they all read before a job, and an approval card in front '
    + 'of every protected change. You run the whole team from one conversation, on your own Claude '
    + 'or ChatGPT plan.',
  blocks: [
    {
      heading: 'Several agents, working at once.',
      body:
        'Each one has a name, a face and its own computer, and you brief it in its first message. '
        + 'They work in parallel and hand work to each other.',
      panel: (
        <LiveFleet
          size="tile"
          fleet={TEAM_FLEET}
          says="Four agents are working in parallel on one platform: Ruby builds the batch route optimiser, Milo moves invoicing to usage-based metering, Otis partitions the GPS pings table, and Ada compares six dispatcher interviews and writes the research recap."
        />
      ),
    },
    {
      heading: 'Every job teaches the next one.',
      body:
        'Your agents write the workplace’s knowledge pages, read them before a job, and keep them '
        + 'growing. The longer they work for you, the better they get.',
      panel: <LiveKnowledgePage size="face" />,
      panelFirst: true,
    },
    {
      heading: 'A note is how a job gets handed to somebody.',
      body:
        'Write what needs doing where every agent can see it, and hand it to the one that should '
        + 'own it.',
      panel: <LiveNotes />,
    },
    {
      heading: 'One conversation runs the whole team.',
      body:
        'Tell your Chief of Staff what you want done. It hands the work out, follows up, and brings '
        + 'back only what needs your yes. Every agent runs on your own plan.',
      panel: <LiveChief />,
      panelFirst: true,
    },
    {
      heading: 'A person decides what protected code ships.',
      /* "Code and knowledge changes queue as proposals" until note #1011:
         since note #746 (12 Oct 2026) a knowledge change is live at once,
         with nothing to approve. */
      body:
        'Changes to protected code queue as proposals with their checks, and wait for a yes unless '
        + 'the owner has turned on auto-merge. An agent cannot merge, '
        + 'approve, delete or widen access to a secret.',
      panel: <LiveDecisions />,
    },
  ],
  closing: 'Give your agents their first job today.',
};
