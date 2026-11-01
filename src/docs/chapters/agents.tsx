import type { DocChapter } from '../model';
import { DocLink, Panel, Ui } from '../model';
import LiveFleet from '../../components/LiveFleet';
import LiveAgent from '../../components/LiveAgent';
import { LiveNewAgent } from '../../components/LiveForms';

/**
 * Agents: how to create one, what its card and its own screen show, how to
 * change its model, effort and machine, when its machine sleeps, one list
 * for the workplace, updates and removal. Facts checked 2026-09-24 against
 * main. Since note #715 Home is the Chief of Staff's conversation and the
 * agents are behind the faces beside its message box (the owner's
 * follow-up, 2026-10-11). Written to src/docs/STYLE.md. Since note #664
 * (2026-09-25) the machines run on the cloud, a workplace holds twenty
 * agents, and the Cloud screen with its machine list is not a hosted
 * workplace's to open — so "The machine" no longer shows it. Since note
 * #733 (2026-10-11) there is no briefing card, so "The briefing" section
 * and its reference row are gone; catching up is a question for the Chief
 * of Staff. Rooms were removed on 30–31 Oct 2026 (note #843): the
 * "Rooms" section became "One list of agents", the Room row and the move
 * picker are gone, and separation is another workplace.
 */
const chapter: DocChapter = {
  slug: 'agents',
  title: 'Agents',
  description:
    'How to create an agent, what its card and its own screen show, how to change its model, effort and machine, when its machine sleeps, and how to remove it.',
  lead: (
    <>
      An agent is a teammate you message with work. Each one has a name, its own cloud computer,
      and its own conversation with you. It runs either <Ui>Claude Code</Ui>{' '}
      on your Claude subscription or <Ui>Codex</Ui> on your ChatGPT subscription, chosen when it
      is created and kept for life. Everything it builds waits for it in its home folder between
      turns.
    </>
  ),
  sections: [
    {
      id: 'creating-an-agent',
      heading: 'How to create an agent',
      body: (
        <>
          <p>
            Your Chief of Staff brings in the agents a job needs, but a new project often wants one of its own.
            Tap the faces beside the message box on Home and press <Ui>New agent</Ui> under your agents. The
            dialog asks one question: <Ui>Claude Code</Ui> or <Ui>Codex</Ui>. That is the whole form.
          </p>
          <p>
            The name and picture are assigned for you, from a pool of human names you are not
            already using. Model, effort and machine start at their defaults, and you can change
            all three later on the agent&rsquo;s screen. If you have not signed in a subscription
            for the tool you chose, you are sent to sign one in first (see{' '}
            <DocLink href="/docs/your-cloud-and-subscriptions#seats">Your subscriptions</DocLink>).
          </p>
          <p>
            The new card reads <Ui>Setting up — a minute or two</Ui>, and it is ready in about
            that. If the machine cannot be built, the half-made agent is removed. More agents working
            at the same time means another subscription (see{' '}
            <DocLink href="/docs/your-cloud-and-subscriptions#seats">Your subscriptions</DocLink>).
            Giving one its first job is in{' '}
            <DocLink href="/docs/talking-to-agents">Talking to agents</DocLink>.
          </p>
        </>
      ),
      panel: (
        <Panel says="The New agent question: what should it run, with the two choices, Claude Code on your Claude subscription or Codex on your ChatGPT subscription.">
          <LiveNewAgent />
        </Panel>
      ),
    },
    {
      id: 'the-agents-list',
      heading: 'The Agents list',
      body: (
        <>
          <p>
            The faces beside the message box on Home open every agent of yours: the ones working
            first, then the most recently used. Each card is a glance at how that agent is doing.
          </p>
          <ul>
            <li>
              The <strong>context ring</strong> around its face shows how full its conversation
              memory is. It turns amber from 67% and red from 90%, when the agent should start a
              fresh chat.
            </li>
            <li>Its model and effort, and its machine shape.</li>
            <li>
              A state line: <Ui>Now</Ui> with the elapsed time while it works, <Ui>Ready</Ui> or{' '}
              <Ui>Active 4m ago</Ui> when it is not, and lines such as{' '}
              <Ui>2 proposals waiting on you</Ui> or <Ui>Session limit</Ui> when something needs
              you.
            </li>
            <li>A one-sentence recap of its latest work, rewritten after every turn.</li>
          </ul>
          <p>
            Tap a card to open the chat. An agent that is still setting up or out of session
            opens its own screen instead, and a paused agent with no subscription opens <Ui>Your subscriptions</Ui>.
          </p>
          <p>
            When some of your agents have finished their work and nothing waits on them, a{' '}
            <Ui>Reset finished agents</Ui> button under the cards gives them all a{' '}
            <DocLink href="/docs/talking-to-agents#a-fresh-chat">fresh chat</DocLink> in one press.
          </p>
        </>
      ),
      panel: (
        <Panel says="The Agents list: each card with its face inside a context ring, its model and effort, its machine, its state line and a one-line recap of its latest work.">
          <LiveFleet size="tile" says="Ruby and Milo, both on Claude Code, mid-job with the time elapsed; Otis, on Codex, ready. Each card carries its context ring and its latest recap." />
        </Panel>
      ),
    },
    {
      id: 'the-agents-screen',
      heading: 'How to change how an agent thinks',
      body: (
        <>
          <p>
            Tap the name or face in the chat header to open the agent&rsquo;s own screen. The
            screen shows the recap, the <Ui>Thinks with</Ui> and <Ui>Machine</Ui> rows, and the
            software card.
          </p>
          <p>
            Tap <Ui>Thinks with</Ui> to open <Ui>How ‹name› thinks</Ui>. A choice saves the moment
            you tap it and begins on the next turn; a turn already running finishes as it started.
            The catalog depends on the tool.
          </p>
          <ul>
            <li>
              <strong>Claude Code</strong>: <code>opus</code>, the default, <code>fable</code> and{' '}
              <code>sonnet</code>. Effort: medium, high, xhigh, max.
            </li>
            <li>
              <strong>Codex</strong>: <code>gpt-6.1-sol</code>, the default, plus{' '}
              <code>gpt-6-astra</code>, <code>gpt-6.1-terra</code>, <code>gpt-6-sol</code>, <code>gpt-6-luna</code>,{' '}
              <code>gpt-5.6-sol</code>, <code>gpt-5.6-terra</code>, <code>gpt-5.6-luna</code> and <code>gpt-5.5</code>. Most
              offer medium through ultra; the luna models stop at max, and <code>gpt-5.5</code> at
              xhigh.
            </li>
          </ul>
          <p>
            The default effort is <strong>high</strong> for both. The heavy levels, xhigh, max and
            ultra, are marked <Ui>Much more compute</Ui>: they think much longer and spend the
            subscription much faster. Worth it on a hard problem, expensive as an everyday setting.
          </p>
        </>
      ),
      panel: (
        <Panel says="Ruby’s own screen: her face inside its context ring, the model and effort she thinks with, her machine line, and the software card with Claude Code, the machine software and her manual.">
          <LiveAgent size="tile" />
        </Panel>
      ),
    },
    {
      id: 'the-machine',
      heading: 'The machine',
      body: (
        <>
          <p>
            Each agent has a dedicated virtual computer on the cloud, with a full shell, outbound
            internet and git. New agents are built on <strong>2 dedicated cores and 4 GB</strong>. The
            other sizes are in{' '}
            <DocLink href="/docs/your-cloud-and-subscriptions#machine-sizes">Machine sizes</DocLink>.
          </p>
          <p>
            To resize one agent, tap the <Ui>Machine</Ui> row on its screen. The picker offers
            dedicated and shared cores and marks the rung new agents get as <Ui>standard</Ui>. A
            size change never touches the agent&rsquo;s files. A sleeping machine simply wakes on
            the new size. An awake one restarts for about a minute, after you confirm with{' '}
            <Ui>Change size</Ui>, and while the agent is working the change waits for the turn to
            finish.
          </p>
          <p>
            Only the agent&rsquo;s home folder survives a machine software update, so ask for
            anything that matters to be pushed to a repository. Resizing is yours to do; an agent
            never changes its own machine.
          </p>
        </>
      ),
    },
    {
      id: 'sleep-and-wake',
      heading: 'Sleep and wake',
      body: (
        <>
          <p>
            A machine sleeps about three quiet minutes after its last turn, and wakes in seconds
            when you send a message. The <Ui>Machine</Ui> row on the agent&rsquo;s screen says which
            it is, and when asleep adds <Ui>It wakes on your next message.</Ui>
          </p>
          <p>
            Sleep is safe. Every file and every unfinished piece of work is there when it wakes.
            A running background job keeps the machine awake, as do a turn in progress, setup, an
            open terminal and an update being installed.
          </p>
          <p>
            A visitor can wake a machine too. A page the agent serves from its own address is
            reachable while it sleeps, but the first load takes about ten seconds. For hosting that
            never sleeps, see <DocLink href="/docs/sites-and-domains">Sites and domains</DocLink>.
          </p>
        </>
      ),
    },
    {
      id: 'one-list',
      heading: 'One list of agents',
      body: (
        <>
          <p>
            A workplace keeps all its agents in one list. Every agent reaches the same
            repositories, notes, knowledge pages, sites and Drive. To catch up after a day away,
            ask your Chief of Staff on Home.
          </p>
          <p>
            To keep work apart, a client&rsquo;s project or a second business for example, give it
            a workplace of its own. An agent stays in the workplace it was made in; see{' '}
            <DocLink href="/docs/workplace-and-people#one-workplace">One workplace, one place</DocLink>.
          </p>
          <p>
            Teammates&rsquo; agents appear under your own, grouped by the person who drives each one.
            Tapping one opens a read-only page; only its owner can message it or change how it
            runs.
          </p>
        </>
      ),
    },
    {
      id: 'updates',
      heading: 'Updates',
      body: (
        <>
          <p>
            Machines update themselves: each is brought up to the pinned version of Claude Code or
            Codex just before it goes to sleep. Most of the time there is nothing to do. The
            software card on the agent&rsquo;s screen shows where it stands, and when a version is
            waiting you can press <Ui>Update Claude Code</Ui>, <Ui>Update Codex</Ui> or{' '}
            <Ui>Update machine software</Ui> yourself. The last one asks first, because it restarts
            the machine for about a minute; files are kept. Both buttons are locked while the agent
            is working.
          </p>
        </>
      ),
    },
    {
      id: 'removing-an-agent',
      heading: 'Removing an agent',
      body: (
        <>
          <p>
            <Ui>Delete this agent</Ui> is at the bottom of the agent&rsquo;s screen. You type the
            name to confirm. The machine and everything on it are erased for good, its private keys
            with it, and the chat stops answering. Anything never pushed to a repository or
            uploaded to Drive goes too. A retired agent, whose owner has left the workplace, has the
            same button.
          </p>
        </>
      ),
    },
  ],
  reference: [
    { term: 'Where', text: <>Home, the faces beside the message box. Tap a card for the chat; tap the name or face in the chat header for the agent&rsquo;s own screen.</> },
    { term: 'Name and picture', text: 'Assigned from a pool of human names, skipping names you already use. Not chosen or changed by you.' },
    { term: 'Default model', text: <><code>opus</code> for Claude Code, <code>gpt-6.1-sol</code> for Codex, both at effort <strong>high</strong>.</> },
    { term: 'More at once', text: 'More agents working at the same time means another subscription.' },
    { term: 'Default machine', text: '2 dedicated cores and 4 GB. Its owner can resize it from its screen.' },
    { term: 'Sleep', text: 'About three quiet minutes after the last turn. Wakes in seconds on a message.' },
    { term: 'Context window', text: 'The ring around the face, labelled “Context window N% full”. Amber from 67%, red from 90%. Only a fresh chat resets it.' },
    { term: 'Recap', text: 'One sentence, twelve words or so, rewritten after every turn. The “Recap from” row says when it was written.' },
    { term: 'Manual', text: <><code>CLAUDE.md</code> or <code>AGENTS.md</code> on the machine, maintained by the platform. Its row reads “v12 · up to date” or names the version arriving next turn.</> },
  ],
};

export default chapter;
