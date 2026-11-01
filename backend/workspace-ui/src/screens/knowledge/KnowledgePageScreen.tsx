/**
 * One knowledge page, on the screen a page is read on.
 *
 * The source never reaches this screen as markup: `KnowledgeHtml` builds
 * every node from an allowlist, so a page can carry a table and a diagram and
 * nothing else. Below the words, in the order the screen reads: who could
 * take this on, then what has been said about it — the hand row is the one
 * thing here that makes something happen, and it belongs above a thread that
 * only comments.
 *
 * It opens WARM on what the room's page list already carried (title and
 * description) and fills in the words underneath, so a tap from Home paints
 * the heading it was tapped on rather than a slug and a spinner.
 *
 * The Send is a transient leaf on this address (knowledge page
 * "miniapp-navigation"), so Back closes it and returns the reader to the page
 * at the line they were on — no history entry, and nothing typed becomes a
 * copied URL.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  WorkspaceKnowledgePageAnswer,
  WorkspaceKnowledgePageRecord,
  WorkspaceKnowledgeRestoreAnswer,
  WorkspaceKnowledgeVersionRow,
  WorkspaceMarginComment,
} from '../../../../src/shared/workspace-api.js';
import { jsonBody } from '../../api/client.js';
import { relative } from '../../ui/time.js';
import { KnowledgeHtml } from '../../render/KnowledgeHtml.js';
import { useNoteRefs } from '../../render/useNoteRefs.js';
import { toFor } from '../../routes.js';
import { useSession } from '../../session/useSession.js';
import { HandRow } from '../../ui/HandRow.js';
import { useImageViewer } from '../../ui/useImageViewer.js';
import { HandoffSend } from '../../ui/HandoffSend.js';
import { kpageHandoffText } from '../../ui/handoff.js';
import type { HomeAgent } from '../../workspace/live.js';
import { useOrgScope, useWorkspace } from '../../workspace/useWorkspace.js';
import { MarginThread } from '../decisions/MarginThread.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';

const pagePath = (name: string) => `api/knowledge/pages/${encodeURIComponent(name)}`;

const HAND_IDS = {
  head: 'kpageHandsHead', card: 'kpageHandsCard', row: 'kpageHands', hint: 'kpageHandsHint',
};
const MARGIN_IDS = { head: 'kpageCommentsHead', card: 'kpageCommentsCard', box: 'kpageComments' };

export function KnowledgePageScreen() {
  const { id: name = '' } = useParams();
  const { api } = useSession();
  const { state } = useWorkspace();
  const scope = useOrgScope();
  const navigate = useNavigate();
  const notes = useNoteRefs();

  const [page, setPage] = useState<WorkspaceKnowledgePageRecord | null>(null);
  const [loadError, setLoadError] = useState('');
  const [said, setSaid] = useState('');
  /** Which agent the reader tapped, when the Send is up. Held in state and
   *  not in the address: the leaf is transient. */
  const [handing, setHanding] = useState<HomeAgent | null>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const answer = await api.api<WorkspaceKnowledgePageAnswer>(
          pagePath(name), undefined,
        );
        if (!current || !alive.current) return;
        setPage(answer.page);
        setLoadError('');
      } catch (error) {
        if (current && alive.current) setLoadError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { current = false; };
  }, [api, name]);

  const onComments = useCallback((comments: WorkspaceMarginComment[]) => {
    setPage((current) => (current ? { ...current, comments } : current));
  }, []);

  // Put the page back (note #746): to the version before its last change,
  // or to exactly what one earlier change landed. The answer carries the
  // page as it stands now, history included, so the screen repaints whole;
  // a restore that removed the page sends the reader back to the shelf.
  const [restoring, setRestoring] = useState(false);
  const restore = useCallback(async (to?: number) => {
    setRestoring(true);
    try {
      const answer = await api.api<WorkspaceKnowledgeRestoreAnswer>(
        `${pagePath(name)}/restore`, jsonBody(to === undefined ? {} : { to }),
      );
      if (!alive.current) return;
      if (answer.page) {
        setPage((current) => (current ? { ...current, ...answer.page } : answer.page!));
        setSaid(`Put back as change #${answer.number}.`);
      } else {
        navigate(toFor({ kind: 'knowledge', ...scope })!, { replace: true });
      }
    } catch (error) {
      if (alive.current) setSaid(error instanceof Error ? error.message : String(error));
    } finally {
      if (alive.current) setRestoring(false);
    }
  }, [api, name, navigate, scope]);

  // A page's own picture is its evidence, and a tap opens it at full size.
  // The page's `files` map IS the gallery: a page carrying three diagrams is
  // three slides, and the reader steps between them without closing this and
  // hunting for the next one.
  const viewer = useImageViewer();
  const gallery = useMemo(
    () => Object.entries(page?.files ?? {}).map(([name, url]) => ({ name, url })),
    [page?.files],
  );
  const openImage = useCallback((url: string, name: string) => {
    const at = gallery.findIndex((image) => image.name === name);
    viewer(gallery.length ? gallery : [{ url, name }], at < 0 ? 0 : at);
  }, [gallery, viewer]);

  const listed = (state?.knowledge ?? []).find((row) => row.name === name);
  // Warm first, then what the fetch said. A failed read leaves the row's own
  // words standing rather than blanking a heading that was true a moment ago.
  const title = page?.title || listed?.title || name;
  const description = page?.description ?? listed?.description ?? '';
  const files = useMemo(() => page?.files ?? null, [page?.files]);

  const openAgent = useCallback((agent: HomeAgent) => {
    navigate(toFor({ kind: 'agent', id: agent.id })!);
  }, [navigate]);

  if (handing) {
    return (
      <HandoffSend
        agent={handing}
        prefill={kpageHandoffText(handing, name, title)}
        onClose={() => setHanding(null)}
      />
    );
  }

  return (
    <div className="screen" id="screenKnowledgePage">
      <ScreenTitle titleId="kpageTitle" title={title} subId="kpageSub" sub={description} />
      <div id="kpageBody">
        {page
          ? <KnowledgeHtml source={page.html} files={files} dropTitle={title} onImage={openImage} noteRefs={notes} />
          : <div className="empty">{loadError || 'Loading…'}</div>}
      </div>
      {/* Nothing closes a page's hand row: a page is never archived and
          nobody claims one, so it is drawn whenever there is a fleet — or a
          room — to draw it from. It waits for the page itself, because there
          is nobody to hand a page that could not be read. */}
      {page ? (
        <>
          <HandRow ids={HAND_IDS} noun="page" onOpen={setHanding} onDetail={openAgent} />
          {page.history?.length ? (
            <KnowledgeHistory versions={page.history} busy={restoring} onRestore={restore} onAgent={(agentId) => navigate(toFor({ kind: 'agent', id: agentId })!)} />
          ) : null}
          <MarginThread
            ids={MARGIN_IDS}
            comments={page.comments ?? []}
            canWrite={Array.isArray(page.comments)}
            path={`${pagePath(name)}/comments`}
            onPosted={onComments}
            onAgentId={(agentId) => navigate(toFor({ kind: 'agent', id: agentId })!)}
            onPerson={(comment) => {
              const to = scope.orgId
                ? toFor({ kind: 'organizationMember', id: comment.authorUserId!, orgId: scope.orgId })
                : null;
              if (to) navigate(to);
            }}
            onSay={setSaid}
          />
        </>
      ) : null}
      {said ? <div className="hintline" id="kpageSaid" role="status">{said}</div> : null}
    </div>
  );
}

