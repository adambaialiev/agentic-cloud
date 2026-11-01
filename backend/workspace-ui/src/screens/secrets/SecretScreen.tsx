/**
 * One secret (`/secrets/:name?org=&agent=`): what it is for, a masked
 * preview, whose agents and which rooms it reaches (note #783), when it
 * changed, and the actions. The value is never held by the page — it is read
 * only inside the copy tap, which is what keeps Safari's clipboard rule and
 * the value's privacy at once.
 */

import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { WorkspaceSecretAudienceAnswer, WorkspaceSecretRow, WorkspaceSecretValueAnswer } from '../../../../src/shared/workspace-api.js';
import { toFor } from '../../routes.js';
import { jsonBody } from '../../api/client.js';
import { useBanner } from '../../chrome/useBanner.js';
import { useConfirm } from '../../chrome/useConfirm.js';
import { useSession } from '../../session/useSession.js';
import { absolute, copyFromTap, errorMessage } from '../../ui/format.js';
import { Icon } from '../../ui/icons.js';
import { relative } from '../../ui/time.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { AddSecretForm } from './AddSecretForm.js';
import { SecretName } from './SecretRows.js';
import { VoiceField } from '../../voice/VoiceField.js';
import { audienceWords, canAddSharedSecrets, canManageSecret, reachesWords, secretQuery, secretsOf } from './secret-words.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';

