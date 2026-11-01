/**
 * Home's Knowledge glimpse: what the workplace's agents KNOW — the recent
 * few, then the way to all of them.
 *
 * Pages, not files: each one is something a person reads, and every change to
 * one waited for this user's approval first. A GLIMPSE, not the list — six is
 * what a glance holds (the owner, note #48), and the door below carries the
 * rest.
 *
 * A workplace owns a knowledge base before its first page, so an empty one
 * keeps the section and says who fills it (note #175). The section goes only
 * when there is nothing behind it at all: a backend with no knowledge
 * feature, or a legacy workspace with no workplace, where a first page has
 * nowhere to belong. An empty section either of those readers cannot act on
 * would be an advertisement in their own workspace. (It asked whether the
 * reader stood in a ROOM, until rooms left the product — note #843.)
 */

import { useWorkspace } from '../../workspace/useWorkspace.js';
import { KnowledgeDoorRow, KnowledgeEmpty, KnowledgeRow } from '../knowledge/KnowledgeRow.js';
import { KNOWLEDGE_SHOWN } from '../knowledge/knowledge-words.js';

export function Knowledge() {
  const { state } = useWorkspace();
  const pages = state?.knowledge ?? null;
  const show = pages !== null && (pages.length > 0 || Boolean(state?.org));
  if (!show) {
    // Hidden, not absent: the shared stylesheet keys Home's spacing on the
    // chain of siblings, so a section that is not drawn still stands here.
    return (
      <>
        <h2 className="homehead" id="knowledgeHead" hidden>Knowledge</h2>
        <div className="card" id="knowledgeCard" hidden />
      </>
    );
  }
  const shown = pages.slice(0, KNOWLEDGE_SHOWN);
  return (
    <>
      <h2 className="homehead" id="knowledgeHead">Knowledge</h2>
      <div className="card" id="knowledgeCard">
        <div id="knowledge">
          {pages.length === 0
            ? <KnowledgeEmpty />
            : (
              <>
                {shown.map((page) => <KnowledgeRow key={page.name} page={page} />)}
                {pages.length > KNOWLEDGE_SHOWN ? <KnowledgeDoorRow count={pages.length} /> : null}
              </>
            )}
        </div>
      </div>
    </>
  );
}
