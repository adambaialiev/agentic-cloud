/**
 * The PEOPLE of this workplace in Home's Workplace window, drawn exactly as
 * the fleet is: one plate each, the same face-name-facts-state shape an
 * agent's row has, in the same two-column deck — and under each person the
 * agents they drive, with what each is doing.
 *
 * Back on 2026-10-28 (Adam: "let's bring back the team UI where I can see
 * my teammates and their statuses and what their agents cooking"). Note
 * #634 had moved it into the account menu's People row, and note #205 hid
 * that row too while inviting was off; a team is the product again, so the
 * deck stands wherever the workplace can have one (`workplaceHasTeam`).
 * `WorkplacePanel` decides that, so a workplace of one that nobody can join
 * does not even make the read.
 *
 * It stands right after the agent counts, before the direct channels:
 * how much is running is the first question the window answers (note
 * #614), who is driving it the second. People belong to the workplace, not
 * to a room — `usePeople()` is keyed on the workplace alone — so the deck
 * reads the same whichever room the chat is in.
 *
 * The plates come from `usePeople()` — the People page's own read, so the
 * two lists cannot disagree — and its tick runs only when somebody else is
 * in the workplace. Inviting a person is not a plate here: it is "Invite to
 * this workplace" in the workplace switch's menu (note #620).
 *
 * The heading paints before the read lands, off the member count the state
 * payload already carries, and holds the deck's shape with a plate-shaped
 * skeleton apiece. The window must not jump as it opens.
 */

import { useNavigate } from 'react-router-dom';
import { Svg } from '../../ui/icons.js';
import { useNow } from '../../ui/time.js';
import { toFor } from '../../routes.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { peopleClockMoves } from '../org/people-words.js';
import { PersonRow } from '../org/PersonRow.js';
import { usePeople } from '../org/usePeople.js';

/** A GLIMPSE, as Notes is: three rows of plates, then the door onto the page
 *  that holds everyone. The window stays a page you can read to the bottom. */
const SHOWN = 6;

/** Stands where a card will, in the card's own shape (note #833), while the
 *  first read is in flight. */
function PersonSkeleton() {
  return (
    <div className="crow personplate" aria-hidden="true">
      <div className="personhead">
        <span className="skel face" />
        <div className="personwho">
          <div className="skel line" style={{ width: '58%' }} />
          <div className="skel line two" style={{ width: '34%' }} />
        </div>
      </div>
    </div>
  );
}

export function People() {
  const { state } = useWorkspace();
  const { people, loading, error } = usePeople();
  const navigate = useNavigate();
  const org = state?.org ?? null;
  // "Active 4m ago" and a recap's "ago" move by themselves; tick the clock
  // only while a row says one of them.
  const now = useNow(peopleClockMoves(people));
  if (!org) return <div id="peopleSection" hidden />;

  const orgId = org.orgId;
  const shown = people.slice(0, SHOWN);
  const here = people.filter((person) => person.here).length;
  const known = people.length > 0;
  // Before the rows land — and if they never do — the count the state
  // payload already carries. Who is HERE is not in that payload, so the
  // heading simply does not say until the rows can answer it.
  const total = known ? people.length : org.members;
  const waiting = !known && loading && !error;
  const countLabel = known
    ? `${total} ${total === 1 ? 'person' : 'people'} in this workplace, ${here} here now`
    : `${total} ${total === 1 ? 'person' : 'people'} in this workplace`;
  return (
    <div id="peopleSection">
      <h2 className="agentshead homehead" id="peopleHead">
        <span>People</span>
        <span className="agentcounts" id="peopleCounts" aria-label={countLabel}>
          <span>{total} total</span>
          {known ? <><span className="sep"> · </span><span className="active">{here} here</span></> : null}
        </span>
      </h2>
      <div id="homePeople" className="plates peopleplates">
        {waiting
          ? Array.from({ length: Math.max(1, Math.min(org.members, SHOWN)) }, (_, index) => <PersonSkeleton key={index} />)
          : error && people.length === 0
            ? <div className="empty">{error}</div>
            : (
              <>
                {shown.map((person) => (
                  <PersonRow
                    key={person.userId}
                    person={person}
                    now={now}
                    onOpen={() => navigate(toFor({ kind: 'organizationMember', id: person.userId, orgId })!)}
                    messageTo={state?.messagesAvailable && !person.you ? toFor({ kind: 'directMessage', id: person.userId, orgId }) : null}
                  />
                ))}
                {people.length > SHOWN
                  ? (
                    <button className="addrow" id="allPeopleBtn" type="button" onClick={() => navigate(toFor({ kind: 'organizationPeople', orgId })!)}>
                      <span className="iconbox dim"><Svg name="user" size={18} /></span>
                      <span>All {people.length} people</span>
                    </button>
                  )
                  : null}
              </>
            )}
      </div>
    </div>
  );
}
