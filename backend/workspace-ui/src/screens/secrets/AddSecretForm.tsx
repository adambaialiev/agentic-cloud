/**
 * Adding a secret, or replacing the value of one — a transient leaf with no
 * address (legacy `screenAdd`). A name that already exists in the workplace
 * flips the button into a replace, and says so above the field.
 *
 * Two shapes (note #655). An admin saves a SHARED key and chooses whose
 * agents it reaches — admins' only unless they open it, because a key on an
 * agent's machine is a key its owner can read. A member saves a key PRIVATE
 * to one of their own agents: the one safe path they have, since pasting a
 * token into chat is exactly what the feature exists to avoid. A shared key
 * is the WORKPLACE's (note #783): every room's agents are handed it.
 */

import { useState, type FormEvent } from 'react';
import type { WorkspaceSecretAudience, WorkspaceSecretWrittenAnswer } from '../../../../src/shared/workspace-api.js';
import { jsonBody } from '../../api/client.js';
import { useBackClaim } from '../../chrome/useBack.js';
import { useBanner } from '../../chrome/useBanner.js';
import { useSession } from '../../session/useSession.js';
import { errorMessage } from '../../ui/format.js';
import { Icon, Svg } from '../../ui/icons.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { canAddSharedSecrets, secretsOf } from './secret-words.js';
import { ScreenTitle } from '../../chrome/ScreenTitle.js';

export function AddSecretForm({ initialName = '', initialAgentId, onClose, onSaved }: {
  initialName?: string;
  /** Replacing a key private to this agent; absent means the form decides by role. */
  initialAgentId?: string;
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const { api } = useSession();
  const { state, agents, reload } = useWorkspace();
  const banner = useBanner();
  const [name, setName] = useState(initialName);
  const [value, setValue] = useState('');
  const [audience, setAudience] = useState<WorkspaceSecretAudience>('admins');
  const [saving, setSaving] = useState(false);
  useBackClaim(onClose);
  const org = state?.org ?? null;
  const shared = !initialAgentId && canAddSharedSecrets(org);
  // A member's own agents — where a private key can go.
  const mine = agents ?? [];
  const [agentId, setAgentId] = useState(initialAgentId ?? mine[0]?.id ?? '');
  const agent = shared ? undefined : mine.find((a) => a.id === agentId);
  const trimmed = name.trim();
  const clash = Boolean(trimmed) && (secretsOf(state) ?? []).some((s) => (
    shared ? s.scope === 'shared' && s.name === trimmed : s.scope === 'agent' && s.agentId === agentId && s.name === trimmed
  ));
  const label = clash
    ? `Replace the value of ${trimmed}`
    : shared ? 'Save for the workplace' : `Save for ${agent?.name ?? 'this agent'}`;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed || !value || (!shared && !agentId)) return;
    setSaving(true);
    try {
      const answer = await api.api<WorkspaceSecretWrittenAnswer>(
        `api/secrets${shared ? '' : `?agent=${encodeURIComponent(agentId)}`}`,
        jsonBody(shared && !clash ? { name: trimmed, value, audience } : { name: trimmed, value }),
      );
      banner.show(
        !answer.created ? `Replaced the value of ${answer.name}.`
          : shared ? `Saved ${answer.name} for ${audience === 'everyone' ? 'every agent in the workplace' : 'admins’ agents'}.`
            : `Saved ${answer.name} for ${agent?.name ?? 'your agent'}.`,
        true,
      );
      await reload().catch(() => {});
      onSaved(answer.name);
    } catch (error) {
      banner.show(errorMessage(error));
      setSaving(false);
    }
  };

  return (
    <div className="screen" id="screenAdd">
      <ScreenTitle title="Add a secret" />
      <div className="sub" id="addSub">{shared ? 'For the agents of this workplace to use.' : `For ${agent?.name ?? 'one of your agents'} to use — private to it, never handed to anyone else’s agent.`}</div>
      <form id="addForm" autoComplete="off" onSubmit={(event) => { void submit(event); }}>
        <div className="card">
          <label className="drow frow">
            <div className="k">Name</div>
            <input id="secretName" placeholder="GH_TOKEN" spellCheck={false} autoCapitalize="characters" required value={name} onChange={(event) => setName(event.target.value)} autoFocus={!initialName} />
            {clash
              ? (
                <div className="warnbox" id="nameWarn">
                  <Svg name="alert" size={16} />
                  <div><code>{trimmed}</code> already exists. Saving replaces the value {shared ? 'your agents use' : `${agent?.name ?? 'that agent'} uses`} — it does not add a second one{shared ? ', and keeps who it reaches' : ''}.</div>
                </div>
              )
              : null}
          </label>
          <label className="drow frow">
            <div className="head">
              <div className="k">Value</div>
              <div className="count" id="valueCount">{value.length ? `${value.length} character${value.length === 1 ? '' : 's'}` : ''}</div>
            </div>
            <textarea id="secretValue" placeholder="Paste the value" rows={3} spellCheck={false} required value={value} onChange={(event) => setValue(event.target.value)} autoFocus={Boolean(initialName)} />
          </label>
        </div>
        {shared && !clash && org
          ? (
            <div className="card" id="audienceCard">
              <div className="drow"><div className="k">Whose agents get it</div></div>
              <AudienceRow picked={audience === 'admins'} title="Admins’ agents only" body="Members see the name and what it is for, but their agents are never handed the value." onPick={() => setAudience('admins')} />
              <AudienceRow picked={audience === 'everyone'} title="Every agent in the workplace" body="Members’ agents get it too — and a member can ask their agent to show it." onPick={() => setAudience('everyone')} />
            </div>
          )
          : null}
        {!shared && !initialAgentId && mine.length > 1
          ? (
            <div className="card" id="agentPickCard">
              <div className="drow"><div className="k">Which of your agents</div></div>
              {mine.map((a) => <AudienceRow key={a.id} picked={a.id === agentId} title={a.name} onPick={() => setAgentId(a.id)} />)}
            </div>
          )
          : null}
        {!shared && mine.length === 0
          ? <div className="warnbox" id="noAgentWarn"><Svg name="alert" size={16} /><div>You have no agent to save a key for. Only a workplace admin can add a key shared by the workplace.</div></div>
          : null}
        <button className="formcommit" id="saveBtn" type="submit" disabled={saving || (!shared && !agentId)}>{saving ? <><span className="spinner" /><span>Saving…</span></> : <span>{label}</span>}</button>
        <div className="formhint" id="formHint">Saved straight over HTTPS — it never appears in your chat history. {shared ? 'The agents it reaches' : agent?.name ?? 'Your agent'} pick{shared ? '' : 's'} it up on the next turn and hand{shared ? '' : 's'} it straight to the tool that needs it; the value is stripped out of anything sent back.</div>
      </form>
    </div>
  );
}

/** One choice in a short list: the picked one is drawn as a state, the rest are doors. */
function AudienceRow({ picked, title, body, onPick }: { picked: boolean; title: string; body?: string; onPick: () => void }) {
  const inner = (
    <>
      <Icon name={picked ? 'check' : 'chev'} size={17} className={picked ? 'icon tick' : 'icon chev'} />
      <div className="main">
        <div className="name plain">{title}</div>
        {body ? <div className="desc">{body}</div> : null}
      </div>
    </>
  );
  return picked
    ? <div className="crow current" aria-current="true">{inner}</div>
    : <button className="crow open" type="button" onClick={onPick}>{inner}</button>;
}
