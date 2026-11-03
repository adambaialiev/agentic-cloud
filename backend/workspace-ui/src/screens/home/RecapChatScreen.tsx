/**
 * The Chief of Staff's conversation — the Workspace Agent, as a person sees
 * it since note #715 — drawn with the room chat's own parts (note #423): the
 * pinned header with its name and the runtime line as the door to the model
 * picker; `ChatMessageRow` for every row, so a receipt
 * is the notice card it is in any other chat, a room agent's reply wears
 * that agent's face and name, and a new day stands a divider; the typing
 * bubble carrying the phase line while a request runs, with Stop beside it;
 * and `ChatComposer` with the paperclip on, so spacing, keyboard, drafts and
 * files match — a file sent here lands in the agent machine's inbox, and a
 * message sent while a request runs steers it, both as a room agent's do.
 *
 * What the conversation stores is its own shape (`RecapMessage`), so the
 * rows are ADAPTED rather than the store changed: an owner's words and the
 * agent's reply map straight; a room agent's reply becomes the peer message
 * the row renderer already recognises; an action receipt becomes a platform
 * row carrying its door as `href` — every door except one into another
 * agent's conversation (note #435). Row objects are kept across polls by id
 * so the memoised row does not re-parse its Markdown every three seconds.
 *
 * A VISIT IS A RETURN AS OFTEN AS AN OPEN (note #615). Replies here are full
 * of doors — a note, a proposal, a page — and the reader who walks through
 * one comes Back expecting the conversation they left, not a fresh one. So
 * the screen paints the answer this tab last read (`recap-chat-cache.ts`) in
 * its first frame and re-reads underneath, and an entry the reader is coming
 * BACK to is put on the line they left from (`recallPaneScroll`, the room
 * chat's own store) rather than at the newest message — which is where an
 * entry being OPENED still lands. A workplace switched to is opened, never
 * returned to, so the line is kept per workplace too (note #754).
 */

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { parseWorkspaceRoute, WORKSPACE_BASE } from '../../../../src/shared/workspace-routes.js';
import type { WorkspaceRecapSettingsAnswer } from '../../../../src/shared/workspace-recap.js';
import { WORKSPACE_AGENT_CHAT_ID, type RecapChatAnswer, type RecapChatStopAnswer, type RecapMessage } from '../../../../src/shared/workspace-recap-chat.js';
import { recapRowViews } from '../../../../src/shared/recap-chat-rows.js';
import type { WorkspaceChatFile, WorkspaceChatFileAccessAnswer, WorkspaceChatMessage } from '../../../../src/shared/workspace-api.js';
import { chatFilesBody } from '../chat/chat-upload.js';
import { TurnRecap } from '../chat/TurnRecap.js';
import { showsTurnRecap } from '../chat/turn-recap-words.js';
import { jsonBody, WorkspaceApiError } from '../../api/client.js';
import { recapDraftKey } from '../../chrome/draft-memory.js';
import { useReturnToParent } from '../../chrome/history.js';
import { recallPaneScroll, rememberPaneScroll } from '../../chrome/scroll-memory.js';
import { Svg } from '../../ui/icons.js';
import { AgentFace } from '../../ui/AgentFace.js';
import { ContextRing } from '../../ui/ContextRing.js';
import { saveFile } from '../../ui/save-file.js';
import { errorMessage } from '../../ui/format.js';
import { agentNamed } from '../../workspace/live.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { AgentSwitch } from '../chat/AgentSwitch.js';
import { ChatComposer } from '../chat/ChatComposer.js';
import { ChatGalleryProvider } from '../chat/ChatGallery.js';
import { ChatMessageRow, OutgoingMessageRow } from '../chat/ChatMessageRow.js';
import { blurBoxOnInertTap, ChatJump, useChatViewport } from '../chat/ChatScreen.js';
import { keyboardTraceWanted, useKeyboardTrace } from '../chat/keyboard-trace.js';
import { jumpToNewest, readChatJump, scrollToBottom } from '../chat/chat-jump.js';
import { chatDayLabel, TURN_STOPPED } from '../chat/chat-notice.js';
import { matchSends, type OutgoingMessage, type ReturnedDraft } from '../chat/outbox.js';
import type { TranscriptRow } from '../chat/transcript.js';
import { useMessagePoll } from '../messages/useMessagePoll.js';
import { useOrgApi, useOrgId } from '../org/useOrgApi.js';
import {
  forgetRecapChatOf, heldRecapChat, heldRecapChatSettings, holdRecapChat, holdRecapChatSettings,
} from './recap-chat-cache.js';
import { RecapRuntimePicker } from './RecapRuntimePicker.js';
import { recalledRuntime } from '../agent/runtime-memory.js';
import { AttentionLine, DidLine, NoticedLine, RemoveAgentCard, UnfinishedLine, UnfinishedMark } from './RecapRows.js';
import { HomeChrome } from './HomeTabs.js';
import { ChiefOfStaffEmpty, FirstRunSignIn, TeamArrivingCard } from './FirstRun.js';
import { CHIEF_OF_STAFF } from '../../ui/chief-of-staff.js';

