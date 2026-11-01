/**
 * The chat's fixed bottom bar: the picked-file draft, the attach button, the
 * box, and Send.
 *
 * What it keeps from the legacy composer:
 *
 *  - The box stops at the cap the route refuses past, rather than taking a
 *    paste it will hand straight back as an error, and it is NOT `required`:
 *    a selected file set is a complete message even with no caption.
 *  - The counter appears only once the cap is in sight. A counter under every
 *    two-line message is bookkeeping nobody asked for.
 *  - The arrow stays the arrow while a send is in flight; the disabled dim is
 *    the "sending" state, exactly as the box's own grey-out is.
 *  - One object URL per picked file, minted at selection and revoked by
 *    remove, send or leaving. The URL is held WITH its file rather than in a
 *    side map, so a repaint can never mint a second and a revoke can never
 *    miss one.
 *  - Picking bare files deliberately put the keyboard away, so a send that
 *    carries only files never pops it back.
 *
 * What note #305 changed: a sent message used to KEEP the keyboard, for rapid
 * chat. On a phone that is half the screen held by keys over the answer the
 * reader just asked for, so a typed message now puts a touch keyboard away.
 * The desk keeps the old behaviour, because there the keyboard is not covering
 * anything and dropping the focus would only cost note #291's Enter.
 *
 * Two things the port had lost (note #273):
 *
 *  - The box GROWS with its lines — the legacy `autoGrow` — up to the cap the
 *    stylesheet sets, and shrinks back when the send empties it. Without it
 *    a second line scrolled inside a one-line box.
 *  - The box is never `disabled`. A disabled control drops focus, and on a
 *    phone that is the keyboard going away on every send; the focus() after
 *    the send could not bring it back because the re-render that re-enables
 *    the box had not happened yet. `readOnly` holds the words still for the
 *    same moment and keeps the focus, and Send itself declines the focus the
 *    tap would take. Both still matter with #305 in: they are what keeps the
 *    keyboard still WHILE the send is in flight, so it goes down once, on
 *    purpose, when the message has actually gone — rather than flickering
 *    away under the thumb and coming back if the send is refused.
 *
 * And the words themselves outlive the screen (note #515): a draft left
 * behind waits in `chrome/draft-memory.ts` under the conversation's key, and
 * is in the box again when the reader comes back to it. The composer only
 * keeps the memory honest on every change; the store decides what is worth
 * holding.
 *
 * Since note #658 a send can be ANSWERED BEFORE IT HAS GONE. The agent chat
 * hands its messages to an outbox that answers at once — the box empties and
 * the bubble is on the transcript in the same moment, however long the
 * server then takes. `onSend` may answer with a plain boolean for exactly
 * that, and the box empties in the same event rather than a tick later,
 * where a second Enter could still find the words in it. A message that is
 * then refused comes back through `giveBack`, in front of whatever has been
 * typed since.
 *
 * And what Enter does (note #291): where there is a keyboard beside the
 * window, a plain Enter sends and Shift+Enter opens the line, the way every
 * chat at a desk behaves. Where there is not — anything a finger drives —
 * Enter stays the newline key it is on a touch keyboard, and the arrow is
 * still the only way to send. `chat-compose.ts` holds both halves of that
 * reading; this file only asks it and obeys.
 */

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { recallDraft, rememberDraft } from '../../chrome/draft-memory.js';
import { VoiceField } from '../../voice/VoiceField.js';
import { useImageViewer } from '../../ui/useImageViewer.js';
import { draftChipMeta, isInlineImage, safeFileName } from '../../ui/file-kind.js';
import { Svg } from '../../ui/icons.js';
import { DraftChip } from '../../ui/DraftChip.js';
import {
  CHAT_COUNT_FROM, CHAT_MESSAGE_MAX, CHAT_TOUCH_QUERY, chatEnterSends, chatFileRefusal,
} from './chat-compose.js';
import type { ReturnedDraft } from './outbox.js';

/** Whether Enter is a key of its own here, rather than the newline key of a
 *  touch keyboard — see CHAT_TOUCH_QUERY for why the test is the negative one.
 *  Asked at the press and never stored, so a folio attached mid-conversation
 *  is picked up on the next one. */
const hasKeyboard = (): boolean =>
  !(window.matchMedia && window.matchMedia(CHAT_TOUCH_QUERY).matches);

/** One picked file and the object URL minted for it. Held together on purpose:
 *  a URL that outlives the file it previews is exactly the leak the revoke
 *  rules exist to prevent, and a repaint must never mint a second. */
interface Picked { file: File; url: string }

