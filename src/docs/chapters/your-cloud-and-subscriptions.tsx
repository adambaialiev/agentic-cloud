import type { DocChapter } from '../model';
import { DocLink, Panel, Ui } from '../model';
import LiveSubscriptions from '../../components/LiveSeats';

/**
 * Cloud and subscriptions: what you pay and to whom, the cloud the agents'
 * machines run on and what a workplace can hold there, the Claude and
 * ChatGPT subscriptions the agents think with, and machine sizes. Written to
 * src/docs/STYLE.md.
 *
 * Rewritten for note #664 (the owner, 2026-09-25): a new workplace no longer
 * connects a Fly account of its own. Its agents' machines, its sites and its
 * files run on OUR cloud, which we pay for, up to twenty agents and ten live
 * sites across the whole workplace (backend config/access.ts,
 * HOSTED_AGENT_LIMIT / HOSTED_SITE_LIMIT). The sections on the Fly token,
 * replacing a cloud and the spend view went with it: a hosted workplace has
 * none of them. The slug stays, because the front page's FAQ links to
 * #what-you-pay and #seats.
 *
 * Since note #822 (the owner, 2026-10-28: "we should not host yet ... Only
 * on-premise") the one offer is the private copy, the whole platform in the
 * company's own cloud account (knowledge page private-copy), so this chapter
 * says what a copy costs and where it runs. Hosted workplaces that already
 * exist keep running, but nothing here offers a new one: the thirty-site
 * allowance and the "no charge" lines belonged to hosting and went. The
 * Cloud card's panel went with them; it drew the hosted card.
 *
 * Re-checked 2026-11-06 (note #1011): OpenCode seats (note #780, live
 * 2026-10-21) joined Claude and ChatGPT; code lives on the copy's own code
 * host in the same account; admins' This copy health section (note #813) is
 * named. What's new and the Upgrade button (notes #1006, #1008) are not
 * named yet: no release a company can install carries them (latest
 * 2026.11.01.1 on 6 Nov).
 */
