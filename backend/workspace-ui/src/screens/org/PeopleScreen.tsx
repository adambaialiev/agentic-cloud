/**
 * The workplace's people (`/workplace/people?org=`, note #328), drawn
 * the way Home draws its fleet: one plate per person with their face, their
 * name, a quiet line of facts, a state line and the latest thing they drove
 * here. Each plate opens the member's own screen.
 *
 * The rows, their order and the tick that keeps two of their facts current
 * all live in `usePeople()` — the same read Home's people section makes, so
 * both lists say the same thing about the same person.
 */

import { useNavigate } from 'react-router-dom';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { useNow } from '../../ui/time.js';
import { toFor } from '../../routes.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { PersonRow } from './PersonRow.js';
import { peopleClockMoves, peopleSubLine, peopleWorkedLine } from './people-words.js';
import { workplaceHasTeam } from './org-words.js';
import { usePeople } from './usePeople.js';

export function PeopleScreen() {
  const { state } = useWorkspace();
  const navigate = useNavigate();
  const { org, people, error } = usePeople();
  const orgId = org?.orgId ?? state?.org?.orgId ?? '';
  // "Active 4m ago" and a recap's "ago" move by themselves; tick the clock
  // only while a row says one of them.
  const now = useNow(peopleClockMoves(people));
  const title = org?.name ?? state?.org?.name ?? 'Workplace';
  const team = workplaceHasTeam({ members: Math.max(people.length, state?.org?.members ?? 0) }, state?.invitesClosed);

  return (
    <div className="screen" id="screenPeople">
      <ScreenTitle
        titleId="peopleTitle"
        title="People"
        subId="peopleSub"
        // No head count in a workplace of one nobody can join (note #205).
        sub={org ? [title, team ? peopleSubLine(people) : '', peopleWorkedLine(org)].filter(Boolean).join(' · ') : ''}
      />
      {!org
        ? <div className="card"><div className="empty">{error || 'Loading…'}</div></div>
        : (
          <div id="people" className="plates peopleplates">
            {people.map((person) => (
              <PersonRow
                key={person.userId}
                person={person}
                now={now}
                showRole={team}
                onOpen={() => navigate(toFor({ kind: 'organizationMember', id: person.userId, orgId })!)}
                messageTo={state?.messagesAvailable && !person.you ? toFor({ kind: 'directMessage', id: person.userId, orgId }) : null}
              />
            ))}
          </div>
        )}
    </div>
  );
}
