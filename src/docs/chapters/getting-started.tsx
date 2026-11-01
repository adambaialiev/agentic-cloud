import type { DocChapter } from '../model';
import { DocLink, Panel, Ui } from '../model';
import LiveFleet from '../../components/LiveFleet';
import LiveChat from '../../components/LiveChat';
import LiveSettings from '../../components/LiveSettings';
import { LiveFirstGreeting, LiveFirstPlan, LiveFirstSignIn, LiveSignIn, LiveSignUp } from '../../components/LiveSetup';

/**
 * Getting started: from the sign-up form to the first result. Since note
 * #822 (2026-10-28) nothing here invites a stranger to sign up: only the
 * private copy is offered, where an account comes through the installer's
 * one-time link or an approved invite. Facts checked
 * 2026-10-11 against note #726 (Rosa's design, approved by the owner): there
 * is no setup gate any more. A new account lands on Home, the Chief of
 * Staff's chat, which greets the person with three starter answers, asks
 * for their Claude or ChatGPT plan inside the chat once they have said what
 * they are working on, and then brings in only the agents it needs,
 * usually two. A new workplace is empty until then: no four pre-made
 * agents, no "Your team is arriving" and no Continue. Written to
 * src/docs/STYLE.md. Since note #664 (2026-09-25) there is no cloud step: a
 * new workplace runs on the cloud. Since rooms were removed (30–31 Oct
 * 2026, note #843) the Chief of Staff opens no room for the first team.
 */
