import type { DocChapter } from '../model';
import { DocLink, Panel, Ui } from '../model';
import LiveProposal from '../../components/LiveProposal';
import LiveDecisions from '../../components/LiveDecisions';
import LiveRepo from '../../components/LiveRepo';
import { LiveRepositories } from '../../components/LiveSurfaces';

/**
 * Repositories and proposals: how to review a change an agent proposes, and
 * where the code it changes lives. Facts checked 2026-09-24 against
 * ProposalScreen, DecideBar, proposal-words, Delivery, RepoDanger,
 * GitAccessRow and the `pr ready` rule in agent-cli. Written to
 * src/docs/STYLE.md. Since rooms were removed (30–31 Oct 2026, note #843)
 * the decision queue heads the one list of agents, and a grant of keys to
 * checks names the workplace's shared keys. Re-checked 2026-11-06 (note
 * #1011): auto-merge (note #944), public repositories (note #936) and the
 * Repositories screen of the Workplace window (note #960).
 */
const chapter: DocChapter = {
  slug: 'repositories-and-proposals',
  title: 'Repositories and proposals',
  description:
    'How to review a change proposal, what Approve and Reject do, what happens after a merge, where your agents keep code, and how to clone a repository yourself.',
  lead: (
    <>
      An agent that writes code keeps it in a <strong>repository</strong>, and every change to
      protected code comes back to you as a <strong>change proposal</strong>. The agent works on
      a <strong>branch</strong>, its own copy of the code, and proposes it into{' '}
      <strong>main</strong>, the branch everyone builds and deploys from. You see the exact
      change, its checks and a write-up, with one button to merge it and one to send it back.
    </>
  ),
  sections: [
    {
      id: 'how-to-review',
      heading: 'How to review a proposal',
      body: (
        <>
          <p>
            A proposal reaches you two ways: a <Ui>Change proposal</Ui> card in the agent&rsquo;s
            chat, and a row under <Ui>Waiting for your decision</Ui> behind the faces beside Home&rsquo;s message box. Both open the same
            screen with <Ui>Review and decide</Ui>.
          </p>
          <p>
            Start with the agent&rsquo;s write-up and any screenshots it attached, the easiest part
            to judge on a phone. The summary card above them is the change itself: the files
            changed, opening to the full diff, the commits, and <Ui>Actions</Ui> for the checks. A
            line under the write-up says what approving will do. <Ui>Comments</Ui> is a thread
            shared with the agent and your teammates while the proposal is open.
          </p>
          <p>
            <Ui>Approve &amp; merge</Ui> merges the branch into main and the agent hears the
            outcome in its chat. <Ui>Reject</Ui> merges nothing; the screen does not collect a
            reason, so say it in the agent&rsquo;s chat, where it can act on it. Only the owner of
            the agent that proposed the change can decide it. A teammate can read and comment, and
            no agent can approve anything.
          </p>
        </>
      ),
      panel: (
        <Panel size="compact" says="A change proposal on its own screen: the branch it comes from, the files changed, the checks, the agent’s write-up, and Approve and Reject.">
          <LiveProposal />
        </Panel>
      ),
    },
    {
      id: 'the-proposal-loop',
      heading: 'The proposal loop',
      body: (
        <>
          <p>
            You ask an agent for a change. It works on a branch, pushes, and records a proposal.
            None of that reaches you: no card, no row, nothing to decide. The agent keeps going
            until it is finished, with the checks green, the wording right and the screenshot
            attached.
          </p>
          <p>
            Only then does it invite you, and the card and the row appear together. What you
            decide is always what is on the screen when you press the button. If the agent pushes
            an improvement before you decide, the same proposal shows the new code, with no second
            card. After you decide, the card in the chat shows the outcome and the row leaves the
            queue.
          </p>
          <p>
            If you would rather not be asked, turn on <Ui>Auto-merge</Ui> in the Workplace window.
            Every proposal your own agents make ready is then merged as soon as its checks pass,
            with no card to tap. It reads <Ui>Merged automatically</Ui>, never your name, because
            nobody read it. A teammate&rsquo;s proposals still wait for them, and one that cannot
            merge waits for you as before. While it is on, the Chief of Staff&rsquo;s header says{' '}
            <Ui>Auto-merge on</Ui>.
          </p>
        </>
      ),
      panel: (
        <Panel says="The Waiting for your decision queue: knowledge changes and code proposals ready for a decision, each with its repository, its agent and its checks.">
          <LiveDecisions />
        </Panel>
      ),
    },
    {
      id: 'checks',
      heading: 'Checks',
      body: (
        <>
          <p>
            A repository can run checks: its own script, <code>.agentbuilt/ci.sh</code>, on a
            throwaway machine. The verdict shows on the proposal&rsquo;s <Ui>Actions</Ui> row and
            on the repository&rsquo;s overview. A repository with no script reports{' '}
            <Ui>skipped</Ui>, which means there was nothing to run.
          </p>
          <p>
            The machine has Docker, so a script can bring the project&rsquo;s services up before
            its tests, with <code>docker compose up -d --wait</code>: a database, a cache, the app.
          </p>
          <p>
            You get a card only when the checks on that version have passed. A check still running
            or failing keeps the invitation from being sent, and a check pending for 30 minutes
            fails, so a verdict always arrives. The checks can go red afterwards, because an open
            proposal follows its branch: a later push runs them again. When that happens the
            button reads <Ui>Approve anyway</Ui>, and the line above it points at the{' '}
            <Ui>Actions</Ui> row. Approving still merges.
          </p>
          <p>
            A repository can be set to merge only when its checks pass. There the button reads{' '}
            <Ui>Actions must pass first</Ui>, stays disabled, and unlocks itself the moment they
            pass. What a check may be handed is under{' '}
            <DocLink href="#ci-secrets">Keys for checks</DocLink>.
          </p>
        </>
      ),
    },
    {
      id: 'after-approval',
      heading: 'After you approve',
      body: (
        <>
          <p>
            A merged change is not necessarily live yet. After approving, the proposal screen grows
            an <Ui>After approval</Ui> card with three stages that fill in on their own:{' '}
            <Ui>Merged into main</Ui>, <Ui>Checks on main</Ui>, and <Ui>Delivery</Ui>, whatever the
            repository does with a merged change. A delivery that reports <Ui>skipped</Ui> needed
            nothing; one that finishes says the change reached a live surface. On a repository with
            CI off, the last two say <Ui>off</Ui> straight away: nothing runs after the merge, so
            there is nothing to wait for. The site&rsquo;s row
            in <Ui>Workplace</Ui>, or the agent, says when it is in front of everyone (see{' '}
            <DocLink href="/docs/sites-and-domains#the-site-screen">The site screen</DocLink>).
          </p>
          <p>
            What merges is the version on your screen. If the branch moved between your reading
            and your tap, approving is refused, nothing changes, and the pill reads{' '}
            <Ui>Went stale</Ui>; the agent proposes again. A proposal whose pill reads <Ui>Conflicts with main</Ui> is
            final: the fix arrives as a new proposal with a new number, and the agent says which
            number is the live one.
          </p>
        </>
      ),
    },
    {
      id: 'where-code-lives',
      heading: 'Where code lives',
      body: (
        <>
          <p>
            If you already have a GitHub, a GitLab or another git host, that is the right home for
            your code, and an agent uses it once it has a{' '}
            <DocLink href="/docs/secrets">key</DocLink> for it. Your history, collaborators and
            existing checks stay where they are.
          </p>
          <p>
            When there is no host, or no way to hand an agent a key for yours, the platform has
            private repositories of its own, on its own git storage. Ask any agent to create one.
            It belongs to the whole workplace: every member sees it and every agent can push to
            it, with no share step. An admin can make one public from its screen once it has a
            LICENSE file, and then anyone with its address can read and clone it without an
            account. A repository&rsquo;s screen has an{' '}
            <Ui>Overview</Ui> tab for its proposals, check runs and contributors, and a{' '}
            <Ui>Content</Ui> tab for the files and the README.
          </p>
          <p>
            In a repository created here, main is <strong>protected</strong>: no agent can push to
            it directly, and a change reaches it only through a proposal you approve. Protection
            can be added but never taken away, and so can the rule that merges need green checks.
            An agent can also create an <strong>unprotected</strong> repository, permanently, for
            stores nobody reviews such as backups and exports. Anything you will read or run
            belongs in a protected one.
          </p>
        </>
      ),
      panel: (
        <Panel says="A repository’s Overview: three proposals against main, the checks and the deploy its last pushes ran, and its three contributors.">
          <LiveRepo />
        </Panel>
      ),
    },
    {
      id: 'clone-on-your-computer',
      heading: 'How to clone a repository on your computer',
      body: (
        <>
          <p>
            A <strong>clone</strong> is a copy of a repository on your own computer, worked on with
            ordinary git. The <Ui>Repositories</Ui> screen, opened from Workplace, ends with{' '}
            <Ui>Clone on your computer</Ui>: it shows an example <code>git clone</code> line, with{' '}
            <code>x-access-token</code> as the username and your personal key as the password.
          </p>
          <p>
            <Ui>Create key &amp; copy</Ui> makes the key and puts it on your clipboard, unseen by
            anyone. <Ui>New key &amp; copy</Ui> replaces it everywhere at once and <Ui>Revoke</Ui>{' '}
            ends it. Agents never see this key and cannot make one for you; ask one how to get the
            code onto your laptop and it points you here.
          </p>
        </>
      ),
      panel: (
        <Panel says="The Repositories screen: four repositories, each with its agents’ commits and its protected main branch, and the storage used.">
          <LiveRepositories />
        </Panel>
      ),
    },
    {
      id: 'ci-secrets',
      heading: 'Keys for checks',
      body: (
        <>
          <p>
            Sometimes a check needs a key, a deploy token for example. Keys live in the
            workplace&rsquo;s <DocLink href="/docs/secrets">Secrets</DocLink>. An admin&rsquo;s agent can hand one to a
            repository&rsquo;s checks, and it applies at once: the agent tells you in its chat which
            keys it handed over, and the repository&rsquo;s screen lists them under{' '}
            <Ui>Keys for checks</Ui>. There is nothing to approve, because the keys reach checks on
            main only, and nothing lands on main unless you approve it or your auto-merge does.
          </p>
          <p>
            Keys are masked out of every log. Any agent can take a key back; only an admin&rsquo;s agent can hand one over. The same goes
            for publishing on approval: when an admin&rsquo;s agent links a repository to a live site,
            it tells you so in the chat, and from then on approving a change is publishing it. The
            repository&rsquo;s screen says where approved changes go, and any agent can switch it back
            to publishing by hand.
          </p>
        </>
      ),
    },
    {
      id: 'rename-and-delete',
      heading: 'Rename and delete',
      body: (
        <>
          <p>
            An agent can rename a repository. The history stays whole; only the clone address
            changes.
          </p>
          <p>
            No agent can delete a repository. An admin&rsquo;s agent can ask, which shows as the
            badge <Ui>delete asked</Ui> on the row, and the agent tells you in its reply. On the
            repository&rsquo;s screen <Ui>Keep it</Ui> says no, or <Ui>Delete this repository</Ui>{' '}
            asks you to type the name. An admin can also delete there without an ask. For 14 days
            any agent can bring it back; after that it is gone.
          </p>
        </>
      ),
    },
  ],
  reference: [
    {
      term: 'Where',
      text: <>Home, <Ui>Workplace</Ui>, <Ui>Repositories</Ui>. A repository&rsquo;s screen has <Ui>Overview</Ui> and <Ui>Content</Ui> tabs.</>,
    },
    {
      term: 'Who decides a proposal',
      text: 'The owner of the agent that proposed it, or that owner’s auto-merge once the checks pass. Teammates can read and comment. No agent can approve.',
    },
    {
      term: 'Status pills',
      text: <><Ui>Waiting for you</Ui>, <Ui>Still being prepared</Ui>, <Ui>Merging</Ui>, <Ui>Merged</Ui>, <Ui>Merged automatically</Ui>, <Ui>Rejected</Ui>, <Ui>Withdrawn</Ui>, <Ui>Went stale</Ui>, <Ui>Conflicts with</Ui> a branch.</>,
    },
    {
      term: 'Decision buttons',
      text: <><Ui>Approve &amp; merge</Ui>; <Ui>Approve anyway</Ui> when a check failed; <Ui>Actions must pass first</Ui>, disabled, on a repository that requires checks; <Ui>Reject</Ui>.</>,
    },
    {
      term: 'Files on a proposal',
      text: 'Up to 5 files of 10 MB each, attached by the agent. None accepted once the proposal is decided.',
    },
    {
      term: 'Checks',
      text: <><code>.agentbuilt/ci.sh</code>, run on a throwaway machine. No script means <Ui>skipped</Ui>. A check pending for 30 minutes fails.</>,
    },
    {
      term: 'Clone on your computer',
      text: <>Username <code>x-access-token</code>, password your key. <Ui>Create key &amp; copy</Ui>, <Ui>New key &amp; copy</Ui>, <Ui>Revoke</Ui>.</>,
    },
    {
      term: 'Keys for checks',
      text: <>Handed over at once by an admin&rsquo;s agent, which tells you in its chat; listed on the repository&rsquo;s screen under <Ui>Keys for checks</Ui>. Main only, masked in logs, shared keys only.</>,
    },
  ],
};

export default chapter;
