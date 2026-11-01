/**
 * The no-account public repository browser.
 *
 * It deliberately has no proposals, actions, people, settings or directory:
 * those are workplace information. A visitor gets the source tree, readable
 * files and the anonymous clone URL — exactly the public contract.
 *
 * Two doors open it (public-addresses, slice 6): the repository's ADDRESS,
 * `/acme/site`, and the older link-only token door
 * `/public/repositories/<id>`, which the server now redirects to the address
 * whenever the workplace has a handle. A signed-in member of the workplace
 * is sent on to the full repository screen; the server says so.
 *
 * At its address a repository also says what HAPPENED in it (the owner,
 * 2026-09-27): the latest commit sits over the tree, and History and
 * Proposals open the pages in PublicRepoPages.tsx. The token door, which
 * only a workplace without a handle still uses, keeps to the tree.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type {
  WorkspacePublicRepoAboutAnswer,
  WorkspacePublicRepoCommitsAnswer,
  WorkspacePublicRepoFileAnswer,
  WorkspacePublicRepoTreeAnswer,
  WorkspaceRepoTreeEntry,
} from '../../../../src/shared/workspace-api.js';
import brandLogo from '../../../../../public/logo-bw.png';
import { useBanner } from '../../chrome/useBanner.js';
import { Markdown } from '../../render/Markdown.js';
import { useSession } from '../../session/useSession.js';
import { toFor } from '../../routes.js';
import { bytes, fileExt, fileIcon } from '../../ui/file-kind.js';
import { copyFromTap } from '../../ui/format.js';
import { PUBLIC_ADDRESS_HOST } from '../../../../src/shared/handles.js';
import { PRIVATE_COPY } from '../../../../src/shared/private-copy.js';
import { Icon, TypeIcon } from '../../ui/icons.js';
import { CodeView } from './CodeView.js';
import { MemberDoor } from './MemberDoor.js';
import {
  aboutFacts, commitLine, contributorsLine, publicEndpoint, publicPageEndpoint, publicPagePath, publicPath, usePublicRead,
  type PublicRepoAddress, type PublicRepoDoor,
} from './public-repo.js';
import { MD_EXT, entrySide, imageDataUrl, orderedEntries, pickReadme } from './repo-nav.js';

/**
 * The header every public page wears: the mark and the name, which open the
 * front page, and the doors on the right (the owner, 2026-09-27) — Sign in
 * and Sign up for a visitor with no account, the Workspace for one who has
 * one. Nothing while the session is still being asked, so the header does
 * not flicker from one to the other.
 *
 * It IS the landing page's header (the owner, 2026-09-27: "absolutely the
 * same"), copied from src/components/SiteHeader.tsx as that page draws it —
 * a fixed full-width bar with its hairline, the row held to the landing's
 * width, the mark as a tinted mask, the wordmark gone below 768px, Sign in
 * in the softer ink and Sign up with its arrow — and the spacer after it,
 * so the page starts beneath it. Change one and change the other.
 */
export function PublicHead() {
  const { state } = useSession();
  const mark = { maskImage: `url(${brandLogo})`, WebkitMaskImage: `url(${brandLogo})` };
  return (
    <>
      <header className="public-repo-head">
        <nav aria-label="Main">
          <a className="public-repo-brand" href="/">
            <span className="mark" style={mark} role="img" aria-label="Agentic Cloud Computer logo" />
            <span className="word">Agentic Cloud Computer</span>
          </a>
          {state.status === 'signed-out' ? (
            <div className="public-repo-doors" id="publicDoors">
              <Link className="signin" to="/login">Sign in</Link>
              {/* Since note #822 (the owner, 2026-10-28: "we should not host
                  yet ... Only on-premise") our own platform offers no
                  sign-up: the door is the site's, Build yours, to the
                  engineer's page on the landing site (a page load, not a
                  route). A copy keeps its own sign-up door, which says
                  accounts there come with an invite. */}
              {PRIVATE_COPY ? (
                <Link className="signup" to="/signup">Sign up<span className="arrow" aria-hidden="true">→</span></Link>
              ) : (
                <a className="signup" href="/own-cloud">Build yours<span className="arrow" aria-hidden="true">→</span></a>
              )}
            </div>
          ) : state.status === 'signed-in' ? (
            <div className="public-repo-doors" id="publicDoors">
              <Link className="signup" to="/">Open Workspace<span className="arrow" aria-hidden="true">→</span></Link>
            </div>
          ) : null}
        </nav>
      </header>
      <div className="public-repo-head-space" aria-hidden="true" />
    </>
  );
}