const chapter: DocChapter = {
  slug: 'getting-started',
  title: 'Getting started',
  description:
    'Create your account, tell your Chief of Staff what you are working on, sign in your Claude or ChatGPT plan, and watch it bring in a team for the work.',
  lead: (
    <>
      All you need is a browser. You create an account and land in a conversation with your Chief
      of Staff. You tell it what you are working on and sign in the Claude or ChatGPT plan your
      agents think with. It brings in the agents the work needs, each on a computer of its own
      on the cloud. The first result arrives in that same
      conversation, a few minutes later. This chapter walks through it, then how to get back in
      tomorrow.
    </>
  ),
  sections: [
    {
      id: 'sign-up',
      heading: 'How to create your account',
      body: (
        <>
          <p>
            Nobody makes an account by just signing up. The first account in{' '}
            <DocLink href="/#give-your-agent">your own Agentic Cloud</DocLink> comes through the one-time
            link its installer prints; everyone after that comes through the workplace&rsquo;s invite link,
            and an admin approves each person. The link opens the sign-up page: type your name,
            choose an address and a password, and press <Ui>Create account</Ui>. You are signed in
            at once. Nothing is emailed to you and there is no link to wait for.
          </p>
          <p>
            The address is a new one, on the platform&rsquo;s own domain. You type only the part
            before the @, and the page tells you as you type whether the name is free. Choose it
            with care: it is the name you sign in with, and it is a real inbox that people can write
            to (see <DocLink href="/docs/email">Email</DocLink>).
          </p>
          <p>
            The first account&rsquo;s workplace is created with it and named after its owner for
            now; everyone invited joins that one. You can{' '}
            <DocLink href="/docs/workplace-and-people#renaming">rename it</DocLink> whenever you like.
          </p>
        </>
      ),
      panel: (
        <Panel says="The sign-up page: Create your Workspace, with the name, address and password fields, and beside it what comes next: a subscription, and nothing else.">
          <LiveSignUp />
        </Panel>
      ),
    },
    {
      id: 'what-you-are-working-on',
      heading: 'How to say what you are working on',
      body: (
        <>
          <p>
            Your Chief of Staff is your own agent across the whole workplace, and Home is its
            conversation. It greets you by name and asks what you are working on. Under the greeting
            are three starter answers to tap: a waitlist page put live for your idea, a review of
            your website, or a team set up for your startup. Tap one, or type your own answer as you
            would brief a person: the outcome, and anything the team should know.
          </p>
          <p>
            A new workplace is empty until this point. There are no agents yet; the Chief of Staff
            brings them in for the work you describe.
          </p>
        </>
      ),
      panel: (
        <Panel size="compact" says="Home, the first time: the Chief of Staff’s greeting and the three starter answers under it.">
          <LiveFirstGreeting />
        </Panel>
      ),
    },
    {
      id: 'sign-in-a-subscription',
      heading: 'How to sign in your plan',
      body: (
        <>
          <p>
            Your agents think with a subscription you already pay for, so the Chief of Staff&rsquo;s
            answer to your first message asks for it. Under its answer is a card with two rows:{' '}
            <Ui>Claude</Ui> for a Claude Pro or Max subscription, <Ui>Codex</Ui> for a ChatGPT Plus
            or Pro subscription. Tap the one you have. You can add the other kind later, and more of
            either. It is the only thing to connect: your agents&rsquo; computers run on the cloud.
          </p>
          <p>
            <strong>Claude</strong>: press <Ui>Open the Claude sign-in</Ui>, approve on Claude&rsquo;s
            own page, and paste the code it gives you into the field. The code is two long strings
            joined by a #, and you paste it whole.
          </p>
          <p>
            <strong>ChatGPT</strong>: copy the code shown on the screen, press{' '}
            <Ui>Open the ChatGPT sign-in</Ui>, enter the code on OpenAI&rsquo;s page and approve. The
            screen notices by itself and takes you back to the conversation.
          </p>
          <p>
            Either way you sign in on the provider&rsquo;s own page, and your password never touches
            the platform. The subscription is yours alone: no teammate or admin can see or use it.
            Anything you write before signing in is kept, and the Chief of Staff starts on all of
            it once the plan is in. What a plan can run and how usage is shown is in{' '}
            <DocLink href="/docs/your-cloud-and-subscriptions#seats">Your subscriptions</DocLink>.
          </p>
        </>
      ),
      panel: (
        <Panel size="compact" says="The sign-in ask under your first message, with the two-row card: Claude or Codex, and where the sign-in happens.">
          <LiveFirstSignIn />
        </Panel>
      ),
    },
    {
      id: 'your-team-arrives',
      heading: 'Your team arrives',
      body: (
        <>
          <p>
            When the plan lands, the conversation says so, then{' '}
            <Ui>Getting your Chief of Staff ready…</Ui> while its own computer is built. That happens
            once and takes between fifteen seconds and a minute. Then it thinks about what you wrote.
          </p>
          <p>
            It brings in only the agents the work needs, usually two, on the plan you signed in.
            Each step appears as a line in the conversation, and then its reply: the plan, with one
            line per agent and what each one is doing. Under the conversation, the{' '}
            <Ui>Arriving</Ui> card shows each agent as its computer is built, which takes a minute
            or two. The agents are named for you, and each joins the workplace&rsquo;s one list
            (see <DocLink href="/docs/agents#one-list">One list of agents</DocLink>).
          </p>
        </>
      ),
      panel: (
        <Panel size="compact" says="The plan: your plan signed in, two agents brought in, the Chief of Staff’s reply, and the Arriving card under it.">
          <LiveFirstPlan />
        </Panel>
      ),
    },
    {
      id: 'the-first-job',
      heading: 'Your first result',
      body: (
        <>
          <p>
            You do not have to watch. The first result arrives in the same conversation: the
            agent&rsquo;s own answer, then the Chief of Staff&rsquo;s line with what is done, a
            link to the page if there is one, a line for each other agent&rsquo;s result, and what it
            can do next. Answer it there, or tap the faces beside the message box and any agent to
            talk to it yourself. From then on everything in this guide applies.
          </p>
          <p>
            Each agent works on its own computer. Close the tab, and when you come back the faces
            beside the message box show which agents have replied. Work that touches protected code or
            a knowledge page comes back as a proposal for you to approve; read{' '}
            <DocLink href="/docs/repositories-and-proposals#the-proposal-loop">The proposal loop</DocLink>{' '}
            when your first one arrives.
          </p>
        </>
      ),
      panel: (
        <Panel size="compact" says="A conversation with an agent later on: the brief, the agent’s reply with what it built, and the proposal card that came back for a decision.">
          <LiveChat />
        </Panel>
      ),
    },
    {
      id: 'home',
      heading: 'Finding your way around Home',
      body: (
        <>
          <p>
            Home stays the Chief of Staff&rsquo;s conversation. Ask it to bring an agent in, hand
            out work or read your mail, and it reports back here.
          </p>
          <p>
            Tap its face or its name at the top to open the <Ui>Workplace</Ui> in a window over the conversation: how many
            agents are working, your mail, your subscriptions, and the shared shelves for
            notes, files, code, knowledge and keys.
          </p>
          <p>
            The faces beside the message box open your agents in one list, with{' '}
            <Ui>Waiting for your decision</Ui> above them once an agent has proposed something. To
            catch up after a day away, ask the Chief of Staff. Your picture at the top right opens Settings and the
            list of people.
          </p>
        </>
      ),
      panel: (
        <Panel says="Your agents: what each one is on, with its latest recap.">
          <LiveFleet size="tile" says="Ruby and Milo, both on Claude Code, mid-job with the time elapsed; Otis, on Codex, ready. Each card carries its latest recap." />
        </Panel>
      ),
    },
    {
      id: 'signing-in-later',
      heading: 'Signing in later',
      body: (
        <>
          <p>
            Open any Workspace address and sign in with the name you chose and your password. The
            bare name works; so does the whole address. With authenticator security on, you are
            asked for the current code next.
          </p>
          <p>
            <Ui>Forgot your password?</Ui> sends a reset link to your recovery email. A new account
            has none until you add one, and without it a forgotten password means a lost account:
            nobody can reset it for you. Add one today, in Settings.
          </p>
        </>
      ),
      panel: (
        <Panel says="The sign-in page: the Email and Password fields, Forgot your password, and Sign in.">
          <LiveSignIn />
        </Panel>
      ),
    },
    {
      id: 'settings-and-security',
      heading: 'Keeping your account safe',
      body: (
        <>
          <p>
            Your picture on Home opens <Ui>Settings</Ui>: your name and picture, your address, and
            the <Ui>Access</Ui> card. Three things there are worth doing on day one.
          </p>
          <ul>
            <li><strong>Add a recovery email.</strong> It is the only way back in after a forgotten password. You confirm it through a link that lasts thirty minutes.</li>
            <li><strong>Turn on authenticator security</strong> if you want a second step at sign-in. Save the recovery codes it shows you; each one replaces the authenticator once, and they are shown only there.</li>
            <li><strong>Check your sessions.</strong> Every signed-in browser is listed, and you can sign any of them out.</li>
          </ul>
          <p>
            The same screen sets which agent, if any, is woken when mail arrives (see{' '}
            <DocLink href="/docs/email#your-address">Your address</DocLink>).
          </p>
        </>
      ),
      panel: (
        <Panel says="The Settings screen: name, picture, your address, and the Access card with password, recovery email, authenticator security and sessions.">
          <LiveSettings />
        </Panel>
      ),
    },
  ],
  reference: [
    { term: 'Sign up', text: 'Through the one-time link the installer prints, for the first account, or through an invite link an admin approves. The first account’s workplace is created with it, and its owner is the admin.' },
    { term: 'Names', text: 'First and last name, up to 64 characters each.' },
    { term: 'Address', text: 'The part before the @, on the platform’s own domain. One per person, and it cannot be changed later.' },
    { term: 'Password', text: 'At least 10 characters, at most 256.' },
    { term: 'Before the first job', text: 'Say what you are working on, then sign in a plan, both in the Chief of Staff’s conversation. There is no cloud to connect.' },
    { term: 'Subscriptions accepted', text: 'Claude Pro or Max, for Claude Code agents. ChatGPT Plus or Pro, for Codex agents.' },
    { term: 'The Chief of Staff’s computer', text: 'Built once, when your plan lands: fifteen seconds to a minute.' },
    { term: 'The first team', text: 'The agents the work needs, usually two, on the plan you signed in. A workplace is empty until then.' },
    { term: 'Password reset link', text: 'Goes to the confirmed recovery email, works once, for thirty minutes, and signs out every browser.' },
    { term: 'Recovery email', text: 'Optional but strongly advised. Confirmed through a link that lasts thirty minutes. An address on the platform’s own domain is refused.' },
    { term: 'Authenticator security', text: 'Optional. Time-based codes from any authenticator app. Recovery codes are shown once; turning it off needs a current code.' },
  ],
};

export default chapter;
