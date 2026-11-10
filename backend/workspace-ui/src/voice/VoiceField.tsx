/**
 * The microphone that sits in a writing field, and the live wave that proves
 * it is hearing you.
 *
 * The legacy page gave every prose input a mic by walking the document with a
 * MutationObserver and wrapping each field in a holder. A React tree cannot be
 * rearranged from outside — inserting a parent between a field and the node
 * React believes is its parent breaks the next insert or remove React makes
 * there — so the holder is a component instead, and a screen opts its field in
 * by wrapping it:
 *
 *     <VoiceField onTranscript={setText}><textarea value={text} … /></VoiceField>
 *
 * `onTranscript` receives the field's WHOLE new value, merged at the selection
 * the field had when recording started, so a controlled component stays
 * controlled and nothing writes to `.value` behind React's back.
 *
 * Exact-value fields — API keys, sign-in codes, the name typed to confirm a
 * deletion — are deliberately NOT wrapped. Recognition must never almost-match
 * a credential (backend/src/routes/workspace.ts says the same thing at
 * the other end of the wire).
 *
 * What the wave is for (note #233): a recording indicator that pulses on a
 * timer looks identical whether the microphone is picking up a voice or is
 * muted, pointed at a wall, or held by a browser that granted the permission
 * and then handed over silence. These bars are the microphone's own signal —
 * the RMS of the last few milliseconds, one bar per step, scrolling right to
 * left — so a flat line is a real answer and a moving one is proof.
 */

import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { WorkspaceApiError, jsonBody } from '../api/client.js';
import { useBanner } from '../chrome/useBanner.js';
import { VOICE_ERROR_CODES, VOICE_ERROR_SENTENCES, voiceErrorIsSettled } from '../../../src/shared/voice-transcription.js';
import { useSession } from '../session/useSession.js';
import { Svg } from '../ui/icons.js';
import { VoiceReview, type VoiceReviewDraft } from './VoiceReview.js';
import { VoiceBlocked } from './VoiceBlocked.js';
import { knownVoiceStatus, noteVoiceOutcome, refreshVoiceStatus, rememberVoiceAnswer, type VoiceStatus } from './voice-status.js';
import type { VoiceAnswer } from '../../../src/shared/voice.js';
import { WorkspaceContext } from '../workspace/context.js';
import {
  VOICE_RECORDING_MAX_MS, VOICE_WAVE_BARS, VOICE_WAVE_STEP_MS,
  barScale, insertTranscript, levelFromTimeDomain, preferredVoiceMimeType,
  pushLevel, voiceInputSupported, voicePermissionMessage,
} from './voice-input.js';

type VoiceTarget = HTMLInputElement | HTMLTextAreaElement;

/**
 * What a failed transcription says, and whether recording again can help
 * (note #1023). The server's own sentence when it sent one; a plain one when
 * nothing readable came back — a dropped connection, or an error page from
 * something in between, which used to surface as "Request failed (502)".
 * Out of credit and a rejected key are settled: no second recording fixes
 * them, so the full-screen recorder offers no "Try recording again".
 */
export function transcriptionFailure(error: unknown): { message: string; retry: boolean } {
  if (error instanceof WorkspaceApiError) {
    const body = error.body as { error?: unknown; code?: unknown } | null;
    if (voiceErrorIsSettled(body?.code)) {
      const sentence = typeof body?.error === 'string' && body.error ? body.error : VOICE_ERROR_SENTENCES[body!.code as keyof typeof VOICE_ERROR_SENTENCES];
      return { message: sentence, retry: false };
    }
    if (typeof body?.error === 'string' && body.error) return { message: body.error, retry: true };
  }
  return { message: VOICE_ERROR_SENTENCES[VOICE_ERROR_CODES.failed], retry: true };
}
type VoiceState = 'idle' | 'requesting' | 'recording' | 'transcribing';

/** The analyser and the frame loop that reads it. Held together because they
 *  are released together: a loop still running against a closed context is a
 *  frame budget spent on nothing. */