function DescribeRow({ secret, canManage, onSaved }: { secret: WorkspaceSecretRow; canManage: boolean; onSaved: () => Promise<unknown> }) {
  const { api } = useSession();
  const banner = useBanner();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(secret.description ?? '');
  const [saving, setSaving] = useState(false);
  if (!editing) {
    return (
      <div className="drow">
        <div className="head">
          <div className="k">What it’s for</div>
          {canManage ? <button className="edit" type="button" onClick={() => { setText(secret.description ?? ''); setEditing(true); }}>{secret.description ? 'Edit' : 'Add'}</button> : null}
        </div>
        {secret.description ? <div className="v">{secret.description}</div> : <div className="v dim">Nothing noted yet — the agent that uses this key writes it down the first time it does.</div>}
      </div>
    );
  }
  return (
    <div className="drow frow">
      <div className="head"><div className="k">What it’s for</div></div>
      <VoiceField onTranscript={setText}>
        <textarea className="prose" rows={3} maxLength={200} placeholder="What is this key for?" value={text} onChange={(event) => setText(event.target.value)} autoFocus />
      </VoiceField>
      <div className="editrow">
        <button className="edit" type="button" disabled={saving} onClick={async () => {
          setSaving(true);
          try {
            await api.api(`api/secrets/${encodeURIComponent(secret.name)}/description${secretQuery(secret)}`, jsonBody({ description: text }, 'PATCH'));
            banner.show(`Saved what ${secret.name} is for`, true);
            await onSaved();
            setEditing(false);
          } catch (error) { banner.show(errorMessage(error)); }
          setSaving(false);
        }}>
          Save
        </button>
        <button className="edit plain" type="button" onClick={() => setEditing(false)}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * Whose agents a shared key reaches (note #655), with the switch for an
 * admin. Drawn for everyone: a member whose agent is NOT handed a key
 * deserves to see that, rather than wonder why the agent cannot find it.
 */
function AudienceRow({ secret, canManage, onSaved }: { secret: WorkspaceSecretRow; canManage: boolean; onSaved: () => Promise<unknown> }) {
  const { api } = useSession();
  const banner = useBanner();
  const [saving, setSaving] = useState(false);
  const everyone = secret.audience === 'everyone';
  return (
    <div className="drow" id="secretAudience">
      <div className="head">
        <div className="k">Whose agents get it</div>
        {canManage
          ? (
            <button className="edit" type="button" disabled={saving} onClick={async () => {
              setSaving(true);
              try {
                const next = everyone ? 'admins' : 'everyone';
                const answer = await api.api<WorkspaceSecretAudienceAnswer>(`api/secrets/${encodeURIComponent(secret.name)}/audience`, jsonBody({ audience: next }, 'PATCH'));
                banner.show(answer.audience === 'everyone' ? `${secret.name} now reaches every agent in the workplace.` : `${secret.name} now reaches admins’ agents only.`, true);
                await onSaved();
              } catch (error) { banner.show(errorMessage(error)); }
              setSaving(false);
            }}>
              {everyone ? 'Admins only' : 'Open to everyone'}
            </button>
          )
          : null}
      </div>
      <div className="v">{audienceWords(secret)}</div>
      <div className="v dim">{reachesWords(secret)}{everyone ? ' — a member can ask their agent to show it.' : '. Members see it here but their agents are never handed the value.'}</div>
    </div>
  );
}

// Which rooms a shared key was limited to (note #783) was a row here, with
// the picker an admin limited it by, until rooms left the product (note
// #843): a shared key reaches the whole workplace or its admins' agents
// (`AudienceRow`), and nothing narrower.

export function SecretScreen() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const { api } = useSession();
  const { state, reload } = useWorkspace();
  const banner = useBanner();
  const ask = useConfirm();
  const navigate = useNavigate();
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const agentId = params.get('agent');
  const org = state?.org ?? null;
  const secret = (secretsOf(state) ?? []).find((s) => s.name === id && (agentId ? s.scope === 'agent' && s.agentId === agentId : s.scope === 'shared'));

  if (!secret) {
    return (
      <div className="screen" id="screenSecret">
        <ScreenTitle titleClass="titlemono" titleId="secretTitle" title={id} />
        <div className="card" id="secretCard"><div className="empty">{state ? 'This secret is not in this workplace any more.' : 'Loading…'}</div></div>
      </div>
    );
  }
  if (replacing) return <AddSecretForm initialName={secret.name} initialAgentId={secret.scope === 'agent' ? secret.agentId : undefined} onClose={() => setReplacing(false)} onSaved={() => setReplacing(false)} />;

  const canManage = canManageSecret(secret, org);
  const canShare = secret.scope === 'shared' && Boolean(org) && canAddSharedSecrets(org);
  const query = secretQuery(secret);
  const owner = secret.agentName || 'that agent';

  return (
    <div className="screen" id="screenSecret">
      <ScreenTitle titleClass="titlemono" titleId="secretTitle" title={<SecretName as="span" name={secret.name} className="" />} />
      <div id="secretScope">
        {secret.scope === 'agent'
          ? <div className="special"><Icon name="user" size={16} /><div><b>Only {owner} can use this one.</b> Your other agents never see it — it is not in their environment.</div></div>
          : null}
        {/* A key renamed when the rooms' keys became one set (note #783)
            said which room it came from here, until rooms left the product
            (note #843). */}
      </div>
      <div className="card" id="secretCard">
        <DescribeRow secret={secret} canManage={canManage} onSaved={reload} />
        {secret.scope === 'shared' && secret.audience ? <AudienceRow secret={secret} canManage={canShare} onSaved={reload} /> : null}
        <div className="drow">
          <div className="k">Value</div>
          <div className="v">{secret.valueKind ? `${secret.valueKind} · ` : ''}{typeof secret.valueLength === 'number' ? `${secret.valueLength} characters` : 'saved'}</div>
          {secret.maskedPreview ? <div className="v mono">{secret.maskedPreview}</div> : null}
        </div>
        {secret.updatedAt ? <div className="drow"><div className="k">Last changed</div><div className="v">{relative(secret.updatedAt)} · {absolute(secret.updatedAt)}</div></div> : null}
      </div>
      {canManage
        ? (
          <div className="card">
            <div className="actions" id="secretActions">
              <button className="btn primary" type="button" onClick={() => {
                copyFromTap(() => api.api<WorkspaceSecretValueAnswer>(`api/secrets/${encodeURIComponent(secret.name)}/value${query}`).then((body) => body.value))
                  .then(() => banner.show(`Copied the value of ${secret.name}`, true), (error: unknown) => banner.show(errorMessage(error) || 'Could not reach the clipboard — try again.'));
              }}>
                <Icon name="copy" size={17} /><span>Copy the value</span>
              </button>
              <button className="btn ghost" type="button" onClick={() => setReplacing(true)}>Replace the value</button>
              <button className="btn danger" type="button" disabled={busy} onClick={async () => {
                const where = secret.scope === 'shared' ? 'every agent it reaches' : owner;
                if (!(await ask({
                  title: `Delete ${secret.name}?`,
                  message: `It stops reaching ${where} from their next turn, and the value is gone for good.`,
                  verb: 'Delete',
                  danger: true,
                }))) return;
                setBusy(true);
                try {
                  await api.api(`api/secrets/${encodeURIComponent(secret.name)}${query}`, { method: 'DELETE' });
                  banner.show(`Deleted ${secret.name}`, true);
                  navigate(toFor({ kind: 'secrets', orgId: state?.org?.orgId })!, { replace: true });
                  await reload().catch(() => {});
                } catch (error) { banner.show(errorMessage(error)); setBusy(false); }
              }}>
                Delete this secret
              </button>
            </div>
            <div className="hintblock" id="secretHint">
              {secret.scope === 'shared'
                ? 'Copying puts the value on your phone’s clipboard, where other apps can read it.'
                : `Copying puts the value on your phone’s clipboard, where other apps can read it. This one is private to ${owner} — only you and it can change it.`}
            </div>
          </div>
        )
        // Note #645: a member has no actions on a shared key, and the card
        // that would hold them drew as an empty grey box over its own excuse.
        // The sentence stands alone under the facts, with the lock to say it.
        : <div className="locknote" id="secretHint"><Icon name="lock" size={16} /><div>Only a workplace admin can copy, replace, describe or delete a shared secret.</div></div>}
    </div>
  );
}
