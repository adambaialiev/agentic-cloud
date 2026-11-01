/**
 * What HAPPENED in a public repository, at its address (the owner,
 * 2026-09-27): the default branch's whole history, one commit's diff, every
 * proposal ever shown, and one proposal whole. Four pages, one shape — the
 * public header, the `workplace / repository` name, the Code · History ·
 * Proposals tabs — and the same rule as the tree: a signed-in member of the
 * workplace is sent on to the member's own screen for the same thing, and
 * what a stranger reads is exactly what the public API answers (no checks,
 * no faces, no margins).
 *
 * The diff goes through the shell's ONE diff renderer, for the reason the
 * commit screen gives: a diff is a diff.
 */

import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type {
  WorkspacePublicRepoAboutAnswer,
  WorkspacePublicRepoCommitAnswer,
  WorkspacePublicRepoCommitsAnswer,
  WorkspacePublicRepoProposalAnswer,
  WorkspacePublicRepoProposalRow,
  WorkspacePublicRepoProposalsAnswer,
} from '../../../../src/shared/workspace-api.js';
import { Diff } from '../../render/Diff.js';
import { Markdown } from '../../render/Markdown.js';
import { toFor } from '../../routes.js';
import { Icon, TypeIcon } from '../../ui/icons.js';
import { relative } from '../../ui/time.js';
import { MemberDoor } from './MemberDoor.js';
import { PublicError, PublicHead, PublicLoading, PublicRepoName, PublicRepoTabs } from './PublicRepoScreen.js';
import { commitLine, publicPageEndpoint, publicPagePath, usePublicRead, type PublicRepoAddress } from './public-repo.js';
import { count } from './repo-nav.js';

/** What became of a proposal, in the words and hues the member's lists use. */
const STATE_TEXT: Record<string, { label: string; tone: string }> = {
  open: { label: 'Awaiting approval', tone: '' },
  merged: { label: 'Merged', tone: ' ok' },
  rejected: { label: 'Rejected', tone: ' mut' },
  withdrawn: { label: 'Withdrawn', tone: ' mut' },
  stale: { label: 'Went stale', tone: ' mut' },
  conflict: { label: 'Conflict', tone: ' warn' },
};

function ProposalState({ status }: { status: string }) {
  const state = STATE_TEXT[status];
  return <span className={`prstate${state ? state.tone : ' mut'}`}>{state ? state.label : String(status || '')}</span>;
}

function DiffStat({ stat }: { stat?: { insertions: number; deletions: number } }) {
  if (!stat) return null;
  return <span className="stat"><span className="plus">+{count(stat.insertions)}</span><span className="minus">−{count(stat.deletions)}</span></span>;
}

function useTitle(title: string) {
  useEffect(() => { document.title = title; }, [title]);
}

/**
 * The frame the pages share. `member` is where a member goes instead, in
 * which workplace.
 */
function PublicPage({ door, current, answer, member, error, title, children }: {
  door: PublicRepoAddress;
  current: 'commits' | 'proposals' | 'code';
  answer: { name: string } | null;
  member: { orgId: string; to: string } | null;
  error: { status: number; message: string } | null;
  title: string;
  children: ReactNode;
}) {
  useTitle(answer ? `${title} · ${door.handle}/${answer.name}` : title);
  if (member) return <MemberDoor orgId={member.orgId} to={member.to} />;
  const missing = Boolean(error && error.status === 404);
  return (
    <div id="publicRepo" className="screen">
      <PublicHead />
      {error ? <PublicError missing={missing} message={error.message} door={door} /> : null}
      {!answer && !error ? <PublicLoading /> : null}
      {answer ? (
        <>
          <PublicRepoName door={door} name={answer.name} />
          <PublicRepoTabs door={door} current={current} />
          {children}
        </>
      ) : null}
    </div>
  );
}

