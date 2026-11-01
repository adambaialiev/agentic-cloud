import type { DocChapter } from '../model';
import { DocLink, Panel, Ui } from '../model';
import LiveMail from '../../components/LiveMail';
import LiveSettings from '../../components/LiveSettings';
import { LiveMailCompose } from '../../components/LiveForms';

/**
 * Email: the address every person gets, how an agent reads and answers mail
 * for you, and the Mail screen. Facts checked 2026-09-24 against the Mail
 * screens, the Settings "Your address" card, MailApprovalCard, mail-outbox,
 * mail-wake and mail-ingest. Written to src/docs/STYLE.md.
 */
const chapter: DocChapter = {
  slug: 'email',
  title: 'Email',
  description:
    'Your own email address on agenticcloudcomputer.com: how an agent reads and answers mail as you, the inbox, files, waking an agent when mail arrives, and the limits.',
  lead: (
    <>
      Every person here gets an email address of their own, and it is the one the outside world
      writes to. The point of it is that your agents can read what arrives and answer as you,
      but nothing leaves without your tap. This chapter covers handing a message to an agent,
      the address, the inbox, and what happens when mail lands.
    </>
  ),
  sections: [
    {
      id: 'handing-a-message-to-an-agent',
      heading: 'How to have an agent handle a message',
      body: (
        <>
          <p>
            All of your agents can read your mail: the inbox, the archive, Spam,
            Trash, Sent, Starred, and every file a message carries. Open any agent&rsquo;s chat and ask:
            &ldquo;read the message from Dana and draft a reply&rdquo;. The agent reads it and
            tells you what it says and what it means.
          </p>
          <p>
            An agent can only <strong>ask</strong> to send. A card labelled <Ui>Email</Ui> appears
            in its chat with the whole message, every address and every file. Nothing goes out
            until you tap <Ui>Send email</Ui>; typing &ldquo;yes&rdquo; in the chat sends nothing.
            Afterwards the card reads <Ui>Sent</Ui> or <Ui>Not sent</Ui>. A message you approve
            goes out as you, with your name and address, and only your own Mail screen records{' '}
            <Ui>sent by</Ui> the agent.
          </p>
          <p>
            An agent can also archive, trash, mark as spam, block and unblock when you ask, with
            its name recorded on each move. Nothing it moves is deleted. An email cannot instruct
            your agent: whatever a message asks for, the agent acts on what you ask about it. See{' '}
            <DocLink href="/docs/secrets#how-agents-use-it">how agents use keys</DocLink> for why
            a secret never goes into a message.
          </p>
        </>
      ),
      panel: (
        <Panel says="The Mail screen: an unopened message from Dana Whitfield, a reply to Priya Raman marked sent by Ruby, and a message from Harbour Freight carrying two files.">
          <LiveMail />
        </Panel>
      ),
    },
    {
      id: 'your-address',
      heading: 'Your address',
      body: (
        <>
          <p>
            Your address is your own name at <code>agenticcloudcomputer.com</code>, chosen at
            sign-up. You need no outside email account and connect no mail provider. If you signed
            up before addresses existed, choose one in <Ui>Settings</Ui> under <Ui>Your address</Ui>{' '}
            with <Ui>Take this address</Ui>.
          </p>
          <p>
            One address per person, for keeps: it cannot be renamed, and once a name is yours it
            is never issued to anyone else. The mailbox is private to you. No teammate, and no
            teammate&rsquo;s agent, can read it.
          </p>
        </>
      ),
    },
    {
      id: 'reading-and-replying',
      heading: 'Reading and replying',
      body: (
        <>
          <p>
            The <Ui>Workplace</Ui> window on Home has a <Ui>Mail</Ui> row that shows your address, or how many new messages are
            waiting. It opens your inbox: one row per <strong>conversation</strong>, every message
            that answers another, with who it is with and the first line of the newest one. There
            are no notifications for mail, so that row is where you look.
          </p>
          <p>
            Opening a conversation marks it read and shows it oldest first. Your own messages are
            headed <Ui>From you to</Ui> the person, and the quoted copy of an earlier message that
            most replies carry is folded behind <Ui>Show quoted text</Ui>. <Ui>Reply to</Ui> at
            the foot answers the newest message that arrived, <Ui>Reply to all</Ui> answers everyone it named, and{' '}
            <Ui>Add Cc</Ui> adds people. If a reply cannot be sent, your words stay in the box.
          </p>
          <p>
            Where a reply goes is chosen by whoever wrote. Mail carries a reply address that can
            differ from the sender&rsquo;s, and you cannot change it. When it differs, the screen
            spells the full address out so you see it before you press send. Reply is not offered
            on a message in Spam or Trash; bring it back first.
          </p>
        </>
      ),
    },
    {
      id: 'writing-and-forwarding',
      heading: 'Writing and forwarding',
      body: (
        <>
          <p>
            <Ui>Write email</Ui> at the head of the inbox opens a new message from your address.
            Everything sent from here goes out as plain text, with no formatting. A message
            reaches four people at most, and when a sending limit is reached the screen says
            which one and keeps your words.
          </p>
          <p>
            Under every message you received is <Ui>Forward</Ui>. Your words go above the message,
            each file it came with has its own checkbox, so you pass on only what you mean to, and{' '}
            <Ui>Send forward</Ui> sends it. A message in Trash cannot be forwarded.
          </p>
        </>
      ),
      panel: (
        <Panel says="The New message screen: To, Add Cc, Subject, the Message box, Attach files and Send message.">
          <LiveMailCompose />
        </Panel>
      ),
    },
    {
      id: 'waking-an-agent',
      heading: 'How to wake an agent when mail arrives',
      body: (
        <>
          <p>
            By default a message arrives quietly and starts nothing. If you want one agent to read
            new mail as it lands, open <Ui>Settings</Ui>, find <Ui>When mail arrives, wake</Ui>{' '}
            under <Ui>Your address</Ui>, press <Ui>Change</Ui> and pick the agent. <Ui>Nobody</Ui>{' '}
            is the default. One agent at most, and an agent cannot make this choice for you.
          </p>
          <p>
            That agent is then told who wrote, the subject and where a reply would go, reads the
            message itself, and writes to you only if it decides the message needs you. Your chat
            stays quiet otherwise, and the row in Settings names the agent. A burst
            of messages is read in one go, an address wakes an agent at most twelve times an hour, and messages
            in Spam wake nobody. Being woken changes nothing about authority: the agent still does
            what you have asked, never what the message asks.
          </p>
        </>
      ),
      panel: (
        <Panel says="The Settings screen: Your address showing james at the mail domain, with the row naming which agent is woken when mail arrives.">
          <LiveSettings />
        </Panel>
      ),
    },
    {
      id: 'archive-spam-trash',
      heading: 'Archive, Spam and Trash',
      body: (
        <>
          <p>
            <Ui>Archive</Ui> takes a conversation out of the inbox and keeps it whole; a new answer
            brings it back on its own. <Ui>Sent</Ui> is everything that has gone out of your
            address, newest first, replies and approved agent messages included. An archived
            conversation still shows there; only Trash takes it out. Every list has its own search, by who a message was with,
            its subject or its body. A search from the inbox also covers the archive but not Spam or Trash, which
            have their own.
          </p>
          <p>
            <Ui>Spam</Ui> is where a message lands when nothing vouched for its sender, and where a
            blocked sender&rsquo;s messages go. Each row there says why. A message that fails the
            checks proving where it came from is marked forged, and one claiming an address on{' '}
            <code>agenticcloudcomputer.com</code> without proving it always is. <Ui>Not spam</Ui>{' '}
            is the way back to the inbox.
          </p>
          <p>
            <Ui>Move to Trash</Ui> asks no confirmation, because nothing in Trash is ever deleted
            for good; <Ui>Restore</Ui> puts it back. Neither Spam nor Trash empties itself, and no
            button anywhere deletes a message permanently. <Ui>Block</Ui>, at the foot of a
            received message, moves everything from that exact address into Spam. <Ui>Unblock</Ui>{' '}
            stops that for new messages but moves nothing back.
          </p>
        </>
      ),
    },
    {
      id: 'stars-and-older-mail',
      heading: 'Stars and older mail',
      body: (
        <>
          <p>
            Tap the star beside a message to keep it in <Ui>Starred</Ui>. A star moves nothing: the
            message stays in the inbox or the archive, wherever it was. The star on a conversation
            in a list stars the newest message you received in it (or, if nobody has written back,
            the newest one you sent); tapping a lit one takes every star in it off.
            Inside a conversation, each message has its own star. Messages in Spam or Trash leave
            Starred and cannot be starred there; bring one back and its star comes with it. An
            agent can star a message when you ask, and the row then says which agent did.
          </p>
          <p>
            Every list shows its newest messages first. When there is more,{' '}
            <Ui>Show older conversations</Ui> (or <Ui>Show older messages</Ui>) at the foot of the
            list adds the next page under it.
          </p>
        </>
      ),
    },
    {
      id: 'files-and-pictures',
      heading: 'Files and pictures',
      body: (
        <>
          <p>
            A message that came with files lists them under <Ui>Files</Ui>, and each opens or
            downloads from there. You can attach files to a new message, a reply or a forward,
            within the limits below. Files whose names start with a dot, and files that are
            programs, are refused, and the screen says which rule was broken.
          </p>
          <p>
            Pictures that travelled inside a message are shown. Pictures hosted elsewhere wait
            for <Ui>Load pictures</Ui>, because fetching one can tell the sender you opened the
            message. <Ui>Always load pictures from</Ui> an address remembers the choice. Tracking
            pixels are always refused.
          </p>
        </>
      ),
    },
  ],
  reference: [
    {
      term: 'Your address',
      text: <>Your name at <code>agenticcloudcomputer.com</code>. 3 to 32 characters: lowercase letters and digits, with single dots or hyphens between them. Names like support, billing, admin, postmaster and noreply are refused.</>,
    },
    {
      term: 'Where',
      text: <>Home, <Ui>Workplace</Ui>, the <Ui>Mail</Ui> row. The Mail screen has <Ui>Write email</Ui>, a search field, and doors to <Ui>Starred</Ui>, <Ui>Sent</Ui>, <Ui>Archive</Ui>, <Ui>Spam</Ui> and <Ui>Trash</Ui>.</>,
    },
    {
      term: 'Sending limits',
      text: 'Ten new messages an hour and thirty a day, shared between you and your agents; a forward counts as new. Twenty replies an hour.',
    },
    {
      term: 'People per message',
      text: <>Four: one <Ui>To</Ui> and up to three <Ui>Cc</Ui>. No Bcc, no mailing lists.</>,
    },
    {
      term: 'Files',
      text: 'Sending: up to 5 files, 10 MB each, 15 MB together. A message arriving can be up to 25 MB, files included.',
    },
    {
      term: 'When mail arrives, wake',
      text: <>In <Ui>Settings</Ui> under <Ui>Your address</Ui>: <Ui>Nobody</Ui> (the default) or one of your agents. At most twelve wakes an hour; Spam wakes nobody.</>,
    },
    {
      term: 'The agent’s card',
      text: <><Ui>Email</Ui> in the agent&rsquo;s chat, with <Ui>Send email</Ui> and <Ui>Don&rsquo;t send</Ui>. Only your tap sends.</>,
    },
  ],
};

export default chapter;
