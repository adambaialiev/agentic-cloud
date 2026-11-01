/**
 * One word at the root of the domain — `agenticcloudcomputer.com/adam`
 * (knowledge page "public-addresses", slice 5). A person's page is an entry
 * door, not a signed-in destination: a stranger reads it without an
 * account, so the screen stands before the session gate, wears the public
 * chrome the public repository page wears, and shows exactly the public
 * contract. Someone signed in reads it inside the Workspace, under its own
 * header with Back (the owner, 2026-10-11).
 *
 * A person: name, picture, address, the public repositories git counts them
 * in. Never their workplaces. A signed-in colleague is sent on to the member
 * screen of the workplace they share. A builder's own page (note #200) also
 * shows this week's numbers, all time, the last 90 days and, if they added
 * it, a Follow on X pill — to them alone, signed in, since the public
 * Leaderboard went (note #824), and on the founder's page to anyone.
 *
 * A workplace has no public page (the owner, 2026-10-12, note #748): its
 * word shares the namespace, but only one of its own signed-in members is
 * told it is a workplace, and is sent on to the workplace's own screen.
 * Anyone else reads "Nothing at this address".
 *
 * A handle nobody holds reads the same as a reserved or malformed one, so
 * the address itself leaks nothing.
 */

import { useEffect, useState } from 'react';
import type {
  WorkspacePublicAddressAnswer,
  WorkspacePublicPersonAnswer,
  WorkspacePublicPersonBoard,
} from '../../../../src/shared/workspace-api.js';
import { LEADERBOARD_DAYS_FROM, xProfileUrl } from '../../../../src/shared/leaderboard.js';
import { PUBLIC_ADDRESS_HOST } from '../../../../src/shared/handles.js';
import { useSession } from '../../session/useSession.js';
import { toFor } from '../../routes.js';
import { MemberDoor } from '../repos/MemberDoor.js';
import { PublicHead } from '../repos/PublicRepoScreen.js';
import { errorMessage } from '../../ui/format.js';
import { PersonFace } from '../../ui/PersonFace.js';
import { Icon } from '../../ui/icons.js';
import { DayGrid } from './DayGrid.js';
import { TOKENS_WRITTEN_HINT, agentsLine, dayWordsUtc, formatHours, formatTokens, runsLine } from './board-words.js';

/* The X mark, drawn as X publishes it. */
function XMark() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

/**
 * A builder's numbers (note #200): this week's; their totals over all
 * time, which say since when (note #209); then the last 90 days, where a
 * tapped square opens that day's numbers (note #208). Counts only. Until
 * note #824 the week led to their place on the public Leaderboard. Exported for the home page's founder card (note #786),
 * so the front door and this page can never show different numbers.
 */
export function PersonBoard({ board, hoverFence }: { board: WorkspacePublicPersonBoard; hoverFence?: string }) {
  const total = board.agents === 1 ? 'agent' : 'agents';
  return (
    <>
      <h2 className="public-person-section lbsection">This week</h2>
      <div className="card lbweek" id="personWeek">
        <div className="lbnow">
          {board.working ? <span className="livedot" /> : null}
          <span>{board.working ? `${board.working} of ${board.agents} ${total} working now` : `${agentsLine(board.agents)}${board.runs.length ? ` · ${runsLine(board.runs)}` : ''}`}</span>
        </div>
        <div className="lbstats">
          <div><b>{formatHours(board.week.workingMs)}</b><span>agent hours</span></div>
          <div><b>{board.week.merged}</b><span>{board.week.merged === 1 ? 'change merged' : 'changes merged'}</span></div>
          <div><b>{board.agents}</b><span>{total}</span></div>
        </div>
        {board.week.claude != null || board.week.codex != null ? (
          <>
            <div className="lbtokens" id="personTokens">
              {board.week.claude != null ? <span>Claude Code <b>{formatTokens(board.week.claude)}</b> tokens written</span> : null}
              {board.week.codex != null ? <span>Codex <b>{formatTokens(board.week.codex)}</b> tokens written</span> : null}
            </div>
            {/* Output tokens only, said plainly (the owner, 2026-10-11,
                note #203). */}
            <div className="formhint lbtokenhint" id="personTokensHint">{TOKENS_WRITTEN_HINT}</div>
          </>
        ) : null}
      </div>
      {/* All time (the owner, 2026-10-12, note #209): hours and tokens
          written, each provider apart, counted from the first day the
          ledgers kept days — said on the card, so a total is never read as
          older than it is. */}
      <h2 className="public-person-section lbsection">All time</h2>
      <div className="card lbweek" id="personAllTime">
        <div className="lbstats lbtotals">
          <div><b>{formatHours(board.allTime.workingMs)}</b><span>agent hours</span></div>
          {board.allTime.claude != null ? <div><b>{formatTokens(board.allTime.claude)}</b><span>Claude Code tokens written</span></div> : null}
          {board.allTime.codex != null ? <div><b>{formatTokens(board.allTime.codex)}</b><span>Codex tokens written</span></div> : null}
        </div>
        <div className="formhint lbtokenhint" id="personAllTimeSince">Counted since {dayWordsUtc(LEADERBOARD_DAYS_FROM)}, when hours and tokens began to be kept by day.</div>
      </div>
      <h2 className="public-person-section lbsection">Last 90 days</h2>
      <div className="card lbdays" id="personDays">
        <DayGrid levels={board.grid} days={board.days} gridStart={board.gridStart} hoverFence={hoverFence} />
      </div>
    </>
  );
}