export function PublicRepoHistoryScreen({ door }: { door: PublicRepoAddress }) {
  const { answer, member, error } = usePublicRead<WorkspacePublicRepoCommitsAnswer>(publicPageEndpoint(door, 'commits'));
  const to = member ? { orgId: member.orgId, to: toFor({ kind: 'repoHistory', id: door.repo, orgId: member.orgId })! } : null;
  const commits = answer?.commits ?? [];
  return (
    <PublicPage door={door} current="commits" answer={answer} member={to} error={error} title="History">
      <div className="filebar">
        <div className="kind branch">
          {answer?.branch ? <><Icon name="git" size={13} /><span>{answer.branch}</span></> : null}
        </div>
        {commits.length ? <div className="kind count">{commits.length === 1 ? '1 commit' : `${count(commits.length)} commits`}</div> : null}
      </div>
      <div className="card public-repo-rows" id="publicRepoCommits">
        {commits.length === 0 ? <div className="empty">No commits to show yet.</div> : null}
        {commits.map((commit) => (
          <Link className="crow open" key={commit.sha} to={publicPagePath(door, 'commits', commit.sha)}>
            <div className="main">
              <div className="name plain">{commit.subject || 'No message'}</div>
              <div className="cline"><span className="ctext">{commitLine(commit)}</span></div>
            </div>
            <div className="cside sha">{commit.sha.slice(0, 7)}</div>
            <Icon name="chev" size={17} className="icon chev" />
          </Link>
        ))}
      </div>
    </PublicPage>
  );
}

export function PublicRepoCommitScreen({ door, sha }: { door: PublicRepoAddress; sha: string }) {
  const { answer, member, error } = usePublicRead<WorkspacePublicRepoCommitAnswer>(publicPageEndpoint(door, 'commits', sha));
  const to = member ? { orgId: member.orgId, to: toFor({ kind: 'repoCommit', id: door.repo, sha, orgId: member.orgId })! } : null;
  const stat = answer?.diffStat;
  return (
    <PublicPage door={door} current="commits" answer={answer} member={to} error={error} title={answer?.subject || 'Commit'}>
      {answer ? (
        <div id="publicRepoCommit">
          <h2 className="public-repo-subject">{answer.subject || 'No message'}</h2>
          <div className="sub">
            {commitLine(answer)}
            {answer.parents.length > 1 ? ' · merge' : ''}
            <span className="sha"> · {answer.sha.slice(0, 7)}</span>
          </div>
          {answer.body ? <div className="hintline commitbody">{answer.body}</div> : null}
          {stat ? (
            <div className="hintline">
              {stat.files === 1 ? '1 file changed' : `${count(stat.files)} files changed`}
              {' '}
              <DiffStat stat={stat} />
            </div>
          ) : null}
          {answer.patch
            ? <Diff patch={answer.patch} open />
            : <div className="hintline">This commit changed no files.</div>}
          {answer.patchTruncated ? <div className="hintline">The rest of this diff is too large to show here.</div> : null}
        </div>
      ) : null}
    </PublicPage>
  );
}

/** When a proposal's row dates itself: by its decision once it has one. */
function proposalWhen(pr: WorkspacePublicRepoProposalRow): string {
  if (pr.status === 'conflict') return `with ${pr.to}`;
  return relative(pr.decidedAt ?? pr.createdAt);
}

export function PublicRepoProposalsScreen({ door }: { door: PublicRepoAddress }) {
  const { answer, member, error } = usePublicRead<WorkspacePublicRepoProposalsAnswer>(publicPageEndpoint(door, 'proposals'));
  const to = member ? { orgId: member.orgId, to: toFor({ kind: 'repo', id: door.repo, orgId: member.orgId })! } : null;
  const prs = answer?.prs ?? [];
  return (
    <PublicPage door={door} current="proposals" answer={answer} member={to} error={error} title="Proposals">
      <div className="filebar">
        <div className="kind">{prs.length === 1 ? '1 proposal' : `${count(prs.length)} proposals`}</div>
      </div>
      <div className="card public-repo-rows" id="publicRepoProposals">
        {prs.length === 0 ? <div className="empty">No proposals yet.</div> : null}
        {prs.map((pr) => (
          <Link className="crow open" key={pr.number} to={publicPagePath(door, 'proposals', String(pr.number))}>
            <div className="main">
              <div className="name plain">{pr.title}</div>
              <div className="cline">
                <ProposalState status={pr.status} />
                <span className="branch"><Icon name="git" size={13} /><span className="bname">{pr.from}</span></span>
                <span className="cwhen">· {proposalWhen(pr)}</span>
              </div>
            </div>
            <span className="cside num">#{pr.number}</span>
            <DiffStat stat={pr.diffStat} />
            <Icon name="chev" size={17} className="icon chev" />
          </Link>
        ))}
      </div>
    </PublicPage>
  );
}

