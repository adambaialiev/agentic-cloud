/**
 * Every knowledge page, on a screen of its own — the same rows Home draws,
 * without the six-row ceiling (the owner, note #48).
 *
 * No "write one" row at the foot of it, unlike the notes screen: a page is
 * PROPOSED by an agent and approved here, so there is nothing for a reader to
 * add from this screen and a button offering it would be a dead end.
 *
 * It reads the state the provider already holds rather than fetching, which
 * is what makes it open on the tap — and what keeps it true underneath a
 * reader, since every full read repaints it. It stays a valid destination
 * even when the count falls under Home's threshold or to nothing at all:
 * visibility on Home is presentation, and must not decide whether a durable
 * route continues to exist.
 *
 * A COLD open — a pasted link, a reload — arrives before that state does, and
 * "0 pages" is a claim rather than a wait. So the shelf says nothing about
 * how full it is until it has been read.
 */

import { useState } from 'react';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { KnowledgeEmpty, KnowledgeRow } from './KnowledgeRow.js';
import { knowledgeScreenSub } from './knowledge-words.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';

/**
 * One shelf for the whole workplace (note #566) is long enough to skim past
 * the page you wanted, so the screen filters by words. It grouped the pages
 * by the room they came from too, the room on screen first, until rooms left
 * the product (note #843): it is one list now, and a page carries no room.
 */
export function KnowledgeListScreen() {
  const { state, status, error, reload } = useWorkspace();
  const [query, setQuery] = useState('');
  const pages = state?.knowledge ?? [];
  const loading = status === 'loading';
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = pages.filter((page) => {
    const hay = `${page.name} ${page.title} ${page.description}`.toLowerCase();
    return words.every((word) => hay.includes(word));
  });
  return (
    <div className="screen" id="screenKnowledge" aria-busy={loading || undefined}>
      <ScreenTitle title="Knowledge" />
      <div className="sub" id="knowledgeSub">{loading ? '' : knowledgeScreenSub(pages.length)}</div>
      {/* The filter earns its place only once there is something to get lost
          in: more than Home's own glimpse holds. */}
      {!loading && pages.length > 6
        ? (
          <form className="drivesearch" role="search" id="knowledgeFilter" onSubmit={(event) => event.preventDefault()}>
            <input
              type="search" aria-label="Filter knowledge pages" placeholder="Filter by name or words"
              value={query} onChange={(event) => setQuery(event.target.value)}
            />
          </form>
        )
        : null}
      {status === 'error' && !state
        ? (
          <div className="card authpanel" role="alert" id="knowledgeError">
            <div className="authsub">{error}</div>
            <button className="btn primary" type="button" onClick={() => { void reload(); }}>Try again</button>
          </div>
        )
        : (
            <div className="card">
              <div id="knowledgeList">
                {loading
                  ? <div className="empty">Loading…</div>
                  : pages.length === 0
                    ? <KnowledgeEmpty />
                    : shown.length === 0
                      ? <div className="empty" id="knowledgeNoMatch">No page matches “{query.trim()}”.</div>
                      : shown.map((page) => <KnowledgeRow key={page.name} page={page} />)}
              </div>
            </div>
          )}
    </div>
  );
}