/**
 * A page's versions (note #746), newest first: who changed it, when and why,
 * with Put back on the newest (the version before it) and on each older one
 * (exactly what it landed). Nobody approves a page any more, so this is the
 * person's one lever — and it is one tap.
 */
function KnowledgeHistory({ versions, busy, onRestore, onAgent }: {
  versions: WorkspaceKnowledgeVersionRow[];
  busy: boolean;
  onRestore: (to?: number) => void;
  onAgent: (agentId: string) => void;
}) {
  const verb = (row: WorkspaceKnowledgeVersionRow) => (
    row.restore ? 'Put back' : row.action === 'create' ? 'Written' : row.action === 'delete' ? 'Removed' : row.action === 'rename' ? `Renamed to ${row.renameTo ?? ''}` : 'Changed'
  );
  return (
    <>
      <h2 id="kpageHistoryHead">History</h2>
      <div className="card" id="kpageHistory">
        {versions.map((row, at) => (
          <div className="cline khist" key={row.number} data-number={row.number}>
            <div className="main">
              <strong>{verb(row)}</strong>
              {' · '}
              {row.agentId
                ? <button type="button" className="linklike" onClick={() => onAgent(row.agentId!)}>{row.agentName ?? 'an agent'}</button>
                : <span>{row.agentName ?? 'you'}</span>}
              {' · '}
              <time dateTime={row.at}>{relative(row.at)}</time>
              {row.note ? <div className="sub">{row.note}</div> : <div className="sub">{row.title}</div>}
            </div>
            {row.canRestore ? (
              <button
                className="btn ghost"
                type="button"
                disabled={busy}
                onClick={() => onRestore(at === 0 ? undefined : row.number)}
                title={at === 0 ? 'Put the page back as it was before this change' : 'Put the page back to exactly this version'}
              >
                {at === 0 ? 'Put back' : 'Put back to this'}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </>
  );
}
