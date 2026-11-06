import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Svg, type IconName } from '../ui/icons.js';

/**
 * What this dialog calls things. Every screen that opens it is committing
 * something different — a message, a note, a remark — and a modal that fills
 * the phone cannot say "message" over a note the reader is writing.
 */
export interface VoiceReviewWords {
  /** Its heading, while reviewing the words and while still recording. */
  review: string;
  record: string;
  /** What Back returns to, for a reader who cannot see where they are. */
  back: string;
  /** The editor itself: its label, and what it says when empty. */
  field: string;
  placeholder: string;
  /** Over the editor: what the reader is about to do with these words. */
  hint: string;
  /** The one button that commits, at rest and in flight. */
  commit: string;
  committing: string;
  /** Its glyph, where the act has one. Saving is not sending, and a paper
   *  plane over "Save note" says it is. */
  icon?: IconName;
  /** Said when committing answers no, with the draft still in the box. */
  failed: string;
}

export interface VoiceReviewDraft {
  value: string;
  onChange: (value: string) => void;
  /** A prose draft such as a note grows with its words until the stylesheet's
   *  bounded review height; compact message/comment reviews keep filling the
   *  available screen as before. */
  autoGrow?: boolean;
  maxLength: number;
  words: VoiceReviewWords;
  /**
   * Files, for a draft that can carry them. A note's words and a remark carry
   * none, so they leave these out and the dialog grows no attach button —
   * rather than offering one that would have nowhere to put a photo.
   */
  attachmentCount?: number;
  attachments?: ReactNode;
  onAttach?: (files: FileList | null) => string | null;
  sending: boolean;
  onSend: () => Promise<boolean>;
}

/** Recording and review share one modal. The native dialog keeps focus and
 * taps out of whatever is underneath; the portal escapes the chat shell's
 * keyboard transform. The draft still belongs to the screen that opened it. */
