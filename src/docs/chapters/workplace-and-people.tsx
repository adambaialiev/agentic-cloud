import type { DocChapter } from '../model';
import { DocLink, Panel, Ui } from '../model';
import LiveFleet from '../../components/LiveFleet';
import LiveCloud from '../../components/LiveCloud';
import { HERO_FLEET } from '../../components/live/fixture';

/**
 * Workplace and people: teammates (switched off since 2026-10-11, owner's
 * decision — RouteDeps.invitesClosed), the two roles, the People page
 * (back wherever a workplace has a team, with each person's agents and
 * what they are doing, 2026-10-28),
 * what a workplace holds, leaving, renaming and deleting.
 * Facts checked 2026-09-24 against the invite, people, workplace and
 * deletion screens on main: the deletion lock is three days. Since note
 * #726 (2026-10-11) a new workplace opens empty: its Chief of Staff brings
 * in a team once the person has said what they are working on and signed
 * in a plan. Since note #715 Home is the Chief of Staff's conversation;
 * its face and name open the Workplace window, and the agents picker is
 * the faces beside the message box (the owner's follow-up, 2026-10-11);
 * founding still builds no machine for it. Rooms were removed on 30–31 Oct
 * 2026 (note #843): "Workplace and rooms" became "One workplace, one
 * place", and keeping work apart is another workplace.
 * Written to src/docs/STYLE.md. Since note #664 (2026-09-25) a new
 * workplace runs on our cloud: there is no cloud for an admin to connect,
 * and deleting a workplace takes its machines and sites with it.
 */
