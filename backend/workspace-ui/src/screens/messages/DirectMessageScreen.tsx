import React, { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  DIRECT_MESSAGE_FILE_MAX_BYTES, DIRECT_MESSAGE_FILES_PER_MESSAGE, DIRECT_MESSAGE_MAX_LENGTH, directMessageFileSize, sentViaChiefOfStaff,
  type DirectMessage, type DirectMessageFile, type DirectMessagePage,
} from '../../../../src/shared/direct-messages.js';
import { ANSWER_UNREADABLE_CODE, ANSWER_UNREADABLE_SENTENCE, jsonBody, WorkspaceApiError } from '../../api/client.js';
import { directDraftKey, recallDraft, rememberDraft } from '../../chrome/draft-memory.js';
import { useReturnToParent } from '../../chrome/history.js';
import { toFor } from '../../routes.js';
import { PersonFace } from '../../ui/PersonFace.js';
import { Markdown } from '../../render/Markdown.js';
import { Svg } from '../../ui/icons.js';
import { errorMessage } from '../../ui/format.js';
import { useOrgApi, useOrgId } from '../org/useOrgApi.js';
import { isAnswerObject, isOpening, pollFailureLine, useMessagePoll, usePollMisses } from './useMessagePoll.js';
import { forgetThread, heldThread, holdThread } from './messages-cache.js';
import { useSession } from '../../session/useSession.js';
import { useChatViewport } from '../chat/ChatScreen.js';
import { chatDayLabel } from '../chat/chat-notice.js';
import { CHAT_COUNT_FROM, CHAT_TOUCH_QUERY, chatEnterSends } from '../chat/chat-compose.js';
import { DraftChip } from '../../ui/DraftChip.js';
import { bytes, draftChipMeta, isInlineImage } from '../../ui/file-kind.js';
import { fileIcon } from '../../ui/file-kind.js';
import { TypeIcon } from '../../ui/icons.js';
import { useImageViewer } from '../../ui/useImageViewer.js';
import { directMessageFileUrl, directMessagePictureSource, makeDirectMessageThumb } from './dm-files.js';
import { DirectMessageFiles } from './DirectMessageFiles.js';

/**
 * One file picked for the next message (note #1125), with the object URL its
 * chip previews from. `uploaded` is filled in on the object itself once its
 * bytes are on the messaging machine, so a send that fails after the upload
 * keeps it: trying again does not upload twice.
 */
