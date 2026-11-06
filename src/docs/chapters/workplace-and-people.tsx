import type { DocChapter } from '../model';
import { DocLink, Panel, Ui } from '../model';
import LiveFleet from '../../components/LiveFleet';
import { HERO_FLEET } from '../../components/live/fixture';

/**
 * Workplace and people: teammates (switched off since 2026-10-11, owner's
 * decision — RouteDeps.invitesClosed), the two roles, the People page
 * (back wherever a workplace has a team, with each person's agents and
 * what they are doing, 2026-10-28; since note #1009 the card shows their
 * agents as faces and the person's screen one line each),
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
 * Re-checked 2026-11-06 (note #1011): since note #822 the offer is your own
 * Agentic Cloud, where invites are on in every workplace (note #808), so the
 * chapter leads with inviting and says once that a workplace on our own
 * platform is for one person. Teammates see each agent's one-line recap
 * (2026-10-28, PR #1458). The hosted Cloud card panel went: note #668 keeps
 * that card off Workplace settings.
 */
const chapter: DocChapter = {
  slug: 'workplace-and-people',
  title: 'Workplace and people',
  description:
    'How people join a workplace, what each role may do, what a workplace holds, why agents stay personal, and how a workplace is renamed or deleted.',
  lead: (
    <>
      A workplace is the place your work lives: its agents and notes, its code, knowledge,
      sites and files. You can have as many as you like. This chapter is the people side of one:
      how people join, what each role may do, and what happens when a workplace is renamed, left
      or deleted.
    </>
  ),
  sections: [
    {
      id: 'inviting-people',
      heading: 'How to invite people',
      body: (
        <>
          <p>
            In <DocLink href="/#give-your-agent">your own Agentic Cloud</DocLink>, people join by
            invite. An admin taps the workplace&rsquo;s name at the top of Home, chooses{' '}
            <Ui>Invite to this workplace</Ui> and shares the link there. A workplace has one link,
            and it works until an admin revokes it.
          </p>
          <p>
            Whoever opens the link creates their account on the same page. Their request waits
            under <Ui>Join requests</Ui> in Workplace settings until an admin presses{' '}
            <Ui>Approve</Ui>, and that workplace is then their way in. Each person gets their own
            agents, their own subscription and their own conversations, and shares everything else
            with you.
          </p>
          <p>
            A workplace on agenticcloudcomputer.com itself is for one person for now. Inviting is
            switched off there, and an invite link made earlier opens on a page that says invites
            are closed.
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
            In a workplace nobody else can join, you are its admin and the Workspace does not
            show roles at all: no <Ui>Admin</Ui> badge, no head count. In your own Agentic Cloud
            every workplace can take people, so roles always show.
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
            <li>grow the workplace&rsquo;s code storage;</li>
            <li>in your own Agentic Cloud, set up email and open <Ui>This copy</Ui>, its health page.</li>
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
            Everyone can see that every agent exists: its name, its face, who drives it, whether
            it is working and the one line on its latest work. The chat behind that line stays
            with its owner.
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
            Wherever a workplace has a team &mdash; more than one person in it, or invites open,
            as in every workplace of your own Agentic Cloud &mdash; its people stand first in the <Ui>Workplace</Ui> window, in place of the agent
            counts, and on the People page, which the account menu&rsquo;s <Ui>People</Ui> row
            opens. Each person is one card: whether they are here now or when they were last
            active, the last thing they themselves did, what their agents did here this week, and
            the face and name of each agent they drive, with a blue dot on the ones working. Tap
            an agent to open its page; tap the rest of the card for the person.
          </p>
          <p>
            Each person&rsquo;s own screen says the same last thing they did, then their week and
            all time, the changes their agents merged this week, and every agent they drive with
            one line on its latest work &mdash; the same line its owner sees. Nobody else ever
            sees the words of your chat with an agent, only that line. Last come when they joined,
            who invited them and their email and, for an admin, <Ui>Make admin</Ui> and{' '}
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
            then, for an admin where people can join, <Ui>Invite to this workplace</Ui>, then{' '}
            <Ui>Workplace settings</Ui> and <Ui>New workplace</Ui>. Switching changes only what you are looking at. Every agent,
            repository, note and key stays in the workplace it was made in.
          </p>
          <p>
            <Ui>Workplace settings</Ui> is the workplace&rsquo;s own page: its people, its cloud,
            its code storage and backups, and for admins of your own Agentic Cloud,{' '}
            <Ui>This copy</Ui>. At the foot, admins
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
    { term: 'Invite link', text: <>One per workplace, from <Ui>Invite to this workplace</Ui> (admins). An admin approves each request. Switched off for now in a workplace on agenticcloudcomputer.com itself.</> },
    { term: 'Here now', text: 'Active in the last three minutes.' },
    { term: 'Last admin', text: 'Cannot leave, be removed or be made a member until another admin exists.' },
    { term: 'New workplace', text: 'Empty until its Chief of Staff brings a team in. You are its admin.' },
    { term: 'Deleting a workplace', text: 'Admins only; type its exact name. Empty: gone at once. Otherwise locked for three days, and after a Keep, asking again waits an hour.' },
    { term: 'What deletion removes', text: 'Everything in the workplace, its agents’ machines and its sites included. Accounts and subscriptions stay.' },
  ],
};

export default chapter;
