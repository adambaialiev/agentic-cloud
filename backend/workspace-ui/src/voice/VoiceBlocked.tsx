/**
 * The recorder's "not set up" screen (note #1026, Adam 6 Nov 2026: "keep
 * microphone, but in the voice input screen there should be UI that key is
 * not set up and hint to where to set the key"). The microphone is always
 * there; when the workplace has no OpenRouter key, or its key is paused,
 * pressing it opens this instead of a recording, and nothing is recorded.
 *
 * It wears the full-screen recorder's own dialog, so on a phone it is the
 * same screen a recording would have opened. The sentences are Rosa's from
 * note #1023; what this adds is where it is fixed: a door to the Workplace
 * screen's Voice-to-text section for an admin, a name to ask for anyone else.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useInRouterContext, useNavigate } from 'react-router-dom';
import { VOICE_ERROR_CODES, VOICE_ERROR_SENTENCES } from '../../../src/shared/voice-transcription.js';
import { toFor } from '../routes.js';
import { Svg } from '../ui/icons.js';
import type { VoiceAnswer, VoiceKeySource } from '../../../src/shared/voice.js';
import { errorMessage } from '../ui/format.js';
import type { VoiceStatus } from './voice-status.js';

/** The section's id on the Workplace screen (screens/org/VoiceSection.tsx). */
export const VOICE_SETTINGS_ANCHOR = 'orgVoice';

export interface VoiceBlockedWords {
  title: string;
  sentence: string;
  /** Where it is fixed: a hint for a member, the button's words for an admin. */
  where: string;
  action?: string;
}

function namesWords(admins: readonly string[]): string {
  if (admins.length === 0) return 'an admin of this workplace';
  if (admins.length === 1) return admins[0]!;
  if (admins.length === 2) return `${admins[0]} or ${admins[1]}`;
  return `${admins[0]}, ${admins[1]} or another admin`;
}

