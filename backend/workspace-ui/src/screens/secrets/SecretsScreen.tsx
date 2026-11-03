/** Every secret of the workplace (`/secrets?org=`; note #783 — one set per
 *  workplace, like repositories), with the add-a-secret leaf over it. */

import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { TypeIcon } from '../../ui/icons.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { AddSecretForm } from './AddSecretForm.js';
import { SecretsEmpty, SecretsList } from './SecretRows.js';
import { SECRETS_LIST_AT, canAddSharedSecrets, secretTo, secretsOf } from './secret-words.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';
import { bucketsOf } from '../storage/bucket-words.js';

export function SecretsScreen() {
  const { state, agents } = useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  // Home's Secrets card sends the reader here with the form up (note #783).
  const [adding, setAdding] = useState(Boolean((location.state as { add?: boolean } | null)?.add));
  const secrets = secretsOf(state) ?? [];
  const org = state?.org ?? null;
  const canAddShared = canAddSharedSecrets(org);
  // A member adds a key private to one of their own agents here (note #655).
  const canAdd = canAddShared || (agents ?? []).length > 0;

  if (adding) return <AddSecretForm onClose={() => setAdding(false)} onSaved={() => setAdding(false)} />;

  return (
    <div className="screen" id="screenSecrets">
      <ScreenTitle title="Secrets" />
      <div className="sub" id="secretsSub">{secrets.length === 1 ? 'One secret, for your agents to use.' : `${secrets.length} secrets, for your agents to use.`}</div>
      <div className="card">
        <div id="secretsList">
          {secrets.length === 0
            ? <SecretsEmpty canAddShared={canAddShared} canAddPrivate={canAdd} />
            : <SecretsList secrets={secrets} buckets={bucketsOf(state)} searchable={secrets.length >= SECRETS_LIST_AT} onOpen={(secret) => navigate(secretTo(secret, org?.orgId))} />}
        </div>
        {canAdd
          ? (
            <button className="addrow" id="secretsAddBtn" type="button" onClick={() => setAdding(true)}>
              <TypeIcon glyph="key" /><span>{canAddShared ? 'Add a secret' : 'Add a secret for one of your agents'}</span>
            </button>
          )
          : null}
      </div>
    </div>
  );
}
