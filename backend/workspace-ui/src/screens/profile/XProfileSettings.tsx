/**
 * Settings → Your builder page: the X profile the page's Follow on X button
 * links to (the owner, 2026-10-10).
 *
 * Until note #824 (Adam, 28 Oct 2026) this was Settings → Leaderboard, with
 * a switch that took a person off the public board; the board went, and a
 * person's numbers are shown to them alone (the founder's to anyone, as the
 * front page shows them), so the switch went with it and the X row stayed.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { normalizeXHandle } from '../../../../src/shared/leaderboard.js';
import type { WorkspaceXProfileSettings } from '../../../../src/shared/workspace-api.js';
import { jsonBody } from '../../api/client.js';
import { useSession } from '../../session/useSession.js';
import { errorMessage } from '../../ui/format.js';

export function XProfileSettings() {
  const { api } = useSession();
  const [settings, setSettings] = useState<WorkspaceXProfileSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [x, setX] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void api.api<WorkspaceXProfileSettings>('api/profile/x')
      .then((read) => { if (alive) setSettings(read); })
      .catch(() => { /* The section simply does not offer the choice. */ });
    return () => { alive = false; };
  }, [api]);

  const saveX = async (event: FormEvent) => {
    event.preventDefault();
    if (normalizeXHandle(x) === null) {
      setError('That is not an X handle — letters, numbers and underscores, up to 15.');
      return;
    }
    setBusy(true); setError('');
    try {
      setSettings(await api.api<WorkspaceXProfileSettings>('api/profile/x', jsonBody({ x }, 'PUT')));
      setEditing(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!settings) return null;
  return (
    <>
      <h2>Your builder page</h2>
      <div className="card" id="profileXCard">
        {editing ? (
          <form className="row lbxform" id="profileXForm" onSubmit={(event) => { void saveX(event); }}>
            <label className="main">
              <div className="name plain">X profile</div>
              <input
                id="profileX"
                className="lbxinput"
                placeholder="@yourname"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={64}
                value={x}
                onChange={(event) => setX(event.target.value)}
                autoFocus
                disabled={busy}
              />
            </label>
            {/* Cancel and Save stand together on their own line under the
                box, as the comment editor's do (note #755): on a phone the
                box needs the whole row for a handle, and two controls of
                different heights beside it never lined up with it or with
                each other. */}
            <div className="lbxactions">
              <button className="btn bare" type="button" disabled={busy} onClick={() => { setEditing(false); setError(''); }}>Cancel</button>
              <button className="formcommit" id="profileXSave" type="submit" disabled={busy}>Save</button>
            </div>
          </form>
        ) : (
          <button className="row open" id="profileXRow" type="button" onClick={() => { setX(settings.x ? `@${settings.x}` : ''); setError(''); setEditing(true); }}>
            <div className="main">
              <div className="name plain">X profile</div>
              <div className="meta">{settings.x ? `@${settings.x} · a Follow on X button on your page` : 'None'}</div>
            </div>
            <span className="act">{settings.x ? 'Edit' : 'Add'}</span>
          </button>
        )}
      </div>
      {error ? <div className="autherror" role="alert">{error}</div> : null}
    </>
  );
}
