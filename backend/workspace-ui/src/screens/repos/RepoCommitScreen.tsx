/**
 * One commit: what it says, what it changed, and whatever CI said about it.
 *
 * The diff goes through the shell's ONE diff renderer — the same cards, the
 * same colours and the same per-file counts a proposal's diff wears, because
 * a diff is a diff and two renderers would be free to disagree about what a
 * removed line looks like.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { WorkspaceRepoCommitAnswer } from '../../../../src/shared/workspace-api.js';
import { Diff } from '../../render/Diff.js';
import { useSession } from '../../session/useSession.js';
import { relative } from '../../ui/time.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { ChecksCard } from '../decisions/Checks.js';
import { RepoCrumb } from './RepoCrumb.js';
import { repoReadError } from './repo-words.js';
import { count } from './repo-nav.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';

export function RepoCommitScreen() {
  const { id: repoName = '', sha = '' } = useParams();
  const { api } = useSession();
  const { state } = useWorkspace();
  const [commit, setCommit] = useState<WorkspaceRepoCommitAnswer | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const read = await api.api<WorkspaceRepoCommitAnswer>(
          `api/repos/${encodeURIComponent(repoName)}/commit/${encodeURIComponent(sha)}`,
          undefined,
        );
        if (current) setCommit(read);
      } catch (error) {
        if (current) setLoadError(error);
      }
    })();
    return () => { current = false; };
  }, [api, repoName, sha]);

  const stat = commit?.diffStat;
  return (
    <div className="screen" id="screenPrDiff">
      <ScreenTitle
        titleId="prDiffTitle"
        title={commit?.subject || 'Commit'}
        subNode={<RepoCrumb id="prDiffSub" repoName={repoName} path="" leaf={sha.slice(0, 7)} />}
      />
      <div id="prDiffBody">
        {loadError ? <div className="empty">{repoReadError(loadError, repoName, state?.org?.name)}</div> : null}
        {!commit && !loadError ? <div className="empty">Loading…</div> : null}
        {commit ? (
          <>
            <div className="sub who">
              <div className="proposalby">
                <div>
                  {commit.authorName || 'Unknown'}
                  {commit.at ? ` · ${relative(commit.at)}` : ''}
                  {/* A merge has more than one parent, and that is the whole
                      explanation for a diff that looks unexpectedly small. */}
                  {commit.parents.length > 1 ? ' · merge' : ''}
                </div>
              </div>
            </div>
            {commit.body ? <div className="hintline commitbody">{commit.body}</div> : null}
            {stat ? (
              <div className="hintline">
                {stat.files === 1 ? '1 file changed' : `${count(stat.files)} files changed`}
                {' '}
                <span className="plus">+{count(stat.insertions)}</span>
                <span className="minus">−{count(stat.deletions)}</span>
              </div>
            ) : null}
            {commit.checks?.length ? <ChecksCard checks={commit.checks} /> : null}
            {commit.patch
              ? <Diff patch={commit.patch} open />
              : <div className="hintline">This commit changed no files.</div>}
            {commit.patchTruncated
              ? <div className="hintline">The rest of this diff is too large to show here.</div>
              : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
