/**
 * Replies the reader has not opened yet (note #219): one door per agent,
 * because several finished turns open the same transcript. Every agent's —
 * it was the viewed room's, until rooms left the product (note #843) — and
 * gone when empty.
 *
 * The row's mark is a dot, not a "new" pill (note #271). Under a heading that
 * says UNREAD MESSAGES, the word "new" was telling the reader what every row
 * there already is, in the loudest chip on the card. What the pill really
 * carried was the NUMBER — the thing that collapse into one door would
 * otherwise lose — so the number moves down to the line of facts beside the
 * time, where the row's other words about those replies already live, and the
 * right column keeps only the quiet dot, the mark this app uses for that
 * promise.
 */

import { useNavigate } from 'react-router-dom';
import { toFor } from '../../routes.js';
import { relative } from '../../ui/time.js';
import { groupUnreadConversations, unreadMessagePreview, unreadRepliesWord } from '../../workspace/live.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { AgentFace } from '../../ui/AgentFace.js';
import { AgentName } from '../../ui/AgentName.js';
import { PressableRow } from './PressableRow.js';

export function UnreadMessages() {
  const { agents, notifications } = useWorkspace();
  const navigate = useNavigate();
  const rows = groupUnreadConversations(notifications, agents ?? [], window.location.origin);
  if (rows.length === 0) {
    return (
      <>
        <h2 className="homehead" id="unreadMessagesHead" hidden>Unread messages</h2>
        <div className="card" id="unreadMessages" hidden />
      </>
    );
  }
  return (
    <>
      <h2 className="homehead" id="unreadMessagesHead">Unread messages</h2>
      <div className="card" id="unreadMessages">
        {rows.map(({ agent, count, latestAt }) => {
          const preview = unreadMessagePreview(agent);
          return (
            <PressableRow key={agent.id} className="crow open" onPress={() => navigate(toFor({ kind: 'chat', id: agent.id })!)}>
              <AgentFace agent={agent} />
              <div className="main">
                <div className="name plain"><AgentName agent={agent} /></div>
                <div className="cline">
                  {/* The count is said exactly once: as this line's own words
                      when the newest reply has none to show, and otherwise as
                      a short fact after them. It keeps its width — a number
                      that ellipsises away is not a number. */}
                  <span className="ctext">{preview || unreadRepliesWord(count)}</span>
                  {preview && count > 1 ? <span className="ctext keep">· {count} replies</span> : null}
                  {latestAt ? <span className="cwhen">· {relative(latestAt)}</span> : null}
                </div>
              </div>
              {/* Decoration, so `aria-hidden`; the word the pill used to give a
                  screen reader comes from the line beside it. */}
              <span className="unreaddot" aria-hidden="true" />
              <span className="sr-only">Unread</span>
            </PressableRow>
          );
        })}
      </div>
    </>
  );
}
