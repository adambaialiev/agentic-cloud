import type { DocChapter } from '../model';
import { DocLink, Panel, Ui } from '../model';
import LiveChat, { LivePeerChat } from '../../components/LiveChat';
import { LiveJobs } from '../../components/LiveForms';
import LivePhone from '../../components/LivePhone';
import LiveChief from '../../components/LiveChief';

/**
 * Talking to agents: how to brief one, what a message carries, turns and
 * steering, voice, background jobs, agents writing to each other, handing
 * work over, fresh chats, the cards in a chat and the phone. Facts checked
 * 2026-09-24 against main: work starts by messaging an agent or handing it
 * a note; re-checked 2026-11-06 (note #1011). Same day (note #1020): a chat
 * file has no product cap since note #943, only the protocol's 10,000 parts
 * of 8 MiB, about 78 GB (AGENT_CHAT_FILE_MAX_BYTES); the 95 MB is one
 * request's inline body, which the screen sends around in parts. Recently
 * finished keeps at most 4 jobs from the last day (RECENT_JOB_MAX_SETTLED in
 * the CLI, MANAGED_JOB_RECENT_MAX_ROWS in agent-service.ts). Written to
 * src/docs/STYLE.md. Since rooms were removed (30–31 Oct 2026, note #843) the chat header names only the agent, and unread replies
 * and decisions head the one list of agents behind the faces.
 */
