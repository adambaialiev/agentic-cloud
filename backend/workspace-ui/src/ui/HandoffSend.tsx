/**
 * The message itself, prefilled and one tap from going — the screen a hand
 * tile opens.
 *
 * Transient (knowledge page "miniapp-navigation"): it keeps the document's
 * address underneath it, so Back closes it and the reader comes back to the
 * page or note they tapped from, at the line they were on. Nothing typed
 * here ever becomes a copied URL.
 *
 * Shared by quick notes, knowledge pages and both proposal review screens.
 * They differ only in what the box opens with and — for a note — the door
 * that records the handoff on it as it sends (notes #234/#258). The caller
 * brings both.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WorkspaceIdleMessageAnswer } from '../../../src/shared/workspace-api.js';
import { ScreenTitle } from '../chrome/ScreenTitle.js';
import { useBackClaim } from '../chrome/useBack.js';
import { useBanner } from '../chrome/useBanner.js';
import { useSession } from '../session/useSession.js';
import type { HomeAgent } from '../workspace/live.js';
import { VoiceField } from '../voice/VoiceField.js';
import { useWorkspace } from '../workspace/useWorkspace.js';
import { HANDOFF_MESSAGE_MAX, sendHandoffMessage } from './handoff.js';

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function HandoffSend({ agent, prefill, onClose, send }: {
  agent: HomeAgent;
  /** What the box opens with. A PREFILL, not a decision — the reader can
   *  edit it or empty it. */
  prefill: string;
  onClose: () => void;
  /** How this document sends. Absent means the plain idle-message door; a
   *  note passes its own, which records the handoff in the same request. */
  send?: (message: string) => Promise<WorkspaceIdleMessageAnswer>;
}) {
  const { api } = useSession();
  const { reload } = useWorkspace();
  const banner = useBanner();
  const [text, setText] = useState(prefill);
  const [sending, setSending] = useState(false);
  const box = useRef<HTMLTextAreaElement | null>(null);
  useBackClaim(onClose);

  // Focused but NOT selected: the prefill is usually right as it stands, and
  // a selection would mean the first keystroke of an edit wipes it.
  useEffect(() => {
    const field = box.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, []);

  // Grow with the text rather than becoming an inner scroller — the legacy
  // `autoGrow`. Measured after layout, because the value was put here from
  // script and the field's own input listener has nothing to fire on.
  useLayoutEffect(() => {
    const field = box.current;
    if (!field) return;
    field.style.height = 'auto';
    const border = field.offsetHeight - field.clientHeight;
    if (field.scrollHeight) field.style.height = `${field.scrollHeight + border}px`;
  }, [text]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    void (async () => {
      try {
        const result = send
          ? await send(message)
          : await sendHandoffMessage(api, agent.id, message);
        banner.show(`${result?.name || agent.name} is on it — the answer lands in its chat.`, true);
        // Back onto the document the card was tapped on, at the line it was
        // tapped from, before the refresh lands under it.
        onClose();
        // The fleet has just changed under us: the agent that took this is
        // working now, so the row it was tapped from must lose its face.
        await reload().catch(() => { /* the next poll repaints the row */ });
      } catch (error) {
        banner.show(errorMessage(error));
        setSending(false);
      }
    })();
  };

  return (
    <div className="screen" id="screenNoteSend">
      <ScreenTitle
        titleId="noteSendTitle"
        title={agent.name}
        subId="noteSendSub"
        sub="Workspace conversation"
      />
      <form id="noteSendForm" autoComplete="off" onSubmit={submit}>
        <div className="card">
          <label className="drow frow">
            <div className="head">
              <div className="k">Message</div>
              <div className="count" id="noteSendCount">{text.length} / {HANDOFF_MESSAGE_MAX}</div>
            </div>
            <VoiceField onTranscript={setText}>
              <textarea
                id="noteSendText"
                className="prose"
                rows={3}
                maxLength={HANDOFF_MESSAGE_MAX}
                required
                ref={box}
                value={text}
                disabled={sending}
                onChange={(event) => setText(event.target.value)}
              />
            </VoiceField>
          </label>
        </div>
        <button className="formcommit" id="noteSendBtn" type="submit" disabled={sending || !text.trim()}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </form>
    </div>
  );
}