interface Attached { key: string; file: File; url: string; uploaded?: DirectMessageFile }
let attachedSeq = 0;
const merge = (old: DirectMessage[], added: DirectMessage[]) => [...new Map([...old, ...added].map(m => [m.id, m])).values()].sort((a, b) => a.id - b.id);
export function DirectMessageScreen() {
  const { id = '' } = useParams();
  const api = useOrgApi(), orgId = useOrgId();
  const back = useReturnToParent(toFor({ kind: 'messages', orgId: orgId ?? undefined })!);
  const path = `api/messages/${encodeURIComponent(id)}`;
  // What this person last saw here (note #1102): drawn in the first frame,
  // with the fresh read landing behind it and only asking for what is new.
  const { state: session } = useSession();
  const reader = session.status === 'signed-in' ? session.session.username : undefined;
  const [held] = useState(() => heldThread(reader, orgId, id));
  const [page, setPage] = useState<DirectMessagePage | null>(() => (held
    ? { orgName: held.orgName, person: held.person, viewerId: held.viewerId, messages: [], hasMore: held.hasMore } : null));
  const [rows, setRows] = useState<DirectMessage[]>(() => held?.messages ?? []);
  const [error, setError] = useState(''), [sendError, setSendError] = useState(''), [opening, setOpening] = useState(false);
  const memory = directDraftKey(orgId, id);
  // Unsent words wait for the reader on another screen, as the agent chat's
  // do (note #515); this composer is the room chat's field written out by
  // hand rather than `ChatComposer`, so it keeps the same memory itself.
  const [draft, setDraft] = useState(() => recallDraft(memory)), [sending, setSending] = useState(false), [olderBusy, setOlderBusy] = useState(false);
  const [more, setMore] = useState(() => held?.hasMore ?? false), [newMessages, setNewMessages] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const pane = useRef<HTMLDivElement>(null), following = useRef(held?.scroll ? held.scroll.following : true), alive = useRef(true);
  const heldNewest = held?.messages.at(-1)?.id ?? 0;
  const [fetchedCursor, setFetchedCursor] = useState(heldNewest);
  const renderedThrough = useRef(0);
  const newestFetched = useRef(heldNewest), readThrough = useRef(0), receiptBusy = useRef(false);
  const restoreScroll = useRef(held?.scroll && !held.scroll.following ? held.scroll.top : null);
  const sendLock = useRef(false), pending = useRef<{ text: string; clientId: string; files: string } | null>(null);
  // Note #1125: files picked for the next message, and a drag held over the screen.
  const [attached, setAttached] = useState<Attached[]>([]), [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null), heldFiles = useRef<Attached[]>([]);
  heldFiles.current = attached;
  useEffect(() => () => { for (const item of heldFiles.current) if (item.url) URL.revokeObjectURL(item.url); }, []);
  const viewer = useImageViewer();
  // Sent and not answered yet (note #764): standing at the end of the
  // conversation from the tap, as an agent chat's own message does, until
  // the row with its request id arrives — from the send's answer or a read
  // that got there first — and takes its place.
  const [outgoing, setOutgoing] = useState<{ text: string; clientId: string; files: Attached[] } | null>(null);
  const sendingNow = outgoing && !rows.some(message => message.clientId === outgoing.clientId) ? outgoing : null;
  const prepend = useRef<{ height: number; top: number } | null>(null);
  const shell = useChatViewport(true, pane, following, '#directMessageForm');
  useEffect(() => { alive.current = true; document.body.classList.add('agent-chat-open'); return () => { alive.current = false; document.body.classList.remove('agent-chat-open'); }; }, []);
  const acknowledge = useCallback(async () => {
    const through = renderedThrough.current;
    if (document.hidden || !following.current || through <= readThrough.current || receiptBusy.current) return;
    receiptBusy.current = true;
    try { await api.api(`${path}/read`, jsonBody({ through })); if (alive.current) readThrough.current = through; }
    catch { /* Retry the receipt on a later tick. */ }
    finally { receiptBusy.current = false; }
  }, [api, path]);
  const misses = usePollMisses();
  const read = useCallback(async (current: () => boolean) => {
    try {
      const after = newestFetched.current;
      const read = await api.api<unknown>(path + (after ? `?after=${after}` : ''));
      if (!isAnswerObject(read) || !Array.isArray(read.messages)) throw new WorkspaceApiError(ANSWER_UNREADABLE_SENTENCE, 0, { error: ANSWER_UNREADABLE_SENTENCE, code: ANSWER_UNREADABLE_CODE });
      let answer = read as unknown as DirectMessagePage;
      if (!current()) return;
      const catchingUp = Boolean(held) && heldNewest > 0 && after === heldNewest;
      // A kept copy is used only while the server still names the same reader.
      if (catchingUp && answer.viewerId !== held!.viewerId) {
        forgetThread(reader, orgId, id); newestFetched.current = 0; setFetchedCursor(0); setRows([]); setPage(null); return;
      }
      // Far behind (more new than one page): do not walk forward a page per
      // tick — start again from the newest page, older ones a tap away.
      if (catchingUp && answer.hasMore) {
        const fresh = await api.api<unknown>(path);
        if (!current()) return;
        if (!isAnswerObject(fresh) || !Array.isArray(fresh.messages)) throw new WorkspaceApiError(ANSWER_UNREADABLE_SENTENCE, 0, { error: ANSWER_UNREADABLE_SENTENCE, code: ANSWER_UNREADABLE_CODE });
        answer = fresh as unknown as DirectMessagePage;
        misses.hit(); setPage(answer); setError(''); setOpening(false); setMore(answer.hasMore);
        newestFetched.current = answer.messages.at(-1)?.id ?? 0; setFetchedCursor(newestFetched.current);
        following.current = true; setRows(answer.messages);
        await acknowledge();
        return;
      }
      misses.hit(); setPage(answer); setError(''); setOpening(false); if (!after) setMore(answer.hasMore);
      if (answer.messages.length) { newestFetched.current = answer.messages.at(-1)!.id; setFetchedCursor(newestFetched.current); setRows(old => merge(old, answer.messages)); if (!following.current) setNewMessages(true); }
      await acknowledge();
    } catch (err) {
      if (!current()) return;
      if (isOpening(err)) { misses.hit(); setError(''); setOpening(true); return; }
      setOpening(false);
      if (err instanceof WorkspaceApiError && [401, 403, 404].includes(err.status)) { forgetThread(reader, orgId, id); setError(errorMessage(err)); setPage(null); setRows([]); return; }
      // A missed read is quiet until it keeps missing (note #1069).
      if (misses.miss()) setError(pollFailureLine(err));
    }
  }, [api, path, acknowledge, misses, held, heldNewest, reader, orgId, id]);
  useMessagePoll(read);
  // Keep what is drawn, and on leaving, where the reader stood (note #1102).
  const latest = useRef({ page, rows, more });
  latest.current = { page, rows, more };
  const keep = useCallback((scroll?: { top: number; following: boolean }) => {
    const { page: shown, rows: drawn, more: older } = latest.current;
    if (!shown || !drawn.length) return;
    holdThread(reader, orgId, id, { viewerId: shown.viewerId, orgName: shown.orgName, person: shown.person, messages: drawn, hasMore: older, ...(scroll ? { scroll } : {}) });
  }, [reader, orgId, id]);
  useEffect(() => { keep(); }, [page, rows, more, keep]);
  // Read from the pane as the reader scrolls: at unmount the ref is gone.
  const stood = useRef<{ top: number; following: boolean } | undefined>(held?.scroll);
  useEffect(() => () => { keep(stood.current); }, [keep]);
  useLayoutEffect(() => {
    const el = pane.current; if (!el) return;
    if (prepend.current) { el.scrollTop = prepend.current.top + el.scrollHeight - prepend.current.height; prepend.current = null; }
    else if (restoreScroll.current !== null) {
      // The pane may not be scrollable in its first frame (the viewport hook
      // sizes it just after): put the reader back as soon as it is.
      const target = restoreScroll.current; restoreScroll.current = null;
      let frames = 0;
      const put = () => { el.scrollTop = target; if (Math.abs(el.scrollTop - target) > 1 && frames++ < 30) requestAnimationFrame(put); };
      put();
    }
    else if (following.current) el.scrollTop = el.scrollHeight;
    renderedThrough.current = fetchedCursor;
    void acknowledge();
  }, [rows, fetchedCursor, acknowledge, sendingNow]);
  useEffect(() => { rememberDraft(memory, draft); }, [memory, draft]);
  // The same expanding field as the agent chat, capped by .chatbar textarea.
  useLayoutEffect(() => {
    const field = box.current;
    if (!field) return;
    field.style.height = 'auto';
    const border = field.offsetHeight - field.clientHeight;
    if (field.scrollHeight) field.style.height = `${field.scrollHeight + border}px`;
  }, [draft]);
  const hasKeyboard = () => !(window.matchMedia && window.matchMedia(CHAT_TOUCH_QUERY).matches);
  /**
   * The message is in the conversation from the tap (note #764): the box
   * empties and the words stand at the end as "Sending…" while the request
   * is out. It used to keep them in a read-only box until the server
   * answered, so nothing reached the conversation for the whole round trip.
   * A send that fails puts its words back in the box — in front of anything
   * typed since — under the same request id, so sending again cannot land
   * it twice.
   */
  /** Picked, dropped or pasted files join the draft — up to ten, 25 MB each. */
  const attach = (chosen: FileList | File[] | null) => {
    const files = Array.from(chosen ?? []);
    if (picker.current) picker.current.value = '';
    if (!files.length || !page?.person.available) return;
    const tooBig = files.find(file => file.size > DIRECT_MESSAGE_FILE_MAX_BYTES);
    if (tooBig) { setSendError(`${tooBig.name} is ${bytes(tooBig.size)}. A file can be up to ${directMessageFileSize(DIRECT_MESSAGE_FILE_MAX_BYTES)}.`); return; }
    const empty = files.find(file => !file.size);
    if (empty) { setSendError(`${empty.name} is empty.`); return; }
    const room = DIRECT_MESSAGE_FILES_PER_MESSAGE - heldFiles.current.length;
    if (files.length > room) { setSendError(`A message can carry up to ${DIRECT_MESSAGE_FILES_PER_MESSAGE} files.`); return; }
    setSendError('');
    setAttached(old => [...old, ...files.map(file => ({ key: `a${++attachedSeq}`, file, url: isInlineImage(file.type) ? URL.createObjectURL(file) : '' }))]);
  };
  const unattach = (item: Attached) => {
    if (item.url) URL.revokeObjectURL(item.url);
    setAttached(old => old.filter(other => other !== item));
  };
  /** One picked file onto the messaging machine, then its small copy when it is a picture. */
  const upload = async (item: Attached): Promise<DirectMessageFile> => {
    if (item.uploaded) return item.uploaded;
    const answer = await api.api<{ file: DirectMessageFile }>(`${path}/files`, {
      method: 'POST', body: item.file,
      headers: { 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(item.file.name || 'file'), 'x-file-type': item.file.type || '' },
    });
    let file = answer.file;
    if (file.type.startsWith('image/')) {
      const small = await makeDirectMessageThumb(item.file);
      if (small) {
        // A picture whose small copy did not land still goes: it is drawn from its full bytes, or named.
        const thumb = await api.api<{ file: DirectMessageFile }>(`${path}/files?thumbOf=${encodeURIComponent(file.id)}`, {
          method: 'POST', body: small, headers: { 'Content-Type': 'application/octet-stream' },
        }).catch(() => null);
        if (thumb?.file) file = thumb.file;
      }
    }
    item.uploaded = file;
    return file;
  };
  const openPicture = (file: DirectMessageFile) => {
    const pictures = rows.flatMap(message => (message.files ?? []).filter(candidate => directMessagePictureSource(candidate) !== null));
    const at = pictures.findIndex(candidate => candidate.id === file.id);
    if (at < 0) return;
    viewer(pictures.map(picture => ({ url: directMessageFileUrl(orgId, id, picture.id, 'full'), name: picture.name })), at);
  };
  /**
   * The message is in the conversation from the tap (note #764): the box
   * empties and the words stand at the end as "Sending…" while the request
   * is out. It used to keep them in a read-only box until the server
   * answered, so nothing reached the conversation for the whole round trip.
   * A send that fails puts its words back in the box — in front of anything
   * typed since — under the same request id, so sending again cannot land
   * it twice. Its files go back too, keeping whatever already uploaded.
   */
  const send = async () => {
    const text = draft.trim(), files = attached;
    if ((!text && !files.length) || sendLock.current || !page?.person.available) return;
    sendLock.current = true; setSending(true); setSendError('');
    const signature = files.map(item => item.key).join(',');
    if (pending.current?.text !== text || pending.current.files !== signature) pending.current = { text, clientId: crypto.randomUUID(), files: signature };
    const sent = pending.current;
    following.current = true; setNewMessages(false); setOutgoing({ text, clientId: sent.clientId, files }); setDraft(''); setAttached([]);
    if (hasKeyboard()) box.current?.focus(); else box.current?.blur();
    try {
      const ids: string[] = [];
      for (const item of files) ids.push((await upload(item)).id);
      const answer = await api.api<{ message: DirectMessage }>(path, jsonBody({ text, clientId: sent.clientId, ...(ids.length ? { files: ids } : {}) }));
      if (!alive.current) return;
      following.current = true; setRows(old => merge(old, [answer.message])); setOutgoing(null);
      for (const item of files) if (item.url) URL.revokeObjectURL(item.url);
      if (pending.current === sent) pending.current = null;
      // Keep the fetch cursor: a concurrent incoming message may precede this send.
    } catch (err) {
      if (!alive.current) return;
      setOutgoing(null);
      if (text) setDraft(typed => (typed.trim() ? `${text}\n\n${typed}` : text));
      if (files.length) setAttached(old => [...files, ...old]);
      const back = files.length ? (text ? 'Your message and files are back' : 'Your files are back') : 'Your message is back in the box';
      setSendError(isOpening(err) ? `Messages are still opening. ${back}; try Send again in a moment.` : `${errorMessage(err)} It was not sent. ${back} — try Send again.`);
    }
    finally { sendLock.current = false; if (alive.current) setSending(false); }
  };
  const loadOlder = async () => {
    if (olderBusy || !rows[0]) return; setOlderBusy(true);
    try {
      const answer = await api.api<DirectMessagePage>(`${path}?before=${rows[0].id}`); if (!alive.current) return;
      if (pane.current) prepend.current = { height: pane.current.scrollHeight, top: pane.current.scrollTop };
      setRows(old => merge(old, answer.messages)); setMore(answer.hasMore); setError('');
    } catch (err) { if (alive.current) setError(errorMessage(err)); }
    finally { if (alive.current) setOlderBusy(false); }
  };
  let lastDay = '';
  const holdsFiles = (event: React.DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  return <div className={`screen${dragging ? ' dmdragging' : ''}`} id="screenDirectMessage" ref={shell}
    onDragOver={event => { if (!holdsFiles(event) || !page?.person.available) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragging(true); }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={event => { if (!holdsFiles(event)) return; event.preventDefault(); setDragging(false); attach(event.dataTransfer.files); }}>
    <header className="chathead">
      <button className="back" onClick={back}><Svg name="back" size={20} />Back</button>
      <div className="chatface chatperson"><PersonFace photoUrl={page?.person.photoUrl} /></div>
      <div className="chatwho"><h1>{page?.person.name ?? 'Message'}</h1><div className="sub">{page?.orgName ?? 'Private conversation'}</div></div>
    </header>
    <div className="chatpane" ref={pane} onScroll={() => {
      const el = pane.current!; following.current = el.scrollHeight - el.clientHeight - el.scrollTop < 60;
      stood.current = { top: el.scrollTop, following: following.current };
      if (following.current) { setNewMessages(false); void acknowledge(); }
    }}>
      {more ? <button className="addrow cardtop" disabled={olderBusy} onClick={() => { void loadOlder(); }}>{olderBusy ? 'Loading…' : 'Earlier messages'}</button> : null}
      {error ? <div role="alert" className="hintblock">{error} Retrying…</div> : null}
      {!page && !error ? <div className="empty" role="status">{opening ? 'Opening messages…' : 'Loading conversation…'}</div> : null}
      {page && opening ? <div className="hintblock dmopening" role="status">Opening messages… showing what you last saw.</div> : null}
      {page && !rows.length ? <div className="chatempty">Say hello to {page.person.name}.</div> : null}
      <div className="chatlog" role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions">
        {rows.map(message => {
          const day = new Date(message.createdAt).toDateString();
          const divider = day !== lastDay ? chatDayLabel(message.createdAt) : '';
          lastDay = day;
          return <Fragment key={message.id}>
            {divider ? <div className="chatday">{divider}</div> : null}
            {/* Note #1090: a message released from the Chief of Staff's card
                is agent-written Markdown, drawn as its card drew it —
                paragraphs, line breaks and lists. A person's own words stay
                exactly as typed. */}
            {message.files?.length ? (() => {
              // Note #1125: the words keep a bubble of their own and the files
              // stand under it, as the agent chat's do (note #160).
              const via = sentViaChiefOfStaff(message);
              const time = new Date(message.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
              return <div className={`chatmsg ${message.senderId === page?.viewerId ? 'owner' : 'agent'} chatfile${via ? ' dmformatted' : ''}`}
                data-message-id={message.id} data-time={message.text ? undefined : time} title={new Date(message.createdAt).toLocaleString()}
                data-gallery="dm-message-files">
                {message.text ? <div className="chatfilecaption" data-time={time}>{via ? <Markdown source={message.text} className="chatmarkdown" /> : message.text}</div> : null}
                <DirectMessageFiles files={message.files} orgId={orgId} peerId={id} onOpenPicture={openPicture}
                  onPictureLoaded={() => { if (following.current && pane.current) pane.current.scrollTop = pane.current.scrollHeight; }} />
                {via ? <span className="dmvia">{message.senderId === page?.viewerId ? 'via your Chief of Staff' : 'via their Chief of Staff'}</span> : null}
              </div>;
            })() : <div className={`chatmsg ${message.senderId === page?.viewerId ? 'owner' : 'agent'}${sentViaChiefOfStaff(message) ? ' rich dmformatted' : ''}`}
              data-message-id={message.id}
              data-time={new Date(message.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
              title={new Date(message.createdAt).toLocaleString()}>{sentViaChiefOfStaff(message) ? <Markdown source={message.text} className="chatmarkdown" /> : message.text}
              {/* Note #1090: released by its sender's tap on their Chief of
                  Staff's card. The mark is the message's own request id. */}
              {sentViaChiefOfStaff(message) ? <span className="dmvia">{message.senderId === page?.viewerId ? 'via your Chief of Staff' : 'via their Chief of Staff'}</span> : null}</div>}
          </Fragment>;
        })}
        {sendingNow && !sendingNow.files.length ? <div className="chatmsg owner sending arriving" data-time="Sending…" aria-busy="true">{sendingNow.text}</div> : null}
        {/* A message with files is NAMED while it goes, as the agent chat's is;
            the row that replaces it draws its pictures. */}
        {sendingNow && sendingNow.files.length ? <div className="chatmsg owner chatfile sending arriving" data-time={sendingNow.text ? undefined : 'Sending…'} aria-busy="true">
          {sendingNow.text ? <div className="chatfilecaption" data-time="Sending…">{sendingNow.text}</div> : null}
          {sendingNow.files.map(item => { const kind = fileIcon(item.file.name.toLowerCase()); return <div key={item.key} className="chatfileitem dmfile">
            <span className="chatfileline"><TypeIcon glyph={kind.glyph} tint={kind.tint} /><span>{item.file.name} · {bytes(item.file.size)}</span></span>
          </div>; })}
        </div> : null}
      </div>
      <div className="chatjump" hidden={!newMessages}>
        <button type="button" aria-label="New messages" title="Newest message" onClick={() => {
          following.current = true;
          if (pane.current) pane.current.scrollTop = pane.current.scrollHeight;
          setNewMessages(false); void acknowledge();
        }}><Svg name="arrowdown" size={20} /></button>
      </div>
    </div>
    <form id="directMessageForm" className="chatbar" autoComplete="off" onSubmit={event => { event.preventDefault(); void send(); }}>
      {sendError ? <div className="hintblock" role="alert">{sendError}</div> : null}
      {page && !page.person.available ? <div className="hintblock">This person has left the workplace. You can still read your conversation.</div> : null}
      {dragging ? <div className="hintblock dmdrop" role="status">Drop to attach</div> : null}
      <div className="chatdraft" id="directMessageDraft" hidden={!attached.length}>
        {attached.map(item => <DraftChip key={item.key} name={item.file.name} url={item.url} picture={Boolean(item.url)} exactName
          meta={draftChipMeta(item.file.size, 'ready to send')}
          onOpen={() => { if (item.url) viewer([{ url: item.url, name: item.file.name }], 0); }}
          onRemove={() => unattach(item)} />)}
      </div>
      <div className="row">
        <div className="chatinput withattach">
          <button className={attached.length ? 'chatattach hasfile' : 'chatattach'} id="directMessageAttach" type="button" aria-label="Attach files"
            disabled={sending || !page?.person.available} onClick={() => picker.current?.click()}><Svg name="attach" size={20} /></button>
          <textarea ref={box} aria-label="Message" placeholder="Message" value={draft}
          maxLength={DIRECT_MESSAGE_MAX_LENGTH} disabled={!page?.person.available}
          onChange={event => setDraft(event.target.value)} rows={1}
          onPaste={event => {
            // A pasted picture or file attaches. Words copied from a document
            // often carry a picture of themselves too: then the words win.
            const files = Array.from(event.clipboardData?.files ?? []);
            if (!files.length || event.clipboardData.getData('text/plain')) return;
            event.preventDefault(); attach(files);
          }}
          onKeyDown={event => {
            if (chatEnterSends({ key: event.key, shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey,
              metaKey: event.metaKey, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode }, hasKeyboard())) {
              event.preventDefault(); void send();
            }
          }} /></div>
        <button className={sending ? 'chatsend sending' : 'chatsend'} type="submit" aria-label="Send" aria-busy={sending || undefined}
          disabled={sending || (!draft.trim() && !attached.length) || !page?.person.available} onMouseDown={event => event.preventDefault()}><Svg name="send" size={19} /></button>
      </div>
      <input type="file" id="directMessageFile" ref={picker} multiple hidden onChange={event => attach(event.target.files)} />
      <div className="count" hidden={draft.length < DIRECT_MESSAGE_MAX_LENGTH - CHAT_COUNT_FROM}>{draft.length} / {DIRECT_MESSAGE_MAX_LENGTH}</div>
    </form>
  </div>;
}
