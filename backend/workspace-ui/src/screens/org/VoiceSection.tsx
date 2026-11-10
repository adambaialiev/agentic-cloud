/**
 * Voice-to-text on the Workplace screen (notes #1024 design, #1026 build).
 * Every workplace brings its own OpenRouter key; this is where an admin
 * saves it and picks the model, and where everyone else reads who pays,
 * which model listens and which admins can change it. Agents cannot reach
 * any of it (Adam, #1026 point 7).
 *
 * The key field is an exact-value field: no microphone, no autocorrect, and
 * the value is never shown back — only OpenRouter's check decides.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  voicePriceWords,
  type VoiceAnswer,
  type VoiceModelOption,
  type VoiceModelsAnswer,
} from '../../../../src/shared/voice.js';
import { jsonBody } from '../../api/client.js';
import { useBanner } from '../../chrome/useBanner.js';
import { useConfirm } from '../../chrome/useConfirm.js';
import { Scrim } from '../../ui/Ask.js';
import { errorMessage } from '../../ui/format.js';
import { Svg, TypeIcon } from '../../ui/icons.js';
import { useOrgApi } from './useOrgApi.js';
import { forgetVoiceStatus } from '../../voice/voice-status.js';
import { VOICE_SETTINGS_ANCHOR } from '../../voice/VoiceBlocked.js';
import { voiceAdminsWords, voiceMonthWords, voiceUsdWords } from './voice-words.js';

/** The recorder's "not set up" screen opens this section by its id. */
export const VOICE_SECTION_ID = VOICE_SETTINGS_ANCHOR;
const OPENROUTER_KEYS_URL = 'https://openrouter.ai/settings/keys';
const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/settings/credits';

function dateWords(iso: string): string {
  const at = new Date(iso);
  return Number.isFinite(at.getTime()) ? at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
}

function KeyDialog({ replacing, onClose, onSaved }: { replacing: boolean; onClose: () => void; onSaved: (answer: VoiceAnswer) => void }) {
  const api = useOrgApi();
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    if (!key.trim() || saving) return;
    setSaving(true);
    setError('');
    try {
      onSaved(await api.api<VoiceAnswer>('api/voice/key', jsonBody({ key }, 'PUT')));
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  };
  return (
    <Scrim onDismiss={() => { if (!saving) onClose(); }}>
      <h3>{replacing ? 'Replace the OpenRouter key' : 'Turn on voice-to-text'}</h3>
      <p>Voice-to-text for everyone in this workplace is paid by this key. It is kept encrypted, used only for voice-to-text, and never given to an agent.</p>
      <label>
        <span className="k">OpenRouter key</span>
        <input
          id="orgVoiceKeyInput"
          type="password"
          value={key}
          placeholder="sk-or-v1-…"
          onChange={(event) => setKey(event.target.value)}
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label="OpenRouter key"
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void save(); } }}
        />
      </label>
      <p className="formhint">Make one at <a href={OPENROUTER_KEYS_URL} target="_blank" rel="noreferrer">openrouter.ai</a> and add credit there; OpenRouter bills you directly. You can give the key a monthly limit on the same page.</p>
      {error ? <p className="formfail" role="alert">{error}</p> : null}
      <div className="btns">
        <button className="btn ghost" type="button" disabled={saving} onClick={onClose}>Cancel</button>
        <button className="btn primary" id="orgVoiceKeySave" type="button" disabled={!key.trim() || saving} onClick={() => void save()}>
          {saving ? <span className="spinner" /> : null}
          {saving ? 'Checking with OpenRouter…' : 'Check and save'}
        </button>
      </div>
    </Scrim>
  );
}

