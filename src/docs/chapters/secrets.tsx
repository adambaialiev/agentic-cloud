import type { DocChapter } from '../model';
import { DocLink, Panel, Ui } from '../model';
import { LiveSecrets } from '../../components/LiveSurfaces';
import { LiveAddSecret } from '../../components/LiveForms';

/**
 * Secrets: how to give an agent a key, who sees it, whose agents receive it.
 * Facts checked 2026-09-24 against the Secrets screens and
 * backend/src/services/user-secrets.ts. Written to src/docs/STYLE.md.
 * Since rooms were removed (30–31 Oct 2026, note #843) a shared key is the
 * whole workplace's: admins' agents only or every agent, or one agent's
 * own. "A key belongs to a room" became "Keeping a key apart".
 */
const chapter: DocChapter = {
  slug: 'secrets',
  title: 'Secrets',
  description:
    'How to give your agents an API key or token without pasting it into a chat, who can see a key, whose agents receive it, and the limits.',
  lead: (
    <>
      Real work needs keys: a GitHub token, an OpenAI key, a deploy password. You save each one
      once, for the whole workplace or for one of your agents. The value goes straight into
      storage, nothing shows it again, and every agent allowed to use it has it from its next turn.
    </>
  ),
  sections: [
    {
      id: 'giving-a-key',
      heading: 'How to give an agent a key',
      body: (
        <>
          <p>
            Never paste a key into a chat: anything typed there stays in the conversation. The
            form is the only way in.
          </p>
          <ol>
            <li>On Home, tap the Chief of Staff&rsquo;s face or name at the top to open <Ui>Workplace</Ui>, and find <Ui>Secrets</Ui>.</li>
            <li>
              Press <Ui>Add a secret</Ui>. A member sees{' '}
              <Ui>Add a secret for one of your agents</Ui> instead, and the key stays private to
              the agent they pick.
            </li>
            <li>
              Give it the name the tool expects, such as <code>GH_TOKEN</code>, and paste the
              value whole. A key with several lines, such as an SSH key, survives the paste box.
            </li>
            <li>
              As an admin, choose <Ui>Whose agents get it</Ui>: <Ui>Admins&rsquo; agents only</Ui>{' '}
              is the default, or <Ui>Every agent in the workplace</Ui>.
            </li>
            <li>Press <Ui>Save for the workplace</Ui>, or <Ui>Save for</Ui> the agent you chose.</li>
          </ol>
          <p>
            Saving a name that already exists replaces the value. It does not add a second key,
            and it keeps who the key reaches.
          </p>
        </>
      ),
      panel: (
        <Panel says="The Add a secret screen, as an admin sees it: the Name field with GH_TOKEN, the Value box, whose agents get it, and Save for the workplace.">
          <LiveAddSecret />
        </Panel>
      ),
    },
    {
      id: 'who-sees-what',
      heading: 'Who can see and use a key',
      body: (
        <>
          <p>
            Only a workplace admin can add a key for the workplace, copy its value, replace it or
            delete it. Members see each shared key&rsquo;s name, what it is for, a masked preview
            and when it last changed. Nobody sees the value again except through{' '}
            <Ui>Copy the value</Ui> on the key&rsquo;s screen, which puts it on your clipboard.
          </p>
          <p>
            A shared key also says whose agents receive it. By default that is admins&rsquo;
            agents only: members see the key in the list, but their agents are never handed the
            value. An admin opens it to every agent with <Ui>Open to everyone</Ui> on the
            key&rsquo;s screen, and closes it again with <Ui>Admins only</Ui>. The screen lists the
            agents it reaches by name.
          </p>
          <p>
            A private key is invisible to everyone but its owner, admins included. Deleting the
            agent deletes its private keys too. Every key carries a line on{' '}
            <Ui>What it&rsquo;s for</Ui>, written by the first agent to use it and editable by
            anyone who can manage the key.
          </p>
        </>
      ),
      panel: (
        <Panel says="The Secrets section in Workplace: four shared keys, each with its name, the line saying what it is for and never its value, and the row that adds another.">
          <LiveSecrets />
        </Panel>
      ),
    },
    {
      id: 'how-agents-use-it',
      heading: 'How an agent uses a key',
      body: (
        <>
          <p>
            When an agent starts a turn, every key it is allowed to have is placed in its
            environment under the key&rsquo;s name. The command that needs the value reads it
            there. A key you save or change reaches the agent on its <strong>next</strong> turn,
            not the one already running.
          </p>
          <p>
            The value is stripped out of the agent&rsquo;s stored transcript, its activity line
            and its error output. That is a strong safeguard and not a guarantee: an agent has a
            full shell and can read its own environment.
          </p>
          <p>
            An agent can also save a key a tool just issued it, saying what it is for. Only an
            admin&rsquo;s agent can create or change a key shared by the workplace.
          </p>
        </>
      ),
    },
    {
      id: 'keeping-keys-apart',
      heading: 'Keeping a key apart',
      body: (
        <>
          <p>
            A shared key belongs to the whole workplace, like its repositories, sites, knowledge
            pages and Drive. There are three ways to narrow who gets one. Leave it on{' '}
            <Ui>Admins&rsquo; agents only</Ui>, save it for one of your agents, or put the work that
            needs it in a workplace of its own.
          </p>
          <p>
            A separate workplace is the way to keep a client&rsquo;s or another company&rsquo;s keys
            away from everything else, because no key reaches across workplaces. See{' '}
            <DocLink href="/docs/workplace-and-people#one-workplace">One workplace, one place</DocLink>.
          </p>
        </>
      ),
    },
    {
      id: 'checks-and-sites',
      heading: 'Keys for checks and for sites',
      body: (
        <>
          <p>
            A repository&rsquo;s checks can use the workplace&rsquo;s shared keys, for example a deploy
            token. An admin&rsquo;s agent hands one over and tells you in its chat; the
            repository&rsquo;s screen lists it under <Ui>Keys for checks</Ui>, and any agent can
            take it back. Only checks on the protected branch receive the key, and the value is
            masked out of any log. Private keys never reach checks. See{' '}
            <DocLink href="/docs/repositories-and-proposals#ci-secrets">Keys for checks</DocLink>.
          </p>
          <p>
            An always-on app can use keys too, for example a chat bot&rsquo;s token. Ask your
            agent to deploy it with the key it needs. The running app gets the key directly, and
            the key is never written into its files. An agent can only pass on a key it has itself.
            If you change a key here, the app gets the new one at its next deploy. A plain website
            of files never gets a key.
          </p>
        </>
      ),
    },
  ],
  reference: [
    {
      term: 'Where',
      text: <>Home, <Ui>Workplace</Ui>, <Ui>Secrets</Ui>. With six or more keys, one <Ui>secrets</Ui> row opens the full list with a search field.</>,
    },
    {
      term: 'Name',
      text: 'Up to 64 characters: letters, digits and underscores, not starting with a digit. Reserved names such as PATH, HOME or ANTHROPIC_API_KEY are refused.',
    },
    { term: 'Value', text: 'Up to 8 KB. Multi-line values are kept as pasted.' },
    { term: 'What it’s for', text: 'Up to 200 characters, one line. Editing it does not count as a change to the key.' },
    { term: 'How many', text: 'Up to 96 secrets a workplace, private ones included. At the limit you can replace a value but not add a name.' },
    {
      term: 'Whose agents get it',
      text: <><Ui>Admins&rsquo; agents only</Ui> (the default) or <Ui>Every agent in the workplace</Ui>. Changed by an admin on the key&rsquo;s screen. A private key reaches its one agent only.</>,
    },
    { term: 'Last changed', text: 'Shown on every key. There is no “last used” time: nothing about a key is recorded when an agent reads it.' },
    { term: 'Deleting a key', text: <><Ui>Delete this secret</Ui> on the key&rsquo;s screen asks once and is final. The key stops reaching agents from their next turn.</> },
    { term: 'At rest', text: <>Values are encrypted in storage; names and descriptions are not. See the <DocLink href="/privacy">Privacy Policy</DocLink>.</> },
  ],
};

export default chapter;
