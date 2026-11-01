/**
 * A repository's Overview: the work happening AROUND the code — the
 * proposals, what CI has been saying, who has written it, which rooms may use
 * it, and the one place in the product a repository can be deleted.
 *
 * Every card here describes the REPOSITORY, so all of them are drawn at its
 * root only (the screen enforces that). Each section holds its own shape
 * while its own request is in flight, in the real destination card rather
 * than in one temporary block above them, so a fast answer replaces its own
 * wait without making the other two move.
 *
 * A failed read says NOTHING rather than "there are none": it leaves whatever
 * is on screen alone. An empty section is absent entirely — never an empty
 * "Actions" card on the way to the files.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  WorkspaceRepoChecksAnswer,
  WorkspaceRepoContributorsAnswer,
  WorkspaceRepoProposalsAnswer,
} from '../../../../src/shared/workspace-api.js';
import { toFor } from '../../routes.js';
import { useSession } from '../../session/useSession.js';
import { Icon } from '../../ui/icons.js';
import { relative } from '../../ui/time.js';
import { useOrgScope } from '../../workspace/useWorkspace.js';
import { CheckRow } from '../decisions/Checks.js';
import { ProposalRow } from '../home/Decisions.js';
import { PressableRow } from '../home/PressableRow.js';
import { RepoCiSecrets } from './RepoCiSecrets.js';
import { RepoDanger } from './RepoDanger.js';
import { RepoPublicAccess } from './RepoPublicAccess.js';
import { RepoPublishing } from './RepoPublishing.js';
import { RepoRooms } from './RepoRooms.js';
import { CHECK_RUNS_SHOWN } from './repo-words.js';

/** How many proposals the card shows before it offers the rest. A screenful,
 *  then a tap: a repository with forty must not push its files off the page. */
const PRS_SHOWN = 5;

/** How many marks the collapsed contributors row carries before it stops. */
const CONTRIBUTOR_FACES_SHOWN = 5;

/** One section's wait, in the shape of the rows that will replace it. */
function SectionSkeleton({ kind, rows }: { kind: 'checks' | 'people' | 'proposal'; rows: number }) {
  const widths = kind === 'checks'
    ? [[44, 68, 42], [58, 51, 35]]
    : kind === 'people'
      ? [[39, 55, 9]]
      : [[64, 43, 61], [49, 58, 53]];
  return (
    <>
      {Array.from({ length: rows }, (_, at) => {
        const [first, second, side] = widths[at % widths.length]!;
        const delay = `${(at * 0.12).toFixed(2)}s`;
        return (
          <div className={kind === 'checks' ? 'checkrow' : 'crow'} key={at} aria-hidden="true">
            <span className={`skel skel-mark ${kind === 'checks' ? 'check' : kind}`} style={{ animationDelay: delay }} />
            <div className="main">
              <div className="skel skel-line" style={{ width: `${first}%`, animationDelay: delay }} />
              <div className="skel skel-line two" style={{ width: `${second}%`, animationDelay: delay }} />
            </div>
            <span className="skel skel-side" style={{ width: `${side}px`, animationDelay: delay }} />
          </div>
        );
      })}
    </>
  );
}

/** One repository read, with the two rules every section here follows: a
 *  failure leaves the card alone, and the answer is dropped if the screen has
 *  moved to another repository under it. */
function useRepoSection<T>(repoName: string, path: string) {
  const { api } = useSession();
  const [answer, setAnswer] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const read = await api.api<T>(`api/repos/${encodeURIComponent(repoName)}/${path}`, undefined);
        if (current) setAnswer(read);
      } catch {
        if (current) setFailed(true);
      }
    })();
    return () => { current = false; };
  }, [api, repoName, path]);
  return { answer, failed };
}

function RepoProposals({ repoName }: { repoName: string }) {
  const { answer, failed } = useRepoSection<WorkspaceRepoProposalsAnswer>(repoName, 'prs');
  const [all, setAll] = useState(false);
  const prs = answer?.prs ?? [];
  if (!answer && !failed) {
    return (
      <>
        <h2 id="repoPrsHead">Proposals</h2>
        <div className="card repo-skeleton" id="repoPrs" aria-busy="true">
          <span className="sr-only">Loading proposals…</span>
          <SectionSkeleton kind="proposal" rows={2} />
        </div>
      </>
    );
  }
  // A repository nobody has proposed anything on says nothing at all: an
  // empty card would be one more thing to read on the way to the files.
  if (prs.length === 0) {
    return (
      <>
        <h2 id="repoPrsHead" hidden>Proposals</h2>
        <div className="card" id="repoPrs" hidden />
      </>
    );
  }
  const shown = all ? prs : prs.slice(0, PRS_SHOWN);
  return (
    <>
      <h2 id="repoPrsHead">Proposals</h2>
      <div className="card" id="repoPrs">
        {/* `outcome` because this is the ONE list in the app where the states
            MIX — merged, rejected and open together — and mixed states are
            the whole question a repository's proposal list is asked. */}
        {shown.map((pr) => <ProposalRow key={pr.id} pr={pr} branch={pr.from} outcome />)}
        {prs.length > shown.length ? (
          <PressableRow className="crow open" onPress={() => setAll(true)}>
            <div className="main"><div className="name plain act">Show all {prs.length} proposals</div></div>
          </PressableRow>
        ) : null}
      </div>
    </>
  );
}