const chapter: DocChapter = {
  slug: 'workplace-and-people',
  title: 'Workplace and people',
  description:
    'Why a workplace is yours alone for now, what a workplace holds, why agents stay personal, and how a workplace is renamed or deleted.',
  lead: (
    <>
      A workplace is the place your work lives: its agents and notes, its code, knowledge,
      sites and files. You can have as many as you like. This chapter is the people side of one:
      why it is yours alone for now, what each role may do where there are several people, and
      what happens when a workplace is renamed, left or deleted.
    </>
  ),
  sections: [
    {
      id: 'inviting-people',
      heading: 'Teammates: not open yet',
      body: (
        <>
          <p>
            A workplace is for one person right now. Inviting people into it is switched off while
            we finish the single-person experience, so there is no invite link to make and no
            request to approve. An invite link made earlier opens on a page that says invites are
            closed. The people already in a workplace stay in it.
          </p>
          <p>
            When teammates come, each will get their own agents, their own subscription and their
            own conversations, and share everything else with you. In your own Agentic Cloud they
            are already here: an admin shares an invite link and approves each person who asks to
            join (see <DocLink href="/#give-your-agent">Your own Agentic Cloud</DocLink>).
          </p>
        </>
      ),
    },
    {
      id: 'roles',
      heading: 'Admins and members',
      body: (
        <>
          <p>
            While a workplace is for one person, you are its admin and the Workspace does not
            show roles at all: no <Ui>Admin</Ui> badge, no head count. What follows is how roles
            work in a workplace that already has several people.
          </p>
          <p>
            There are two roles. Whoever creates a workplace is its <strong>admin</strong>.
            Everyone who joins is a <strong>member</strong> until an admin promotes them, from
            their screen on the People page.
          </p>
          <p>Only an admin can:</p>
          <ul>
            <li>change roles and remove people;</li>
            <li>rename and delete the workplace;</li>
            <li>add, copy or delete a shared key, and decide whose agents receive it;</li>
            <li>grow the workplace&rsquo;s code storage.</li>
          </ul>
          <p>
            Any member can create agents, use every repository, knowledge page, note and
            site, sign in their own subscriptions, save a key for one of their own agents, and
            leave. One rule protects the whole thing: the last admin cannot leave, be removed or be
            made a member until another admin exists.
          </p>
        </>
      ),
    },
    {
      id: 'agents-are-personal',
      heading: 'Agents are personal',
      body: (
        <>
          <p>
            An agent belongs to the person who created it and stays in that workplace for life.
            Only its owner chats with it, and only its owner decides its proposals. Being an admin
            does not let you approve a teammate&rsquo;s proposal, read their conversation, or see
            their subscription.
          </p>
          <p>
            Everyone can see that every agent exists: its name, its face, who drives it
            and whether it is working. What it is working on stays with its owner.
          </p>
        </>
      ),
    },
    {
      id: 'people',
      heading: 'The People page',
      body: (
        <>
          <p>
            Wherever a workplace has a team &mdash; more than one person in it, or invites open
            &mdash; its people stand in the <Ui>Workplace</Ui> window, right under the agent
            counts, and on the People page, which the account menu&rsquo;s <Ui>People</Ui> row
            opens. Each person is one card: whether they are here now or when they were last
            active, the last thing they did, and under it each agent they drive &mdash;{' '}
            <Ui>Working</Ui> or <Ui>Idle</Ui>, with the same one-line summary of its latest work
            that its owner sees. Tap an agent to open its page; tap the rest of the card for the
            person. Nobody else ever sees the words of your chat with an agent, only that line.
          </p>
          <p>
            Each person&rsquo;s own screen lists every agent they drive the same way, with when
            they joined and, for an admin, <Ui>Make admin</Ui> and{' '}
            <Ui>Remove from workplace</Ui>. A workplace of one that nobody can join shows none of
            this: no People row, and no role or head count in the workplace switcher.
          </p>
        </>
      ),
    },
    {
      id: 'one-workplace',
      heading: 'One workplace, one place',
      body: (
        <>
          <p>
            Everything in a workplace sits together: one list of agents, one list of notes, one set
            of keys, one knowledge shelf, and the repositories, sites and Drive. Every agent can
            clone any repository and read any note or page. A shared key reaches the agents an
            admin chose; see{' '}
            <DocLink href="/docs/secrets#who-sees-what">Who can see and use a key</DocLink>.
          </p>
          <p>
            To keep work apart, a client&rsquo;s project or a second company for example, start
            another workplace for it. Agents, notes, keys and code in one workplace never reach
            another; see{' '}
            <DocLink href="#renaming">Renaming, switching and starting another</DocLink>.
          </p>
        </>
      ),
      panel: (
        <Panel says="The workplace’s agents: four cards, each with its face, its model and effort, its machine and its state line.">
          <LiveFleet size="tile" fleet={HERO_FLEET} says="Ruby and Milo on Claude Code and Ada on Codex, all mid-job; Otis, on Codex, ready. Each has its own cloud machine." />
        </Panel>
      ),
    },
    {
      id: 'leaving-and-removing',
      heading: 'Leaving and removing',
      body: (
        <>
          <p>
            To leave, open <Ui>Workplace settings</Ui> and press <Ui>Leave</Ui> under{' '}
            <Ui>Membership</Ui> at the bottom. To remove someone, open their screen from People and
            press <Ui>Remove from workplace</Ui>. You cannot remove yourself, and nobody can remove
            the last admin.
          </p>
          <p>
            Both have the same effect. The person&rsquo;s agents in that workplace are retired for
            good and can no longer run, and their undecided proposals are withdrawn. Everything
            shared stays: repositories, knowledge pages, notes, sites and history. Their account,
            their subscriptions and their other workplaces are untouched.
          </p>
        </>
      ),
    },
    {
      id: 'renaming',
      heading: 'Renaming, switching and starting another',
      body: (
        <>
          <p>
            The workplace&rsquo;s name at the top of Home is a menu: every workplace you belong to,
            then <Ui>Workplace settings</Ui> and <Ui>New workplace</Ui>. Switching changes only what you are looking at. Every agent,
            repository, note and key stays in the workplace it was made in.
          </p>
          <p>
            <Ui>Workplace settings</Ui> is the workplace&rsquo;s own page: its people, its cloud,
            its code storage and backups. At the foot, admins
            have <Ui>Rename this workplace</Ui>. Type the new name and press <Ui>Save name</Ui>;
            nothing else changes.
          </p>
          <p>
            <Ui>New workplace</Ui> asks only for a name. You are its admin, and it opens empty, as
            your first one did: its Chief of Staff greets you, asks what you are working on, and
            brings in a team for it. A subscription you signed in is yours across workplaces; see{' '}
            <DocLink href="/docs/your-cloud-and-subscriptions#seats">Your subscriptions</DocLink>.
          </p>
        </>
      ),
      panel: (
        <Panel says="The Cloud card on Workplace settings: Agentic Cloud Computer, free, with nothing to connect; 18 of 20 agents and 3 of 30 sites in use.">
          <LiveCloud />
        </Panel>
      ),
    },
    {
      id: 'deleting-a-workplace',
      heading: 'Deleting a workplace',
      body: (
        <>
          <p>
            An admin asks with <Ui>Delete this workplace</Ui> at the foot of Workplace settings,
            then types the workplace&rsquo;s exact name. An empty workplace goes at once. Any other
            locks for three days first: its agents stop, every member sees a lock screen and is
            emailed, and any admin can press <Ui>Keep this workplace</Ui> to bring it back as it
            was.
          </p>
          <ul>
            <li><strong>What goes:</strong> the agents and their machines, repositories, proposals, sites with their machines and addresses, notes, knowledge pages, Drive and keys.</li>
            <li><strong>What stays:</strong> everyone&rsquo;s account, subscriptions and other workplaces.</li>
          </ul>
        </>
      ),
    },
  ],
  reference: [
    { term: 'Invite link', text: 'Switched off for now. A workplace is for one person; teammates are coming.' },
    { term: 'Here now', text: 'Active in the last three minutes.' },
    { term: 'Last admin', text: 'Cannot leave, be removed or be made a member until another admin exists.' },
    { term: 'New workplace', text: 'Empty until its Chief of Staff brings a team in. You are its admin.' },
    { term: 'Deleting a workplace', text: 'Admins only; type its exact name. Empty: gone at once. Otherwise locked for three days, and after a Keep, asking again waits an hour.' },
    { term: 'What deletion removes', text: 'Everything in the workplace, its agents’ machines and its sites included. Accounts and subscriptions stay.' },
  ],
};

export default chapter;