function ModelPicker({ voice, onChanged }: { voice: VoiceAnswer; onChanged: (answer: VoiceAnswer) => void }) {
  const api = useOrgApi();
  const banner = useBanner();
  const [models, setModels] = useState<VoiceModelsAnswer | null>(null);
  const [busy, setBusy] = useState('');
  const [other, setOther] = useState(false);
  const [otherId, setOtherId] = useState('');

  useEffect(() => {
    let live = true;
    api.api<VoiceModelsAnswer>('api/voice/models').then((answer) => { if (live) setModels(answer); }).catch(() => undefined);
    return () => { live = false; };
  }, [api]);

  const choose = async (id: string) => {
    if (busy || id === voice.model.id) return;
    setBusy(id);
    try {
      onChanged(await api.api<VoiceAnswer>('api/voice/model', jsonBody({ model: id }, 'PUT')));
      setOther(false);
      setOtherId('');
    } catch (err) {
      banner.show(errorMessage(err));
    } finally {
      setBusy('');
    }
  };

  const list: readonly VoiceModelOption[] = models?.models ?? [];
  const chosenElsewhere = list.length > 0 && !list.some((model) => model.id === voice.model.id);
  return (
    <>
      <h2>Model</h2>
      <div className="card runtimecard" id="orgVoiceModels" role="radiogroup" aria-label="Voice-to-text model">
        {chosenElsewhere ? (
          <div className="crow current" role="radio" aria-checked="true">
            <div className="main"><div className="name plain">{voice.model.name}</div><div className="cline"><span className="ctext">Another OpenRouter model, priced on openrouter.ai</span></div></div>
            <span className="badge">current</span>
          </div>
        ) : null}
        {list.map((model, index) => {
          const on = model.id === voice.model.id;
          const body = (
            <>
              <div className="main">
                <div className="name plain">{model.name}</div>
                <div className="cline"><span className="ctext">{model.line}{index === 0 ? ' · recommended' : ''}</span></div>
              </div>
              <div className="voiceprice">{busy === model.id ? <span className="spinner" /> : voicePriceWords(model)}<small>a minute</small></div>
              {on ? <span className="badge">current</span> : null}
            </>
          );
          return on
            ? <div key={model.id} className="crow current" role="radio" aria-checked="true">{body}</div>
            : (
              <button key={model.id} className="crow open" type="button" role="radio" aria-checked="false" disabled={Boolean(busy)} onClick={() => void choose(model.id)}>
                {body}
              </button>
            );
        })}
        {!models ? <div className="empty">Reading prices from OpenRouter…</div> : null}
        {other ? (
          <div className="crow">
            <div className="main voiceother">
              <label>
                <span className="k">OpenRouter model id</span>
                <input
                  type="text"
                  value={otherId}
                  placeholder="maker/model"
                  onChange={(event) => setOtherId(event.target.value)}
                  autoCapitalize="none"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void choose(otherId.trim()); } }}
                />
              </label>
              <div className="voicekeyacts">
                <button className="btn ghost" type="button" onClick={() => { setOther(false); setOtherId(''); }}>Cancel</button>
                <button className="btn primary" type="button" disabled={!otherId.trim() || Boolean(busy)} onClick={() => void choose(otherId.trim())}>Use this model</button>
              </div>
            </div>
          </div>
        ) : (
          <button className="addrow" type="button" onClick={() => setOther(true)}>Use another OpenRouter model…</button>
        )}
      </div>
      <p className="formhint">Prices are OpenRouter’s{models?.pricesCheckedAt ? ', checked today' : ''}; ≈ marks a model billed by the word, where the price a minute is the maker’s estimate. A 30-second message costs about a tenth of a cent with the recommended model.</p>
    </>
  );
}