interface Meter {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  /** The analyser writes into this one, so it is pinned to a plain
   *  ArrayBuffer rather than the shared-buffer union `Uint8Array` allows. */
  samples: Uint8Array<ArrayBuffer>;
  history: Float32Array;
  frame: number;
  last: number;
}

/** Everything one recording owns, in a ref rather than in state: teardown has
 *  to be exact and immediate, and a render is neither. */
interface Live {
  stream: MediaStream | null;
  recorder: MediaRecorder | null;
  chunks: Blob[];
  timer: ReturnType<typeof setTimeout> | undefined;
  meter: Meter | null;
  abort: AbortController | null;
  canceled: boolean;
  transcribe: boolean;
  selectionStart: number;
  selectionEnd: number;
}

/**
 * One microphone, for the whole app.
 *
 * Two fields recording at once would be two permission grants, two uploads and
 * a transcript that lands in whichever field is asked last — and the device
 * itself may only have one input. The second tap is refused with a sentence
 * rather than silently stealing the first one's stream.
 */
let inUse: Live | null = null;

function audioContextClass(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  const scope = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return scope.AudioContext ?? scope.webkitAudioContext;
}

const LABELS: Record<VoiceState, (name: string) => string> = {
  idle: (name) => `Dictate into ${name}`,
  requesting: () => 'Waiting for microphone access',
  recording: (name) => `Stop recording for ${name}`,
  transcribing: () => 'Turning recording into text',
};

/** What to call this field in the button's label. The screens caption their
 *  fields in three different ways; all three are better than "this field". */
function fieldName(field: VoiceTarget | null): string {
  if (!field) return 'this field';
  const labelled = field.getAttribute('aria-label');
  if (labelled) return labelled;
  const caption = field.closest('label')?.querySelector('.k, .stepk');
  return caption?.textContent?.trim() || field.placeholder || 'this field';
}