const WORKSPACE_AGENT = CHIEF_OF_STAFF;
/** How near the newest message counts as following the conversation. */
const FOLLOW_PX = 60;
const atEnd = (pane: HTMLElement): boolean => pane.scrollHeight - pane.clientHeight - pane.scrollTop < FOLLOW_PX;
/** The pane's box, both ways: a new width reflows every row as surely as a
 *  new height moves the end. */
const sizeOf = (pane: HTMLElement | null): string => (pane ? `${pane.clientWidth}x${pane.clientHeight}` : '');
/** How long a page whose screen has just come back is left to the browser
 *  laying it out again (note #750), unless the reader touches it first. */
const WAKE_SETTLE_MS = 1000;
/** What only a reader does to the transcript. */
const READER_INPUT = ['touchstart', 'pointerdown', 'wheel', 'keydown'] as const;

/**
 * Whether an address leads into another agent's own conversation — the one
 * door a receipt here never carries (note #435).
 *
 * A message sent from this conversation is answered INTO it: the reply, or
 * the line saying there was none, arrives as the next row. A card that says
 * "sent" is the whole receipt, and a link out of it walks the reader away
 * from the only place the answer will land.
 *
 * Read at the row rather than only where receipts are written, because the
 * conversations already stored carry the address they were written with, and
 * those rows are what the reader scrolls back through.
 */
function opensAgentChat(href?: string): boolean {
  if (!href) return false;
  const split = href.indexOf('?');
  const route = parseWorkspaceRoute(split < 0 ? href : href.slice(0, split), split < 0 ? '' : href.slice(split));
  return route?.kind === 'chat';
}

/** One stored message as a transcript row. `seq` is its place in the list;
 *  `arriving` is what earns the entrance animation on a row that landed
 *  while the reader was watching. */
function rowOf(message: RecapMessage, seq: number, arriving: boolean, faceOf: (name: string) => string | undefined): TranscriptRow {
  const base = { seq, at: message.at, ...(arriving ? { arriving: true } : {}) };
  // The fresh-chat rule (note #429): punctuation, not a receipt — the row
  // renderer tests the kind before it looks at the role.
  if (message.kind === 'new-chat-divider') return { ...base, role: 'platform', kind: 'new-chat-divider', text: message.text };
  if (message.role === 'owner') return { ...base, role: 'owner', text: message.text, ...(message.files?.length ? { files: message.files } : {}) };
  // Its files ride the row (note #749): the backend stored them beside the
  // reply, and this is the one place they were dropped on the way to the eye.
  if (message.role === 'assistant') return { ...base, role: 'agent', text: message.text, ...(message.files?.length ? { files: message.files } : {}) };
  if (message.role === 'agent') {
    const from = message.name ?? 'agent';
    const avatar = faceOf(from);
    return { ...base, role: 'platform', text: `Message from agent ${from}: ${message.text}`, ...(avatar ? { fromAvatarUrl: avatar } : {}) };
  }
  const href = opensAgentChat(message.href)
    ? undefined
    : message.href?.startsWith(WORKSPACE_BASE) ? message.href.slice(WORKSPACE_BASE.length) : message.href;
  return {
    ...base,
    role: 'platform',
    text: message.text,
    ...(href ? { href } : {}),
    ...(message.mailApprovalId ? { mailApprovalId: message.mailApprovalId } : {}),
    ...(message.mailApproval ? { mailApproval: message.mailApproval } : {}),
    ...(message.forwarded?.length ? { forwarded: message.forwarded } : {}),
  };
}

/**
 * A reply that carries files is drawn as two rows (note #749), the way a
 * room agent's ATTACH: lands: its words first, then its files. The pair is
 * held per row, so a re-render hands the memoised row component the same
 * objects it saw last time.
 */
const split = new WeakMap<TranscriptRow, { words: TranscriptRow; files: TranscriptRow }>();
function pairOf(row: TranscriptRow): { words: TranscriptRow; files: TranscriptRow } {
  let pair = split.get(row);
  if (!pair) {
    const { files, ...words } = row;
    pair = { words, files: { ...row, text: '', files } };
    split.set(row, pair);
  }
  return pair;
}
const wordsOf = (row: TranscriptRow): TranscriptRow => pairOf(row).words;
const filesOf = (row: TranscriptRow): TranscriptRow => pairOf(row).files;

/** What makes a held row stale besides its words: a forwarded proposal's
 *  state, which moves without the row's text moving (note #724). */
const forwardedKey = (message: RecapMessage): string => (
  message.forwarded?.length ? JSON.stringify(message.forwarded) : ''
);

/** The conversation as the room chat's outbox reads a transcript, so a sent
 *  message is matched to its row by the same rule (note #764): its place in
 *  the list is its seq, and only the reader's own words are owner rows. */
const sendRowsOf = (messages: readonly RecapMessage[]): WorkspaceChatMessage[] => messages.map((message, at) => ({
  seq: at + 1,
  role: message.role === 'owner' ? 'owner' : 'agent',
  text: message.text,
  at: message.at,
  ...(message.files?.length ? { files: message.files } : {}),
}));