export function VoiceSection({ admin }: { admin: boolean }) {
  const api = useOrgApi();
  const banner = useBanner();
  const ask = useConfirm();
  const [voice, setVoiceState] = useState<VoiceAnswer | null>(null);
  // Any change here is news to every microphone on the page.
  const setVoice = useCallback((answer: VoiceAnswer) => { forgetVoiceStatus(); setVoiceState(answer); }, []);
  const [failed, setFailed] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setVoiceState(await api.api<VoiceAnswer>('api/voice'));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  // Arriving from the recorder's "Set up voice-to-text" (#orgVoice): bring
  // the section into view once it has something to show.
  const loaded = Boolean(voice);
  useEffect(() => {
    if (!loaded || window.location.hash !== `#${VOICE_SECTION_ID}`) return;
    document.getElementById(VOICE_SECTION_ID)?.scrollIntoView({ block: 'start' });
  }, [loaded]);

  if (!voice) {
    return failed ? null : (
      <div id={VOICE_SECTION_ID}><h2>Voice-to-text</h2><div className="card"><div className="empty">Reading…</div></div></div>
    );
  }

  const key = voice.admin?.key ?? null;
  const removeKey = async () => {
    const sure = await ask({
      title: 'Remove the OpenRouter key?',
      message: 'Voice-to-text stops for everyone in this workplace until an admin saves a key again.',
      verb: 'Remove key',
      danger: true,
    });
    if (!sure) return;
    setBusy(true);
    try {
      setVoice(await api.api<VoiceAnswer>('api/voice/key', { method: 'DELETE' }));
      banner.show('Voice-to-text is off.', true);
    } catch (err) {
      banner.show(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  // Note #1116: copy the key this admin already saved in another workplace.
  // One tap, no value on the screen; the server checks both admin roles.
  const copyFrom = admin && !key ? voice.admin?.copyFrom ?? [] : [];
  const copyKey = async (fromOrgId: string, fromName: string) => {
    setBusy(true);
    try {
      setVoice(await api.api<VoiceAnswer>('api/voice/key/copy', jsonBody({ fromOrgId }, 'POST')));
      banner.show(`Voice-to-text is on, with a copy of the key from ${fromName}.`, true);
    } catch (err) {
      banner.show(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const checkAgain = async () => {
    setBusy(true);
    await load();
    setBusy(false);
  };

  const status = voice.state === 'off'
    ? { glyph: 'mic' as const, name: 'Off', line: admin
      ? 'Nobody can dictate yet. Voice-to-text needs an OpenRouter key; it costs about 18¢ an hour of speech.'
      : `Not set up yet. ${voiceAdminsWords(voice.admins)} can turn it on.` }
    : voice.state === 'paused'
      ? { glyph: 'pause' as const, name: voice.reason === 'key_rejected' ? 'Paused: the key no longer works' : 'Paused: out of credit', line: admin ? 'Paid by the workplace’s own OpenRouter key' : `${voiceAdminsWords(voice.admins)} can fix it.`, badge: 'Paused' }
      : { glyph: 'mic' as const, name: admin ? 'On for everyone' : 'On', line: admin ? 'Paid by the workplace’s own OpenRouter key' : `Paid by the workplace · ${voice.model.name}` };

  return (
    <div id={VOICE_SECTION_ID}>
      {admin && voice.state === 'paused' ? (
        <div className="warnbox voicenotice" role="status">
          <Svg name="pause" size={16} />
          <div>
            <b>Voice-to-text is paused for everyone.</b>{' '}
            {voice.reason === 'key_rejected'
              ? 'OpenRouter no longer accepts the workplace’s key. Save a new one.'
              : 'The OpenRouter account behind the workplace’s key has run out of credit. Add credit there; voice comes back by itself within a couple of minutes.'}
          </div>
        </div>
      ) : null}
      <h2>Voice-to-text</h2>
      <div className="card" id="orgVoiceCard">
        <div className="crow">
          <TypeIcon glyph={status.glyph} />
          <div className="main">
            <div className="name plain">{status.name}</div>
            <div className="cline"><span className="ctext">{status.line}</span>{status.badge ? <span className="badge warn">{status.badge}</span> : null}</div>
          </div>
        </div>
        {admin && key ? (
          <div className="crow">
            <TypeIcon glyph="key" />
            <div className="main">
              <div className="name plain">Key</div>
              <div className="cline"><span className="ctext">
                {key.preview}
                {key.savedByName ? ` · ${key.copiedFromName ? 'copied' : 'saved'} by ${key.savedByName}${key.copiedFromName ? ` from ${key.copiedFromName}` : ''}${key.savedAt ? ` on ${dateWords(key.savedAt)}` : ''}` : ''}
                {voice.admin?.creditLeftUsd !== null && voice.admin?.creditLeftUsd !== undefined ? ` · credit left ${voiceUsdWords(voice.admin.creditLeftUsd)}` : ''}
              </span></div>
              {voice.admin ? <div className="cline"><span className="ctext">{voiceMonthWords(voice.admin.month)}</span></div> : null}
              <div className="voicekeyacts">
                {voice.state === 'paused' && voice.reason === 'out_of_credit'
                  ? <a className="btn primary" href={OPENROUTER_CREDITS_URL} target="_blank" rel="noreferrer">Add credit on OpenRouter</a> : null}
                {voice.state === 'paused' ? <button className="btn" type="button" disabled={busy} onClick={() => void checkAgain()}>Check again</button> : null}
                <button className="btn" id="orgVoiceReplace" type="button" disabled={busy} onClick={() => setDialog(true)}>Replace key</button>
                <button className="btn danger" type="button" disabled={busy} onClick={() => void removeKey()}>Remove key</button>
              </div>
            </div>
          </div>
        ) : null}
        {copyFrom.map((source) => (
          <button
            key={source.orgId} className="addrow strong orgVoiceCopy" type="button" disabled={busy}
            onClick={() => void copyKey(source.orgId, source.name)}
          >
            Use the key from {source.name}
          </button>
        ))}
        {admin && !key ? (
          <button className={copyFrom.length ? 'addrow' : 'addrow strong'} id="orgVoiceTurnOn" type="button" onClick={() => setDialog(true)}>
            {copyFrom.length ? 'Use a new OpenRouter key instead' : 'Turn on with an OpenRouter key'}
          </button>
        ) : null}
      </div>
      {copyFrom.length ? (
        <p className="formhint">
          You already saved a key in {copyFrom.length === 1 ? copyFrom[0]!.name : 'another workplace you run'}. Using it copies it here once, without showing it:
          after that the two are not linked, so replacing or removing the key in one workplace does not change the other. Both pay the same OpenRouter account.
        </p>
      ) : admin && !key ? <p className="formhint">OpenRouter is one account for many speech models. You add credit there and it bills you directly.</p> : null}
      {admin && key?.copiedFromName ? (
        <p className="formhint">This is this workplace’s own copy of the key from {key.copiedFromName}. Replacing or removing it here does not change {key.copiedFromName}, and a change there does not reach here.</p>
      ) : null}
      {!admin && voice.state !== 'off' ? <p className="formhint">{voiceAdminsWords(voice.admins)} can change this.</p> : null}
      {admin && key ? <ModelPicker voice={voice} onChanged={setVoice} /> : null}
      {dialog ? (
        <KeyDialog
          replacing={Boolean(key)}
          onClose={() => setDialog(false)}
          onSaved={(answer) => { setVoice(answer); setDialog(false); banner.show('Voice-to-text is on.', true); }}
        />
      ) : null}
    </div>
  );
}
