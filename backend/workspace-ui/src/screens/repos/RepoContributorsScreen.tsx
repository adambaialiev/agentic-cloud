/**
 * Everyone who has written this repository, on a screen of its own: the face,
 * the name, the ADDRESS git knows them by, and the numbers.
 *
 * The email is here and nowhere else. It is what actually IDENTIFIES a
 * contributor — two people can share a display name, and one person can
 * change theirs — and it is the answer to "who is the account owner", which
 * the summary cannot give and the row on Home has no room for.
 *
 * Its own screen because seventeen rows is a page, and the repository's own
 * screen is about the code.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { WorkspaceRepoContributorsAnswer } from '../../../../src/shared/workspace-api.js';
import { useSession } from '../../session/useSession.js';
import { TypeIcon } from '../../ui/icons.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { RepoCrumb } from './RepoCrumb.js';
import { repoReadError } from './repo-words.js';
import { count } from './repo-nav.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { FaceDoor } from '../../ui/FaceDoor.js';

export function RepoContributorsScreen() {
  const { id: repoName = '' } = useParams();
  const { api } = useSession();
  const { state } = useWorkspace();
  const [answer, setAnswer] = useState<WorkspaceRepoContributorsAnswer | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const read = await api.api<WorkspaceRepoContributorsAnswer>(
          `api/repos/${encodeURIComponent(repoName)}/contributors`, undefined,
        );
        if (current) setAnswer(read);
      } catch (error) {
        if (current) setLoadError(error);
      }
    })();
    return () => { current = false; };
  }, [api, repoName]);

  const people = answer?.contributors ?? [];
  return (
    <div className="screen" id="screenContributors">
      <ScreenTitle
        titleId="contributorsTitle"
        title={answer ? (people.length === 1 ? '1 contributor' : `${people.length} contributors`) : 'Contributors'}
        subNode={<RepoCrumb id="contributorsSub" repoName={repoName} path="" leaf="Contributors" />}
      />
      <div className="card" id="contributorsList">
        {loadError ? <div className="empty">{repoReadError(loadError, repoName, state?.org?.name)}</div> : null}
        {!answer && !loadError ? <div className="empty">Loading…</div> : null}
        {answer && people.length === 0 ? <div className="empty">No contributors to show yet.</div> : null}
        {people.map((person) => (
          <div className="crow" key={`${person.email}:${person.name}`}>
            {/* An agent brings its face; everyone else gets the same anonymous
                mark the app uses for a person, rather than a gap. */}
            {person.agentAvatarUrl
              ? (
                <FaceDoor
                  agentId={person.agentId}
                  agentName={person.name}
                  avatarUrl={person.agentAvatarUrl}
                  className="aface small"
                />
              )
              : <TypeIcon glyph="user" />}
            <div className="main">
              <div className="name plain">{person.name}</div>
              {person.email
                // Monospace, and allowed to ellipsise: an address is read
                // character by character when it is read at all, and it is
                // the longest thing here.
                ? <div className="cline"><span className="bname">{person.email}</span></div>
                : null}
              <div className="cline">
                <span className="cwhen">
                  {person.commits === 1 ? '1 commit' : `${count(person.commits)} commits`}
                </span>
                {/* Zero is still printed: "+0 −0" is a real fact about
                    someone whose commits only moved files about, and a blank
                    reads as missing. */}
                <span className="plus">+{count(person.insertions)}</span>
                <span className="minus">−{count(person.deletions)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