function DraftItem({ file, url, onRemove, onPreview }: {
  file: File;
  url: string;
  onRemove: () => void;
  /** A picture picked but not yet sent opens where a sent one does. */
  onPreview: () => void;
}) {
  const picture = Boolean(url) && isInlineImage(file.type);
  return (
    <DraftChip
      name={file.name}
      url={url}
      picture={picture}
      meta={draftChipMeta(file.size, 'ready to send')}
      onOpen={() => { if (picture) { onPreview(); return; } if (url) window.open(url, '_blank', 'noopener'); }}
      onRemove={onRemove}
    />
  );
}

export function ChatComposer({ sending = false, onSend, onRefuse, memory = '', attachments = true, lead = null, giveBack }: {
  /** A send is in flight and the box holds its words (read-only, Send dim).
   *  Never true for a composer whose `onSend` answers at once. */
  sending?: boolean;
  /** What stands to the LEFT of the box, outside the pill — the agent
   *  switcher's stack of faces (note #581). Outside because the pill is the
   *  message: the paperclip inside it puts a file ON this message, and a door
   *  to another conversation is not part of the one being written. */
  lead?: ReactNode;
  /** Whether a file can ride on a message. Off for the Workspace Agent,
   *  whose messages have nowhere for a file to land (note #423): the box,
   *  the keyboard, the voice field and the send are the room chat's, and
   *  only the paperclip is missing. */
  attachments?: boolean;
  /** Where this composer's unsent words wait while the reader is on another
   *  screen (note #515) — the conversation's key in `draft-memory.ts`, or ''
   *  for a composer with nothing to come back to. */
  memory?: string;
  /** True when the message went — or was taken to go, which clears the box
   *  in the same event; a promise when the answer has to be waited for. */
  onSend: (message: string, files: File[]) => boolean | Promise<boolean>;
  onRefuse: (reason: string) => void;
  /** Where a message taken to go comes back from when it was refused after
   *  all (note #658): subscribe, and be handed its words and files. */
  giveBack?: (take: (draft: ReturnedDraft) => void) => () => void;
}) {
  // The words this conversation was left with, if any were (note #515).
  const [text, setText] = useState(() => (memory ? recallDraft(memory) : ''));
  const [picked, setPicked] = useState<Picked[]>([]);
  const viewer = useImageViewer();
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const held = useRef<Picked[]>([]);

  // Every URL this composer minted goes back when it leaves.
  useEffect(() => { held.current = picked; }, [picked]);

  // The words outlive the screen (note #515). Written on every change rather
  // than on the way out, so the memory is right however the composer goes —
  // a Back, a room switch, a re-key — and the send that empties the box is
  // the same write that forgets the draft.
  useEffect(() => { if (memory) rememberDraft(memory, text); }, [memory, text]);

  // Grow with the text rather than scrolling inside one line. Measured after
  // layout on every change of the words, which also covers the send that
  // empties the box from script. The stylesheet's max-height caps the growth
  // and the box scrolls inside itself only past that cap.
  useLayoutEffect(() => {
    const field = box.current;
    if (!field) return;
    field.style.height = 'auto';
    const border = field.offsetHeight - field.clientHeight;
    if (field.scrollHeight) field.style.height = `${field.scrollHeight + border}px`;
  }, [text]);
  useEffect(() => () => { for (const item of held.current) URL.revokeObjectURL(item.url); }, []);

  // Refused after the box had emptied for it (note #658): the words go back
  // in FRONT of anything typed since, because they were written first, and
  // the files are picked again, each with a URL of its own.
  useEffect(() => giveBack?.((draft) => {
    setText((current) => [draft.text, current].filter(Boolean).join('\n\n'));
    if (!draft.files.length) return;
    const back = draft.files.map((file) => ({ file, url: URL.createObjectURL(file) }));
    setPicked((current) => [...back, ...current]);
  }), [giveBack]);

  const select = (chosen: FileList | null): string | null => {
    const selected = Array.from(chosen ?? []);
    if (picker.current) picker.current.value = '';
    if (!selected.length) return null;
    for (const file of selected) {
      const refusal = chatFileRefusal(file);
      if (refusal) return refusal;
    }
    // One URL per file per draft; remove, send and leaving revoke exactly
    // what selection created.
    setPicked([...picked, ...selected.map((file) => ({ file, url: URL.createObjectURL(file) }))]);
    return null;
  };

  const remove = (item: Picked) => {
    URL.revokeObjectURL(item.url);
    setPicked(picked.filter((candidate) => candidate !== item));
  };

  /** The picked PICTURES, full screen, in the order they will be sent —
   *  the same viewer the transcript above opens (note #294), reading the
   *  object URLs the draft already minted. */
  const preview = (item: Picked) => {
    const photos = picked.filter((candidate) => Boolean(candidate.url) && isInlineImage(candidate.file.type));
    const at = photos.indexOf(item);
    if (at < 0) return;
    const review = document.querySelector<HTMLElement>('.voicereview[open]');
    viewer(photos.map((photo) => ({ url: photo.url, name: safeFileName(photo.file.name) })), at, review ?? undefined);
  };

  /** The one send, whichever of the three ways asked for it: the arrow, the
   *  form, or Enter. */
  const submit = async () => {
    const message = text.trim();
    if (sending || (!message && picked.length === 0)) return false;
    const answer = onSend(message, picked.map((item) => item.file));
    const sent = typeof answer === 'boolean' ? answer : await answer;
    if (!sent) return false;
    setText('');
    for (const item of picked) URL.revokeObjectURL(item.url);
    setPicked([]);
    // Note #305: a sent message puts the touch keyboard away. Half the screen
    // stops being keys the moment there is nothing left to type, and the
    // reader gets the answer they just asked for back. At a desk there is no
    // keyboard to put away and the focus is all that would be lost — so there
    // the box keeps it, and note #291's Enter still sends the next message.
    // Only a send that WENT — or was taken to go (note #658) — does this: one
    // refused on the spot leaves the words in the box, where the keyboard is
    // still wanted.
    if (message) { if (hasKeyboard()) box.current?.focus(); else box.current?.blur(); }
    return true;
  };

  const press = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const sends = chatEnterSends({
      key: event.key,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.keyCode,
    }, hasKeyboard());
    if (!sends) return;
    // A press that means "send" must not leave a line break behind as well —
    // including the press that finds nothing to send, where the newline would
    // just be the empty box growing a row for no reason.
    event.preventDefault();
    if (!sending) void submit();
  };

  const empty = !text.trim() && picked.length === 0;
  return (
    <form
      id="agentChatForm"
      className="chatbar"
      autoComplete="off"
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
    >
      {attachments ? <div className="chatdraft" id="agentChatDraft" hidden={picked.length === 0} data-gallery="chat-draft-files">
        {picked.map((item, index) => (
          <DraftItem
            key={`${item.file.name}:${index}`}
            file={item.file}
            url={item.url}
            onRemove={() => remove(item)}
            onPreview={() => preview(item)}
          />
        ))}
      </div> : null}
      <div className="row">
        {lead}
        <div className={attachments ? 'chatinput' : 'chatinput noattach'}>
          {attachments ? <button
            className={picked.length ? 'chatattach hasfile' : 'chatattach'}
            id="agentChatAttach"
            type="button"
            aria-label="Attach files"
            disabled={sending}
            onClick={() => picker.current?.click()}
          >
            <Svg name="attach" size={20} />
          </button> : null}
          <VoiceField onTranscript={setText} review={{
            value: text, onChange: setText, maxLength: CHAT_MESSAGE_MAX,
            attachmentCount: picked.length,
            attachments: picked.map((item, index) => (
              <DraftItem
                key={`${item.file.name}:${index}`}
                file={item.file}
                url={item.url}
                onRemove={() => remove(item)}
                onPreview={() => preview(item)}
              />
            )),
            ...(attachments ? { onAttach: select } : {}), sending, onSend: submit,
            words: {
              review: 'Review message', record: 'Voice message', back: 'Back to chat',
              field: 'Your message', placeholder: 'Write your message…',
              hint: 'Make any changes before you send.',
              commit: 'Send message', committing: 'Sending…', icon: 'send',
              failed: 'The message could not be sent. Your draft is still here. Try again.',
            },
          }}>
            <textarea
              id="agentChatText"
              ref={box}
              rows={1}
              maxLength={CHAT_MESSAGE_MAX}
              placeholder="Message"
              readOnly={sending}
              aria-busy={sending || undefined}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={press}
            />
          </VoiceField>
        </div>
        <button
          className={sending ? 'chatsend sending' : 'chatsend'}
          id="agentChatSend"
          type="submit"
          aria-label="Send"
          disabled={sending || empty}
          // The tap must not take the focus from the box, or the keyboard
          // goes down with every message sent.
          onMouseDown={(event: MouseEvent) => event.preventDefault()}
        >
          <Svg name="send" size={19} />
        </button>
      </div>
      <div className="count" id="agentChatCount" hidden={text.length < CHAT_MESSAGE_MAX - CHAT_COUNT_FROM}>
        {text.length} / {CHAT_MESSAGE_MAX}
      </div>
      {attachments ? <input
        type="file" id="agentChatFile" ref={picker} multiple hidden
        onChange={(event) => {
          const refusal = select(event.target.files);
          if (refusal) onRefuse(refusal);
        }}
      /> : null}
    </form>
  );
}
