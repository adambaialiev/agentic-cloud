/**
 * Renaming a workplace: a transient leaf over its detail address, just like
 * room rename. The server changes display metadata only; every durable object
 * stays pinned to the same workplace id.
 */

import { useState, type FormEvent } from 'react';
import type { WorkspaceOrgNameAnswer } from '../../../../src/shared/workspace-api.js';
import { jsonBody } from '../../api/client.js';
import { useBackClaim } from '../../chrome/useBack.js';
import { useBanner } from '../../chrome/useBanner.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { errorMessage } from '../../ui/format.js';
import { VoiceField } from '../../voice/VoiceField.js';
import { useOrgApi } from './useOrgApi.js';

const normalizedName = (value: string) => value.replace(/\s+/g, ' ').trim();

export function WorkplaceNameForm({ current, onClose, onWritten }: {
  current: string;
  onClose: () => void;
  onWritten: (answer: WorkspaceOrgNameAnswer) => Promise<void> | void;
}) {
  const api = useOrgApi();
  const banner = useBanner();
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  useBackClaim(onClose);
  const normalized = normalizedName(name);
  const unchanged = normalized === current;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!normalized || unchanged) return;
    setBusy(true);
    try {
      const answer = await api.api<WorkspaceOrgNameAnswer>('api/org/name', jsonBody({ name: normalized }));
      banner.show(`Your workplace is now called ${answer.name}.`, true);
      await onWritten(answer);
    } catch (error) {
      banner.show(errorMessage(error));
      setBusy(false);
    }
  };

  return (
    <div className="screen" id="screenOrgName">
      <ScreenTitle titleId="orgNameTitle" title="Rename workplace" />
      <div className="sub" id="orgNameSub">A new name is all that changes. Its people, agents, code and shared work stay here.</div>
      <form id="orgNameForm" autoComplete="off" onSubmit={(event) => { void submit(event); }}>
        <div className="card">
          <label className="drow frow">
            <div className="k">Workplace name</div>
            <VoiceField onTranscript={setName}>
              <input
                id="orgName"
                autoFocus
                placeholder="Acme Trading"
                maxLength={80}
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </VoiceField>
          </label>
        </div>
        <button className="formcommit" id="orgNameSave" type="submit" disabled={busy || !normalized || unchanged}>
          {busy ? 'Saving…' : 'Save name'}
        </button>
      </form>
    </div>
  );
}
