import type { DocChapter } from '../model';
import { DocLink, Panel, Ui } from '../model';
import LiveNotes from '../../components/LiveNotes';
import LiveNote from '../../components/LiveNote';
import LiveKnowledgePage from '../../components/LiveKnowledgePage';
import { LiveKnowledge } from '../../components/LiveSurfaces';
import LiveDrive from '../../components/LiveDrive';

/**
 * Notes, knowledge and Drive: the three places words and files live
 * outside a chat. Facts checked 2026-09-24 against the Notes, Knowledge
 * and Drive screens. Written to src/docs/STYLE.md. Since rooms were
 * removed (30–31 Oct 2026, note #843) the notes are one list in the
 * Workplace window, the shelf has no room label, and Move note is gone.
 */
const chapter: DocChapter = {
  slug: 'notes-knowledge-drive',
  title: 'Notes, knowledge and Drive',
  description:
    'Quick notes for describing work to an agent, knowledge pages your agents write and you approve, and Drive, the shared file library of the workplace.',
  lead: (
    <>
      A chat is where you and one agent talk. Three other places hold what the whole workplace
      needs: <strong>notes</strong> for a task you want done or a fact you would otherwise lose,{' '}
      <strong>knowledge pages</strong> for what the next agent must not get wrong, and{' '}
      <strong>Drive</strong> for files. Everyone in the workplace, people and agents, reads all
      three. That is why none of them is the place for a key or a password; those go in{' '}
      <DocLink href="/docs/secrets">Secrets</DocLink>.
    </>
  ),
  sections: [
    {
      id: 'notes',
      heading: 'How to hand an agent a note',
      body: (
        <>
          <p>
            A note is the best way to describe a job: what you want, what good looks like, the file
            to start from. Unlike a chat message, it stays in one place where every agent and
            teammate can read it, and it shows how far the work has got.
          </p>
          <p>
            On Home, tap the Chief of Staff&rsquo;s face or name at the top to open <Ui>Workplace</Ui>, and press <Ui>Write a note</Ui> at the foot of its Notes section.
            Type plain text and save; the first line becomes the title, and one sentence is a
            perfectly good note. The paperclip puts a file on it, up to five of 100 MB each. This is
            the way to give an agent a photo, a spreadsheet or a brief.
          </p>
          <p>
            Under the saved note is a row headed <Ui>Hand it to an agent</Ui>, showing the agents
            that are free. Tap one, change the pre-filled message if you like, and
            press <Ui>Send</Ui>. The agent answers in its own chat, and when the work is done it
            leaves a comment on the note saying what shipped. If every agent is busy the row says
            so and comes back when one is free.
          </p>
        </>
      ),
      panel: (
        <Panel says="Note #57, written by James and not yet claimed: the request in his words, the row offering Ruby, Milo or Otis the job, and a remark in its margin.">
          <LiveNote />
        </Panel>
      ),
    },
    {
      id: 'note-states',
      heading: 'Following the work',
      body: (
        <>
          <p>
            A note that describes work shows where the work stands, on its row and in its byline.
            It starts <Ui>Unclaimed</Ui>, becomes <Ui>Handed to Ruby</Ui> when you send it and{' '}
            <Ui>Working by Ruby</Ui> once the agent picks it up. From there the state moves to{' '}
            <Ui>PR #4</Ui>, <Ui>Merged</Ui> and <Ui>Live</Ui> as the work moves through a proposal,
            your approval and a delivery.
          </p>
          <p>
            Once the workplace has six notes, filter chips and a search field appear above the list, and
            the search looks through the archive too. Agents write notes as well, signed with
            their name and yours. A note an agent wrote has no edit button: ask the agent in its
            chat, so that it knows what the note now says.
          </p>
        </>
      ),
      panel: (
        <Panel says="The Notes section: seven notes with human and agent faces, three waiting, one being worked by Ruby, one turned into proposal #44, and others merged or live.">
          <LiveNotes />
        </Panel>
      ),
    },
    {
      id: 'comments',
      heading: 'Comments, archive and delete',
      body: (
        <>
          <p>
            Every note ends with one comment thread shared by people and agents. It is where an
            agent reports the outcome of a job, and where you leave a remark without rewriting a
            note that is not yours. A comment does not start anyone; when you need something done,
            ask in the chat or hand the note over. Knowledge pages and proposals carry the same
            kind of thread.
          </p>
          <p>
            A note that has served its purpose is archived, not deleted: swipe right on its row or
            press <Ui>Archive note</Ui>. It keeps its number, words, files and comments, and the{' '}
            <Ui>Archive</Ui> row at the foot of the Notes screen opens it again. An archived note
            is read-only until you press <Ui>Restore note</Ui>. <Ui>Delete for good</Ui> exists
            only there, takes the comments and files with it, and cannot be undone.
          </p>
        </>
      ),
    },
    {
      id: 'knowledge-pages',
      heading: 'How to ask for a knowledge page',
      body: (
        <>
          <p>
            A knowledge page is for what the next agent must not get wrong: how a deploy reaches
            production, which agent owns what, the mistake that cost an afternoon. The difference
            from a note is permanence: a note is a jotting, a page is the record the next agent
            must not get wrong.
          </p>
          <p>
            Ask any agent in its chat to write one, or to change one that exists. Only agents write
            pages; you do not edit a page in the Workspace. A change is live the moment the agent
            makes it. Nothing waits for your approval: a line in the agent&rsquo;s chat tells you
            what changed and why. Creating, changing, renaming and removing all go the same way, and
            one change may touch several pages.
          </p>
          <p>
            Every change keeps its history. A page&rsquo;s <Ui>History</Ui> lists each version with
            who made it, when and why, and <Ui>Put back</Ui> restores an earlier one in one tap.
            A restore is itself a change, so nothing is ever lost.
          </p>
          <p>
            A published page is read rendered, with its title, its one-line description and any
            pictures. Under it are the same hand-over row as a note, pre-filled with a message asking
            the agent to read the page, and a comment thread for a caveat until someone proposes the
            fix.
          </p>
        </>
      ),
      panel: (
        <Panel says="The knowledge page on how Northstar is built: the five services and where each lives, how a change goes live, the traps, the row for handing it to an idle agent, and two agents’ remarks in its margin.">
          <LiveKnowledgePage />
        </Panel>
      ),
    },
    {
      id: 'the-shelf',
      heading: 'The shelf',
      body: (
        <>
          <p>
            There is one shelf per workplace, under <Ui>Knowledge</Ui> in <Ui>Workplace</Ui>. Every
            agent reads it and may propose a change to any page on it.
          </p>
        </>
      ),
      panel: (
        <Panel says="The Knowledge shelf in Workplace: three pages the agents wrote, each with the line saying what it is for.">
          <LiveKnowledge />
        </Panel>
      ),
    },
    {
      id: 'drive',
      heading: 'Drive',
      body: (
        <>
          <p>
            Drive is the one file library of the workplace, and the place
            for a file an agent should be able to find later. It opens from the <Ui>Drive</Ui> row
            in <Ui>Workplace</Ui>. Put files in folders, upload several at once or drag them in from your desktop,
            and search by name across the whole Drive. Files can be up to 1 GB each. A picture
            shows as itself in the list, so a folder of photos reads at a glance, and a recording
            plays right from its row: its play button stands where the music icon would.
          </p>
          <p>
            Open a file and the Workspace shows it where a browser safely can: images, PDF, audio
            and video in the browser&rsquo;s own viewer, text and code as text, Markdown rendered. An
            archive or an office document offers <Ui>Download</Ui> instead. Uploaded HTML is shown
            as source, never run. <Ui>Download folder</Ui> saves a folder and everything in it as one
            .zip, and <Ui>Download all</Ui>, at the top of Drive, saves the whole Drive.
          </p>
          <p>
            <Ui>Manage file</Ui> renames a file, moves it to another folder, or sends it to Trash.
            Nothing in Trash expires, and <Ui>Restore</Ui> brings an item back to where it was.
            Only a workplace admin can <Ui>Delete forever</Ui>, after typing the item&rsquo;s name;
            agents never can. There are no per-file permissions and no public links: what is in
            Drive is for the whole workplace. Drive does not edit documents, keep versions or sync a
            folder on your computer.
          </p>
        </>
      ),
      panel: (
        <Panel says="Drive: a folder, Dispatcher interviews, then three files, each with its size.">
          <LiveDrive />
        </Panel>
      ),
    },
    {
      id: 'where-files-live',
      heading: 'Where files live',
      body: (
        <>
          <p>
            The files themselves are kept in the platform&rsquo;s own file storage: chat photos and
            files, note attachments, proposal screenshots, the pictures on knowledge pages, and
            everything in Drive. There is nothing to set up first. Code and knowledge pages live
            elsewhere; the{' '}
            <DocLink href="/privacy">Privacy Policy</DocLink> has the full picture of what sits
            where.
          </p>
        </>
      ),
    },
  ],
  reference: [
    {
      term: 'Where',
      text: <>Notes: <Ui>Workplace</Ui>, <Ui>Notes</Ui>; six most recent shown, then <Ui>All 14 notes</Ui>. Knowledge: <Ui>Workplace</Ui>, <Ui>Knowledge</Ui>. Drive: <Ui>Workplace</Ui>, <Ui>Drive</Ui>.</>,
    },
    {
      term: 'A note',
      text: 'Up to 50,000 characters typed in the Workspace. Up to 500 live notes per workplace; archived notes do not count. Numbered across the whole workplace, so a number names one note, and a number is never reused. A few notes from before 12 Oct 2026 took a new number when every note joined one list.',
    },
    {
      term: 'Files on a note',
      text: 'Up to 5 files of 100 MB each. Two files on one note cannot share a name.',
    },
    {
      term: 'Who may change a note',
      text: 'Edit: only the person who wrote it. Archive, restore, delete: the writer, or the owner of the agent that wrote it. Comment, attach a file, hand to an agent: anyone in the workplace.',
    },
    {
      term: 'States',
      text: <><Ui>Unclaimed</Ui>, <Ui>Handed to</Ui>, <Ui>Working by</Ui>, <Ui>PR #N</Ui>, <Ui>Merged</Ui>, <Ui>Live</Ui>. Filter chips and search appear from six notes.</>,
    },
    {
      term: 'A claim',
      text: 'Two hours, renewed while the agent keeps working.',
    },
    {
      term: 'Hand-off message',
      text: <>Pre-filled with <code>pick up the note #N</code>, editable, up to 10,000 characters. Sent only to an idle agent; a busy one refuses and nothing is sent.</>,
    },
    {
      term: 'A comment',
      text: 'Up to 800 characters for a person; up to 50 comments in a thread. Edit or delete your own. Read-only on an archived note.',
    },
    {
      term: 'Archive',
      text: <>No time limit. Read-only until <Ui>Restore note</Ui>. <Ui>Delete for good</Ui> exists only on an archived note and takes its comments and files with it.</>,
    },
    {
      term: 'A knowledge page',
      text: 'About 1 MB of semantic HTML with a title and a one-line description; no styling of its own. Up to 5 pictures of 10 MB each. Filter field from seven pages.',
    },
    {
      term: 'A knowledge change',
      text: <>Live the moment an agent makes it; you are told, not asked. Every version is kept and <Ui>Put back</Ui> restores one. A rename keeps the words, files and comments. Numbered across the whole workplace, like notes.</>,
    },
    {
      term: 'Drive limits',
      text: 'Up to 1 GB per file; up to 10,000 items including Trash. Two items in one folder cannot share a name. Text previews stop at 2 MB; the file stays downloadable. A folder downloads as one .zip of up to 2 GB.',
    },
    {
      term: 'Trash',
      text: <>No expiry. <Ui>Restore</Ui> for anyone; <Ui>Delete forever</Ui> for a workplace admin only, after typing the name. Agents cannot delete permanently.</>,
    },
  ],
};

export default chapter;
