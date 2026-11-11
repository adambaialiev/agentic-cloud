import { useState } from 'react';
import type { WorkspaceMarginComment } from '../../backend/src/shared/workspace-api';
import { KnowledgeHtml } from '../../backend/workspace-ui/src/render/KnowledgeHtml';
import { useNoteRefs } from '../../backend/workspace-ui/src/render/useNoteRefs';
import { MarginThread } from '../../backend/workspace-ui/src/screens/decisions/MarginThread';
import { noteSubLine } from '../../backend/workspace-ui/src/screens/notes/note-words';
import { HandRow } from '../../backend/workspace-ui/src/ui/HandRow';
import { useNow } from '../../backend/workspace-ui/src/ui/time';
import { LivePanel, LiveWorkspace } from './live/LiveWorkspace';
import { FACES, MINUTE, NOTE_HANDOFF_FLEET, ago } from './live/fixture';
import { PanelTitle } from './live/PanelTitle';

/**
 * A note, live: the note screen's own pieces — the words through the app's
 * HTML renderer, the line that says who wrote it and when, the row that hands
 * it to one of the workplace's idle agents, and the margin. The fixture is note
 * #7, the one Ruby picked up for the proposal in the section above, before
 * anybody had it: the hand row is the point of this section.
 */

const NOTE = {
  number: 57,
  title: 'Batch route optimiser for the routing service',
  html: '<p>Take a whole day’s stops and the vans on shift, and return every van’s route in one call. Time windows, van capacity and driver breaks are hard constraints. Benchmark it on Monday’s 2,000-stop sample and put the numbers on a page I can show Harbour Freight.</p>',
};

function Panel() {
  const notes = useNoteRefs();
  const now = useNow(false);
  const [updatedAt] = useState(() => ago(9 * MINUTE));
  const [comments] = useState<WorkspaceMarginComment[]>(() => [
    {
      text: '<p>Leo has the pharmacy accounts’ contracts if the time windows are unclear.</p>',
      createdAt: ago(4 * MINUTE),
      byPerson: true,
      userName: 'James',
      authorUserId: 'user_james',
      userPhotoUrl: '/agent-avatars/james.svg',
      self: true,
    },
  ]);
  const line = noteSubLine({ number: NOTE.number, byUser: true, authorName: 'James', updatedAt, work: { state: 'unclaimed' } }, now);
  return (
    <div className="screen" id="screenNote">
      <div className="phead">
        <div className="pname">
          <PanelTitle id="noteTitle" className="clamped">{NOTE.title}</PanelTitle>
        </div>
      </div>
      <div className="sub who" id="noteSub">
        <img className="face" src={FACES.jamesPerson} alt="" />
        <span>{line}</span>
      </div>
      <div id="noteBody">
        {/* No copy button under the words: on the real screen it is a 40px
            row the hand-over section then clears, and on the landing it
            held the request a finger's width away from the row that is the
            point of the section. */}
        <KnowledgeHtml source={NOTE.html} empty="This note is empty." dropTitle={NOTE.title} titleIsFirstLine noteRefs={notes} />
      </div>
      <HandRow ids={{ head: 'noteHandsHead', card: 'noteHandsCard', row: 'noteHands', hint: 'noteHandsHint' }} noun="note" onOpen={() => {}} onDetail={() => {}} />
      <MarginThread
        ids={{ head: 'noteCommentsHead', card: 'noteCommentsCard', box: 'noteComments' }}
        comments={comments}
        canWrite
        path="api/notes/57/comments"
        onPosted={() => {}}
        onSay={() => {}}
      />
    </div>
  );
}

export default function LiveNote({ className = '' }: { className?: string }) {
  return (
    <LivePanel
      size="tile"
      className={`landing-note ${className}`}
      says="Note #57, written by James and not yet claimed: the request for the batch route optimiser in his words, a row offering Ruby, Milo, or Otis the job, and a remark in its margin."
    >
      <LiveWorkspace agents={NOTE_HANDOFF_FLEET}>
        <Panel />
      </LiveWorkspace>
    </LivePanel>
  );
}
