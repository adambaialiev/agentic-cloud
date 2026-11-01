/**
 * Every recent commit on the default branch, on a screen of its own. No glyph
 * per row — the whole screen is commits, so a mark saying "commit" on every
 * one says nothing — but a chevron, because these rows open the commit's own
 * diff.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { WorkspaceRepoCommitsAnswer } from '../../../../src/shared/workspace-api.js';
import { toFor } from '../../routes.js';
import { useSession } from '../../session/useSession.js';
import { Icon } from '../../ui/icons.js';
import { relative } from '../../ui/time.js';
import { useOrgScope, useWorkspace } from '../../workspace/useWorkspace.js';
import { CheckPip } from '../decisions/Checks.js';
import { PressableRow } from '../home/PressableRow.js';
import { RepoCrumb } from './RepoCrumb.js';
import { COMMITS_SHOWN, repoReadError } from './repo-words.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';

export function RepoHistoryScreen() {
  const { id: repoName = '' } = useParams();
  const { api } = useSession();
  const { state } = useWorkspace();
  const scope = useOrgScope();
  const navigate = useNavigate();
  const [answer, setAnswer] = useState<WorkspaceRepoCommitsAnswer | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const read = await api.api<WorkspaceRepoCommitsAnswer>(
          `api/repos/${encodeURIComponent(repoName)}/commits?limit=${COMMITS_SHOWN}`,
          undefined,
        );
        if (current) setAnswer(read);
      } catch (error) {
        if (current) setLoadError(error);
      }
    })();
    return () => { current = false; };
  }, [api, repoName]);

  const commits = answer?.commits ?? [];
  return (
    <div className="screen" id="screenCommits">
      <ScreenTitle
        titleId="commitsTitle"
        title="History"
        subNode={<RepoCrumb id="commitsSub" repoName={repoName} path="" leaf="History" />}
      />
      <div className="card" id="commitsList">
        {loadError ? <div className="empty">{repoReadError(loadError, repoName, state?.org?.name)}</div> : null}
        {!answer && !loadError ? <div className="empty">Loading…</div> : null}
        {answer && commits.length === 0 ? <div className="empty">No commits to show yet.</div> : null}
        {commits.map((commit) => {
          const to = toFor({ kind: 'repoCommit', id: repoName, sha: commit.sha, ...scope });
          return (
            <PressableRow className="crow open" key={commit.sha} onPress={() => { if (to) navigate(to); }}>
              <div className="main">
                <div className="name plain">{commit.subject || 'No message'}</div>
                <div className="cline">
                  <span className="ctext">{commit.authorName || 'Unknown'}</span>
                  <span className="cwhen">· {relative(commit.at)}</span>
                </div>
              </div>
              {commit.checks ? <CheckPip state={commit.checks.worst} /> : null}
              {/* Seven characters is what git itself shows and what a person
                  compares against a terminal; the full sha would take the row
                  and say no more. */}
              <div className="cside sha">{(commit.sha || '').slice(0, 7)}</div>
              <Icon name="chev" size={17} className="icon chev" />
            </PressableRow>
          );
        })}
      </div>
    </div>
  );
}