/** "Eldiiar", "Eldiiar or Personal", "Eldiiar, Personal or Studio". */
function workplacesWords(sources: readonly VoiceKeySource[]): string {
  const names = sources.map((source) => source.name);
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/** What the screen says once a copy landed (note #1116). */
export function voiceCopiedWords(fromName: string): { title: string; sentence: string; where: string } {
  return {
    title: 'Voice-to-text is on',
    sentence: `This workplace now has its own copy of the key from ${fromName}. Tap the microphone again to dictate.`,
    where: `The two are not linked: replacing or removing the key in one workplace does not change the other. Both keep paying the same OpenRouter account.`,
  };
}

export function voiceBlockedWords(status: VoiceStatus): VoiceBlockedWords {
  const admin = status.canChange;
  if (status.state === 'off' && admin && status.copyFrom?.length) {
    return {
      title: 'Voice-to-text is not set up yet',
      sentence: VOICE_ERROR_SENTENCES[VOICE_ERROR_CODES.notConfigured],
      where: `You already saved a key in ${workplacesWords(status.copyFrom)}. One tap copies it into this workplace; the key itself is never shown.`,
      action: 'Use a new key instead',
    };
  }
  if (status.state === 'off') {
    return {
      title: 'Voice-to-text is not set up yet',
      sentence: VOICE_ERROR_SENTENCES[VOICE_ERROR_CODES.notConfigured],
      where: admin
        ? 'Turn it on with the workplace’s own OpenRouter key on the Workplace screen, under Voice-to-text.'
        : `An admin turns it on with an OpenRouter key on the Workplace screen, under Voice-to-text. Ask ${namesWords(status.admins)}.`,
      ...(admin ? { action: 'Set up voice-to-text' } : {}),
    };
  }
  const rejected = status.reason === 'key_rejected';
  return {
    title: 'Voice-to-text is paused',
    sentence: VOICE_ERROR_SENTENCES[rejected ? VOICE_ERROR_CODES.keyRejected : VOICE_ERROR_CODES.outOfCredit],
    where: admin
      ? (rejected
        ? 'Save a new OpenRouter key on the Workplace screen, under Voice-to-text.'
        : 'Add credit on openrouter.ai; voice comes back by itself within a couple of minutes. The key is on the Workplace screen, under Voice-to-text.')
      : `Ask ${namesWords(status.admins)}.`,
    ...(admin ? { action: 'Open voice settings' } : {}),
  };
}

function SettingsButton({ label, orgId, onDone, quiet = false }: { label: string; orgId?: string; onDone: () => void; quiet?: boolean }) {
  const navigate = useNavigate();
  const to = toFor({ kind: 'organization', ...(orgId ? { orgId } : {}) });
  return (
    <button
      type="button" className={quiet ? 'btn' : 'btn primary'} id="voiceBlockedSettings"
      onClick={() => {
        onDone();
        if (to) navigate(`${to}#${VOICE_SETTINGS_ANCHOR}`);
      }}
    >
      {label}
    </button>
  );
}

export function VoiceBlocked({ status, orgId, onClose, onCopy }: {
  status: VoiceStatus;
  orgId?: string;
  onClose: () => void;
  /** Copy another workplace's key into this one (note #1116); absent, no offer. */
  onCopy?: (fromOrgId: string) => Promise<VoiceAnswer>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const routed = useInRouterContext();
  const [copying, setCopying] = useState('');
  const [copied, setCopied] = useState('');
  const [failure, setFailure] = useState('');
  const sources = onCopy && status.state === 'off' && status.canChange ? status.copyFrom ?? [] : [];
  const blocked = voiceBlockedWords(sources.length ? status : { ...status, copyFrom: undefined });
  const words = copied ? { ...voiceCopiedWords(copied), action: undefined } : blocked;

  const copy = async (source: VoiceKeySource) => {
    if (!onCopy || copying) return;
    setCopying(source.orgId);
    setFailure('');
    try {
      await onCopy(source.orgId);
      setCopied(source.name);
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setCopying('');
    }
  };

  useLayoutEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (typeof node.showModal === 'function' && !node.open) node.showModal();
    close.current?.focus({ preventScroll: true });
    node.style.setProperty('--voice-height', `${window.innerHeight}px`);
    node.style.setProperty('--voice-top', '0px');
    return () => { if (node.open) node.close(); };
  }, []);

  return createPortal(
    <dialog
      ref={dialog} className="voicereview voiceblocked" aria-labelledby="voiceBlockedTitle"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
    >
      <div className="voicereview-inner">
        <header className="voicereview-head">
          <button ref={close} type="button" className="voicereview-back" aria-label="Back" onClick={onClose}>
            <Svg name="back" size={20} />
          </button>
          <h1 id="voiceBlockedTitle">Voice-to-text</h1>
        </header>
        <div className="voicereview-stage voiceblocked-stage">
          <span className={copied ? 'voiceblocked-icon on' : 'voiceblocked-icon'} aria-hidden="true"><Svg name={copied || status.state === 'off' ? 'mic' : 'pause'} size={32} /></span>
          <p className="voiceblocked-title">{words.title}</p>
          <p className="voiceblocked-sentence" role="status">{words.sentence}</p>
          <p className="voicereview-hint">{words.where}</p>
          {failure ? <p className="formfail" role="alert">{failure}</p> : null}
        </div>
        <footer className="voicereview-actions voiceblocked-actions">
          {!copied ? sources.map((source) => (
            <button
              key={source.orgId} type="button" className="btn primary voiceblocked-copy"
              disabled={Boolean(copying)} onClick={() => void copy(source)}
            >
              {copying === source.orgId ? <span className="spinner" /> : null}
              {copying === source.orgId ? 'Checking with OpenRouter…' : `Use the key from ${source.name}`}
            </button>
          )) : null}
          {words.action && routed ? <SettingsButton label={words.action} orgId={orgId} onDone={onClose} quiet={sources.length > 0} /> : null}
          <button type="button" className={(words.action && routed) || (sources.length > 0 && !copied) ? 'btn ghost' : 'btn primary'} onClick={onClose}>
            {copied ? 'Done' : (words.action && routed) || sources.length > 0 ? 'Not now' : 'Got it'}
          </button>
        </footer>
      </div>
    </dialog>, document.body,
  );
}