/**
 * The name as a public address reads it: `workplace / repository`. The
 * repository is a door to its own root, which is what a reader deep in a
 * folder or a diff reaches for; the workplace is only words, because a
 * workplace has no public page (note #748).
 */
export function PublicRepoName({ door, name }: { door: PublicRepoDoor; name: string }) {
  // Its own class, not `.badge`: the Workspace's states are bare words
  // (badges.test.ts), and this one pill is the public page's exception.
  const badge = <span className="public-visibility" id="publicRepoBadge">Public</span>;
  // The name and its pill travel together: when they do not fit beside the
  // workplace, both go to the next line rather than the pill alone.
  if (door.kind === 'token') return <h1 className="public-repo-name" id="publicRepoName"><span className="tail"><span>{name}</span>{badge}</span></h1>;
  return (
    <h1 className="public-repo-name" id="publicRepoName">
      <span className="owner">{door.handle}</span>
      <span className="slash" aria-hidden="true">/</span>
      <span className="tail">
        <Link to={publicPath(door)}>{name}</Link>
        {badge}
      </span>
    </h1>
  );
}

/** Code · History · Proposals — the three things a public repository has. */
export function PublicRepoTabs({ door, current }: { door: PublicRepoAddress; current: 'code' | 'commits' | 'proposals' }) {
  const tab = (key: typeof current, to: string, label: string) => (
    <Link to={to} className={current === key ? 'current' : undefined} aria-current={current === key ? 'page' : undefined}>{label}</Link>
  );
  return (
    <nav className="public-repo-tabs" aria-label="Repository">
      {tab('code', publicPath(door), 'Code')}
      {tab('commits', publicPagePath(door, 'commits'), 'History')}
      {tab('proposals', publicPagePath(door, 'proposals'), 'Proposals')}
    </nav>
  );
}

/** The same two lines every public page waits behind. */
export function PublicLoading() {
  return <div className="public-repo-loading" aria-label="Loading"><span className="skel line" /><span className="skel line two" /></div>;
}

/** "Nothing at this address" or what went wrong, in the same place on every page. */
export function PublicError({ missing, message, door }: { missing: boolean; message: string; door: PublicRepoDoor }) {
  return (
    <div className="public-repo-error" id={missing ? 'repoMissing' : undefined}>
      <h1>{missing ? 'Nothing at this address' : 'Repository unavailable'}</h1>
      <p>{missing ? `There is no public repository at ${PUBLIC_ADDRESS_HOST}/${door.kind === 'address' ? `${door.handle}/${door.repo}` : ''}.` : message}</p>
    </div>
  );
}

/**
 * The newest commit on the default branch, over the tree: what changed
 * last and who did it — the one line a visitor reads to know whether the
 * repository is alive — with the door to the whole history beside it.
 */
function PublicLatest({ door }: { door: PublicRepoAddress }) {
  const { answer } = usePublicRead<WorkspacePublicRepoCommitsAnswer>(`${publicPageEndpoint(door, 'commits')}?limit=1`);
  const latest = answer?.commits[0];
  if (!latest) return null;
  return (
    <Link className="public-repo-latest" id="publicRepoLatest" to={publicPagePath(door, 'commits', latest.sha)}>
      <Icon name="commit" size={15} className="icon" />
      <span className="subject">{latest.subject || 'No message'}</span>
      <span className="who">{commitLine(latest)}</span>
      <span className="sha">{latest.sha.slice(0, 7)}</span>
    </Link>
  );
}

/**
 * The About strip and the contributors line (the owner, 2026-09-27): what a
 * visitor checks before cloning, in the space between the tabs and the tree.
 * The description is the README's first paragraph; the facts are the
 * licence, the size, the dates and the counts, and each count is the door
 * to its tab. The contributors line names the first few and counts the
 * rest — names as git wrote them, no faces, no addresses — and opens the
 * whole list. Absent while loading and absent on failure: the strip is a
 * summary, and a summary that says "unavailable" says nothing.
 */