const chapter: DocChapter = {
  slug: 'talking-to-agents',
  title: 'Talking to agents',
  description:
    'How to brief an agent and read what comes back: files and voice, turns and steering, background jobs, agents writing to each other, hand-offs, and the phone.',
  lead: (
    <>
      You talk to an agent the way you would brief a teammate: say what you want, in plain words,
      and read what comes back. The agent works on its own computer while it answers, then waits
      for you. This chapter is the conversation and everything that can happen in it.
    </>
  ),
  sections: [
    {
      id: 'how-to-brief-an-agent',
      heading: 'How to brief an agent',
      body: (
        <>
          <p>
            Tap the faces beside the message box on Home and tap an agent. The header names the
            agent, and its face or name opens the agent&rsquo;s own screen. Write
            the outcome you want and anything the agent should know, attach files if it helps,
            and press <Ui>Send</Ui>.
          </p>
          <p>
            A good brief says what done looks like. &ldquo;Build a page that lists our open roles,
            from the spreadsheet attached&rdquo; gets a page. &ldquo;Look at the careers
            page&rdquo; gets a question back. You can always add to it: a second message while the
            agent works reaches it mid-job (see <DocLink href="/docs/talking-to-agents#turns">Turns</DocLink>).
          </p>
          <p>
            While the agent works, an activity line under the last message shows the step it is
            on, with a round <Ui>Stop</Ui> button beside it. The reply lands in the transcript, and
            anything the Workspace has to tell you, such as a proposal waiting, appears as a small
            card. At a desk, Enter sends and Shift+Enter adds a line. A draft you have not sent
            stays with its conversation.
          </p>
        </>
      ),
      panel: (
        <Panel size="compact" says="A conversation with Ruby: the brief in plain words, her reply with the numbers she measured, the proposal card the Workspace added when she proposed the change, and her acknowledgement of the next brief.">
          <LiveChat />
        </Panel>
      ),
    },
    {
      id: 'your-chief-of-staff',
      heading: 'How to run your fleet through your Chief of Staff',
      body: (
        <>
          <p>
            The first screen of the Workspace is a conversation with your Chief of Staff: one
            agent of your own for the whole workplace. Talk to it when the job is bigger than one
            agent, or when you would rather not pick the agent yourself.
          </p>
          <p>
            Say what you want done. It brings agents in, hands each one its part and
            follows the answers. A line under your message says who it sent work to, with the
            message behind a tap. When a proposal needs your decision, it brings the card here, and
            you approve on the proposal&rsquo;s own screen. It cannot approve anything.
          </p>
          <p>
            It can also start by itself when something needs you. Tap its face or name, open{' '}
            <Ui>Chief of Staff</Ui>, and under <Ui>On its own</Ui> switch on <Ui>Start by itself when something needs you</Ui>. It then
            notices a red build, a proposal still waiting, a report nobody answered, a note nobody
            picked up and new mail. Most of the time it stays quiet. Under{' '}
            <Ui>Without asking, it may</Ui> you choose the few things it may do alone, such as handing
            an unclaimed note to a free agent. Each turn it starts runs on your own plan.
          </p>
        </>
      ),
      panel: (
        <Panel size="compact" says="The Chief of Staff's conversation: a request for Friday's pilot, the work sent to Otis and Ada, two proposals brought back for a decision, and a note it handed to Otis on its own.">
          <LiveChief />
        </Panel>
      ),
    },
    {
      id: 'what-a-message-can-carry',
      heading: 'What a message can carry',
      body: (
        <>
          <p>
            A message is up to 10,000 characters, any number of files, or both, and files alone
            are fine. Each file can be up to about 78 GB, and a big one goes up in parts. Photos
            show inline and open full screen, and videos and recordings play right in the
            conversation. A PDF opens in a viewer, an HTML file opens in a sandbox
            kept apart from the rest of the Workspace, and anything else downloads.
          </p>
          <p>
            Agents send files back the same way. A report, an image or an archive arrives as a
            photo or a document, with a chip to open or download it. Where those files are kept is
            in the <DocLink href="/privacy">Privacy Policy</DocLink>.
          </p>
        </>
      ),
    },
    {
      id: 'turns',
      heading: 'Turns, steering and Stop',
      body: (
        <>
          <p>
            An agent works in <strong>turns</strong>. Your message starts one. The agent reads,
            works, replies, and then stops until you write again, so a reply is always the
            finished result rather than a promise that one is coming. When a job is too big for one
            turn, the agent says what is done and asks you to say <code>continue</code>.
          </p>
          <p>
            You can write while it works. A message sent during a turn <strong>steers</strong> it:
            the agent reads your words mid-job and adjusts. <Ui>Stop</Ui> ends the turn where it
            stands and leaves <Ui>You stopped this turn</Ui> in the transcript.
          </p>
          <p>
            You can close the tab. The computer keeps working. When you come back, the faces beside
            the message box open on <Ui>Unread messages</Ui>, one row for each agent that has
            answered. If an agent uses up its
            subscription&rsquo;s usage window, its card reads <Ui>Session limit</Ui> until the
            window resets, then <Ui>Ready to resume</Ui> with a <Ui>Resume</Ui> button on its
            screen. See <DocLink href="/docs/your-cloud-and-subscriptions#seats">Your subscriptions</DocLink>.
          </p>
        </>
      ),
    },
    {
      id: 'voice',
      heading: 'Voice',
      body: (
        <>
          <p>
            The microphone in the <Ui>Message</Ui> box, labelled <Ui>Dictate</Ui>, opens a recorder
            that shows what you said as text, so you can fix it before sending. The agent gets the words
            rather than the audio, and voice never works for keys, sign-in codes or the name you
            type to confirm a deletion.
          </p>
          <p>
            Voice-to-text is paid by your workplace&rsquo;s own OpenRouter key. Until an admin{' '}
            <DocLink href="/docs/your-cloud-and-subscriptions#voice-to-text">turns it on</DocLink>,
            the microphone says it is not set up yet and records nothing.
          </p>
          <p>
            Your Chief of Staff can also talk back. Once voice-to-text is on, a speaker stands in its
            header: tap it and each new <Ui>Recap</Ui> under its replies is read aloud once, and a play
            button beside the recap replays it. On or off is remembered on each device. The recap&rsquo;s
            words go to OpenRouter on the same key, up to about a cent a recap. An admin chooses the
            voice on the Workplace screen, under <Ui>Reading recaps aloud</Ui>, from the speech models
            OpenRouter offers, each with its price a recap and a <Ui>Play sample</Ui> button.
          </p>
        </>
      ),
    },
    {
      id: 'background-jobs',
      heading: 'Background jobs',
      body: (
        <>
          <p>
            Some work outlives a reply: a build, a download, a migration, a long analysis. The
            agent runs it as a <strong>background job</strong> on its own computer, replies to you,
            and the job carries on. While one runs, a pill on the agent&rsquo;s card and under the
            chat header reads <Ui>2 background jobs</Ui> and opens the <Ui>Background jobs</Ui>{' '}
            screen.
          </p>
          <p>
            Each running job shows its command, how long it has run and when it started. Under{' '}
            <Ui>Recently finished</Ui>, a job ends as <Ui>Finished</Ui>, <Ui>Failed</Ui>,{' '}
            <Ui>Timed out</Ui>, <Ui>Stopped by the agent</Ui> or <Ui>Interrupted by a restart</Ui>,
            and stays listed for a day. The list keeps the four that ended most recently. Opening
            the screen never wakes the machine. When the job finishes, the agent tells you in its
            chat.
          </p>
        </>
      ),
      panel: (
        <Panel says="Ruby’s Background jobs screen: one job running for four minutes, a benchmark, and under Recently finished a build that finished and a replay that timed out.">
          <LiveJobs />
        </Panel>
      ),
    },
    {
      id: 'agents-messaging-each-other',
      heading: 'Agents messaging each other',
      body: (
        <>
          <p>
            Your agents can write to one another, and you see it happen. When one agent needs
            another, its message lands in the other&rsquo;s conversation, shown with the
            sender&rsquo;s face and name, and the answer appears there too. Ask any agent to check
            something with a sibling by name.
          </p>
          <p>
            A message reaches an agent only while it is idle. A busy one refuses it, nothing is
            queued, and the sender carries on or tells you. A hand-off between agents carries
            words: instructions and context. Code travels by pushing to a repository first and
            sending the branch name (see{' '}
            <DocLink href="/docs/repositories-and-proposals">Repositories and proposals</DocLink>).
          </p>
        </>
      ),
      panel: (
        <Panel size="compact" says="Milo’s conversation: your brief, his report, then a message from Ruby asking whether billing should count a van’s return leg, shown with her face, and his answer to her.">
          <LivePeerChat />
        </Panel>
      ),
    },
    {
      id: 'handing-work-over',
      heading: 'Handing work over',
      body: (
        <>
          <p>
            Work often starts from a note, a knowledge page or a proposal rather than from a chat.
            Each has a row of agent cards headed <Ui>Hand it to an agent</Ui> (on a proposal,{' '}
            <Ui>Ask for review</Ui>). Tap a card and a Send screen opens with the <Ui>Message</Ui>{' '}
            box filled in with what you are handing over. Change or add to it, then press{' '}
            <Ui>Send</Ui>, and the Workspace confirms that the agent is on it and that the answer
            lands in its chat.
          </p>
          <p>
            A handed note changes state to <Ui>Handed to ‹name›</Ui>, then <Ui>Working by ‹name›</Ui>{' '}
            once the agent picks it up, and follows any proposal through <Ui>PR #‹n›</Ui>,{' '}
            <Ui>Merged</Ui> and <Ui>Live</Ui>. If every agent is busy, the row says so
            and comes back when one is free. See{' '}
            <DocLink href="/docs/notes-knowledge-drive#notes">Notes</DocLink>.
          </p>
        </>
      ),
    },
    {
      id: 'a-fresh-chat',
      heading: 'A fresh chat',
      body: (
        <>
          <p>
            A long conversation carries every dead end into every new turn, and the context ring
            around the agent&rsquo;s face shows it filling. When a job is done and the next is
            unrelated, ask for a fresh chat in your own words, or tap{' '}
            <Ui>Ask agent to reset chat</Ui> on the agent&rsquo;s screen.
          </p>
          <p>
            To clear several at once, use <Ui>Reset 2 finished agents</Ui> under your agents&rsquo;
            cards. It appears only while some of them are idle with their work finished and
            nothing waiting on them: no proposal, background job, held note or reply still due.
            It names them before it asks, and anyone who started working in the meantime is left
            alone.
          </p>
          <p>
            The agent saves what must survive to its own notes, resets, and says so. You see a
            divider in the transcript and the ring empties. Its lifetime totals, its machine and
            everything on it stay. An agent may also start fresh on its own when a conversation
            has grown heavy, and it tells you in the same reply. When it resets mid-task, the new
            conversation opens with a <Ui>Fresh chat</Ui> card such as{' '}
            <Ui>Picking up saved work</Ui>.
          </p>
        </>
      ),
    },
    {
      id: 'notices',
      heading: 'Cards in the chat',
      body: (
        <>
          <p>
            The Workspace adds a small card to the conversation when something outside the chat
            needs you or has changed: a proposal awaiting your decision, an email the agent drafted
            from your address with <Ui>Send email</Ui> and <Ui>Don&rsquo;t send</Ui>, or the outcome
            of a decision you made. Each card waits in the conversation, and a proposal that needs
            you also appears under <Ui>Waiting for your decision</Ui> at the top of your agents.
          </p>
        </>
      ),
    },
    {
      id: 'on-a-phone',
      heading: 'On a phone',
      body: (
        <>
          <p>
            The Workspace is one web app, and the same app runs in a phone&rsquo;s browser with
            nothing to install. Sign in there and every conversation, note and decision is the one
            you left at your desk.
          </p>
          <p>
            The chat is built for a thumb. After you send, the keyboard goes away so the reply has
            room. Enter makes a new line and only the <Ui>Send</Ui> arrow sends. The microphone
            opens a full-screen recorder, so a brief can be spoken and checked before it goes. Put
            the phone away, and the reply is waiting when you open it again.
          </p>
        </>
      ),
      panel: (
        <Panel size="compact" says="The Workspace conversation on a phone, open in its browser: the same chat, with the compose bar and the microphone at the bottom.">
          <LivePhone />
        </Panel>
      ),
    },
  ],
  reference: [
    { term: 'Message length', text: 'Up to 10,000 characters. A counter appears as you near the limit.' },
    { term: 'Files in a message', text: 'Any number, each up to about 78 GB, with or without words. A big file goes up in parts.' },
    { term: 'Keyboard', text: 'At a desk, Enter sends and Shift+Enter adds a line. On a touch keyboard Enter adds a line and only Send sends.' },
    { term: 'Voice', text: 'Up to 90 seconds per recording. The words are shown for review before anything is sent.' },
    { term: 'History shown', text: 'The last 500 messages of each conversation.' },
    { term: 'Background jobs', text: <>On the agent’s <Ui>Background jobs</Ui> screen while running, and for a day after they end. At most the 4 most recently ended are listed.</> },
    { term: 'Agent to agent', text: 'Delivered only to an idle agent. A busy one refuses, and nothing is queued.' },
    { term: 'Where replies wait', text: <>In the conversation. The faces beside the message box show <Ui>Unread messages</Ui> per agent.</> },
  ],
};

export default chapter;
