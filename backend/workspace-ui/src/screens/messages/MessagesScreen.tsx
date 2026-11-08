import { useCallback, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { DirectMessageInbox } from '../../../../src/shared/direct-messages.js';
import type { WorkspaceOrgMember } from '../../../../src/shared/workspace-api.js';
import { ANSWER_UNREADABLE_CODE, ANSWER_UNREADABLE_SENTENCE, WorkspaceApiError } from '../../api/client.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { useBackClaim } from '../../chrome/useBack.js';
import { toFor } from '../../routes.js';
import { EmptyState } from '../../ui/EmptyState.js';
import { PersonFace } from '../../ui/PersonFace.js';
import { errorMessage } from '../../ui/format.js';
import { relative, useNow } from '../../ui/time.js';
import { PersonRow } from '../org/PersonRow.js';
import { useOrgApi, useOrgId } from '../org/useOrgApi.js';
import { usePeople } from '../org/usePeople.js';
import { isAnswerObject, isOpening, pollFailureLine, useMessagePoll, usePollMisses } from './useMessagePoll.js';

/** The same People plates in a transient picker, with the normal Back. */
function NewMessagePicker({ people, orgName, orgId, loading, error, close }: {
  people: WorkspaceOrgMember[];
  orgName: string;
  orgId: string | null;
  loading: boolean;
  error: string;
  close: () => void;
}) {
  useBackClaim(close);
  const navigate = useNavigate();
  const now = useNow(people.some(person => !person.here && Boolean(person.lastSeenAt)));
  return <div className="screen" id="screenNewMessage">
    <ScreenTitle title="New message" sub={orgName} />
    <div className="plates" aria-label="Choose a teammate">
      {people.map(person => <PersonRow key={person.userId} person={person} now={now}
        onOpen={() => navigate(toFor({ kind: 'directMessage', id: person.userId, orgId: orgId ?? undefined })!)} />)}
    </div>
    {!people.length ? <div className="card"><div className="empty">{error || (loading ? 'Loading people…' : 'No teammates to message yet.')}</div></div> : null}
  </div>;
}

export function MessagesScreen() {
  const api = useOrgApi(), orgId = useOrgId();
  const { people, org, loading, error: peopleError } = usePeople();
  const [inbox, setInbox] = useState<DirectMessageInbox | null>(null);
  const [error, setError] = useState(''), [choosing, setChoosing] = useState(false), [opening, setOpening] = useState(false);
  const closePicker = useCallback(() => setChoosing(false), []);
  // A missed read is quiet until it keeps missing (note #1069).
  const misses = usePollMisses();
  const read = useCallback(async (alive: () => boolean) => {
    try {
      const answer = await api.api<unknown>('api/messages');
      if (!isAnswerObject(answer)) throw new WorkspaceApiError(ANSWER_UNREADABLE_SENTENCE, 0, { error: ANSWER_UNREADABLE_SENTENCE, code: ANSWER_UNREADABLE_CODE });
      if (alive()) { misses.hit(); setInbox(answer as unknown as DirectMessageInbox); setError(''); setOpening(false); }
    } catch (err) {
      if (!alive()) return;
      if (isOpening(err)) { misses.hit(); setError(''); setOpening(true); return; }
      setOpening(false);
      if (err instanceof WorkspaceApiError && [401, 403, 404].includes(err.status)) { setError(errorMessage(err)); setInbox(null); return; }
      if (misses.miss()) setError(pollFailureLine(err));
    }
  }, [api, misses]);
  useMessagePoll(read);
  const address = (id: string) => toFor({ kind: 'directMessage', id, orgId: orgId ?? undefined })!;
  const peers = people.filter(person => !person.you);
  if (choosing) return <NewMessagePicker people={peers} orgName={org?.name ?? 'Your workplace'}
    orgId={orgId} loading={loading} error={peopleError} close={closePicker} />;

  return <div className="screen" id="screenMessages">
    <ScreenTitle title="Messages" sub={org?.name ?? 'Your workplace'} />
    {error ? <div className="hintblock" role="alert">{error} Retrying…</div> : null}
    <div className="card">
      {inbox?.threads.map(thread => <Link key={thread.person.userId} className="crow open" to={address(thread.person.userId)}>
        <PersonFace photoUrl={thread.person.photoUrl} />
        <div className="main">
          <div className="name plain">{thread.person.name}</div>
          <div className="cline">
            <span className="ctext">{thread.lastMessage.senderId !== thread.person.userId ? 'You: ' : ''}{thread.lastMessage.text}</span>
            <span className="cwhen">· {relative(thread.lastMessage.createdAt)}</span>
          </div>
          {thread.unread > 1 || !thread.person.available ? <div className="cline">
            {thread.unread > 1 ? `${thread.unread} unread messages` : ''}
            {!thread.person.available ? `${thread.unread > 1 ? ' · ' : ''}Left the workplace` : ''}
          </div> : null}
        </div>
        {thread.unread > 0 ? <span className="unreaddot" role="img" aria-label={`${thread.unread} unread messages`} /> : null}
      </Link>)}
      {!inbox?.threads.length ? inbox
        ? <EmptyState glyph="user" title="No conversations yet" body="Choose a teammate to say hello." />
        : <div className="empty" role="status">{error || (opening ? 'Opening messages…' : 'Loading messages…')}</div> : null}
      <button className="addrow" type="button" onClick={() => setChoosing(true)}>New message</button>
    </div>
  </div>;
}