function PublicAbout({ door }: { door: PublicRepoAddress }) {
  const { answer } = usePublicRead<WorkspacePublicRepoAboutAnswer>(publicPageEndpoint(door, 'about'));
  if (!answer) return null;
  const people = answer.contributors;
  return (
    <div className="card public-repo-about" id="publicRepoAbout">
      {answer.description ? <p className="description" id="publicRepoDescription">{answer.description}</p> : null}
      <div className="facts" id="publicRepoFacts">
        {aboutFacts(answer).map((fact) => (fact.page
          ? <Link key={fact.key} to={publicPagePath(door, fact.page)}>{fact.text}</Link>
          : <span key={fact.key}>{fact.text}</span>))}
      </div>
      {people.length ? (
        <Link className="people" id="publicRepoPeople" to={publicPagePath(door, 'contributors')}>
          <span className="faces">
            {people.slice(0, 3).map((person, index) => (person.avatarUrl
              ? <img className="face" key={`${index}:${person.name}`} src={person.avatarUrl} alt="" />
              // Everyone counts, picture or not: a stack that skipped the
              // faceless would say two where the count says four.
              : <span className="face dot" key={`${index}:${person.name}`}><Icon name="user" size={11} /></span>))}
          </span>
          <span className="count">{people.length === 1 ? '1 contributor' : `${people.length} contributors`}</span>
          <span className="names">{contributorsLine(people.map((person) => person.name))}</span>
          <Icon name="chev" size={15} className="icon chev" />
        </Link>
      ) : null}
    </div>
  );
}

function folderOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

function leafOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function PublicCrumb({ door, repoName, path, leaf }: {
  door: PublicRepoDoor; repoName: string; path: string; leaf?: string;
}) {
  const parts = path.split('/').filter(Boolean);
  // At the root the crumb would only repeat the title; it starts one level in.
  if (parts.length === 0 && !leaf) return null;
  return (
    <nav className="public-repo-crumb" aria-label="Repository path">
      <Link to={publicPath(door)}>{repoName}</Link>
      {parts.map((part, index) => {
        const at = parts.slice(0, index + 1).join('/');
        return <span key={at}><span aria-hidden="true">/</span><Link to={publicPath(door, at)}>{part}</Link></span>;
      })}
      {leaf ? <span><span aria-hidden="true">/</span><b>{leaf}</b></span> : null}
    </nav>
  );
}

function PublicReadme({ door, entry, path }: { door: PublicRepoDoor; entry: WorkspaceRepoTreeEntry; path: string }) {
  const { api } = useSession();
  const [content, setContent] = useState<string | null>(null);
  const filePath = path ? `${path}/${entry.name}` : entry.name;
  const endpoint = publicEndpoint(door, 'file', filePath);
  useEffect(() => {
    let current = true;
    void api.api<WorkspacePublicRepoFileAnswer>(endpoint).then((answer) => {
      if (current) setContent(answer.tooLarge || answer.binary || answer.image ? null : (answer.content ?? null));
    }).catch(() => { if (current) setContent(null); });
    return () => { current = false; };
  }, [api, endpoint]);
  if (!content) return null;
  return MD_EXT.has(fileExt(entry.name))
    ? <div className="card readme"><Markdown source={content} /></div>
    : <div className="card readme"><CodeView content={content} ext={fileExt(entry.name)} /></div>;
}

function PublicTree({ door, path, answer }: { door: PublicRepoDoor; path: string; answer: WorkspacePublicRepoTreeAnswer }) {
  const entries = useMemo(() => orderedEntries(answer.entries), [answer.entries]);
  const readme = useMemo(() => pickReadme(entries), [entries]);
  return (
    <>
      <PublicCrumb door={door} repoName={answer.name} path={path} />
      <div className="filebar">
        <div className="kind branch">
          {answer.branch ? <><Icon name="git" size={13} /><span>{answer.branch}</span></> : null}
        </div>
      </div>
      {door.kind === 'address' && !path && answer.branch ? <PublicLatest door={door} /> : null}
      <div className="card" id="publicRepoTree">
        {answer.branch === null
          ? <div className="empty">This repository has no commits yet.</div>
          : entries.length === 0
            ? <div className="empty">This folder is empty.</div>
            : entries.map((entry) => {
              const child = path ? `${path}/${entry.name}` : entry.name;
              const isDir = entry.type === 'dir';
              const kind = isDir
                ? { glyph: 'folder' as const, tint: 'dir' as const }
                : entry.type === 'submodule'
                  ? { glyph: 'box' as const, tint: 'code' as const }
                  : entry.type === 'symlink'
                    ? { glyph: 'link' as const, tint: '' as const }
                    : fileIcon(entry.name);
              const body = (
                <>
                  <TypeIcon glyph={kind.glyph} tint={kind.tint} />
                  <span className="tname">{entry.name}{isDir ? '/' : ''}</span>
                  <span className="tsize">{entrySide(entry, bytes)}</span>
                </>
              );
              return entry.type === 'submodule'
                ? <div className="trow" key={child}>{body}</div>
                : <Link className="trow open" key={child} to={publicPath(door, child, !isDir)}>{body}</Link>;
            })}
      </div>
      {readme ? <div className="public-repo-readme"><PublicReadme door={door} entry={readme} path={path} /></div> : null}
    </>
  );
}

