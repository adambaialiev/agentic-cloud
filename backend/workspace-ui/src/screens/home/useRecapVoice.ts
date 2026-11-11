/**
 * The speaker in the Chief of Staff's header and the play button on its
 * recap (note #1146). The rules are in recap-voice.ts; this is their wiring.
 *
 * The speaker stands only where the workplace has an OpenRouter key — the
 * one dictation already uses, read through the same shared status answer
 * (voice/voice-status.ts): no key, no button. The audio comes from
 * POST api/recap/speech, which holds the key; the page never sees it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceTurnRecap } from '../../../../src/shared/turn-recap.js';
import { RECAP_SPEECH_CHANGED, RECAP_SPEECH_SENTENCES, type RecapSpeechAnswer } from '../../../../src/shared/voice-speech.js';
import { VOICE_ERROR_CODES } from '../../../../src/shared/voice-transcription.js';
import { jsonBody, WorkspaceApiError, type WorkspaceApi } from '../../api/client.js';
import { knownVoiceStatus, noteVoiceOutcome, refreshVoiceStatus, type VoiceStatus } from '../../voice/voice-status.js';
import {
  audioUrl, existingRecapPlayer, recapAutoplay, recapPlayer, recapVoiceRemembered, RECAP_NOT_PRIMED, rememberRecapVoice, unlockRecapAudio, type RecapHeard,
} from './recap-voice.js';

export type RecapPlayState = 'idle' | 'loading' | 'playing';

export interface RecapVoice {
  /** The workplace has a key: the speaker and the play button may stand. */
  available: boolean;
  on: boolean;
  toggle(): void;
  play(): void;
  state: RecapPlayState;
  /** One plain line when reading aloud failed; '' otherwise. */
  error: string;
}

const BLOCKED = 'Your browser kept the recap quiet. Tap play to hear it.';

export function useRecapVoice(
  api: Pick<WorkspaceApi, 'api'>,
  turn: WorkspaceTurnRecap | undefined,
  shown: boolean,
  loaded: boolean,
): RecapVoice {
  const [status, setStatus] = useState<VoiceStatus | null>(() => knownVoiceStatus());
  const [on, setOn] = useState(recapVoiceRemembered);
  const [state, setState] = useState<RecapPlayState>('idle');
  const [error, setError] = useState('');
  const heard = useRef<RecapHeard>(RECAP_NOT_PRIMED);
  const urls = useRef(new Map<string, string>());
  /** Which request is current: a tap on Stop, or a newer play, outdates it. */
  const asked = useRef(0);

  useEffect(() => {
    let live = true;
    void refreshVoiceStatus((path) => api.api(path)).then((next) => { if (live) setStatus(next); });
    return () => { live = false; };
  }, [api]);
  const available = Boolean(status && status.state !== 'off');

  const stop = useCallback(() => {
    asked.current += 1;
    try { existingRecapPlayer()?.pause(); } catch { /* nothing playing */ }
    setState('idle');
  }, []);

  // What it played stops, and the URLs it was given die, with the screen.
  useEffect(() => {
    const made = urls.current;
    return () => {
      asked.current += 1;
      try { existingRecapPlayer()?.pause(); } catch { /* nothing playing */ }
      for (const url of made.values()) URL.revokeObjectURL(url);
      made.clear();
    };
  }, []);

  const speak = useCallback(async (text: string, byTap: boolean) => {
    const ask = ++asked.current;
    setError('');
    setState('loading');
    try {
      let url = urls.current.get(text);
      if (!url) {
        const answer = await api.api<RecapSpeechAnswer>('api/recap/speech', jsonBody({ text }));
        if (!answer?.audio) throw new Error('no audio');
        url = audioUrl(answer.audio, answer.contentType);
        urls.current.set(text, url);
        noteVoiceOutcome(null);
      }
      if (ask !== asked.current) return;
      const element = recapPlayer();
      // Only a recap's end counts: the unlocking breath of silence ends too.
      element.onended = () => { if (ask === asked.current) setState('idle'); };
      element.src = url;
      await element.play();
      if (ask === asked.current) setState('playing');
    } catch (err) {
      if (ask !== asked.current) return;
      setState('idle');
      const code = err instanceof WorkspaceApiError ? err.code : undefined;
      // Replaced by a newer summary since this screen read it: the next read
      // brings the new words, and nothing went wrong.
      if (code === RECAP_SPEECH_CHANGED) return;
      if (typeof code === 'string' && code !== VOICE_ERROR_CODES.failed) {
        noteVoiceOutcome(code);
        setStatus(knownVoiceStatus());
      }
      const sentence = typeof code === 'string' && code in RECAP_SPEECH_SENTENCES
        ? RECAP_SPEECH_SENTENCES[code as keyof typeof RECAP_SPEECH_SENTENCES]
        : (err as { name?: string } | null)?.name === 'NotAllowedError' && !byTap
          ? BLOCKED
          : RECAP_SPEECH_SENTENCES.voice_failed;
      setError(sentence);
    }
  }, [api]);

  // Each answer: does a new recap play by itself?
  const text = turn?.recap;
  useEffect(() => {
    if (!loaded) return;
    const step = recapAutoplay(heard.current, {
      turn, shown, on: on && available,
      visible: typeof document === 'undefined' || document.visibilityState !== 'hidden',
    });
    heard.current = step.heard;
    if (step.play && text) void speak(text, false);
  }, [loaded, turn?.endedAt, text, shown, on, available, speak]); // eslint-disable-line react-hooks/exhaustive-deps

  // With the speaker on after a reload, the first tap anywhere unlocks the
  // player (iPhone Safari): sending a message is such a tap.
  useEffect(() => {
    if (!on || typeof document === 'undefined') return;
    const unlock = () => unlockRecapAudio();
    document.addEventListener('touchend', unlock, { capture: true, once: true });
    document.addEventListener('click', unlock, { capture: true, once: true });
    return () => {
      document.removeEventListener('touchend', unlock, { capture: true });
      document.removeEventListener('click', unlock, { capture: true });
    };
  }, [on]);

  const toggle = useCallback(() => {
    const next = !on;
    setOn(next);
    rememberRecapVoice(next);
    setError('');
    if (next) unlockRecapAudio();
    else stop();
  }, [on, stop]);

  const play = useCallback(() => {
    if (state !== 'idle') { stop(); return; }
    if (!text) return;
    unlockRecapAudio();
    void speak(text, true);
  }, [state, text, stop, speak]);

  return { available, on, toggle, play, state, error };
}