function PersonBody({ person }: { person: WorkspacePublicPersonAnswer }) {
  return (
    <>
      <div className="public-person-head">
        <span className="face person big"><PersonFace photoUrl={person.photoUrl} /></span>
        <div className="public-person-who">
          <h1 id="personName">{person.name}</h1>
          <div className="sub" id="personAddress">{PUBLIC_ADDRESS_HOST}/{person.handle}</div>
        </div>
        {/* Follow on X (the owner, 2026-10-10): only beside their numbers,
            when they added their X in Settings. */}
        {person.x ? (
          <a className="lbfollow" id="personFollow" href={xProfileUrl(person.x)} target="_blank" rel="noopener noreferrer" aria-label={`Follow @${person.x} on X`}>
            <span>Follow on</span>
            <XMark />
          </a>
        ) : null}
      </div>
      {person.board ? <PersonBoard board={person.board} /> : null}
      {/* A builder's page is the person and their week (the owner,
          2026-10-10): an empty repositories card is not part of it. */}
      {person.board && person.repos.length === 0 ? null : (
        <>
          <h2 className="public-person-section">Public repositories</h2>
          <div className="card" id="personRepos">
            {person.repos.length === 0
              ? <div className="empty">No public repositories yet.</div>
              : person.repos.map((repo) => (
                <a className="trow open" key={`${repo.workplaceHandle ?? repo.workplace}/${repo.name}`} href={repo.publicUrl}>
                  <Icon name="git" size={15} />
                  <span className="tname">
                    {repo.workplace ? <span className="public-person-owner">{repo.workplace} / </span> : null}{repo.name}
                  </span>
                  <span className="tsize">{repo.commits === 1 ? '1 commit' : `${repo.commits} commits`}</span>
                </a>
              ))}
          </div>
        </>
      )}
    </>
  );
}

export function PublicAddressScreen({ handle }: { handle: string }) {
  const { api, state } = useSession();
  const [answer, setAnswer] = useState<WorkspacePublicAddressAnswer | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);

  useEffect(() => {
    let current = true;
    void api.api<WorkspacePublicAddressAnswer>(`api/public/addresses/${encodeURIComponent(handle)}`)
      .then((next) => { if (current) setAnswer(next); })
      .catch((caught: unknown) => {
        if (!current) return;
        const status = typeof (caught as { status?: unknown })?.status === 'number' ? (caught as { status: number }).status : 0;
        setError({ status, message: errorMessage(caught) });
      });
    return () => { current = false; };
  }, [api, handle]);

  useEffect(() => {
    document.title = answer?.kind === 'person'
      ? `${answer.person.name} (${answer.person.handle})`
      : `${PUBLIC_ADDRESS_HOST}/${handle}`;
  }, [answer, handle]);

  // Somebody who belongs reads the real screen: a colleague the member
  // screen of the workplace they share, a member the workplace's own. A
  // replace, so Back does not land on a page that only sends them on again.
  if (answer?.kind === 'person' && answer.person.colleague) {
    const door = toFor({ kind: 'organizationMember', id: answer.person.colleague.userId, orgId: answer.person.colleague.orgId });
    if (door) return <MemberDoor orgId={answer.person.colleague.orgId} to={door} />;
  }
  if (answer?.kind === 'workplace') {
    const door = toFor({ kind: 'organization', orgId: answer.workplace.member.orgId });
    if (door) return <MemberDoor orgId={answer.workplace.member.orgId} to={door} />;
  }

  return (
    <div id="personPage" className="screen public-person">
      {/* A visitor's header; signed in, the Workspace's own stands over the
          page instead, with Back (the owner, 2026-10-11). */}
      {state.status === 'signed-in' ? null : <PublicHead />}
      {error ? (
        <div className="public-repo-error" id="personMissing">
          <h1>{error.status === 404 ? 'Nothing at this address' : 'This page is unavailable'}</h1>
          <p>{error.status === 404 ? `There is nobody at ${PUBLIC_ADDRESS_HOST}/${handle}.` : error.message}</p>
        </div>
      ) : null}
      {!answer && !error ? <div className="public-repo-loading" aria-label="Loading"><span className="skel line" /><span className="skel line two" /></div> : null}
      {answer?.kind === 'person' ? <PersonBody person={answer.person} /> : null}
    </div>
  );
}