function PublicFile({ door, path, answer }: { door: PublicRepoDoor; path: string; answer: WorkspacePublicRepoFileAnswer }) {
  const name = leafOf(path);
  const image = answer.image ? imageDataUrl(answer.image) : '';
  const content = answer.content ?? '';
  const markdown = MD_EXT.has(fileExt(name));
  return (
    <>
      <PublicCrumb door={door} repoName={answer.name} path={folderOf(path)} leaf={name} />
      <div className="filebar">
        <div className="kind">{markdown ? 'Markdown' : (fileExt(name).toUpperCase() || 'File')} · {bytes(answer.sizeBytes)}</div>
      </div>
      {answer.tooLarge ? <div className="empty">This file is too large to show here. Clone the repository to open it.</div> : null}
      {!answer.tooLarge && answer.image && image
        ? <div className="imgview"><img alt={name} src={image} /></div>
        : null}
      {!answer.tooLarge && answer.binary
        ? <div className="empty">This is a binary file. Clone the repository to open it.</div>
        : null}
      {!answer.tooLarge && !answer.image && !answer.binary && content === ''
        ? <div className="empty">This file is empty.</div>
        : null}
      {!answer.tooLarge && !answer.image && !answer.binary && content
        ? markdown ? <Markdown source={content} /> : <CodeView content={content} ext={fileExt(name)} />
        : null}
    </>
  );
}

export function PublicRepoScreen({ door }: { door: PublicRepoDoor }) {
  const [search] = useSearchParams();
  const path = search.get('path') ?? '';
  const file = search.get('file') === '1';
  const banner = useBanner();
  const endpoint = publicEndpoint(door, file ? 'file' : 'tree', path);
  const { answer, member, error } = usePublicRead<WorkspacePublicRepoTreeAnswer | WorkspacePublicRepoFileAnswer>(endpoint);

  useEffect(() => {
    document.title = answer?.name ? `${answer.name} · Public repository` : 'Public repository';
  }, [answer?.name]);

  // A member of the workplace reads the repository's own screen — public or
  // private, it is theirs. A replace, so Back does not land here again.
  if (member && door.kind === 'address') {
    const own = toFor({ kind: 'repo', id: door.repo, orgId: member.orgId, ...(path ? { path } : {}) });
    if (own) return <MemberDoor orgId={member.orgId} to={own} />;
  }

  // At its address, a repository nobody may see reads like one that is not
  // there: the same words as any other empty address.
  const missing = error && error.status === 404 && door.kind === 'address' && !path;

  return (
    <div id="publicRepo" className="screen">
      <PublicHead />
      {error ? <PublicError missing={Boolean(missing)} message={error.message} door={door} /> : null}
      {!answer && !error ? <PublicLoading /> : null}
      {answer ? (
        <>
          <PublicRepoName door={door} name={answer.name} />
          <div className="public-repo-clone">
            <code>{answer.cloneUrl}</code>
            <button
              type="button"
              onClick={() => {
                void copyFromTap(async () => answer.cloneUrl)
                  .then(() => banner.show('Clone URL copied.', true))
                  .catch(() => banner.show('Could not reach the clipboard — select and copy the URL.'));
              }}
            >
              <Icon name="copy" size={15} /><span>Copy</span>
            </button>
          </div>
          {door.kind === 'address' ? <PublicRepoTabs door={door} current="code" /> : null}
          {door.kind === 'address' && !path && !file ? <PublicAbout door={door} /> : null}
          <div className="public-repo-body">
            {file
              ? <PublicFile door={door} path={path} answer={answer as WorkspacePublicRepoFileAnswer} />
              : <PublicTree door={door} path={path} answer={answer as WorkspacePublicRepoTreeAnswer} />}
          </div>
        </>
      ) : null}
    </div>
  );
}

