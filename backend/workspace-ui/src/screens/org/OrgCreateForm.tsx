/**
 * Founding a workplace — a transient leaf with no address (legacy
 * `screenOrgCreate`). It keeps whatever screen opened it underneath, so Back
 * closes it; creating one moves this tab into the new workplace and lands
 * the founder on its Home, where the setup gate takes over.
 */

import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { WorkspaceOrgCreateAnswer } from '../../../../src/shared/workspace-api.js';
import { jsonBody } from '../../api/client.js';
import { useBackClaim } from '../../chrome/useBack.js';
import { useBanner } from '../../chrome/useBanner.js';
import { useSession } from '../../session/useSession.js';
import { errorMessage } from '../../ui/format.js';
import { VoiceField } from '../../voice/VoiceField.js';
import { useSeats } from '../../workspace/useSeats.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';

export function OrgCreateForm({ onClose }: { onClose: () => void }) {
  const { api } = useSession();
  const { switchWorkplace } = useWorkspace();
  const seats = useSeats();
  const banner = useBanner();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useBackClaim(onClose);
  // Only the name (the owner, 2026-10-12, note #748): a workplace has no
  // public address. The server still reads its handle off the name, as the
  // word its repositories live under, and never shows it here.

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const answer = await api.api<WorkspaceOrgCreateAnswer>('api/org', jsonBody({ name: trimmed }));
      // Home is the next screen: the setup gate stands on it until a
      // subscription is in and the team has arrived. The server made the
      // new workplace the account's active one, but this tab stands where
      // it stood until it is moved (note #628) — a plain re-read would ask
      // as the old workplace and leave the founder there (note #670). So it
      // moves, exactly as a switch does; its first read is also what
      // carries a subscription in and starts the founding.
      seats.invalidate();
      const refresh = switchWorkplace(answer.orgId);
      navigate('/', { replace: true });
      await refresh;
    } catch (error) {
      banner.show(errorMessage(error));
      setBusy(false);
    }
  };

  return (
    <div className="screen" id="screenOrgCreate">
      <ScreenTitle title="New workplace" />
      <div className="sub">A workplace of your own: its own agents, code, knowledge and notes. It opens with four agents as soon as it has a subscription.</div>
      <form id="orgCreateForm" autoComplete="off" onSubmit={(event) => { void submit(event); }}>
        <div className="card">
          <label className="drow frow">
            <div className="k">Workplace name</div>
            <VoiceField onTranscript={setName}>
              <input id="orgCreateName" placeholder="Acme Trading" maxLength={80} required value={name} onChange={(event) => setName(event.target.value)} />
            </VoiceField>
          </label>
        </div>
        <button className="formcommit" id="orgCreateBtn" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create workplace'}</button>
      </form>
    </div>
  );
}
