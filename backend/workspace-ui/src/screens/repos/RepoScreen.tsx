/**
 * A repository: the work around it, and its code one tap away.
 *
 * Overview and Content are TABS on the same place, not two addresses — the
 * selection rides the history entry's own state (knowledge page
 * "miniapp-navigation"), so it is restored with the entry and costs no second
 * URL and no second Back. A FOLDER is the same place with a `path` query, and
 * it always restores Content: there is nothing else a folder could be showing.
 *
 * Overview describes the REPOSITORY, never whichever folder the reader
 * happened to be inside, so its cards are drawn at the root only — and
 * choosing Overview from inside a folder walks back to the root, which is
 * what restores them.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type {
  WorkspaceRepoTreeAnswer,
  WorkspaceRepoTreeEntry,
} from '../../../../src/shared/workspace-api.js';
import { toFor } from '../../routes.js';
import { useSession } from '../../session/useSession.js';
import { bytes, fileIcon } from '../../ui/file-kind.js';
import { Icon, TypeIcon } from '../../ui/icons.js';
import { relative } from '../../ui/time.js';
import { useOrgScope, useWorkspace } from '../../workspace/useWorkspace.js';
import { PressableRow } from '../home/PressableRow.js';
import { RepoCrumb } from './RepoCrumb.js';
import { RepoOverview } from './RepoOverview.js';
import { RepoReadme } from './RepoReadme.js';
import { entrySide, orderedEntries, pickReadme } from './repo-nav.js';
import { COMMITS_SHOWN, isMissingRepo, missingRepoWords, repoReadError } from './repo-words.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';

interface TabState { tab?: string }

/** The wait, drawn as the thing being waited for: a listing arrives as typed
 *  rows of varying width, staggered so it reads as a list filling in.
 *  `aria-hidden` because it says nothing a reader needs — the row it replaces
 *  carries the word. */