const chapter: DocChapter = {
  slug: 'your-cloud-and-subscriptions',
  title: 'Cloud and subscriptions',
  description:
    'Your agents run in your own cloud account and think with your own Claude, ChatGPT or OpenCode subscription: what you pay and to whom, what runs where, machine sizes.',
  lead: (
    <>
      Two things power a workplace. Your own cloud account is where every agent&rsquo;s machine
      and every site runs. Your Claude, ChatGPT or OpenCode subscription is what the agents
      think with, signed in once and private to you.
    </>
  ),
  sections: [
    {
      id: 'what-you-pay',
      heading: 'What you pay',
      body: (
        <>
          <p>
            The platform runs as your own Agentic Cloud, in your company&rsquo;s own cloud account
            (see <DocLink href="/#give-your-agent">Your own Agentic Cloud</DocLink>). Each cost is billed
            by whoever provides it:
          </p>
          <ul>
            <li><strong>Us</strong>: nothing. Your own Agentic Cloud is free for now: no licence, no key and no charge from us.</li>
            <li><strong>Cloud</strong>: your cloud provider bills your own account directly for the agents&rsquo; machines, your sites, your files and the Workspace itself.</li>
            <li><strong>AI</strong>: your Claude, ChatGPT or OpenCode subscription, billed by Anthropic, OpenAI or OpenCode as it always was.</li>
            <li><strong>Anything else you connect</strong>, such as a GitHub account: on that provider&rsquo;s own terms.</li>
          </ul>
        </>
      ),
    },
    {
      id: 'what-runs-there',
      heading: 'What runs where',
      body: (
        <>
          <p>Three kinds of thing run in your cloud account for your workplace.</p>
          <ul>
            <li>
              <strong>One machine per agent.</strong> It keeps its files between turns, sleeps when
              idle and wakes in seconds when there is work. See{' '}
              <DocLink href="/docs/agents#the-machine">The machine</DocLink> and{' '}
              <DocLink href="/docs/agents#sleep-and-wake">Sleep and wake</DocLink>.
            </li>
            <li>
              <strong>The sites</strong> your agents deploy, each on its own small machine. See{' '}
              <DocLink href="/docs/sites-and-domains#production-sites">Production sites</DocLink>.
            </li>
            <li>
              <strong>Your files</strong>: the ones sent in chats, put on notes, proposals and
              knowledge pages, and everything in Drive. See{' '}
              <DocLink href="/docs/notes-knowledge-drive#where-files-live">Where files live</DocLink>.
            </li>
          </ul>
          <p>
            Repositories live on your Agentic Cloud&rsquo;s own code host, in the same account,
            unless you use a host of your own; see{' '}
            <DocLink href="/docs/repositories-and-proposals#where-code-lives">Where code lives</DocLink>{' '}
            and the <DocLink href="/privacy">Privacy Policy</DocLink> for the full split.
          </p>
          <p>
            Admins see how it is all doing under <Ui>This copy</Ui> in Workplace settings: one
            line each for the Workspace, its backups, the disk, the code host, previews and
            sites, and mail coming in.
          </p>
          <p>
            Several agents can share one seat, and more seats run more agents at once (see{' '}
            <DocLink href="/docs/your-cloud-and-subscriptions#seats">Seats</DocLink>).
          </p>
        </>
      ),
    },
    {
      id: 'seats',
      heading: 'Your subscriptions',
      body: (
        <>
          <p>
            A subscription you have signed in is called a <strong>seat</strong>: a Claude Pro or Max
            plan, which runs agents on Claude Code, a ChatGPT Plus or Pro plan, which runs them on
            Codex, or an OpenCode subscription, added with its key, which runs them on OpenCode (see{' '}
            <DocLink href="/docs/getting-started#sign-in-a-subscription">Sign in a subscription</DocLink>).
            The agents run the official Claude Code, Codex and OpenCode tools on their own machines.
            The platform gives them the machines, and the plan itself stays between you and its
            provider.
            It is yours alone. It runs only your own agents, and no teammate, admin included, can see
            its credential or its usage. Several of your agents share one seat, and you can use the
            same seat in several of your workplaces at once.
          </p>
          <p>
            Your subscriptions appear as a strip in <Ui>Workplace</Ui> on Home, one tile per subscription with its usage, and{' '}
            <Ui>Add sub</Ui> opens <Ui>Your subscriptions</Ui>. There you sign in another, or bring in one
            you use elsewhere with <Ui>Use here</Ui>. With more than one seat of a provider,{' '}
            <Ui>Make primary here</Ui> puts one first; when it is paused, your agents
            fall back to the next ready seat of the same provider. <Ui>Unassign from this
            workplace</Ui> keeps a seat working in your other workplaces, while{' '}
            <Ui>Remove subscription everywhere</Ui> takes it out of all of them and deletes the
            platform&rsquo;s copy of its sign-in. It does not sign you out at Anthropic or OpenAI.
          </p>
          <p>
            A subscription has windows: an amount for a short period and an amount for the week. A
            Claude seat shows <Ui>5 hours</Ui>, <Ui>7 days</Ui> and a weekly window per model. Each
            shows the percentage used, when it resets, and a mark where an even pace would be by
            now. A high percentage late in the window is fine; a high one early means the agents will
            hit the limit before it resets, and the pace line forecasts when. An agent that
            reaches the limit pauses at <Ui>Session limit</Ui> and picks up again on its own once the
            window resets. When Claude pauses a subscription, usually a billing matter on their side,
            the seat&rsquo;s screen says so and offers <Ui>Open Claude billing</Ui>. OpenCode keeps
            its usage in its own console, so an OpenCode seat shows none here, and your agent says
            when a limit is reached.
          </p>
        </>
      ),
      panel: (
        <Panel says="The subscriptions strip with four seats, two Claude Max 20x and two ChatGPT Pro 5x, each showing its usage, and under it one Claude seat’s usage: the five-hour window at 46 percent and the week at 68 percent, each with a mark where an even pace would be by now.">
          <LiveSubscriptions />
        </Panel>
      ),
    },
    {
      id: 'machine-sizes',
      heading: 'Machine sizes',
      body: (
        <>
          <p>
            Every agent&rsquo;s machine has a size: how many processor cores, whether they are shared
            or dedicated, and how much memory. The standard for a new agent is two dedicated cores
            and 4 GB of memory, which is a good size for almost all work. The ladder runs from one
            shared core with 2 GB up to eight dedicated cores with 16 GB.
          </p>
          <ul>
            <li>
              <Ui>Shared cores</Ui>: one, two or four cores with 2, 4 or 8 GB. A shared core is
              throttled hard under sustained load, and the same job can take many times longer
              there.
            </li>
            <li>
              <Ui>Dedicated cores</Ui>: one, two, four or eight cores with 2, 4, 8 or 16 GB. The
              standard is in this list.
            </li>
          </ul>
          <p>
            Memory is a wall, not a slope. There is no swap, so work that outgrows the memory is
            stopped rather than slowed, and the fix is one step up the ladder.
          </p>
          <p>
            An agent&rsquo;s owner, whatever their role, resizes that one agent from its own screen,
            in its <Ui>Machine</Ui> row. A resize is refused while the agent is mid-turn. An awake
            machine restarts and stops for about a minute; an asleep one wakes up on the new size.
            Files are kept either way.
          </p>
        </>
      ),
    },
  ],
  reference: [
    {
      term: 'The cloud',
      text: 'Your company’s own cloud account: where every agent’s machine, every site, your files and the Workspace itself run, billed to you by your provider.',
    },
    {
      term: 'More agents at once',
      text: 'Several agents can share one seat; more seats run more at once.',
    },
    {
      term: 'Seat',
      text: 'One signed-in subscription: Claude Pro or Max (Claude Code), ChatGPT Plus or Pro (Codex) or an OpenCode key (OpenCode). Private to the person who signed it in; usable in several of their workplaces at once.',
    },
    {
      term: 'Seat status',
      text: <><Ui>Ready</Ui>, <Ui>Resting</Ui>, <Ui>Needs sign-in</Ui>, <Ui>Off</Ui> or <Ui>Subscription needs attention</Ui>.</>,
    },
    {
      term: 'Seat order',
      text: <><Ui>Make primary here</Ui>, <Ui>Earlier fallback</Ui>, <Ui>Later fallback</Ui>, per workplace.</>,
    },
    {
      term: 'Windows',
      text: <>Claude: <Ui>5 hours</Ui>, <Ui>7 days</Ui>, a weekly window per model, and <Ui>Extra usage</Ui> when set. Pace: ahead of, under, or right on an even pace; within three points counts as even.</>,
    },
    {
      term: 'Machine sizes',
      text: 'Shared cores: 1, 2 or 4 with 2, 4 or 8 GB. Dedicated cores: 1, 2, 4 or 8 with 2, 4, 8 or 16 GB. Standard for new agents: 2 dedicated cores, 4 GB. No swap.',
    },
    {
      term: 'A resize',
      text: 'By the agent’s owner, from its screen; never by the platform or the agent itself. Refused mid-turn. Awake: restarts, about a minute. Asleep: wakes on the new size. Files kept.',
    },
  ],
};

export default chapter;