export function VoiceReview({ draft, state, error, canRetry = true, wave, metered, onClose, onStop, onRetry }: {
  draft: VoiceReviewDraft;
  state: 'idle' | 'requesting' | 'recording' | 'transcribing';
  error: string;
  /** False when recording again cannot help — voice-to-text is out of credit
   *  or its key was refused (note #1023) — so the dialog offers no retry. */
  canRetry?: boolean;
  wave: ReactNode;
  metered: boolean;
  onClose: () => void;
  onStop: () => void;
  onRetry: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [sendError, setSendError] = useState('');
  const busy = pending || draft.sending;
  const editing = state === 'idle';
  const words = draft.words;
  const attached = draft.attachmentCount ?? 0;
  const canAttach = Boolean(draft.onAttach);
  const empty = !draft.value.trim() && !attached;

  // Transcription changes a controlled value; it does not fire an input
  // event on the textarea. Measure after React has committed those words so
  // a spoken note expands for exactly the same reason as a typed edit.
  useLayoutEffect(() => {
    const field = text.current;
    if (!field || !editing || !draft.autoGrow) return;
    field.style.height = 'auto';
    const border = field.offsetHeight - field.clientHeight;
    if (field.scrollHeight) field.style.height = `${field.scrollHeight + border}px`;
  }, [draft.autoGrow, draft.value, editing]);

  useLayoutEffect(() => {
    const node = dialog.current;
    if (!node) return;
    const previous = document.activeElement;
    node.showModal();
    close.current?.focus({ preventScroll: true });
    // dvh alone does not account for a keyboard covering iOS's layout
    // viewport. Keep both the editor and Send inside the visible rectangle.
    //
    // Both numbers are CLAMPED to the window (note #387). They used to be
    // written through exactly as the browser reported them, and a reading
    // taken while the page was mid-reflow — a picture opening full screen
    // over this one is enough — then stood for good, because nothing here
    // ever measured again on its own. `offsetTop` past the bottom of the
    // window is what pushed this screen down the phone, leaving a band of
    // empty background above it and the editor off the end.
    const place = () => {
      const viewport = window.visualViewport;
      const full = window.innerHeight || document.documentElement.clientHeight || 0;
      const height = full > 0 ? Math.min(viewport?.height ?? full, full) : (viewport?.height ?? 0);
      // At most far enough to sit the visible rectangle on the bottom of the
      // window: a keyboard can push this screen down, nothing can push it off.
      const top = Math.min(Math.max(viewport?.offsetTop ?? 0, 0), Math.max(full - height, 0));
      node.style.setProperty('--voice-height', `${height}px`);
      node.style.setProperty('--voice-top', `${top}px`);
    };
    place();
    // Anything that opens over this screen is portalled INTO the dialog — it
    // has to be, because a document-level overlay cannot rise above an open
    // modal's top layer. So its arrival and its departure are both child-list
    // changes here, and both are moments the visible rectangle may have
    // moved: they are when this measures again. Once on the change, and once
    // more on the next frame, because a phone resizes its viewport a beat
    // after the DOM settles.
    let frame = 0;
    const replace = () => {
      place();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    const overlays = new MutationObserver(replace);
    overlays.observe(node, { childList: true });
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    window.addEventListener('resize', place);
    return () => {
      overlays.disconnect();
      cancelAnimationFrame(frame);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
      window.removeEventListener('resize', place);
      node.close();
      // Restore a control, never summon a phone keyboard just by closing.
      if (previous instanceof HTMLButtonElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  const send = async () => {
    if (submitting.current || draft.sending || empty) return;
    submitting.current = true;
    setPending(true);
    setSendError('');
    try {
      if (await draft.onSend()) onClose();
      else setSendError(words.failed);
    } catch {
      setSendError(words.failed);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  const title = editing ? words.review : words.record;
  const status = state === 'requesting' ? 'Waiting for microphone access…'
    : state === 'transcribing' ? 'Turning your voice into text…' : 'Listening';

  return createPortal(
    <dialog
      ref={dialog} className="voicereview" aria-labelledby="voiceReviewTitle"
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
    >
      {/* Marked as the scroller so a picture opened from inside here can put
          this column back exactly where it was when it closes: the page
          underneath is sealed off by this modal, and this is the only thing
          on screen that moves. */}
      <div className="voicereview-inner" data-scroller="voice-review">
        <header className="voicereview-head">
          <button ref={close} type="button" className="voicereview-back" aria-label={words.back} disabled={busy} onClick={onClose}>
            <Svg name="back" size={20} />
          </button>
          <h1 id="voiceReviewTitle">{title}</h1>
        </header>
        {editing ? (
          <>
            <p className="voicereview-hint" id="voiceReviewHint">{words.hint}</p>
            <div className={draft.autoGrow ? 'voicereview-editor autogrow' : 'voicereview-editor'}>
              <textarea
                ref={text}
                className="voicereview-text" aria-label={words.field} placeholder={words.placeholder}
                aria-describedby="voiceReviewHint"
                value={draft.value} maxLength={draft.maxLength} readOnly={busy}
                onChange={(event) => { draft.onChange(event.target.value); setSendError(''); }}
              />
            </div>
            {/* Under the words, not over them (note #387). What is being
                written is the screen; what was brought along sits beneath it,
                small — one chip each, in chat's own strip. */}
            {canAttach ? (
              <div className="chatdraft voicereview-draft" hidden={!attached} data-gallery="voice-review-files">
                {draft.attachments}
              </div>
            ) : null}
            {(error || sendError) ? <p className="voicereview-error" role="alert">{sendError || error}</p> : null}
            <footer className="voicereview-actions">
              {error && canRetry ? <button type="button" className="btn" disabled={busy} onClick={onRetry}>Try recording again</button> : null}
              {/* Attach beside Save, where a running word count used to be.
                  The count was bookkeeping over a screen whose whole job is
                  the words themselves, and the picks below now say how many
                  there are by being there. */}
              <div className="voicereview-sendrow">
                {canAttach ? (
                  <button
                    type="button" className="voicereview-attach" aria-label="Attach files" disabled={busy}
                    onClick={() => picker.current?.click()}
                  >
                    <Svg name="attach" size={18} /> <span className="voicereview-attach-label">Attach files</span>
                  </button>
                ) : null}
                <button type="button" className="btn primary" disabled={busy || empty} onClick={() => { void send(); }}>
                  {words.icon ? <><Svg name={words.icon} size={18} /> </> : null}{busy ? words.committing : words.commit}
                </button>
              </div>
              {canAttach ? (
                <input
                  type="file" id="voiceReviewFile" ref={picker} multiple hidden disabled={busy}
                  onChange={(event) => {
                    const refusal = draft.onAttach?.(event.target.files) ?? null;
                    event.target.value = '';
                    setSendError(refusal ?? '');
                  }}
                />
              ) : null}
            </footer>
          </>
        ) : (
          <>
            <div className="voicereview-stage">
              <p className="voicereview-status" role="status">{status}</p>
              <div className="voicereview-wave">
                {wave || <span className="voicereview-wait" aria-hidden="true"><Svg name="mic" size={40} /></span>}
              </div>
              <p className="voicereview-hint">{state === 'recording' ? 'Speak freely. You can edit the words next.' : 'Your message will appear here.'}</p>
            </div>
            <footer className="voicereview-controls">
              {state === 'recording' ? (
                <>
                  <button type="button" className={`voicereview-stop recording${metered ? ' metered' : ''}`} aria-label="Stop recording" onClick={onStop}>
                    <Svg name="stop" size={28} />
                  </button>
                  <span>Stop recording</span>
                  <span className="voicereview-hint">Up to 90 seconds</span>
                </>
              ) : null}
            </footer>
          </>
        )}
      </div>
    </dialog>, document.body,
  );
}