export function PublicRepoProposalScreen({ door, number }: { door: PublicRepoAddress; number: string }) {
  const { answer, member, error } = usePublicRead<WorkspacePublicRepoProposalAnswer, { orgId: string; id: string }>(
    publicPageEndpoint(door, 'proposals', number),
  );
  const to = member ? { orgId: member.orgId, to: toFor({ kind: 'pr', id: member.id })! } : null;
  const pr = answer?.pr;
  return (
    <PublicPage door={door} current="proposals" answer={answer} member={to} error={error} title={pr ? `#${pr.number} ${pr.title}` : 'Proposal'}>
      {answer && pr ? (
        <div id="publicRepoProposal">
          <h2 className="public-repo-subject">{pr.title}</h2>
          <div className="sub public-repo-prline">
            <ProposalState status={pr.status} />
            <span className="branch"><Icon name="git" size={13} /><span className="bname">{pr.from}</span></span>
            <span> → {pr.to}</span>
            <span className="num"> · #{pr.number}</span>
          </div>
          <div className="sub">
            {pr.agentName ? `${pr.agentName} · ` : ''}
            {`proposed ${relative(pr.createdAt)}`}
            {pr.decidedAt && pr.status !== 'open' ? ` · ${STATE_TEXT[pr.status]?.label.toLowerCase() ?? pr.status} ${relative(pr.decidedAt)}` : ''}
          </div>
          {pr.body ? <div className="card readme public-repo-prbody"><Markdown source={pr.body} /></div> : null}
          {answer.commits.length ? (
            <div className="card public-repo-rows" id="publicRepoProposalCommits">
              {answer.commits.map((commit, index) => {
                const body = (
                  <>
                    <div className="main">
                      <div className="name plain">{commit.subject || 'No message'}</div>
                      {commit.at ? <div className="cline"><span className="cwhen">{relative(commit.at)}</span></div> : null}
                    </div>
                    {commit.sha ? <div className="cside sha">{commit.sha.slice(0, 7)}</div> : null}
                  </>
                );
                return commit.sha
                  ? <Link className="crow open" key={commit.sha} to={publicPagePath(door, 'commits', commit.sha)}>{body}</Link>
                  : <div className="crow" key={`${index}:${commit.subject}`}>{body}</div>;
              })}
            </div>
          ) : null}
          {pr.diffStat ? (
            <div className="hintline">
              {pr.diffStat.files === 1 ? '1 file changed' : pr.diffStat.files ? `${count(pr.diffStat.files)} files changed` : ''}
              {' '}
              <DiffStat stat={pr.diffStat} />
            </div>
          ) : null}
          {answer.patch
            ? <Diff patch={answer.patch} />
            : <div className="hintline">{answer.compareError ?? 'This proposal changed no files.'}</div>}
          {answer.patchTruncated ? <div className="hintline">The rest of this diff is too large to show here.</div> : null}
        </div>
      ) : null}
    </PublicPage>
  );
}

/**
 * Everyone who wrote this repository, as git counted them: the name and the
 * numbers. No address (it is what identifies a person, and this is a page a
 * stranger reads), no face, no door to an agent. Ranked as the member's
 * screen ranks them — by commits.
 */
export function PublicRepoContributorsScreen({ door }: { door: PublicRepoAddress }) {
  const { answer, member, error } = usePublicRead<WorkspacePublicRepoAboutAnswer>(publicPageEndpoint(door, 'about'));
  const to = member ? { orgId: member.orgId, to: toFor({ kind: 'repoContributors', id: door.repo, orgId: member.orgId })! } : null;
  const people = answer?.contributors ?? [];
  return (
    <PublicPage door={door} current="code" answer={answer} member={to} error={error} title="Contributors">
      <div className="filebar">
        <div className="kind">{people.length === 1 ? '1 contributor' : `${count(people.length)} contributors`}</div>
        {answer?.countedAt ? <div className="kind count">counted {relative(answer.countedAt) || 'just now'}</div> : null}
      </div>
      <div className="card public-repo-rows" id="publicRepoContributors">
        {people.length === 0 ? <div className="empty">No contributors to show yet.</div> : null}
        {people.map((person, index) => (
          <div className="crow" key={`${index}:${person.name}`}>
            {person.avatarUrl
              ? <img className="aface small" src={person.avatarUrl} alt="" />
              : <TypeIcon glyph="user" />}
            <div className="main">
              <div className="name plain">{person.name}</div>
              <div className="cline"><span className="ctext">{person.commits === 1 ? '1 commit' : `${count(person.commits)} commits`}</span></div>
            </div>
            <DiffStat stat={person} />
          </div>
        ))}
      </div>
    </PublicPage>
  );
}