function TreeSkeleton({ rows }: { rows: number }) {
  const widths = [58, 41, 66, 35, 52, 44, 61, 38];
  return (
    <div>
      <span className="sr-only">Loading…</span>
      <div className="card" aria-hidden="true">
        {Array.from({ length: rows }, (_, at) => (
          <div className="trow" key={at}>
            <span className="skel ic" style={{ animationDelay: `${(at * 0.09).toFixed(2)}s` }} />
            <div className="skel nm" style={{ width: `${widths[at % widths.length]}%`, animationDelay: `${(at * 0.09).toFixed(2)}s` }} />
            <div className="skel sz" style={{ animationDelay: `${(at * 0.09).toFixed(2)}s` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function TreeRow({ entry, path, repoName }: {
  entry: WorkspaceRepoTreeEntry;
  path: string;
  repoName: string;
}) {
  const navigate = useNavigate();
  const scope = useOrgScope();
  const isDir = entry.type === 'dir';
  const childPath = path ? `${path}/${entry.name}` : entry.name;
  const kind = isDir
    ? { glyph: 'folder' as const, tint: 'dir' as const }
    : entry.type === 'submodule'
      ? { glyph: 'box' as const, tint: 'code' as const }
      : entry.type === 'symlink'
        ? { glyph: 'link' as const, tint: '' as const }
        : fileIcon(entry.name);
  const side = entrySide(entry, bytes);
  const body = (
    <>
      <TypeIcon glyph={kind.glyph} tint={kind.tint} />
      <div className="tname">{entry.name}{isDir ? '/' : ''}</div>
      {side ? <div className="tsize">{side}</div> : null}
    </>
  );
  // A submodule is a pointer at another repository this host does not have:
  // it is listed, and it is not a door.
  if (entry.type === 'submodule') return <div className="trow">{body}</div>;
  const to = isDir
    ? toFor({ kind: 'repo', id: repoName, ...scope, path: childPath })
    : toFor({ kind: 'repoFile', id: repoName, ...scope, path: childPath });
  return (
    <PressableRow className="trow open" onPress={() => { if (to) navigate(to); }}>{body}</PressableRow>
  );
}

export function RepoScreen() {
  const { id: repoName = '' } = useParams();
  const [search] = useSearchParams();
  const path = search.get('path') ?? '';
  const location = useLocation();
  const navigate = useNavigate();
  const { api } = useSession();
  const { state } = useWorkspace();
  const scope = useOrgScope();

  const [tree, setTree] = useState<WorkspaceRepoTreeAnswer | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // A folder always restores Content; the root restores whatever this history
  // entry recorded, and Overview is where a repository opens.
  const tab = path || (location.state as TabState | null)?.tab === 'content' ? 'content' : 'overview';

  const selectTab = (next: 'overview' | 'content') => {
    if (next === tab) return;
    // Overview describes the repository itself, so choosing it from inside a
    // folder walks back to the root — which is also what brings back the
    // root-only cards a folder render correctly removed.
    if (next === 'overview' && path) {
      navigate(toFor({ kind: 'repo', id: repoName, ...scope })!);
      return;
    }
    // Replace, not push: a tab is not a place, and a Back that only undid a
    // tab would be a Back the reader did not ask for.
    navigate(`${location.pathname}${location.search}`, { replace: true, state: { ...(location.state ?? {}), tab: next } });
    window.scrollTo(0, 0);
  };

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const answer = await api.api<WorkspaceRepoTreeAnswer>(
          `api/repos/${encodeURIComponent(repoName)}/tree${path ? `?path=${encodeURIComponent(path)}` : ''}`,
          undefined,
        );
        if (!current || !alive.current) return;
        setTree(answer);
      } catch (error) {
        if (!current || !alive.current) return;
        setLoadError(error);
      }
    })();
    return () => { current = false; };
  }, [api, repoName, path]);

  const entries = useMemo(() => orderedEntries(tree?.entries ?? []), [tree]);
  const readme = useMemo(() => pickReadme(entries), [entries]);
  const content = tab === 'content';
  const workplace = state?.org?.name;
  // Not a repository of this workplace — another workplace's private one, or
  // none at all; the server will not say which (note #671). Tabs over nothing
  // read as a page still loading, so the screen says this instead of them.
  if (isMissingRepo(loadError)) {
    return (
      <div className="screen" id="screenRepo">
        <ScreenTitle titleId="repoTitle" title={repoName} />
        <div className="card" id="repoMissing">
          <div className="empty">{missingRepoWords(repoName, workplace)}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="screen" id="screenRepo">
      <ScreenTitle titleId="repoTitle" title={repoName} />
      <div className="segtabs" id="repoTabs" role="tablist" aria-label="Repository view">
        <button
          className="segtab" id="repoOverviewTab" type="button" role="tab"
          aria-controls="repoOverview" aria-selected={!content} tabIndex={content ? -1 : 0}
          onClick={() => selectTab('overview')}
        >
          Overview
        </button>
        <button
          className="segtab" id="repoContentTab" type="button" role="tab"
          aria-controls="repoContent" aria-selected={content} tabIndex={content ? 0 : -1}
          onClick={() => selectTab('content')}
        >
          Content
        </button>
      </div>
      <div id="repoOverview" role="tabpanel" aria-labelledby="repoOverviewTab" hidden={content}>
        {/* Drawn at the ROOT only: proposals, actions, contributors, the room
            grants and the delete all describe the repository, and hanging any
            of them over a folder's listing would say they were that folder's. */}
        {!path && !content ? <RepoOverview repoName={repoName} /> : null}
      </div>
      <div id="repoContent" role="tabpanel" aria-labelledby="repoContentTab" hidden={!content}>
        <RepoCrumb id="repoCrumb" repoName={repoName} path={path} leaf={null} />
        {/* Which branch these files come from — the one thing the explorer
            showed nowhere, and the reason the bar exists at all. */}
        <div className="filebar" id="repoBar" hidden={!tree?.branch} aria-busy={!tree || undefined}>
          <div className="kind branch" id="repoBranch">
            {tree?.branch ? <><Icon name="git" size={13} /><span>{tree.branch}</span></> : null}
          </div>
        </div>
        {!path ? <RepoHistoryRow repoName={repoName} /> : null}
        <h2 id="repoFilesHead" hidden={Boolean(path)}>Files</h2>
        {!tree && !loadError ? <TreeSkeleton rows={8} /> : null}
        <div className="card" id="repoTree" hidden={!tree && !loadError}>
          {loadError ? <div className="empty">{repoReadError(loadError, repoName, workplace)}</div> : null}
          {tree?.branch === null
            ? <div className="empty">This repository has no commits yet. Once an agent pushes, its files show up here.</div>
            : null}
          {tree && tree.branch !== null && entries.length === 0
            ? <div className="empty">This folder is empty.</div>
            : null}
          {tree ? entries.map((entry) => (
            <TreeRow entry={entry} key={`${entry.type}:${entry.name}`} path={path} repoName={repoName} />
          )) : null}
        </div>
        <div id="repoReadme">
          {/* What this folder is FOR, without a tap — the same place GitHub
              puts it. Read after the listing is on screen, so the files never
              wait on it. */}
          {readme ? <RepoReadme repoName={repoName} path={path} entry={readme} /> : null}
        </div>
      </div>
    </div>
  );
}

/** The one-line answer to "what happened here lately", above the files. A
 *  repository with no commits takes the row away rather than explaining
 *  itself — the listing under it is already saying so in words. */
function RepoHistoryRow({ repoName }: { repoName: string }) {
  const { latest, loading } = useRepoLatestCommit(repoName);
  const navigate = useNavigate();
  const scope = useOrgScope();
  const to = toFor({ kind: 'repoHistory', id: repoName, ...scope });
  if (loading) {
    return (
      <div className="card" id="repoHistory">
        <div className="trow" aria-hidden="true">
          <span className="skel ic" /><div className="skel nm" style={{ width: '54%' }} /><div className="skel sz" />
        </div>
      </div>
    );
  }
  if (!latest) return <div className="card" id="repoHistory" hidden />;
  return (
    <div className="card" id="repoHistory">
      <PressableRow className="trow open" onPress={() => { if (to) navigate(to); }}>
        <TypeIcon glyph="commit" tint="code" />
        <div className="tname prose">{latest.subject || 'No message'}</div>
        <div className="tsize">{latest.when}</div>
      </PressableRow>
    </div>
  );
}

/** The newest commit, read beside the tree rather than after it: two
 *  different questions, and neither should wait on the other's answer. */
function useRepoLatestCommit(repoName: string) {
  const { api } = useSession();
  const [latest, setLatest] = useState<{ subject: string; when: string } | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setLatest(null);
    void (async () => {
      try {
        const answer = await api.api<{ commits?: Array<{ subject: string; at: string }> }>(
          `api/repos/${encodeURIComponent(repoName)}/commits?limit=${COMMITS_SHOWN}`, undefined,
        );
        if (!current) return;
        const commit = answer.commits?.[0];
        setLatest(commit ? { subject: commit.subject, when: relative(commit.at) } : null);
      } catch {
        // A history that could not be read has nothing to add to a tree that
        // may have failed for the same reason; the row simply goes.
        if (current) setLatest(null);
      } finally {
        if (current) setLoading(false);
      }
    })();
    return () => { current = false; };
  }, [api, repoName]);
  return { latest, loading };
}

