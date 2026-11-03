/**
 * Home's Secrets card: the workplace's keys by name and mask, never value
 * (note #783 — one set per workplace, like repositories); a door to the list
 * once there are many; Add a secret for whoever may. In the Workplace window
 * Add opens the secrets screen with its form up (`SecretsScreen` reads the
 * `add` state); a personal workspace hands it a leaf instead.
 */

import { useNavigate } from 'react-router-dom';
import { toFor } from '../../routes.js';
import { TypeIcon } from '../../ui/icons.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { SecretsDoorRow, SecretsEmpty, SecretsList } from '../secrets/SecretRows.js';
import { SECRETS_LIST_AT, canAddSharedSecrets, secretTo, secretsOf } from '../secrets/secret-words.js';

export function Secrets({ onAdd }: { onAdd?: () => void }) {
  const { state } = useWorkspace();
  const navigate = useNavigate();
  const secrets = secretsOf(state);
  const org = state?.org ?? null;
  const canAdd = canAddSharedSecrets(org);
  const listTo = toFor({ kind: 'secrets', orgId: org?.orgId })!;
  return (
    <>
      <h2 className="homehead">Secrets</h2>
      <div className="card">
        <div id="secrets">
          {!secrets
            ? <div className="empty">Secrets are not available right now.</div>
            : secrets.length === 0
              ? <SecretsEmpty canAddShared={canAdd} />
              : secrets.length >= SECRETS_LIST_AT
                ? <SecretsDoorRow secrets={secrets} onOpen={() => navigate(listTo)} />
                : <SecretsList secrets={secrets} searchable={false} onOpen={(secret) => navigate(secretTo(secret, org?.orgId))} />}
        </div>
        {canAdd
          ? (
            <button className="addrow" id="addBtn" type="button" onClick={onAdd ?? (() => navigate(listTo, { state: { add: true } }))}>
              <TypeIcon glyph="key" /><span>Add a secret</span>
            </button>
          )
          : null}
      </div>
    </>
  );
}
