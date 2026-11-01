/**
 * The repository's remove/delete action, and the one request an agent can
 * leave beside it: the delete. (CI secrets and publishing on approval used to
 * be asked here too; since note #739 an admin's agent applies them at once
 * and the owner is told — RepoCiSecrets and RepoPublishing show what stands.)
 *
 * From its home room this screen is the ONLY place a repository can be
 * deleted: no agent can, and no chat card does. From any additional room the
 * same position removes only that room's grant, leaving the bytes and every
 * other room untouched (note #498).
 *
 * The confirmation is the app's type-the-name gate. That is deliberate: the
 * delete used to lean on the undo behind it, a Restore button waiting in the
 * list for fourteen days, and the list is no longer where that promise is
 * kept. The recoverability is unchanged — any agent brings a repository back
 * inside the window — but a delete that leaves the screen clean has to be a
 * delete nobody reaches by accident.
 */

import { overviewTo } from '../home/home-address.js';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBanner } from '../../chrome/useBanner.js';
import { useSession } from '../../session/useSession.js';
import { AskByTyping } from '../../ui/Ask.js';
import { errorMessage } from '../../ui/format.js';
import { relative } from '../../ui/time.js';
import { askedOf } from '../../ui/ask-words.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';

/** Only the owner of the agent that asked may answer it — and on shared
 *  workplace code that owner must also be an admin. */
const NOT_YOURS_DELETE = 'Only the owner of the agent that made this request can decide it. '
  + 'Destructive workplace actions also require that owner to be an admin.';

export function RepoDanger({ repoName }: { repoName: string }) {
  const { state, reload } = useWorkspace();
  const { api } = useSession();
  const banner = useBanner();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);

  const repo = (state?.repos ?? []).find((entry) => entry.name === repoName) ?? null;
  const deleteAsk = repo?.deleteAsk;
  const canManage = !state?.org || state.org.role === 'admin';
  // A repository belongs to the workplace (note #566): there is no "this room
  // only shares it" any more, so the one thing to do here is delete it.
  if (!repo || (!canManage && !deleteAsk)) return <div id="repoDanger" hidden />;

  const path = `api/repos/${encodeURIComponent(repoName)}`;

  const keep = () => {
    setBusy(true);
    void (async () => {
      try {
        await api.api(`${path}/keep`, { method: 'POST' });
        banner.show(`Kept ${repoName} — the agent has been told.`, true);
        await reload();
      } catch (error) {
        banner.show(errorMessage(error));
      } finally {
        setBusy(false);
      }
    })();
  };

  const erase = (confirmed: boolean) => {
    setAsking(false);
    if (!confirmed) return;
    setBusy(true);
    void (async () => {
      try {
        await api.api(path, { method: 'DELETE' });
        // The place itself is gone, so the child address goes with it: the
        // overview's repositories rather than a repository screen that would
        // 404 on its next read.
        navigate(overviewTo(state?.org?.orgId, { half: 'workplace' }), { replace: true });
        banner.show(`Deleted ${repoName} — an agent can bring it back for 14 days.`, true);
        await reload();
      } catch (error) {
        banner.show(errorMessage(error));
        setBusy(false);
      }
    })();
  };

  const deleteDecidable = !deleteAsk || deleteAsk.canDecide !== false;
  return (
    <div id="repoDanger">
      {/* An agent asked. Say who, and offer the other answer as plainly as
          this one — a request with only one button on it is not a decision. */}
      {deleteAsk ? (
        <div className="asked">
          {`${askedOf(deleteAsk)} to delete this repository${deleteAsk.at ? ` · ${relative(deleteAsk.at)}` : ''}`}
        </div>
      ) : null}
      <div className="danger-actions">
        {deleteDecidable ? (
          <button className="btn danger bare" type="button" disabled={busy} onClick={() => setAsking(true)}>
            {busy ? 'Deleting…' : 'Delete this repository'}
          </button>
        ) : null}
        {deleteAsk && deleteAsk.canDecide !== false ? (
          <button className="btn ghost bare" type="button" disabled={busy} onClick={keep}>Keep it</button>
        ) : null}
      </div>
      {deleteAsk && !deleteDecidable
        ? <div className="hintblock">{NOT_YOURS_DELETE}</div>
        : (
          <div className="hintblock">
            Deleting takes the repository out of your account, with its history and any proposals still
            waiting. For 14 days any agent can bring it back; after that it is gone.
          </div>
        )}
      {asking ? (
        <AskByTyping
          name={repoName}
          lines={[
            'Its code, its history and any proposals still waiting go with it, and it leaves your list straight away.',
            'For 14 days you can ask any agent to bring it back.',
          ]}
          verb="Delete"
          onAnswer={erase}
        />
      ) : null}
    </div>
  );
}