export function VoiceField({ onTranscript, children, review }: {
  /** The field's whole new value, with the transcript already merged in, and
   *  where the caret ends up — the end of what was just dictated. A screen
   *  that tracks the caret itself needs the second one; most callers pass
   *  their setter and ignore it. */
  onTranscript: (value: string, caret: number) => void;
  /** Exactly one `<input>` or `<textarea>`, plus whatever belongs beside it. */
  children: ReactNode;
  /** Chat reviews its words in a full-screen editor before sending. Other
   *  writing fields keep their inline microphone. */
  review?: VoiceReviewDraft;
}) {
  const [state, setState] = useState<VoiceState>('idle');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [error, setError] = useState('');
  /** False only for a failure no second recording can fix. */
  const [canRetry, setCanRetry] = useState(true);
  const fullscreen = Boolean(review);
  /** True once the analyser is actually running: only then does the ring stop
   *  keeping its own time and follow the microphone instead. */
  const [metered, setMetered] = useState(false);
  const [name, setName] = useState('this field');
  const holder = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  const live = useRef<Live | null>(null);
  const mounted = useRef(true);
  const banner = useBanner();
  const { api } = useSession();
  /** The workplace's voice-to-text is off or paused: the "not set up" screen
   *  is open instead of a recording (note #1026). */
  const [blocked, setBlocked] = useState<VoiceStatus | null>(null);
  const orgId = useContext(WorkspaceContext)?.state?.org?.orgId;
  const read = useCallback(<T,>(path: string) => api.api<T>(path), [api]);
  // The "not set up" screen's one tap (note #1116): copy the key this admin
  // already saved in another workplace. Same scope as the read above, so it
  // lands in the workplace that answered "off".
  const copyKey = useCallback(async (fromOrgId: string) => {
    const answer = await api.api<VoiceAnswer>('api/voice/key/copy', jsonBody({ fromOrgId }, 'POST'));
    rememberVoiceAnswer(answer);
    return answer;
  }, [api]);
  const report = useCallback((message: string, retry = true) => {
    if (fullscreen) { setError(message); setCanRetry(retry); }
    else banner.show(message);
  }, [banner, fullscreen]);
  /** Read at the moment the transcript arrives, never captured when the
   *  recording started: a screen is free to hand a fresh closure every
   *  render, and ninety seconds is a long time to hold a stale one. */
  const emit = useRef(onTranscript);
  useEffect(() => { emit.current = onTranscript; });

  /** The field this holder wraps. Read from the DOM rather than taken as a
   *  ref so a screen opts in by wrapping and nothing else. */
  const target = useCallback((): VoiceTarget | null => (
    holder.current?.querySelector<VoiceTarget>('textarea, input:not([type="file"]):not([type="hidden"])') ?? null
  ), []);

  const stopMeter = useCallback((session: Live) => {
    const meter = session.meter;
    if (!meter) return;
    session.meter = null;
    if (mounted.current) setMetered(false);
    cancelAnimationFrame(meter.frame);
    try { meter.source.disconnect(); } catch { /* already torn down with the track */ }
    try { meter.analyser.disconnect(); } catch { /* the same */ }
    void meter.context.close().catch(() => { /* a context closed twice is still closed */ });
    button.current?.style.removeProperty('--voicelevel');
  }, []);

  /** Give the physical microphone back and put the button at rest. Safe to
   *  call twice: the second call has nothing left to release. */
  const release = useCallback((session: Live) => {
    clearTimeout(session.timer);
    stopMeter(session);
    if (session.stream) {
      for (const track of session.stream.getTracks()) track.stop();
      session.stream = null;
    }
    if (live.current === session) {
      live.current = null;
      if (mounted.current) setState('idle');
    }
    if (inUse === session) inUse = null;
  }, [stopMeter]);

  /**
   * Watch the stream and drive the bars imperatively.
   *
   * Sixty state updates a second for twenty-eight bars would repaint the
   * screen the composer sits on; a transform written straight onto the bar is
   * the compositor's job and React never hears about it. The analyser is NOT
   * connected onward to the destination — that would play the microphone back
   * through the speakers, which is a feedback loop, not a feature.
   */
  const startMeter = useCallback((session: Live, stream: MediaStream) => {
    const Context = audioContextClass();
    if (!Context) return;
    try {
      const context = new Context();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      // Safari hands back a suspended context even inside the gesture that
      // asked for the microphone; an unresumed one reads as pure silence.
      if (context.state === 'suspended') void context.resume().catch(() => { /* the wave stays flat, the recording is unaffected */ });
      const meter: Meter = {
        context,
        source,
        analyser,
        samples: new Uint8Array(analyser.fftSize),
        history: new Float32Array(VOICE_WAVE_BARS),
        frame: 0,
        last: 0,
      };
      session.meter = meter;
      const step = (now: number) => {
        if (session.meter !== meter) return;
        meter.frame = requestAnimationFrame(step);
        if (now - meter.last < VOICE_WAVE_STEP_MS) return;
        meter.last = now;
        meter.analyser.getByteTimeDomainData(meter.samples);
        const level = levelFromTimeDomain(meter.samples);
        pushLevel(meter.history, level);
        const strip = bars.current;
        for (let index = 0; index < strip.length; index += 1) {
          const bar = strip[index];
          if (bar) bar.style.transform = `scaleY(${barScale(meter.history[index] ?? 0).toFixed(3)})`;
        }
        // The ring around the button breathes with the same number, so the
        // control itself carries the signal even where the strip is clipped.
        button.current?.style.setProperty('--voicelevel', level.toFixed(3));
      };
      meter.frame = requestAnimationFrame(step);
      if (mounted.current) setMetered(true);
    } catch {
      // No Web Audio, or a browser that refuses a second context. The
      // recording is unaffected; the button falls back to its own pulse.
      session.meter = null;
    }
  }, []);

  /** The recording is over: send it up, put what came back into the words. */
  const finish = useCallback(async (session: Live) => {
    clearTimeout(session.timer);
    if (session.stream) {
      for (const track of session.stream.getTracks()) track.stop();
      session.stream = null;
    }
    stopMeter(session);
    if (session.canceled || !session.transcribe) { release(session); return; }
    if (mounted.current) setState('transcribing');

    const contentType = session.recorder?.mimeType || session.chunks[0]?.type || 'audio/webm';
    const recording = new Blob(session.chunks, { type: contentType });
    if (!recording.size) {
      release(session);
      report('No audio was captured. Please try again.');
      return;
    }
    const controller = new AbortController();
    session.abort = controller;
    try {
      const answer = await api.api<{ text?: string }>('api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: recording,
        signal: controller.signal,
      });
      if (session.canceled) return;
      noteVoiceOutcome(null);
      const field = target();
      const merged = field
        ? insertTranscript(
          field.value,
          session.selectionStart,
          session.selectionEnd,
          answer?.text ?? '',
          field.maxLength,
        )
        : null;
      if (!merged) {
        report(answer?.text?.trim() ? 'This field is already full.' : 'No words were heard. Please try again.');
      } else {
        emit.current(merged.value, merged.caret);
        // The caret goes to the end of what was dictated, after React has put
        // the new words on screen — before that, the field is still the old
        // string and the position would land in the middle of it.
        requestAnimationFrame(() => {
          const settled = target();
          if (!settled?.isConnected) return;
          // An input type that does not carry a selection throws rather than
          // declining, and this runs outside every catch the page has.
          try { settled.setSelectionRange(merged.caret, merged.caret); }
          catch { /* the words landed; only the caret did not */ }
        });
      }
    } catch (error) {
      if (!session.canceled) {
        const failure = transcriptionFailure(error);
        // A settled refusal is remembered, so the next press opens the "not
        // set up" screen straight away (note #1026).
        if (!failure.retry && error instanceof WorkspaceApiError) noteVoiceOutcome(error.code ?? null);
        report(failure.message, failure.retry);
      }
    } finally {
      release(session);
    }
  }, [api, report, release, stopMeter, target]);

  const stop = useCallback((session: Live, transcribe: boolean) => {
    clearTimeout(session.timer);
    session.transcribe = transcribe;
    if (transcribe && mounted.current) setState('transcribing');
    if (session.recorder && session.recorder.state !== 'inactive') session.recorder.stop();
    else if (transcribe) void finish(session);
    else release(session);
  }, [finish, release]);

  /** Leaving the screen, hiding the tab or unmounting always hands the
   *  physical microphone back — an in-flight upload included. */
  const cancel = useCallback(() => {
    if (mounted.current) setReviewOpen(false);
    const session = live.current;
    if (!session) return;
    session.canceled = true;
    session.transcribe = false;
    session.abort?.abort();
    if (session.recorder && session.recorder.state !== 'inactive') session.recorder.stop();
    release(session);
  }, [release]);

  const start = useCallback(async () => {
    const field = target();
    if (!field || field.disabled || field.readOnly) return;
    setError('');
    setCanRetry(true);
    // Known before anybody talks (note #1026): no key, or a paused one, opens
    // the "not set up" screen and records nothing. Unknown records as before;
    // the route still refuses, and that answer lands in the same place.
    const status = knownVoiceStatus();
    void refreshVoiceStatus(read);
    if (status && status.state !== 'on') {
      setBlocked(status);
      return;
    }
    if (fullscreen) setReviewOpen(true);
    if (!voiceInputSupported()) {
      report('Voice-to-text is not supported by this browser.');
      return;
    }
    if (inUse) {
      report('Finish the current recording before starting another one.');
      return;
    }
    const session: Live = {
      stream: null,
      recorder: null,
      chunks: [],
      timer: undefined,
      meter: null,
      abort: null,
      canceled: false,
      transcribe: true,
      selectionStart: typeof field.selectionStart === 'number' ? field.selectionStart : field.value.length,
      selectionEnd: typeof field.selectionEnd === 'number' ? field.selectionEnd : field.value.length,
    };
    live.current = session;
    inUse = session;
    setState('requesting');
    // The keyboard has nothing to do while a voice is being recorded, and on a
    // phone it is half the screen the wave wants.
    field.blur();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (session.canceled || live.current !== session || !mounted.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      session.stream = stream;
      const mimeType = preferredVoiceMimeType();
      const recorder = mimeType ? new window.MediaRecorder(stream, { mimeType }) : new window.MediaRecorder(stream);
      session.recorder = recorder;
      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data?.size) session.chunks.push(event.data);
      };
      recorder.onerror = () => {
        session.transcribe = false;
        report('The recording stopped unexpectedly. Please try again.');
        if (recorder.state !== 'inactive') recorder.stop();
        else release(session);
      };
      recorder.onstop = () => { void finish(session); };
      recorder.start();
      setState('recording');
      startMeter(session, stream);
      session.timer = setTimeout(() => stop(session, true), VOICE_RECORDING_MAX_MS);
    } catch (error) {
      const refused = session.canceled;
      release(session);
      if (!refused) report(voicePermissionMessage(error));
    }
  }, [fullscreen, report, finish, read, release, startMeter, stop, target]);

  const toggle = useCallback(() => {
    const session = live.current;
    if (!session) { void start(); return; }
    if (state === 'recording') stop(session, true);
  }, [start, state, stop]);

  // Every microphone asks once when it appears; the page shares one answer.
  useEffect(() => { void refreshVoiceStatus(read); }, [read]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancel(); };
  }, [cancel]);

  useEffect(() => {
    if (state === 'idle') return undefined;
    const hidden = () => { if (document.hidden) cancel(); };
    document.addEventListener('visibilitychange', hidden);
    return () => { document.removeEventListener('visibilitychange', hidden); };
  }, [cancel, state]);

  // The caption is a fact of the DOM this holder wraps, so it can only be read
  // once that DOM exists — and again at every state change, which is where the
  // legacy page re-read it too. Settling on the same string bails out of the
  // re-render rather than looping.
  useLayoutEffect(() => { setName(fieldName(target())); }, [state, target]);

  const recording = state === 'recording';
  const label = LABELS[state](name);
  const paint = recording
    ? (metered ? 'voicebtn recording metered' : 'voicebtn recording')
    : state === 'idle' ? 'voicebtn' : 'voicebtn working';
  const wave = recording ? (
    <div className="voicewave" aria-hidden="true">
      {Array.from({ length: VOICE_WAVE_BARS }, (_, index) => (
        <span key={index} ref={(node) => { bars.current[index] = node; }} />
      ))}
    </div>
  ) : null;

  return (
    <div className="voicefield" ref={holder}>
      {children}
      {fullscreen ? null : wave}
      <button
        className={paint}
        ref={button}
        type="button"
        aria-label={label}
        aria-pressed={recording}
        title={state === 'idle' ? 'Dictate' : label}
        // A mic inside one of the wrapping labels must not hand focus straight
        // back to the field the recording just put the keyboard away for. The
        // click still fires; only the label's own activation does not.
        onPointerDown={(event) => event.preventDefault()}
        onClick={(event) => { event.preventDefault(); event.stopPropagation(); toggle(); }}
      >
        {recording ? <Svg name="stop" size={17} /> : state === 'idle' ? <Svg name="mic" size={18} /> : <span className="voicespin" />}
      </button>
      {blocked ? <VoiceBlocked status={blocked} orgId={orgId} onCopy={copyKey} onClose={() => setBlocked(null)} /> : null}
      {reviewOpen && review ? (
        <VoiceReview
          draft={review} state={state} error={error} canRetry={canRetry} wave={wave} metered={metered}
          onClose={cancel} onRetry={() => { void start(); }}
          onStop={() => { const session = live.current; if (session && state === 'recording') stop(session, true); }}
        />
      ) : null}
    </div>
  );
}
