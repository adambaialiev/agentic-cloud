/**
 * Home's Repositories card: what the agents BUILD, most recently touched
 * first, closed by the one footer strip the whole namespace shares: the
 * storage it has used, and the git key for cloning it.
 *
 * No deleted repositories follow the live ones. One used to wait here for
 * fourteen days with a Restore button, and the list was the wrong place to
 * keep that promise: what you own ended, every time, with something you had
 * already thrown away. The undo did not go anywhere — an agent still restores
 * a repository inside the window — but the safety now sits in FRONT of the
 * delete, in the name the dialog makes you type.
 */

import { bytes } from '../../ui/file-kind.js';
import { EmptyState } from '../../ui/EmptyState.js';
import { useNow } from '../../ui/time.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { GitAccessRow } from '../repos/GitAccessRow.js';
import { RepoRow } from '../repos/RepoRow.js';
import { reposByActivity } from '../repos/repo-words.js';

export function Repositories() {
  const { state } = useWorkspace();
  const now = useNow(false);
  const repos = state?.repos ?? null;
  const quota = state?.quota;
  const ordered = repos ? reposByActivity(repos) : null;
  // How many open proposals each repository is waiting on.
  const waiting = new Map<string, number>();
  for (const pr of state?.prs ?? []) waiting.set(pr.repoName, (waiting.get(pr.repoName) ?? 0) + 1);
  return (
    <>
      <h2 className="homehead">Repositories</h2>
      <div className="card">
        <div id="repos">
          {!ordered
            ? <div className="empty">Repository hosting is not available right now.</div>
            : ordered.length === 0
              ? (
                <EmptyState
                  glyph="git"
                  tint="code"
                  title="Give the work a durable home"
                  body="Repositories keep code, history, and proposed changes together. Every agent shares them — ask any agent to create the first one."
                />
              )
              : ordered.map((repo) => (
                <RepoRow key={repo.name} repo={repo} waiting={waiting.get(repo.name) ?? 0} now={now} />
              ))}
        </div>
        {/* ONE footer strip closes the card, holding the two facts that
            belong to the whole namespace rather than to any one repository:
            what the shelf has used, and the key for cloning it. The key was
            a full row in the list before (note #360), which gave a settings
            panel the same weight — the same icon column, the same title, the
            same second line — as the repositories above it. Down here it is
            a quiet line, and the list is only repositories again.

            The key is not offered under the EMPTY state: there is nothing to
            clone yet, and a key there answers a question nobody has. The
            storage line still is — an empty shelf has a size. */}
        {quota || ordered?.length
          ? (
            <div className="repofoot">
              {quota
                ? (
                  <div className="quota" id="quota">
                    Storage: {bytes(quota.userUsedBytes)} of {bytes(quota.userMaxBytes)} used
                  </div>
                )
                : null}
              {ordered?.length ? <GitAccessRow cloneExample={ordered[0]!.cloneUrl} /> : null}
            </div>
          )
          : null}
      </div>
    </>
  );
}