/**
 * `home` (2026-10-10): this conversation IS the Workspace's front door. No
 * Back — there is nothing beneath it — and its header carries the two doors
 * into the rest of the workplace, Workplace and Rooms, each opening a window
 * over the conversation (note #715), then the workplace switch and the
 * reader's own picture at the far edge.
 *
 * The agent has no face since note #715 (the owner: a plain title only), so
 * the name is a title rather than a door: what it used to open — its details,
 * the workplace's two halves — is what the two doors open now.
 */
export function Conversation({ orgId, home = false, notice = '', standing = '', windowOpen = false, onOpenWindow }: {
  orgId: string;
  home?: boolean;
  notice?: string;
  /** A line that stays above the message box while it is true: a private
   *  copy's licence, for its admins, while it needs them (note #814). */
  standing?: string;
  /** Whether the Workplace window stands over the conversation. */
  windowOpen?: boolean;
  /** The Chief of Staff's face and name open it. */
  onOpenWindow?: () => void;
}) {
  const api = useOrgApi(), back = useReturnToParent();
  const { agents, state: workspace, reload } = useWorkspace();
  const { key: entry, search } = useLocation();
  /**
   * Where this conversation's line is kept: the entry AND the workplace
   * (note #754). A switch moves the workplace at once and the address a
   * beat later — the router moves it in a transition — so the conversation
   * switched TO is drawn while the address still names the entry the other
   * workplace's chat was left on. Kept by entry alone, it took that line for
   * one of its own to come back to, and opened in the middle of the
   * conversation (the owner, 2026-10-15).
   */
  const key = `${orgId}:${entry}`;
  // The line this entry was left on, or null for a conversation being opened
  // rather than returned to. Put back once there are rows to put it into;
  // until then nothing may drag the reader to the end.
  const restore = useRef<number | null>(recallPaneScroll(key) ?? null);
  const pane = useRef<HTMLDivElement>(null), following = useRef(restore.current === null);
  const shell = useChatViewport(true, pane, following);
  // The owner's phone, recorded (see keyboard-trace.ts). Off unless asked;
  // the same recorder as the room chat's, so the two can be compared.
  useKeyboardTrace(shell, pane, keyboardTraceWanted(search));
  // The way back down is the room chat's own button (note #730), shown by
  // the same rule — a whole pane or more above the newest message — plus
  // this screen's older one (note #615): news that landed while the reader
  // was away from the end. `hidden` is written here, never by a render.
  const jumpAnchor = useRef<HTMLDivElement>(null), news = useRef(false), paneSize = useRef('');
  // The screen just came back, and the browser is still laying it out (note #750).
  const waking = useRef(false);
  useLayoutEffect(() => { paneSize.current = sizeOf(pane.current); }, []);
  const [answer, setAnswer] = useState<RecapChatAnswer | null>(() => heldRecapChat(orgId)), [error, setError] = useState('');
  const [sendError, setSendError] = useState(''), [sending, setSending] = useState(false);
  // Sent and not on the record yet: drawn as the room chat draws its own.
  const [outgoing, setOutgoing] = useState<OutgoingMessage[]>([]);
  // How many messages the conversation held as last drawn: a row that
  // answers a send is newer than that (note #764).
  const drawnCount = useRef(0);
  const [stopping, setStopping] = useState(false);
  /**
   * A stop the backend ACCEPTED, held as this screen's own truth until the
   * server agrees the turn is over (note #453).
   *
   * The turn ends on the MACHINE, and the conversation stays `running` until
   * that abort unwinds and writes its row — seconds, sometimes longer. The
   * screen must not spend those seconds drawing a spinner and a Stop button
   * over a turn the person has already ended: it reads as a tap that did
   * nothing, so they press Stop again, and the second tap answers "it had
   * already finished" — true of that tap and baffling as an answer to the
   * first. Measured on a real machine by the owner, 2026-09-10.
   *
   * It is optimism the backend has already agreed to (`stopped: true` means
   * the run was found and aborted), and it lasts exactly until the answer
   * says `working: false` — the same beat the transcript's own "Turn stopped
   * by the user." row lands, which is what says it permanently.
   */
  const [stopped, setStopped] = useState(false);
  const [settings, setSettings] = useState<WorkspaceRecapSettingsAnswer | null>(() => heldRecapChatSettings(orgId));
  // What this browser last saw it run on (note #735), for a fresh open whose
  // settings read is still out: the header never says "Model & effort" over
  // a choice the reader has already made.
  const [remembered] = useState(() => recalledRuntime(orgId, 'agent'));
  const [picking, setPicking] = useState(false);
  const parked = useRef<number | null>(null);
  const latest = useRef(answer?.messages.at(-1)?.id ?? ''), opened = useRef(false);
  const held = useRef(new Map<string, TranscriptRow>());
  const pendingSend = useRef<{ clientId: string; draft: string } | null>(null);
  // The conversation owns the viewport while it is visible, but its runtime
  // picker is an ordinary document page and needs the document's own scroll.
  // Release the chat shell while the picker stands over it, exactly as the
  // room-agent conversation does for the same transient leaf.
  useLayoutEffect(() => {
    if (picking) return;
    document.body.classList.add('agent-chat-open');
    return () => { document.body.classList.remove('agent-chat-open'); };
  }, [picking]);

  const readSettings = useCallback(() => {
    // The agent's OWN runtime (note #437), not the briefing's: the header is
    // the only place it is picked, and Home no longer shows it.
    void api.api<WorkspaceRecapSettingsAnswer>('api/recap/agent/settings')
      .then((next) => { holdRecapChatSettings(orgId, next); setSettings(next); })
      .catch(() => {});
  }, [api, orgId]);
  useEffect(readSettings, [readSettings]);

  // The workplace, re-read when the conversation grows while a turn runs
  // (note #726): the Chief of Staff opens rooms and brings agents in from
  // its turn, and the roster, the picker's tabs and the arriving card all
  // draw from the state read, which nothing else would refresh. Throttled:
  // a turn leaves several receipts in a row.
  const grown = useRef({ count: -1, reloadedAt: 0 });
  const read = useCallback(async (alive: () => boolean) => {
    try {
      const next = await api.api<RecapChatAnswer>('api/recap/chat');
      if (alive() && next.orgId === orgId) {
        const id = next.messages.at(-1)?.id ?? '';
        if (latest.current && id !== latest.current && !following.current) {
          news.current = true;
          if (jumpAnchor.current) jumpAnchor.current.hidden = false;
        }
        latest.current = id; holdRecapChat(orgId, next); setAnswer(next); setError('');
        // ...and the moment it does agree, the local truth is spent.
        if (!next.working) setStopped(false);
        const was = grown.current.count;
        grown.current.count = next.messages.length;
        if (was >= 0 && next.messages.length > was && Date.now() - grown.current.reloadedAt > 4000) {
          grown.current.reloadedAt = Date.now();
          void reload().catch(() => { /* the next growth asks again */ });
        }
      }
    } catch (err) {
      if (!alive()) return;
      setError(errorMessage(err));
      if (err instanceof WorkspaceApiError && [401, 403, 404].includes(err.status)) { forgetRecapChatOf(orgId); setAnswer(null); }
    }
  }, [api, orgId, reload]);
  useMessagePoll(read);
  // Every answer lands in the layout phase, before the frame it is seen in: a
  // conversation returned to is put back on the reader's line the first time
  // it has rows to measure it against — from the held copy, usually, so in
  // the very first frame — and a reader at the end follows it down.
  useLayoutEffect(() => {
    drawnCount.current = answer?.messages.length ?? 0;
    const node = pane.current;
    if (!node) return;
    if (restore.current !== null) {
      if (!answer) return;
      if (answer.messages.length) node.scrollTop = restore.current;
      restore.current = null;
      following.current = atEnd(node);
      return;
    }
    if (following.current) node.scrollTop = node.scrollHeight;
  }, [answer]);
  // Back from the picker: the transcript stands where it stood.
  useLayoutEffect(() => {
    if (picking || parked.current === null) return;
    if (pane.current) pane.current.scrollTop = parked.current;
    parked.current = null;
  }, [picking]);

  /**
   * What the reader sent, matched to the row that is its record by the room
   * chat's own rule (note #764): newer than the conversation they sent from,
   * the same words and files. A bubble is drawn until its row is in an
   * answer — the send's own or a poll that got there first — and that row
   * takes its place in the same commit: never beside it, and never rising in
   * as news over the bubble it replaces. Once the row is on the page the
   * bubble is forgotten.
   */
  const recorded = useMemo(() => matchSends(outgoing, sendRowsOf(answer?.messages ?? [])), [answer, outgoing]);
  const pending = useMemo(() => {
    if (!recorded.size) return outgoing;
    const gone = new Set(recorded.values());
    return outgoing.filter((message) => !gone.has(message.id));
  }, [outgoing, recorded]);
  useEffect(() => {
    if (!recorded.size) return;
    const gone = new Set(recorded.values());
    setOutgoing((current) => current.filter((message) => !gone.has(message.id)));
  }, [recorded]);
  // The bubble is followed down in the frame it is drawn in (note #764). It
  // used to wait for the next answer to scroll it into view — the send's own,
  // which brings the whole conversation back, or the next poll — so the
  // message stood under the fold for a second or more after Send.
  useLayoutEffect(() => {
    if (pending.length && following.current && pane.current) pane.current.scrollTop = pane.current.scrollHeight;
  }, [pending]);

  /**
   * The reader's scroll: whether they follow the conversation, the line they
   * are on for the Back that brings them here, and the way back down. That
   * last is read the room chat's way (note #334): a scroll that arrives with
   * the pane a different size — a keyboard, a draft grown taller — is the
   * browser keeping the words in place, not the reader moving, so it decides
   * nothing; the next one, at a settled size, does.
   *
   * Nothing, following included (note #750). Safari keeps the words in place
   * by moving the scroll whenever the page changes size, and a phone whose
   * screen goes dark and comes back changes it several times — the lock
   * screen, the app switcher's picture of the page, the bars coming back.
   * Read as the reader's own, the first of those scrolls left a reader who
   * was at the newest message "up in older messages": the replies that came
   * in while the phone was dark stayed below, and the conversation woke up
   * in the middle (the owner, 2026-10-14). A page nobody can see is not
   * being scrolled by anybody either.
   */
  const onScroll = useCallback(() => {
    const el = pane.current;
    if (!el) return;
    const size = sizeOf(el);
    if (size === paneSize.current && !waking.current && !document.hidden) {
      following.current = atEnd(el);
      if (following.current) news.current = false;
      readChatJump(jumpAnchor.current, el, news.current);
    }
    paneSize.current = size;
    rememberPaneScroll(key, el.scrollTop);
  }, [key]);
  /**
   * The screen coming back (note #750). A page can be laid out at a passing
   * size and back again between two frames, and then the pane never reads
   * as resized: Safari has already moved the scroll to keep the words in
   * place, and the scroll it reports stands at the pane's usual size. So
   * from the moment the page is hidden until the browser has had a second
   * with it back, no scroll is the reader's unless they touch the
   * conversation first — and a reader who was at the newest message is put
   * on it again once that second is over, where the browser left them or not.
   */
  useEffect(() => {
    const node = pane.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const awake = () => { clearTimeout(timer); waking.current = false; };
    const onVisibility = () => {
      clearTimeout(timer);
      waking.current = true;
      if (document.hidden) return;
      timer = setTimeout(() => {
        awake();
        if (following.current) scrollToBottom(pane.current);
      }, WAKE_SETTLE_MS);
    };
    // Back from the back-forward cache, which may say so only this way.
    const onShow = (event: PageTransitionEvent) => { if (event.persisted) onVisibility(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onShow);
    for (const name of READER_INPUT) node?.addEventListener(name, awake, { passive: true });
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onShow);
      for (const name of READER_INPUT) node?.removeEventListener(name, awake);
    };
  }, [following]);
  /** To the newest message, following it again from there; the button goes at once, as the room chat's does. */
  const jump = useCallback(() => {
    following.current = true; news.current = false;
    jumpToNewest(jumpAnchor.current, pane.current);
  }, []);

  const faceOf = useCallback((name: string) => agentNamed(agents, name)?.avatarUrl, [agents]);
  const rows = useMemo(() => {
    const messages = answer?.messages ?? [];
    const arriving = opened.current;
    const next = new Map<string, TranscriptRow>();
    const list = messages.map((message, seq) => {
      const was = held.current.get(message.id);
      const row = was && was.seq === seq && was.text === message.text && forwardedKey(message) === (was.forwarded?.length ? JSON.stringify(was.forwarded) : '')
        ? was
        : rowOf(message, seq, arriving && !was && !recorded.has(seq + 1), faceOf);
      next.set(message.id, row);
      return row;
    });
    held.current = next;
    if (answer) opened.current = true;
    return list;
  }, [answer, faceOf, recorded]);
  // What each row shows (note #725): news to the person or a decision for
  // them; the rest of the platform's narration stays in the agent's record.
  const views = useMemo(() => recapRowViews(answer?.messages ?? []), [answer]);
  // The first run (note #726): the sign-in card under the FIRST ask, for as
  // long as no plan is in — a later "I've kept that too" points up at it.
  const messages = answer?.messages ?? [];
  const signInAfter = answer?.awaitingSeat ? messages.findIndex((message) => message.kind === 'signin-ask') : -1;
  // Nothing said yet (note #967): no row drawn — a founder's stored greeting
  // is not drawn either — and nothing on its way. The pane's empty state
  // stands in the middle of it until the first real row lands.
  const empty = Boolean(answer) && !pending.length && views.every((view) => view.form === 'hidden' || view.form === 'remove-room');

  /**
   * Send, exactly as the room chat sends (note #423): words alone as JSON,
   * words with files as the one-request envelope. One request id per draft,
   * so a retry after a lost connection cannot land the message twice — and
   * a send while a request runs is not refused: the backend steers the
   * running turn, and the transcript shows the words where they landed.
   *
   * And ANSWERED AT ONCE, as the room chat's outbox answers (note #658): the
   * box empties and lets go of the focus inside the Send tap itself, and the
   * words stand at the end of the conversation as a "Sending…" bubble until
   * the answer brings their row (note #736). This screen used to hold the
   * box focused and read-only for the whole request and let go of it from
   * code when the answer came — so on an iPhone the keyboard went away
   * while the box still had the focus, the one way of leaving it the room
   * chat never takes, and the page stayed shifted up over a blank lower
   * half. A send refused after all puts its words and files back in the
   * box, in front of anything typed since.
   */
  const send = useCallback((message: string, files: File[]): boolean => {
    const text = message.trim();
    if (!text && !files.length) return false;
    const draft = `${text}\n${files.map((file) => `${file.name}:${file.size}`).join('\n')}`;
    if (pendingSend.current?.draft !== draft) pendingSend.current = { clientId: crypto.randomUUID(), draft };
    const { clientId } = pendingSend.current;
    // Whatever the last turn ended as, this message starts one: the stopped
    // turn's line must not sit over a request that is running again.
    setSending(true); setSendError(''); setStopped(false);
    following.current = true;
    const bubble: OutgoingMessage = { id: clientId, text, files, sentAt: Date.now(), after: drawnCount.current, state: 'sending' };
    setOutgoing((current) => [...current.filter((sent) => sent.id !== clientId), bubble]);
    const settle = () => setOutgoing((current) => current.filter((sent) => sent.id !== clientId));
    void (async () => {
      try {
        // Big files go up in parts first (note #943); the bubble says how far.
        const progress = (sent: number, total: number) => {
          const percent = total > 0 ? Math.min(100, Math.floor((sent / total) * 100)) : 0;
          setOutgoing((current) => current.map((item) => (item.id === clientId && item.percent !== percent ? { ...item, percent } : item)));
        };
        const next = files.length
          ? await api.api<RecapChatAnswer>('api/recap/chat/files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/vnd.agentbuilt.chat-attachments', 'x-recap-client-id': clientId },
            body: await chatFilesBody(api, WORKSPACE_AGENT_CHAT_ID, text, files, progress),
          })
          : await api.api<RecapChatAnswer>('api/recap/chat', jsonBody({ clientId, text }));
        if (pendingSend.current?.clientId === clientId) pendingSend.current = null;
        following.current = true; holdRecapChat(orgId, next); setAnswer(next);
        // Its row in the answer retires the bubble as it lands; an answer
        // that does not carry it never will, so the bubble goes now.
        if (!matchSends([bubble], sendRowsOf(next.messages)).size) settle();
      } catch (err) {
        settle(); setSendError(errorMessage(err));
        returnDraft.current?.({ text, files });
      } finally { setSending(false); }
    })();
    return true;
  }, [api, orgId]);
  // Where a refused send's words go back to: the composer subscribes, as it
  // does to the room chat's outbox.
  const returnDraft = useRef<((draft: ReturnedDraft) => void) | null>(null);
  const giveBack = useCallback((take: (draft: ReturnedDraft) => void) => {
    returnDraft.current = take;
    return () => { if (returnDraft.current === take) returnDraft.current = null; };
  }, []);

  /**
   * Stop the running request: the room chat's Stop. The screen answers the
   * tap ITSELF the moment the backend accepts it (note #453) — the live row
   * goes and says the turn was stopped — rather than waiting for the machine
   * to unwind. A turn that had already ended says so in the one place this
   * screen has for a line, and leaves the live row alone: nothing was
   * stopped, so nothing may claim it was.
   */
  const stop = useCallback(async () => {
    setStopping(true); setSendError('');
    try {
      const result = await api.api<RecapChatStopAnswer>('api/recap/chat/stop', jsonBody({}));
      if (result.stopped) setStopped(true);
      else setSendError(`${WORKSPACE_AGENT} had already finished.`);
      const next = await api.api<RecapChatAnswer>('api/recap/chat');
      if (next.orgId === orgId) { holdRecapChat(orgId, next); setAnswer(next); if (!next.working) setStopped(false); }
    } catch (err) { setSendError(errorMessage(err)); }
    finally { setStopping(false); }
  }, [api, orgId]);

  /** A file that is not a picture on screen, or a picture the viewer's
   *  Download was pressed on: saved, under a URL minted at the tap — through
   *  an anchor, because a window opened after the awaited read is a popup
   *  Safari refuses (note #552). */
  const openFile = useCallback(async (file: WorkspaceChatFile) => {
    try {
      const access = await api.api<WorkspaceChatFileAccessAnswer>(`api/agents/${WORKSPACE_AGENT_CHAT_ID}/chat/files/${encodeURIComponent(file.id)}`);
      if (access?.url) saveFile(access.url, access.fileName || file.fileName);
    } catch (err) { setSendError(errorMessage(err)); }
  }, [api]);

  /**
   * The rows' callbacks, made once (note #764). A row is memoised, and a new
   * function on every render redrew all of them — a whole conversation of
   * Markdown, 1,200 rows on the owner's — before a sent message could be
   * drawn. A picture that lands while the reader follows the conversation
   * keeps them at its end, as the room chat's does.
   */
  const noProposal = useCallback(() => {}, []);
  const pictureLoaded = useCallback(() => { if (following.current) scrollToBottom(pane.current); }, []);

  /** The agent's own model picker: from the header's runtime line, and from
   *  the row that says its model cannot run (note #725). */
  const openSettings = useCallback(() => { parked.current = pane.current?.scrollTop ?? 0; setPicking(true); }, []);

  // Model and effort only: the harness name ("Claude Code", "Codex") is left
  // out of the Chief of Staff's header (the owner, 2026-10-11 — note #723).
  // The model already says which one it is, and the picker behind the line
  // still names the harness where it is chosen.
  // Once a read has answered, it rules — a pair it no longer names is gone,
  // and only then is the placeholder the truth.
  const pair = settings ? settings.settings : remembered;
  const runtime = [pair?.model, pair?.effort].filter(Boolean).join(' · ') || 'Model & effort';
  // What the SCREEN shows as running: the server's answer, less a stop this
  // screen has already been told landed.
  const running = Boolean(answer?.working);
  const working = running && !stopped;
  // The recap line under the latest completed request (note #945). The
  // conversation's last word is the last row it DRAWS — a quiet event
  // turn's rows stay in the record and off the screen.
  const shownMessages = messages.filter((_, at) => { const form = views[at]?.form; return form !== 'hidden' && form !== 'remove-room'; });
  const recapShown = showsTurnRecap(answer?.lastTurn, {
    busy: running || pending.length > 0,
    ...(shownMessages.length ? { last: shownMessages.at(-1)! } : {}),
    ...(() => { const reply = shownMessages.findLast((message) => message.role === 'assistant'); return reply ? { lastReplyAt: reply.at } : {}; })(),
  });
  let lastDay = '';
  return <>
    {picking ? <RecapRuntimePicker orgId={orgId} seed={settings} target="agent" onClose={() => { setPicking(false); readSettings(); }} /> : null}
    {/* A tap on the conversation puts the keyboard away, as it does in every
        room chat (note #727). Without it the box kept the focus here, so the
        keyboard left some other way, with no blur to arm the viewport sync's
        settle loop: Safari's refused scroll back was never asked again, and
        the whole shell stood stranded above a blank lower half. (The sync
        now retries without a blur too.) */}
    <div className="screen" id={home ? 'screenHome' : 'screenRecapChat'} ref={shell} hidden={picking} onPointerDown={blurBoxOnInertTap}>
      <div className="chathead">
        {home ? null : <button className="back" type="button" onClick={back}><Svg name="back" size={20} />Back</button>}
        {/* The face, in the context ring every agent's plate wears (note
            #434), and the name: on Home both are the door to the Workplace
            window (the owner, 2026-10-11 — note #715 had taken the face
            away and put two doors beside the name). The face steps out of
            the reading order: the name says the same thing in words. */}
        {onOpenWindow
          ? (
            <button className="chatface chatagent homefacedoor" id="recapChatFace" type="button" tabIndex={-1} aria-hidden="true" onClick={onOpenWindow}>
              <ContextRing context={answer?.context}><AgentFace agent={{ avatarUrl: workspace?.org?.workspaceAgentAvatarUrl ?? answer?.avatarUrl }} /></ContextRing>
            </button>
          )
          : (
            <span className="chatface chatagent" id="recapChatFace" aria-hidden="true">
              <ContextRing context={answer?.context}><AgentFace agent={{ avatarUrl: workspace?.org?.workspaceAgentAvatarUrl ?? answer?.avatarUrl }} /></ContextRing>
            </span>
          )}
        <div className="chatwho">
          <h1 id="recapChatTitle">
            {onOpenWindow
              ? (
                <button
                  className="homenamedoor"
                  id="homeWorkplaceDoor"
                  type="button"
                  aria-haspopup="dialog"
                  aria-expanded={windowOpen}
                  title="Open the Workplace"
                  onClick={onOpenWindow}
                >
                  {WORKSPACE_AGENT}
                </button>
              )
              : WORKSPACE_AGENT}
          </h1>
          <div className="chatsubline">
            <button
              className="sub chatruntime"
              id="recapChatRuntime"
              type="button"
              aria-label={`Change ${WORKSPACE_AGENT} model and effort. Current: ${runtime}`}
              onClick={openSettings}
            >
              <span>{runtime}</span>
            </button>
            {/* The reader's own auto-merge, while it is on (note #944; Adam,
                1 Nov 2026: "in chief of staff chat screen in header it should
                be displayed text that auto merge is on as yellow colored
                text"): their agents' proposals merge without them reading. */}
            {workspace?.org?.autoMerge?.on ? <span className="sub automergeon" id="recapAutoMerge">Auto-merge on</span> : null}
          </div>
        </div>
        {home ? <HomeChrome /> : null}
      </div>
      <div className={empty ? 'chatpane isempty' : 'chatpane'} id="recapChatScroll" ref={pane} onScroll={onScroll}>
        <ChatGalleryProvider>
        {/* The one arrival with no screen of its own to say it — redeeming
            an invitation — lands on Home and says so here, over the log. */}
        {notice ? <div className="card authpanel" role="status" id="homeBanner">{notice}</div> : null}
        <div id="recapChatLog" className="chatlog" role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions">
          {!answer && !error ? <span className="sr-only" role="status">Loading conversation…</span> : null}
          {empty ? <ChiefOfStaffEmpty avatarUrl={workspace?.org?.workspaceAgentAvatarUrl ?? answer?.avatarUrl} /> : null}
          {rows.map((row, at) => {
            const view = views[at] ?? { form: 'row' as const };
            // An old ask to delete a room (note #740) has nothing left to
            // decide since rooms left the product (note #843): its card, and
            // the room's screen it opened, are gone, and so is the row.
            if (view.form === 'hidden' || view.form === 'remove-room') return null;
            const day = row.at ? new Date(row.at).toDateString() : lastDay;
            const divider = row.at && day !== lastDay ? chatDayLabel(row.at) : '';
            if (divider) lastDay = day;
            const where = { at: row.at, arriving: row.arriving };
            return <Fragment key={row.seq}>
              {divider ? <div className={row.arriving ? 'chatday arriving' : 'chatday'}>{divider}</div> : null}
              {view.form === 'did' ? <DidLine view={view} {...where} />
                : view.form === 'attention' ? <AttentionLine view={view} {...where} onOpenSettings={openSettings} />
                  : view.form === 'remove-agent' ? <RemoveAgentCard view={view} {...where} />
                    : view.form === 'noticed' ? <NoticedLine text={view.text} href={row.href} {...where} />
                      : view.form === 'unfinished' ? <UnfinishedLine reason={view.reason} {...where} />
                        : <>
                          {/* The Chief of Staff's files (note #749), drawn as a room
                              agent's ATTACH: files are — the words as Markdown in
                              their own row, the files on a row of their own under it. */}
                          <ChatMessageRow row={row.role === 'agent' && row.files?.length ? wordsOf(row) : row} agentId={WORKSPACE_AGENT_CHAT_ID} workspaceLinks foldReports onOpenProposal={noProposal} onOpenFile={openFile} onPictureLoaded={pictureLoaded} />
                          {row.role === 'agent' && row.files?.length
                            ? <ChatMessageRow row={filesOf(row)} agentId={WORKSPACE_AGENT_CHAT_ID} workspaceLinks foldReports onOpenProposal={noProposal} onOpenFile={openFile} onPictureLoaded={pictureLoaded} />
                            : null}
                          {view.unfinished
                            ? <UnfinishedMark unfinished={view.unfinished} busy={sending} onRetry={(retry) => { void send(retry === 'continue' ? 'Continue' : row.text, []); }} />
                            : null}
                        </>}
              {row.seq === signInAfter ? <FirstRunSignIn orgId={orgId} /> : null}
            </Fragment>;
          })}
          {/* Sent and not on the record yet, as the room chat draws it (notes
              #658, #736): after every row, in the order it was written. */}
          {pending.map((message) => <OutgoingMessageRow key={message.id} message={message} />)}
          {/* The team the Chief of Staff is bringing in, while its computers
              are built (note #726): on Home, where the first run happens. */}
          {home ? <TeamArrivingCard agents={agents ?? []} /> : null}
          {/* Nothing is drawn while replies are being collected (note #486).
              The line that stood here explained a mechanism the reader did
              not ask about, under every answer, and the reply it promised
              arrives as its own row anyway. Who the conversation is waiting
              for is still said where a state belongs: the agent's plate on
              Home and its own screen, through `agentStateLine`. */}
        </div>
        </ChatGalleryProvider>
        {/* Under the latest completed request, once it is over (note #945),
            with whose answers it is still collecting where an agent's says
            what it left running. */}
        {recapShown && answer?.lastTurn ? <TurnRecap id="recapChatRecap" turn={answer.lastTurn} waiting={answer.waiting} /> : null}
        {/* Visible only while a request runs: the typing bubble carries the
            phase the machine reports — Thinking…, the rare first-time
            setup, Stopping… (never the machine waking, note #633; a room
            agent's bubble does not say that either) — and Stop keeps the room chat's
            contract (note #423): the turn on the machine is ended, the
            conversation keeps everything it already did, and the next
            message starts afresh. */}
        <div className={working ? 'chatlive arriving' : 'chatlive'} id="recapChatLive" hidden={!working}>
          <div className="chatmsg agent">
            <span className="tdots"><i /><i /><i /></span>
            <span className="activity" id="recapChatActivity" role="status">{answer?.phase || 'Thinking…'}</span>
          </div>
          <button
            className="chatstop"
            id="recapChatStop"
            type="button"
            aria-label={stopping ? 'Stopping…' : 'Stop'}
            aria-busy={stopping || undefined}
            disabled={stopping}
            data-stopping={stopping ? '1' : undefined}
            onClick={() => { void stop(); }}
          >
            <Svg name="stop" size={18} />
          </button>
        </div>
        {/* The tap's own answer, standing where the spinner stood until the
            machine's row arrives to say it permanently (note #453). */}
        {stopped && running
          ? <div className="chatmsg chatquiet" id="recapChatStopped" role="status">{TURN_STOPPED}</div>
          : null}
        {error ? <p className="hintblock" role="alert">{error} Retrying…</p> : null}
        <ChatJump anchor={jumpAnchor} id="recapChatJump" onJump={jump} />
      </div>
      {standing ? <p className="hintblock" role="status" id="homeStanding">{standing}</p> : null}
      {sendError ? <p className="hintblock" role="alert">{sendError}</p> : null}
      {/* Open while a request runs, as the room chat's is: a message sent
          then steers the turn rather than waiting for it. */}
      <ChatComposer onSend={send} giveBack={giveBack} onRefuse={setSendError} memory={recapDraftKey(orgId)} lead={<AgentSwitch />} />
    </div>
  </>;
}
export function RecapChatScreen() { const orgId = useOrgId(); return orgId ? <Conversation key={orgId} orgId={orgId} /> : null; }