/**
 * The repository's recent CI activity, newest run first, whatever commit each
 * ran against. This list is where default-branch CI is findable at a glance:
 * deploys and main-branch checks never had a proposal card to show up on, and
 * per-commit pips make you hunt.
 */
function RepoChecks({ repoName }: { repoName: string }) {
  const { answer, failed } = useRepoSection<WorkspaceRepoChecksAnswer>(repoName, 'checks');
  const [limit, setLimit] = useState(CHECK_RUNS_SHOWN);
  const runs = answer?.runs ?? [];
  if (!answer && !failed) {
    return (
      <>
        <h2 id="repoChecksHead">Actions</h2>
        <div className="card repo-skeleton" id="repoChecks" aria-busy="true">
          <span className="sr-only">Loading actions…</span>
          <SectionSkeleton kind="checks" rows={2} />
        </div>
      </>
    );
  }
  if (runs.length === 0) {
    return (
      <>
        <h2 id="repoChecksHead" hidden>Actions</h2>
        <div className="card" id="repoChecks" hidden />
      </>
    );
  }
  return (
    <>
      <h2 id="repoChecksHead">Actions</h2>
      <div className="card" id="repoChecks">
        {/* Closed by default, unlike the proposal screen's card: there ONE
            failed check is why the reader came; here a list of runs with
            every red log unrolled would bury the repository under its
            history. */}
        {runs.slice(0, limit).map((run) => (
          <CheckRow check={run} key={`${run.sha}:${run.context}`} side={relative(run.startedAt)} startClosed />
        ))}
        {runs.length > limit ? (
          <PressableRow className="crow open" onPress={() => setLimit(runs.length)}>
            <div className="main"><div className="name plain act">Show all {runs.length} runs</div></div>
          </PressableRow>
        ) : null}
      </div>
    </>
  );
}

/**
 * Who has written this repository, and how much of it — EVERYONE, unlike the
 * row on Home: the owner's own commits and anything a collaborator pushed
 * belong in the count, and only the agents among them have a face to draw.
 *
 * ONE row: the faces, how many people, and the way in. The full list lived
 * here first and pushed the proposals, the actions and the files off the
 * screen — seventeen contributors is a page of its own, not the thing you
 * read on the way to the code.
 */
function RepoPeople({ repoName }: { repoName: string }) {
  const { answer, failed } = useRepoSection<WorkspaceRepoContributorsAnswer>(repoName, 'contributors');
  const navigate = useNavigate();
  const scope = useOrgScope();
  const people = answer?.contributors ?? [];
  if (!answer && !failed) {
    return (
      <div className="card repo-skeleton" id="repoPeople" aria-busy="true">
        <span className="sr-only">Loading contributors…</span>
        <SectionSkeleton kind="people" rows={1} />
      </div>
    );
  }
  // A failed count says nothing, which is not "nobody has written this".
  if (people.length === 0) return <div className="card" id="repoPeople" hidden />;
  const to = toFor({ kind: 'repoContributors', id: repoName, ...scope });
  const named = people.slice(0, 3).map((person) => person.name).join(', ')
    + (people.length > 3 ? ` and ${people.length - 3} more` : '');
  return (
    <div className="card" id="repoPeople">
      <PressableRow className="crow open" onPress={() => { if (to) navigate(to); }}>
        <span className="faces">
          {people.slice(0, CONTRIBUTOR_FACES_SHOWN).map((person) => (person.agentAvatarUrl
            ? <img className="face" key={person.email} src={person.agentAvatarUrl} alt="" />
            // Everyone counts towards the summary, including the people with
            // no picture: a stack that silently skipped them would say five
            // where the list says nine.
            : <span className="face dot" key={person.email}><Icon name="user" size={11} /></span>))}
        </span>
        <div className="main">
          <div className="name plain">
            {people.length === 1 ? '1 contributor' : `${people.length} contributors`}
          </div>
          {/* The top few by name, in the order they are ranked — the same
              answer the faces give, for a reader who cannot see them. */}
          <div className="cline"><span className="ctext">{named}</span></div>
        </div>
        <Icon name="chev" size={17} className="icon chev" />
      </PressableRow>
    </div>
  );
}

export function RepoOverview({ repoName }: { repoName: string }) {
  return (
    <>
      <RepoProposals repoName={repoName} />
      <RepoChecks repoName={repoName} />
      {/* Who wrote it, under everything happening around the repository:
          seventeen rows at the top pushed the proposals and actions off the
          screen. Above the danger zone, which stays last. */}
      <RepoPeople repoName={repoName} />
      <RepoPublicAccess repoName={repoName} />
      <RepoCiSecrets repoName={repoName} />
      <RepoPublishing repoName={repoName} />
      <RepoRooms repoName={repoName} />
      <RepoDanger repoName={repoName} />
    </>
  );
}
