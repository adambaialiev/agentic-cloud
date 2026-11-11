/**
 * The Chief of Staff's recap voice, on the Workplace screen's voice section
 * (note #1151). Adam, 11 Nov 2026: "What voice model is used and I think I
 * need to be able to switch voice models in workspace settings."
 *
 * An admin picks a text-to-speech model from what OpenRouter offers now —
 * each with its price for a recap of 240 characters, the longest a recap
 * gets — then one of that model's voices, hears it with Play sample on the
 * workplace's key, and keeps it with "Use this voice". A member reads which
 * voice it is. The setting is the workplace's, like the key.
 */

import { useEffect, useMemo, useState } from 'react';
import type { VoiceAnswer } from '../../../../src/shared/voice.js';
import {
  speechRecapPriceWords, speechVoiceName,
  type RecapSpeechAnswer, type SpeechModelOption, type SpeechModelsAnswer,
} from '../../../../src/shared/voice-speech.js';
import { jsonBody } from '../../api/client.js';
import { useBanner } from '../../chrome/useBanner.js';
import { errorMessage } from '../../ui/format.js';
import { TypeIcon } from '../../ui/icons.js';
import { audioUrl, recapPlayer, unlockRecapAudio } from '../home/recap-voice.js';
import { useOrgApi } from './useOrgApi.js';

function dateWords(iso: string): string {
  const at = new Date(iso);
  return Number.isFinite(at.getTime()) ? at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
}

/** The voice to land on when the model changes: the one kept if this model
 *  has it, Sarah on the default, else the model's first. */
export function voiceFor(model: SpeechModelOption, keep: string, fallback: { model: string; voice: string }): string {
  if (model.voices.includes(keep)) return keep;
  if (model.id === fallback.model && model.voices.includes(fallback.voice)) return fallback.voice;
  return model.voices[0] ?? '';
}

export function RecapVoicePicker({ voice, admin, onChanged }: { voice: VoiceAnswer; admin: boolean; onChanged: (answer: VoiceAnswer) => void }) {
  const api = useOrgApi();
  const banner = useBanner();
  const speech = voice.speech!;
  const [list, setList] = useState<SpeechModelsAnswer | null>(null);
  const [failed, setFailed] = useState(false);
  const [model, setModel] = useState(speech.model);
  const [pick, setPick] = useState(speech.voice);
  const [sampling, setSampling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [line, setLine] = useState('');

  useEffect(() => {
    if (!admin) return;
    let live = true;
    api.api<SpeechModelsAnswer>('api/voice/speech/models')
      .then((answer) => { if (live) { setList(answer); setFailed(!answer?.models?.length); } })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [api, admin]);
  useEffect(() => { setModel(speech.model); setPick(speech.voice); }, [speech.model, speech.voice]);

  const models = list?.models ?? [];
  const chosen = useMemo(() => models.find((entry) => entry.id === model), [models, model]);
  const changed = model !== speech.model || pick !== speech.voice;
  const fallback = list?.default ?? { model: speech.model, voice: speech.voice };

  const chooseModel = (id: string) => {
    const next = models.find((entry) => entry.id === id);
    if (!next) return;
    setModel(id);
    setPick(voiceFor(next, pick, fallback));
    setLine('');
  };

  const sample = async () => {
    if (!chosen || !pick) return;
    unlockRecapAudio();
    setSampling(true);
    setLine('');
    try {
      const answer = await api.api<RecapSpeechAnswer>('api/voice/speech/sample', jsonBody({ model, voice: pick }));
      const element = recapPlayer();
      element.onended = null;
      element.src = audioUrl(answer.audio, answer.contentType);
      await element.play();
    } catch (err) {
      setLine(errorMessage(err));
    } finally {
      setSampling(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setLine('');
    try {
      onChanged(await api.api<VoiceAnswer>('api/voice/speech', jsonBody({ model, voice: pick }, 'PUT')));
      banner.show(`Recaps will be read by ${speechVoiceName(pick)} from the next one on.`, true);
    } catch (err) {
      setLine(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const who = speech.isDefault ? 'The default' : `Chosen by ${speech.changedByName ?? 'an admin'}${speech.changedAt ? ` on ${dateWords(speech.changedAt)}` : ''}`;
  return (
    <>
      <h2>Reading recaps aloud</h2>
      <div className="card" id="orgSpeechCard">
        <div className="crow">
          <TypeIcon glyph="speaker" />
          <div className="main">
            <div className="name plain" id="orgSpeechCurrent">{speech.voiceName} · {speech.modelName}</div>
            <div className="cline"><span className="ctext">{who}. Reads the Chief of Staff’s recaps for whoever turns on its speaker.</span></div>
            {speech.problem ? (
              <div className="cline"><span className="ctext warnline" id="orgSpeechProblem" role="status">{dateWords(speech.problem.at)}: {speech.problem.words}</span></div>
            ) : null}
          </div>
        </div>
        {admin ? (
          <div className="crow">
            <div className="main voiceother speechchoose">
              {!list && !failed ? <div className="empty">Reading the voices OpenRouter offers…</div> : null}
              {failed ? <div className="empty">OpenRouter’s list of voices could not be read just now. Try again in a minute.</div> : null}
              {models.length ? (
                <>
                  <label>
                    <span className="k">Model</span>
                    <select id="orgSpeechModel" value={chosen ? model : ''} onChange={(event) => chooseModel(event.target.value)}>
                      {chosen ? null : <option value="" disabled>{speech.modelName} (no longer offered)</option>}
                      {models.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.name.replace(/^[^:]+:\s*/, '')} · {entry.name.split(':')[0]} · {speechRecapPriceWords(entry)} a recap{entry.id === fallback.model ? ' · default' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span className="k">Voice</span>
                    <select id="orgSpeechVoice" value={pick} disabled={!chosen} onChange={(event) => { setPick(event.target.value); setLine(''); }}>
                      {(chosen?.voices ?? []).map((id) => <option key={id} value={id}>{speechVoiceName(id)}</option>)}
                    </select>
                  </label>
                  <div className="voicekeyacts">
                    <button className="btn" id="orgSpeechSample" type="button" disabled={!chosen || !pick || sampling} onClick={() => void sample()}>
                      {sampling ? 'Playing…' : 'Play sample'}
                    </button>
                    <button className="btn primary" id="orgSpeechSave" type="button" disabled={!changed || !chosen || !pick || saving} onClick={() => void save()}>
                      {saving ? 'Saving…' : 'Use this voice'}
                    </button>
                  </div>
                  {line ? <p className="formfail" id="orgSpeechLine" role="alert">{line}</p> : null}
                </>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      {admin ? (
        <p className="formhint">
          Prices are OpenRouter’s{list?.checkedAt ? ', read today' : ''}, for a recap of 240 characters, the longest one gets; ≈ marks a model billed by
          the length of the audio. A sample is one sentence on the workplace’s key. The default is ElevenLabs Eleven v4 Turbo with Sarah; if the chosen
          voice stops working, the default reads the recap and says so under it.
        </p>
      ) : null}
    </>
  );
}
