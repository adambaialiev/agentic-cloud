/**
 * One repository as Home lists it, and the key row under the list.
 *
 * The row talks about ACTIVITY, not policy: no "protected" label — the gate
 * shows itself where it acts, on the proposal flow. The whole row opens the
 * explorer, because there is nothing else on it to tap: the faces are
 * pictures rather than buttons, since a 16px second target inside a
 * full-width one is a mis-tap waiting to happen.
 */

import { useNavigate } from 'react-router-dom';
import type { WorkspaceRepoRow } from '../../../../src/shared/workspace-api.js';
import { toFor } from '../../routes.js';
import { bytes } from '../../ui/file-kind.js';
import { Icon, TypeIcon } from '../../ui/icons.js';
import { useOrgScope } from '../../workspace/useWorkspace.js';
import { PressableRow } from '../home/PressableRow.js';
import { proposalBadge, repoPushLine } from './repo-words.js';

export function RepoRow({ repo, waiting, now }: {
  repo: WorkspaceRepoRow;
  /** How many open proposals this repository is waiting on. The queue above
   *  shows THEM; the badge here says which repository they belong to. */
  waiting: number;
  now?: number;
}) {
  const navigate = useNavigate();
  const scope = useOrgScope();
  const to = toFor({ kind: 'repo', id: repo.name, ...scope });
  const push = repoPushLine(repo, now);
  // The `alt` is empty and the GROUP carries the names: three faces read out
  // as three separate "written by" is noise, and what the reader wants is the
  // list. Contributors, not the agent that ran `repo create` — a repository
  // is a place several agents work.
  const faces = repo.contributors ?? [];
  return (
    <PressableRow className="crow open" onPress={() => { if (to) navigate(to); }}>
      <TypeIcon glyph="folder" />
      <div className="main">
        <div className="name">{repo.name}</div>
        <div className="cline">
          {faces.length ? (
            <span className="faces" aria-label={`Written by ${faces.map((face) => face.name).join(', ')}`}>
              {faces.map((face) => <img className="face" key={face.name} src={face.agentAvatarUrl} alt="" />)}
            </span>
          ) : null}
          {push.branch
            ? <span className="branch"><Icon name="git" size={13} /><span className="bname">{push.branch}</span></span>
            : null}
          <span className="cwhen">{push.when}</span>
        </div>
      </div>
      {/* An agent has asked for something only the owner decides. The row says
          so because nothing else will: a state change sends no notification,
          so a request one screen deeper would wait unseen. */}
      {repo.deleteAsk ? <span className="badge warn">delete asked</span> : null}
      {repo.publicUrl ? <span className="badge ok">public</span> : null}
      {waiting ? <span className="badge">{proposalBadge(waiting)}</span> : null}
      <div className="cside">{bytes(repo.sizeBytes || 0)}</div>
    </PressableRow>
  );
}
