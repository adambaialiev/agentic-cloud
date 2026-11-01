/**
 * One knowledge page as a row, and the door onto the rest of them. Home draws
 * the recent few and the Knowledge screen draws them all, from this same row
 * — so the two lists cannot drift apart, and the browser entry records which
 * of them the tap came from.
 */

import { useNavigate } from 'react-router-dom';
import type { WorkspaceKnowledgePageRow } from '../../../../src/shared/workspace-api.js';
import { toFor } from '../../routes.js';
import { AgentLine } from '../../ui/AgentLine.js';
import { EmptyState } from '../../ui/EmptyState.js';
import { Icon, TypeIcon } from '../../ui/icons.js';
import { relative } from '../../ui/time.js';
import { useOrgScope } from '../../workspace/useWorkspace.js';
import { PressableRow } from '../home/PressableRow.js';
import {
  KNOWLEDGE_EMPTY_BODY, KNOWLEDGE_EMPTY_TITLE, knowledgeDoorLabel,
} from './knowledge-words.js';

/**
 * A page row: what it is called, then the agent that last landed it in front
 * of what the page is about — the same face-then-name shape a site's row
 * carries. The workplace's agents write into ONE knowledge base, so "who
 * wrote this?" is otherwise unanswerable without opening the page and
 * guessing from its prose (the owner, 2026-08-17).
 *
 * The section heading already says these are Knowledge pages, so — like Notes
 * — the rows stay icon-free and the title starts at the card edge rather than
 * repeating the shelf's mark on every page.
 */
export function KnowledgeRow({ page, now }: {
  page: WorkspaceKnowledgePageRow;
  now?: number;
}) {
  const navigate = useNavigate();
  const scope = useOrgScope();
  const to = toFor({ kind: 'knowledgePage', id: page.name, ...scope });
  return (
    <PressableRow className="crow open" onPress={() => { if (to) navigate(to); }}>
      <div className="main">
        <div className="name plain">{page.title || page.name}</div>
        <div className="cline">
          {/* A page that came from another room said so at the head of this
              line, while there were rooms; the shelf is one list and a page
              carries no room since note #843. */}
          <AgentLine subject={page} tail={page.description || page.name} />
        </div>
      </div>
      <div className="cside">{page.updatedAt ? relative(page.updatedAt, now) : ''}</div>
    </PressableRow>
  );
}

/**
 * The door onto the Knowledge screen, drawn only when there is something
 * behind it: at six pages or fewer the card already holds every one, and a
 * row saying "all 6 pages" over the six of them is a tap that gives nothing
 * back. It is NOT a page row, so it keeps the knowledge mark that tells the
 * reader what opens — and carries no time, which would read as some page's.
 */
export function KnowledgeDoorRow({ count }: { count: number }) {
  const navigate = useNavigate();
  const scope = useOrgScope();
  const to = toFor({ kind: 'knowledgeList', ...scope });
  return (
    <button className="crow open" type="button" onClick={() => { if (to) navigate(to); }}>
      <TypeIcon glyph="bulb" tint="doc" />
      <div className="main">
        <div className="name plain">{knowledgeDoorLabel(count)}</div>
      </div>
      <Icon name="chev" size={17} className="icon chev" />
    </button>
  );
}

/** What a knowledge base with nothing in it says — on Home and on the screen
 *  alike, because a list that shrank to nothing must not eject its reader. */
export function KnowledgeEmpty() {
  return <EmptyState glyph="bulb" tint="doc" title={KNOWLEDGE_EMPTY_TITLE} body={KNOWLEDGE_EMPTY_BODY} />;
}
