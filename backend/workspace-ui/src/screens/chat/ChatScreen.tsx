/**
 * The agent's durable Workspace conversation (note #131), read from the
 * platform chat record. A working agent is steered, not refused.
 *
 * This is the one screen with its OWN header. Back rides the pinned bar
 * rather than the top of the document (note #188): every other screen opens
 * at its first line, so a Back above the title is on screen exactly when it
 * is wanted — but the chat opens at its NEWEST message and is read there, so
 * a Back at the top of the transcript is a whole conversation out of reach
 * the moment the screen appears. The persistent header is absent here for the
 * same reason, and who is answering is pinned in its place.
 *
 * Back is the one exception in the navigation model (knowledge page
 * "miniapp-navigation"). A chat this page session opened spends its entry
 * like anything else. A DIRECT or reloaded chat has no Agent entry underneath
 * it, but the product's contextual rule still says Chat → Agent — so Back
 * REPLACES the chat entry with the agent rather than pushing another, and the
 * following browser Back does not walk through a duplicate.
 *
 * The refresh here is the chat's own three-second poll, not the Workspace's:
 * an open conversation is the one surface where a reply has to arrive by
 * itself. It stops while the document is hidden and while a transient leaf is
 * up, and one catch-up read restarts it — so whatever was said while the
 * picker was open arrives at once rather than a whole interval later.
 *
 * THE WAIT IS THE SHAPE OF A CHAT, not a ring in an empty box (note #309).
 * Two reads can leave this screen empty and they are different waits: the
 * fleet read owes it a name to pin and somebody to send to, and until that
 * lands the WHOLE screen is held; the transcript read owes it only the pane
 * between a header and a composer that are already standing. `ChatSkeleton`
 * draws both out of the same held turns, and its own comment carries why the
 * held pane must never be given the transcript's ref.
 *
 * SCROLLING IS DONE AFTER THE COMMIT, never beside the setState (note #273).
 * A `scrollTo(scrollHeight)` written right after `setRows` measures the
 * document the rows are not in yet, so the chat opened at its FIRST message
 * and a send was never followed. A read only ASKS for a follow; the layout
 * effect keyed on the rows carries it out once they are on the page.
 *
 * THE TRANSCRIPT IS THE ONLY THING THAT SCROLLS (note #278). This screen is a
 * shell exactly as tall as the viewport: the identity header at the top, the
 * composer at the bottom, and the conversation in the pane between them.
 * Nothing here uses the window as the reader's scroller. A `sticky` header
 * and a `fixed` composer were the page's two ways of faking that, and both
 * were paid for out of the transcript — a measured bottom reserve that had
 * to be kept in step with a growing draft, an overlaid keyboard and a leaf
 * coming and going, and a header that had to be pushed back down by hand
 * whenever a phone panned the page under it. A pane that simply ENDS where
 * the composer begins needs no reserve, and a header outside the scroller
 * cannot be carried off the top of one. The one document-scroll correction
 * is after an iPhone keyboard has gone: Safari can leave behind the temporary
 * page pan it used to reveal the box, and the chat returns that to zero.
 */

import { overviewTo } from '../home/home-address.js';
import {
  Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type PointerEvent, type RefObject,
} from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import type {
  WorkspaceAgentContext,
  WorkspaceAgentRuntimeAnswer,
  WorkspaceAgentStopAnswer,
  WorkspaceChatAnswer,
  WorkspaceChatFile,
  WorkspaceChatFileAccessAnswer,
  WorkspaceChatMessage,
} from '../../../../src/shared/workspace-api.js';
import { jsonBody } from '../../api/client.js';
import { agentDraftKey } from '../../chrome/draft-memory.js';
import { useReturnToParent } from '../../chrome/history.js';
import { recallPaneScroll, rememberPaneScroll } from '../../chrome/scroll-memory.js';
import { useBack } from '../../chrome/useBack.js';
import { useBanner } from '../../chrome/useBanner.js';
import { toFor } from '../../routes.js';
import { useSession } from '../../session/useSession.js';
import { reducedMotion } from '../../ui/motion.js';
import { jumpToNewest, NEAR_BOTTOM_PX, readChatJump, scrollToBottom } from './chat-jump.js';
import { AgentFace } from '../../ui/AgentFace.js';
import { AgentName } from '../../ui/AgentName.js';
import { ContextRing } from '../../ui/ContextRing.js';
import { Svg } from '../../ui/icons.js';
import { saveFile } from '../../ui/save-file.js';
import { useWait } from '../../ui/wait.js';
import { useWorkspace } from '../../workspace/useWorkspace.js';
import { RuntimePicker } from '../agent/RuntimePicker.js';
import { agentRuntimeLine } from '../home/agent-words.js';
import { AgentSwitch } from './AgentSwitch.js';
import { ChatComposer } from './ChatComposer.js';
import { keyboardTraceWanted, useKeyboardTrace } from './keyboard-trace.js';
import { ChatGalleryProvider } from './ChatGallery.js';
import { ChatMessageRow, OutgoingMessageRow } from './ChatMessageRow.js';
import { ChatShellWait, ChatWaitTurns } from './ChatSkeleton.js';
import { chatDayLabel } from './chat-notice.js';
import { matchSends, type ReturnedDraft } from './outbox.js';
import { broughtArrivals, mergeTranscript, transcriptCursor, type TranscriptRow } from './transcript.js';
import { useChatOutbox } from './useChatOutbox.js';
import { useTranscripts } from './useTranscripts.js';
import { useManagedJobs } from '../jobs/useManagedJobs.js';
import { RadioButton } from '../../radio/RadioButton.js';

export const CHAT_POLL_MS = 3000;
/** How long a rising row takes to settle, so the live row can queue behind it
 *  rather than land beside it (note #178). */
export const CHAT_ARRIVE_MS = 280;
/** How long the shell keeps re-measuring after the box takes or loses the
 *  focus (notes #305, #289). Long enough to outlast a phone keyboard's slide
 *  — iOS animates it in about a quarter of a second, Android a little less —
 *  with room for the frame the browser reports the finished height on. */
const KEYBOARD_SETTLE_MS = 600;
/** How long a shell placed for a REMEMBERED keyboard waits for that keyboard
 *  to begin moving before it takes the page's own geometry back. A phone
 *  starts its keyboard within a frame or two of the focus; a tablet with a
 *  hardware keyboard never starts one at all. */
const KEYBOARD_PREDICTION_GRACE_MS = 300;
/** Where the last keyboard's geometry is kept between page loads — a
 *  keyboard is the same height every time on the same phone the same way
 *  up, which is what lets the shell be placed for it before it moves. */
const KEYBOARD_MEMORY_KEY = 'chat-keyboard';
/** Where it is kept that THIS browser moves its own page for its keyboard
 *  (the iPhone shape below). Such a phone must never be placed for a
 *  remembered keyboard: the one time it was (the owner's trace, 2026-10-11)
 *  the shell stood shrunk and shifted under the rising keys, the phone
 *  scrolled the page 516px to reach the box instead of its own 320, and
 *  never gave that scroll back — the Chief of Staff's chat stranded above a
 *  blank lower half while the room chat, placed for nothing, came back on
 *  its own. The memory itself was written by a focus whose settle deadline
 *  caught the one frame iOS reports `innerHeight` at the full height while
 *  the visual viewport is still the keyboard's: a reading that looks exactly
 *  like a browser that paints its keyboard over the page. */
const KEYBOARD_PHONE_KEY = 'chat-keyboard-phone';

/** The visible viewport as the shell needs it: the height to hold the shell
 *  to when a keyboard is painted over the page (0 when nothing is), how far
 *  the visual viewport has been panned under that keyboard, and whether the
 *  browser is moving its own page for the keyboard instead. That last bit is
 *  observed, not laid out from: it is what lets us put the page back after
 *  the keys have gone without fighting their arrival. */
type ViewportReading = { height: number; top: number; browserKeyboard: boolean };

const sameReading = (a: ViewportReading, b: ViewportReading): boolean =>
  a.height === b.height && a.top === b.top && a.browserKeyboard === b.browserKeyboard;

/** Read the visual viewport — and read NOTHING on the phone that handles its
 *  own keyboard.
 *
 *  An iPhone (iOS 18, measured on the owner's phone, 2026-09-05) reports the
 *  visual viewport's height AS `innerHeight` once its keyboard is up, keeps
 *  the layout viewport (`documentElement.clientHeight`, what `100dvh` lays
 *  the shell out to) the whole screen, and SCROLLS the page to bring the box
 *  over the keys — in one motion, animated with the keyboard itself, on the
 *  compositor. Nothing written from here can join that motion: a shell
 *  shrunk to the visible height puts the box in place a hundred milliseconds
 *  BEFORE the keys arrive, which reads as a jump; a shell shifted by the
 *  scroll's own reading lands under the keys and is corrected over half a
 *  second, which reads as a flash (PRs #621, #624, #631 — each one measured
 *  right in a harness and wrong on the phone). Ten recorded taps and the
 *  owner's own verdict picked the version that writes nothing while the
 *  keyboard is moving: the header
 *  scrolls off the top while the keyboard is up, the newest lines and the
 *  box are exactly where the phone put them, and the keys rise under them
 *  in one piece. So a browser whose window IS its visual viewport gets no
 *  height or shift and nothing is remembered. The one correction comes
 *  AFTER that keyboard is gone: iOS can leave the page at the scroll it used
 *  to reveal the box, stranding the whole chat a keyboard-height above its
 *  resting place (note #351). The caller observes this shape so it can
 *  restore the page only once the full viewport is back.
 *
 *  The sync stays for the browsers that keep `innerHeight` at the whole
 *  screen while the visual viewport shrinks beneath it — the shape the
 *  Chrome harness stands in for — where `dvh` still measures the covered
 *  height and the composer would otherwise sit under the keys.
 *
 *  Rounding alone can put the two a pixel apart on a zoomed page; only a
 *  real cover is worth overriding the stylesheet for. */
/** Whether this browser drives a touch screen — a phone or tablet, never a
 *  desktop. The one shape where a visual viewport OFFSET down the page is a
 *  keyboard the browser handles itself (the iPhone pans its own page) rather
 *  than a keyboard painted over a fixed layout the shell must shrink to fit.
 *  Read once: a pointer does not change kind within a session. Absent in
 *  jsdom, where it reads false and the desktop shell behaviour is kept. */
let coarsePointerCached: boolean | null = null;
const coarsePointer = (): boolean => {
  if (coarsePointerCached === null) coarsePointerCached = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  return coarsePointerCached;
};

function readViewport(): ViewportReading {
  const viewport = window.visualViewport;
  const visibleHeight = viewport?.height;
  const offset = viewport?.offsetTop;
  const measured = visibleHeight !== undefined && Number.isFinite(visibleHeight) && visibleHeight > 0;
  const height = measured ? Math.round(visibleHeight) : 0;
  const windowIsVisual = measured && Math.abs(window.innerHeight - height) <= 1;
  const browserKeyboard = Boolean(windowIsVisual && layoutHeight() - height > 1);
  if (!measured || windowIsVisual) return { height: 0, top: 0, browserKeyboard };
  const covered = layoutHeight() - height > 1;
  const top = offset !== undefined && Number.isFinite(offset) ? Math.max(0, Math.round(offset)) : 0;
  // On a TOUCH screen a cover with the visual viewport OFFSET down the page is
  // the iPhone panning its own page, not a keyboard painted over a fixed
  // layout. The iPhone reaches here for ONE frame mid-slide — the visual
  // viewport has already shrunk while `innerHeight` has not caught up, so
  // `windowIsVisual` is briefly false — and answering that frame with a real
  // height shrank the shell to the keyboard's size, which STRANDS the page on
  // the phone and no scroll-back recovers it (the owner's lab, 2026-10-11:
  // mode "shrink" stranded even with the full scroll cascade on blur, while
  // "none" came back on its own). So on a coarse pointer an offset cover is
  // written NOTHING, armed for the keyboard-restore like every other iPhone
  // frame. A desktop (fine pointer, and jsdom) keeps the shell: a browser that
  // pans a fixed layout under its keyboard is answered by shifting and
  // shrinking it.
  if (covered && top > 1 && coarsePointer()) return { height: 0, top: 0, browserKeyboard: true };
  return { height: covered ? height : 0, top, browserKeyboard: false };
}

/** The height the shell is laid out to with no keyboard up — what a
 *  keyboard's remembered geometry is kept against, since `innerHeight` is
 *  the keyboard-shortened height on the phone that matters most. */
const layoutHeight = (): number => Math.max(document.documentElement.clientHeight, window.innerHeight);
function rememberKeyboard(reading: ViewportReading | null): void {
  try {
    if (!reading) localStorage.removeItem(KEYBOARD_MEMORY_KEY);
    else localStorage.setItem(KEYBOARD_MEMORY_KEY, JSON.stringify({ height: reading.height, top: reading.top, width: window.innerWidth, window: layoutHeight() }));
  } catch { /* no memory, then: the keyboard is measured as it arrives */ }
}
function keyboardPhoneKnown(): boolean {
  try { return localStorage.getItem(KEYBOARD_PHONE_KEY) === '1'; } catch { return false; }
}
function rememberKeyboardPhone(): void {
  try { localStorage.setItem(KEYBOARD_PHONE_KEY, '1'); } catch { /* then it is learned again at the next keyboard */ }
}
function recallKeyboard(): ViewportReading | null {
  if (keyboardPhoneKnown()) return null;
  try {
    const kept = JSON.parse(localStorage.getItem(KEYBOARD_MEMORY_KEY) ?? 'null') as
      { height?: unknown; top?: unknown; width?: unknown; window?: unknown } | null;
    if (!kept || kept.width !== window.innerWidth || kept.window !== layoutHeight()) return null;
    const { height, top } = kept;
    if (typeof height !== 'number' || typeof top !== 'number' || height <= 0 || height >= layoutHeight() || top < 0) return null;
    return { height: Math.round(height), top: Math.round(top), browserKeyboard: false };
  } catch { return null; }
}
/** How many frames an OPENING snap keeps asking for the end of the
 *  conversation while the shell settles into its height. A quarter of a
 *  second at 60fps: long enough for a cold load's first layout, short enough
 *  that it is over before a reader could have scrolled anywhere on purpose. */
const SNAP_SETTLE_FRAMES = 15;

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const sameContext = (a: WorkspaceAgentContext | null, b: WorkspaceAgentContext | null): boolean =>
  a === b || (a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b));

/** True while the reader is at (or near) the newest message — the one state
 *  in which new rows may move the scroll under them. The transcript is this
 *  screen's ONE scroller, so this reads that pane rather than the window; a
 *  pane not on the page yet counts as being at its end, which is where a
 *  conversation opens. */
const nearBottom = (pane: HTMLElement | null): boolean =>
  !pane || pane.scrollHeight - pane.scrollTop - pane.clientHeight <= NEAR_BOTTOM_PX;

/**
 * The way back to the newest message, for a reader a whole pane or more up
 * the transcript (note #334) — the room chat's, and since note #730 the Chief
 * of Staff's too, so the two cannot drift apart. It stands at the end of the
 * transcript's flow, sticky to the pane's bottom edge, so it rides just above
 * the composer whatever height the draft has given it, and it takes no height
 * of its own so the words above never move for it. Near the end it is not
 * there at all: the end is a flick away, and a button over the last lines
 * would be in their way. `hidden` is written by the screen's scroll handler
 * through `anchor`, never by a render: React leaves an attribute it did not
 * change alone.
 */
export function ChatJump({ anchor, id, onJump }: { anchor: RefObject<HTMLDivElement | null>; id: string; onJump: () => void }) {
  return (
    <div className="chatjump" ref={anchor} hidden>
      <button type="button" id={id} aria-label="Scroll to the newest message" title="Newest message" onClick={onJump}>
        <Svg name="arrowdown" size={20} />
      </button>
    </div>
  );
}

/**
 * Hold the shell to the height the reader can actually SEE, and keep the end
 * of the conversation in view while that height changes.
 *
 * Some browsers resize the layout viewport for their keyboard, and `100dvh`
 * follows those on its own — nothing has to be written here at all. Others
 * leave the layout viewport where it was and paint the keyboard OVER it:
 * `dvh` then still measures the covered height and the composer sits under
 * the keys. The visual viewport is the only thing that reports which of the
 * two happened, so its height is written back as the shell's when — and only
 * when — the two disagree. A browser that PANS the page under a fixed layout
 * viewport is answered from the other end, by moving the shell down the
 * offset it panned by. No guessed iPhone or keyboard height can be right for
 * both.
 *
 * ONE reading of that is never enough (notes #305, #289). A keyboard SLIDES,
 * and the browser reports the viewport while it is still moving: the height
 * that arrives with the event is the height the screen had a moment ago, and
 * once the keys land nothing is guaranteed to say so. Measured once, the
 * shell keeps the full height it was told, the composer stays under the keys,
 * and the reader gets it back only when something unrelated — a typed letter
 * growing the box — happens to send another event. That accident is the whole
 * of #289's "I can't see the text input; then when I type something, I start
 * seeing it properly". So the box taking or losing the focus arms a short
 * watch over the slide, to a fixed deadline, and the reading it ends on is
 * the one that counts.
 *
 * The readings in between are NOT written. Chasing them is what flickered:
 * the phone pans the page under its rising keyboard on the compositor, a
 * frame ahead of every reading it sends here, so a shell moved to each one
 * sat a step behind the viewport for the whole quarter-second of the slide
 * — "a flash of chat content flickering" before it came right. The shell
 * holds instead, and is written when a reading stands still. Better still
 * is a shell that has nothing to do when the slide ends: the keyboard is the
 * same height every time on the same phone, so the geometry it ended on is
 * remembered, and the next focus places the shell for it BEFORE the
 * keyboard moves — the reader then sees the keys rise under a composer that
 * was already where it will be. A remembered keyboard that never comes (a
 * tablet's hardware keys) is given back within a few frames; one that comes
 * a different size is corrected at the end of the slide, as an unknown one
 * is placed.
 *
 * The composer's own height is nobody's business any more: the pane ends
 * where the bar begins, so a draft grown to seven lines simply takes seven
 * lines of transcript with it. What is still watched is the TRANSCRIPT,
 * because a reader at the end of the conversation has to stay there through
 * every one of these — a keyboard, a growing draft, a rotated phone.
 */
export function useChatViewport(
  active: boolean,
  pane: RefObject<HTMLDivElement | null>,
  following: RefObject<boolean>,
  composerSelector = '#agentChatForm',
): RefObject<HTMLDivElement | null> {
  const screen = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const root = screen.current;
    const bar = root?.querySelector<HTMLElement>(composerSelector);
    if (!root || !bar) return;
    const page = document.documentElement;
    const clear = () => {
      page.style.removeProperty('--chat-shell-height');
      root.style.removeProperty('transform');
      delete bar.dataset.keyboardOverlay;
    };
    // The iPhone path above deliberately lets the browser move the page while
    // its keyboard is on screen. It does not always give that scroll back
    // when the keyboard leaves, which strands the entire shell high above a
    // blank lower half (note #351). Remember seeing that browser-owned
    // keyboard, then restore the chat's one valid document position only
    // AFTER the full viewport is back. Keeping the flag until scrollY really
    // reads zero also lets the focusout settle loop retry a scroll Safari did
    // not accept on its first closing frame.
    let browserKeyboardSeen = false;
    // The phone that moves its own page, known from this or an earlier
    // visit: nothing is written for its keyboard, ever (see
    // KEYBOARD_PHONE_KEY) — not a remembered height before it comes, not
    // the transient reading its own `innerHeight` lags into as it goes.
    let phone = keyboardPhoneKnown();
    // A keyboard can also leave with NO blur — the box kept the focus, so the
    // settle loop below was never armed (note #727). Then one refused frame
    // stranded the page for good. Once the keyboard has gone and the page is
    // still not back, the scroll back is asked for every frame for the same
    // short window the settle loop would have given it.
    let retrying = 0;
    let retryUntil = 0;
    const retry = () => {
      retrying = 0;
      if (!browserKeyboardSeen || Date.now() >= retryUntil) return;
      read();
      if (browserKeyboardSeen) retrying = requestAnimationFrame(retry);
    };
    // "Back" is the VISIBLE page at the top, not only the document's scroll:
    // an iPhone can leave its visual viewport panned with `scrollY` already
    // reading zero (note #736), and a check on `scrollY` alone then called
    // that stranded page restored and stopped asking.
    const shifted = () => Math.max(Math.abs(window.scrollY), Math.abs(window.visualViewport?.pageTop ?? 0)) > 1;
    /** The visual viewport stands at the layout's full height: no keyboard
     *  (or anything else) is covering the page. */
    const viewportFull = () => {
      const visible = window.visualViewport?.height;
      return visible === undefined || !Number.isFinite(visible) || layoutHeight() - Math.round(visible) <= 1;
    };
    const read = () => {
      const reading = readViewport();
      if (reading.browserKeyboard) {
        browserKeyboardSeen = true; retryUntil = 0;
        if (!phone) { phone = true; rememberKeyboardPhone(); rememberKeyboard(null); }
      } else if (browserKeyboardSeen && viewportFull()) {
        // Only once the WHOLE viewport is back. A frame mid-slide where the
        // visual viewport is still the keyboard's but `innerHeight` reads
        // full (and the offset not yet reported) is not the phone's keyboard
        // by the reading above, and asking the page back on it — with the
        // keys still up — made iOS reveal the box again by scrolling the
        // page, further than its own pan: the box mid-screen over a gap
        // (the owner's phone, 2026-10-11, after #1357).
        if (shifted() && typeof window.scrollTo === 'function') window.scrollTo(0, 0);
        // The window's scroll can be refused where the element's is not.
        if (shifted() && document.scrollingElement) document.scrollingElement.scrollTop = 0;
        if (!shifted()) browserKeyboardSeen = false;
        else if (!retryUntil) { retryUntil = Date.now() + KEYBOARD_SETTLE_MS; retrying = requestAnimationFrame(retry); }
      }
      return reading;
    };
    // READ, then write what differs — never clear and measure again. The
    // readings are the browser's own viewport, which nothing written here
    // moves, so there is no offset to compound; but reading a visual
    // viewport's height LAYS THE PAGE OUT first, in WebKit and Chromium
    // both. A shell unset before that read is laid out a whole screen tall
    // for the reading, and WebKit clamps the transcript's scroll to that
    // taller pane on the spot — then the keyboard's height goes back on,
    // the pane is short again, and the newest lines are under the composer
    // by exactly a keyboard (note #322). Ending each frame at the size it
    // began, nothing announced that either: no resize for the pane to
    // re-pin on, and a scroll the handler took for the reader's own. Chrome
    // clamps a frame later, which is why its harness never saw it.
    let initialized = false;
    const apply = (reading: ViewportReading) => {
      const { height, top } = phone ? { height: 0, top: 0 } : reading;
      const shell = height ? `${height}px` : '';
      const resized = page.style.getPropertyValue('--chat-shell-height') !== shell;
      if (resized) {
        if (shell) page.style.setProperty('--chat-shell-height', shell);
        else page.style.removeProperty('--chat-shell-height');
      }
      if (height && !bar.hasAttribute('data-keyboard-overlay')) bar.dataset.keyboardOverlay = 'true';
      else if (!height) delete bar.dataset.keyboardOverlay;
      const shift = top ? `translateY(${top}px)` : '';
      if (root.style.transform !== shift) root.style.transform = shift;
      // Commit the reading position with the new height. Reading scrollHeight
      // here lays out the resized pane before placing it; waiting for the
      // observer leaves the two updates separate during a keyboard transition.
      // A reader in older messages keeps their own position.
      // On mount, the screen's layout effect owns opening/restoring the
      // position. Only subsequent viewport changes may follow the end.
      if (initialized && resized && following.current) scrollToBottom(pane.current);
      initialized = true;
    };
    apply(read());
    // The keyboard's own slide, watched every frame of it, and the shell
    // written ONCE at the end of it rather than chased through it. Armed by
    // the box taking or losing the focus — the two moments a keyboard moves
    // for a reason this screen knows about — and stopped by the deadline,
    // so a conversation nobody is typing into costs nothing.
    //
    // Chasing it is what flickered. A phone slides its keyboard up over a
    // quarter of a second and pans the page under it on its compositor,
    // frame by frame; the readings that describe each frame reach this
    // handler a frame later, and a shell moved to match them is always one
    // step behind the viewport it is trying to sit in. Held instead, the
    // shell keeps its place while the viewport slides across it — and a
    // shell already at the keyboard's geometry (below) has nothing left to
    // do when the slide ends. The one reading written mid-slide is a
    // reading that has stood still for a frame, which the slide never
    // produces; the readings that agree before the keyboard has begun to
    // move are the geometry already on the page, and writing those again
    // changes nothing.
    let settling = 0;
    let until = 0;
    let armed = 0;
    let opening = false;
    let predicted = false;
    let before: ViewportReading = { height: 0, top: 0, browserKeyboard: false };
    let last: ViewportReading | null = null;
    const settle = () => {
      settling = 0;
      const now = Date.now();
      const reading = read();
      if (now >= until) {
        apply(reading);
        // The keyboard as it stood when it had finished arriving — what the
        // next focus is placed for before the keyboard has begun to move.
        if (opening) rememberKeyboard(reading.height && !phone ? reading : null);
        return;
      }
      const moved = !sameReading(reading, before);
      if (predicted && !moved) {
        // Nothing has come up: a hardware keyboard, or a phone whose
        // keyboard is slower than the one remembered. The page gets its
        // own geometry back rather than a guessed one.
        if (now - armed >= KEYBOARD_PREDICTION_GRACE_MS) { predicted = false; apply(reading); }
      } else if (last && sameReading(reading, last)) {
        apply(reading);
      }
      last = reading;
      settling = requestAnimationFrame(settle);
    };
    const onFocus = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLTextAreaElement) || !bar.contains(event.target)) return;
      armed = Date.now();
      until = armed + KEYBOARD_SETTLE_MS;
      opening = event.type === 'focusin';
      before = read();
      last = null;
      predicted = false;
      // A keyboard this page has met before is placed for BEFORE it moves:
      // the shell takes the height and offset it ended on last time, so the
      // slide that follows carries the viewport over a shell already where
      // it will be needed, and the reader sees the keyboard rise under a
      // composer that never jumps. A different keyboard than remembered is
      // corrected at the end of the slide, the same way an unknown one is
      // placed.
      if (opening && !before.height) {
        const remembered = recallKeyboard();
        if (remembered) { apply(remembered); predicted = true; }
      }
      if (!settling) settling = requestAnimationFrame(settle);
    };
    // A viewport event outside a slide — a rotation, a keyboard that
    // changed its own height while it stood — reports a moved visible area,
    // and is written at delivery: deferring it to another frame lets the
    // old shell appear in the new area. During a slide the frame loop above
    // is the one reader, so an event's mid-slide geometry is not chased.
    const onViewport = () => { if (!settling) apply(read()); };
    // The transcript's OWN box, watched rather than measured. A draft grown
    // to five lines, a keyboard that took half the viewport and a picked
    // file's strip all reach the transcript as the same one fact — it got
    // shorter. The viewport path above already lays out and places its own
    // changes; this observer also covers changes made by the composer.
    //
    // Whether the reader was following is the flag the scroll handler keeps,
    // never a fresh measurement. By the time this runs they are already a
    // keyboard's worth of distance from the newest message, which reads as
    // "not near the bottom" however firmly they were pinned to it.
    //
    // The first delivery is the pane arriving on the page rather than
    // changing, and a conversation returned to has just been put on the
    // reader's own line — so it is skipped.
    let primed = false;
    const onPane = () => {
      if (!primed) { primed = true; return; }
      if (following.current) scrollToBottom(pane.current);
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(onPane) : null;
    if (pane.current) observer?.observe(pane.current);
    window.visualViewport?.addEventListener('resize', onViewport);
    window.visualViewport?.addEventListener('scroll', onViewport);
    window.addEventListener('resize', onViewport);
    root.addEventListener('focusin', onFocus);
    root.addEventListener('focusout', onFocus);
    return () => {
      cancelAnimationFrame(settling);
      cancelAnimationFrame(retrying);
      observer?.disconnect();
      window.visualViewport?.removeEventListener('resize', onViewport);
      window.visualViewport?.removeEventListener('scroll', onViewport);
      window.removeEventListener('resize', onViewport);
      root.removeEventListener('focusin', onFocus);
      root.removeEventListener('focusout', onFocus);
      clear();
    };
  }, [active, following, pane, composerSelector]);
  return screen;
}

/** A tap on the transcript or the background puts the keyboard away. A tap
 *  on a control is left alone: blurring on the way INTO a button would slide
 *  it out from under the finger mid-tap. Shared with the Chief of Staff's
 *  conversation (note #727). */
export function blurBoxOnInertTap(event: PointerEvent<HTMLDivElement>): void {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active.id !== 'agentChatText') return;
  const target = event.target as HTMLElement;
  if (target.closest('input, textarea, select, button, a, label, [role="button"], [contenteditable]')) return;
  active.blur();
}

/** The first jobs an empty conversation offers. Each one finishes on its own
 *  in a few minutes from nothing but the words: a live site, a short review,
 *  a knowledge page brought back for a yes. */
export const CHAT_STARTERS = [
  'Make a one-page website for my business and put it live.',
  'Look at my website and tell me the three things to fix first.',
  'Write our first knowledge page: ask me three questions about how we work.',
] as const;

export function ChatScreen() {
  const { id = '' } = useParams();
  const { agents, reload, patchAgentRuntime, markAgentNotificationsRead, state: workspace } = useWorkspace();
  const { api } = useSession();
  const banner = useBanner();
  const back = useBack();
  const navigate = useNavigate();
  const location = useLocation();
  // The direct-or-reloaded case lands on the agent's page — replaced, never
  // pushed — as does a step back the browser had nowhere to take (note #742).
  const returnToParent = useReturnToParent(toFor({ kind: 'agent', id })!);
  const transcripts = useTranscripts();
  const outbox = useChatOutbox();

  const [rows, setRows] = useState<TranscriptRow[]>(() => transcripts.read(id) ?? []);
  const [answered, setAnswered] = useState(false);
  // Why the pane is empty, when the reason is a read that failed rather than a
  // conversation with nothing in it. Held only while there is nothing else to
  // draw: a reader with a transcript keeps it, and keeps their quiet.
  const [failed, setFailed] = useState('');
  const [turn, setTurn] = useState<{ working: boolean; preparing: boolean; activity: string }>({
    working: false, preparing: false, activity: '',
  });
  const [context, setContext] = useState<WorkspaceAgentContext | null>(null);
  const [stopping, setStopping] = useState(false);
  // What the reader has sent that is not on the record yet (note #658). It
  // lives above this screen, so a message that went keeps going — and keeps
  // its bubble — when the reader steps away and back.
  const outgoing = useSyncExternalStore(outbox.subscribe, () => outbox.list(id));
  // A bubble stops being drawn in the same render its row arrives in, so the
  // row takes its place in one commit; the outbox forgets it just after.
  const pending = useMemo(() => {
    const recorded = new Set(matchSends(outgoing, rows).values());
    return recorded.size ? outgoing.filter((message) => !recorded.has(message.id)) : outgoing;
  }, [outgoing, rows]);
  const [liveUp, setLiveUp] = useState(false);
  const [picking, setPicking] = useState(false);
  // The way back down (note #334): shown and hidden by the scroll handler
  // below WRITING to the node, not through state. A scroll is the one event
  // this screen sees continuously, and a render on each one — even a
  // bailed-out render of a 1,000-line screen — was enough to sometimes unpin
  // the reader from the newest message under a phone keyboard (the harness's
  // 4d–4f), where the pinning is a race between the viewport's readings and
  // the frames they are written in. The button's state is a bit on a box.
  const jumpAnchor = useRef<HTMLDivElement>(null);

  const rowsRef = useRef(rows);
  const stoppingRef = useRef(stopping);
  const nameRef = useRef('');
  const refreshRef = useRef<(initial: boolean) => Promise<unknown>>(async () => null);
  const alive = useRef(true);
  const poll = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const entrance = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The transcript's own scroller: the one thing on this screen that moves.
  const pane = useRef<HTMLDivElement>(null);
  // The line parked under a leaf, or null when no leaf has been up.
  const parked = useRef<number | null>(null);
  const stick = useRef(true);
  // The opening read happens once per conversation. Coming back from a leaf
  // is a CATCH-UP: it must not re-acknowledge notifications, re-toast a
  // failure, or drag the reader off the line they returned to.
  const opened = useRef(false);
  // Whether this entry is one the reader is coming BACK to — from the
  // proposal behind a receipt's door — rather than one they are opening. A
  // returned-to conversation keeps the row they left; an opened one ends at
  // its newest message.
  const returning = useRef(recallPaneScroll(location.key) !== undefined);
  // That row, put back once the rows it was measured against are on the page.
  const restore = useRef<number | null>(recallPaneScroll(location.key) ?? null);
  // The follow a read asked for, carried out by the layout effect below once
  // the rows it saw are on the page. A warm open asks for its snap up front:
  // the cached rows paint in the first commit, and the follow rides it. A
  // send asks for `now`: the end, in the commit its bubble is drawn in.
  const follow = useRef<'snap' | 'smooth' | 'now' | null>(rows.length && !returning.current ? 'snap' : null);
  const liveWas = useRef(false);
  const jobsWereVisible = useRef(false);

  const agent = (agents ?? []).find((row) => row.id === id) ?? null;
  // The shell — header, pane, composer — is on the page only once there is an
  // agent to name in it. Until then this screen is a spinner, and the effects
  // that measure the shell have nothing to measure.
  const ready = Boolean(agents && agent);
  const { jobs } = useManagedJobs({ agentId: id, active: !picking && ready, working: turn.working });

  /**
   * Whether each of this screen's two reads is late enough to draw a wait for,
   * and has been drawn long enough that clearing it is not a blink (note
   * #287). They are counted separately because they ARE separate reads: on a
   * cold load the fleet read and the transcript's race each other, and the
   * pane's wait — started while this screen was still nothing but a shell
   * skeleton — carries straight on into the real pane when the transcript is
   * the one that loses.
   */
  const shellWait = useWait(!agents);
  const transcriptPending = rows.length === 0 && !answered && !failed;
  const paneWait = useWait(transcriptPending);
  /**
   * Whether the wait may hold room for a CONVERSATION, rather than only for
   * the screen around one. A shell, a pane and a composer are on every chat
   * ever drawn; turns are not — an agent nobody has spoken to answers with
   * "Nothing here yet — say hello", and a held conversation over that would
   * have promised the one thing the reader came for and then taken it away.
   * The fleet row already knows: an agent's own last words, or the stamp its
   * first turn left. A screen whose fleet read is still out knows neither,
   * and holds the turns — a chat opened cold, from a link or a reload, is one
   * somebody has been having.
   */
  const spoken = !agent || Boolean(agent.lastReply || agent.lastActiveAt);

  // Refs are written after render, never during it.
  useEffect(() => {
    rowsRef.current = rows;
    stoppingRef.current = stopping;
    nameRef.current = agent?.name ?? '';
  });

  // Whatever a read teaches belongs to this conversation even when the reader
  // has already moved on: the rows still make its next open warm.
  useEffect(() => { transcripts.write(id, rows); }, [id, rows, transcripts]);
  // Rows on the page are the record of the sends they answer: the outbox can
  // forget those now, and a message queued behind one that was unsure goes.
  useEffect(() => { outbox.claim(id, rows); }, [id, outbox, rows]);

  useEffect(() => () => {
    alive.current = false;
    clearTimeout(entrance.current);
    clearTimeout(poll.current);
  }, []);

  // The stylesheet keys the whole shell on this: the page gives up its
  // padding, its scroll and its document height, so the conversation can be
  // exactly as tall as the viewport and the transcript can own the only
  // scroller.
  //
  // In the LAYOUT phase, and BEFORE every effect that places the reader:
  // both the line a leaf gives back and the line a Back returns to are put
  // back in that same phase, and a pane inside a page with no bounded height
  // has no scroll to put anything back into — the assignment is clamped to
  // zero and the reader lands at the top of the conversation.
  useLayoutEffect(() => {
    if (picking) return;
    document.body.classList.add('agent-chat-open');
    return () => { document.body.classList.remove('agent-chat-open'); };
  }, [picking]);

  /**
   * The live row's entrance (note #178). It rises the way a message does
   * rather than blinking on — and when it would land in the same frame as
   * rows that are still rising, above all the reader's own send, it waits for
   * them to settle. The sequence is the point: the message goes, and THEN the
   * agent picks it up. Nothing waits when there is nothing to wait for, and a
   * poll every three seconds must not restart the entrance mid-turn.
   */
  const showLive = useCallback((afterArrivals: boolean) => {
    if (entrance.current) return;
    const settle = afterArrivals && !reducedMotion() ? CHAT_ARRIVE_MS : 0;
    const reveal = () => {
      entrance.current = undefined;
      if (!alive.current) return;
      // The layout effect follows it once it is on the page — but only for a
      // reader still at the end, the only one a new row may move.
      setLiveUp(true);
    };
    if (settle) entrance.current = setTimeout(reveal, settle); else reveal();
  }, []);

  /** The live row down, and any entrance still waiting cancelled with it: a
   *  turn that ends inside that window must not flash a row for work that is
   *  already over. */
  const hideLive = useCallback(() => {
    clearTimeout(entrance.current);
    entrance.current = undefined;
    setLiveUp(false);
  }, []);

  const refresh = useCallback(async (initial: boolean): Promise<WorkspaceChatMessage[] | null> => {
    // Capture the cursor this request actually carries. A later poll may move
    // the transcript while this one is in flight, but its URL must keep asking
    // the question this read began with. A warm open has a cursor already, so
    // even the opening read is incremental.
    const held = rowsRef.current;
    const afterSeq = transcriptCursor(held);
    try {
      const answer = await api.api<WorkspaceChatAnswer>(
        `api/agents/${encodeURIComponent(id)}/chat${afterSeq ? `?after=${afterSeq}` : ''}`,
      );
      if (!alive.current) return null;
      const messages = answer.messages ?? [];
      const news = broughtArrivals(held, messages);
      const rising = !initial && news;
      // Rows on the opening read paint in place; rows after it are news
      // landing in a watched conversation and arrive with the entrance —
      // except the reader's own sends, which take the place of the bubbles
      // already standing for them (note #658).
      const settled = new Set(matchSends(outbox.list(id), messages).keys());
      setRows((current) => mergeTranscript(current, messages, !initial, settled));
      // Follow the conversation only when the reader was already at its end
      // — or is opening it, which ends at the newest message by definition.
      // Asked for here, carried out once the rows are on the page.
      const opening = initial && !returning.current;
      if (news && (opening || stick.current)) follow.current = opening ? 'snap' : 'smooth';
      setAnswered(true);
      // Whatever the last read could not do, this one did.
      setFailed('');
      // The ring rides the same read as the rows: the header and the
      // transcript must not be two requests that can disagree about one agent.
      // Only a CHANGE is written: a poll that brought nothing new must not
      // re-render the transcript beneath it every three seconds.
      const nextContext = answer.context ?? null;
      setContext((held) => (sameContext(held, nextContext) ? held : nextContext));
      const nextTurn = { working: answer.working, preparing: Boolean(answer.preparing), activity: answer.activity ?? '' };
      outbox.noteRebuilding(id, nextTurn.preparing);
      setTurn((held) => (
        held.working === nextTurn.working && held.preparing === nextTurn.preparing && held.activity === nextTurn.activity
          ? held
          : nextTurn
      ));
      // The typing bubble rides the working state — and the rebuild a send is
      // waiting on (note #658), which is the agent getting to it too —
      // except mid-Stop, when the row holds its own truth until the answer
      // comes back.
      if (!stoppingRef.current) {
        if (answer.working || answer.preparing) showLive(rising); else hideLive();
      }
      // Only a SUCCESSFUL opening read clears the queue on Home: reaching the
      // screen is not enough if the transcript itself failed.
      if (initial) await markAgentNotificationsRead(id);
      return messages;
    } catch (error) {
      if (!alive.current) return null;
      // A poll that fails is silence, like the live tick's; the opening read
      // owes the reader the reason the screen is empty.
      if (initial) banner.show(errorMessage(error));
      // Silence is only affordable while there is a transcript on the page to
      // go on reading. With the pane EMPTY it draws nothing at all, which is
      // the one thing a reader cannot tell apart from a read still in flight —
      // so the failure stands IN the pane, with its reason, until a later read
      // succeeds. A banner cannot do this job: it fades, and every poll after
      // the opening one is deliberately quiet.
      if (!rowsRef.current.length) setFailed(errorMessage(error));
      return null;
    }
  }, [api, banner, hideLive, id, markAgentNotificationsRead, outbox, showLive]);

  /** The failure's own way out. A read is already on its way every few
   *  seconds, so this is not the only thing that can recover the pane — it is
   *  what lets the reader stop waiting on it. `initial` is the truth about
   *  this read: it is an opening read, so it may toast, and its success is
   *  what earns the notification queue being cleared. */
  const retry = useCallback(() => {
    setFailed('');
    void refreshRef.current(true);
  }, []);

  useEffect(() => { refreshRef.current = refresh; });

  const schedule = useCallback(() => {
    clearTimeout(poll.current);
    if (document.hidden) return;
    poll.current = setTimeout(() => {
      void refreshRef.current(false).then(() => { if (alive.current) schedule(); });
    }, CHAT_POLL_MS);
  }, []);

  // Open: one read at this conversation's end, then the poll. A leaf on top
  // suspends both without touching the transcript standing behind it.
  useEffect(() => {
    if (picking) { clearTimeout(poll.current); return; }
    const first = !opened.current;
    opened.current = true;
    // Where the reader stands as the read goes out: at the end of an empty
    // or short page, or on the line a return put them on.
    stick.current = nearBottom(pane.current);
    void Promise.resolve()
      .then(() => refreshRef.current(first))
      .then(() => { if (alive.current) schedule(); });
    const onVisibility = () => {
      clearTimeout(poll.current);
      // Coming back is a catch-up, not a wait.
      if (!document.hidden) void refreshRef.current(false).then(() => { if (alive.current) schedule(); });
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(poll.current);
    };
  }, [id, picking, schedule]);

  // The follow, once the rows it was asked for are on the page — and the
  // live row's own entrance, which lands under the fold otherwise. Runs
  // after `ScrollMemory` has placed the entry, so an opened conversation ends
  // at its newest message whatever that placed it at.
  //
  // NOT before the pane exists. The transcript read and the state read that
  // names the agent go out together, and on a cold load the transcript wins
  // more often than not — it is one storage read against a dozen. The rows
  // are then held while this screen is still a spinner, and a follow consumed
  // here would be spent on a pane that is not on the page: the conversation
  // would open at its FIRST message, and a picture landing later would drag
  // it to the end (note #302). So the follow waits, and runs once the shell
  // is up.
  useLayoutEffect(() => {
    if (!pane.current) return;
    const rose = liveUp && !liveWas.current;
    liveWas.current = liveUp;
    // A conversation the reader is coming BACK to is put on their own line
    // instead, once it has the rows that line was measured against.
    if (restore.current !== null) {
      if (!rows.length) return;
      pane.current.scrollTop = restore.current;
      restore.current = null;
      follow.current = null;
      return;
    }
    const want = follow.current ?? (rose && stick.current ? 'smooth' : null);
    follow.current = null;
    if (!want) return;
    scrollToBottom(pane.current, want === 'smooth');
    if (want !== 'snap') return;
    /**
     * A pane the shell has not BOUNDED yet cannot scroll: its box is its own
     * content, so the write above has nowhere to go and clamps to 0 — and on
     * a cold load nothing ever asks again. The transcript is already whole,
     * so this effect does not run a second time, and the pane's later change
     * of height is the ResizeObserver's FIRST delivery, which is skipped
     * precisely so a conversation returned to keeps its line.
     *
     * The reader then lands at the TOP of a long conversation — on a refresh
     * or a pasted chat link, about one open in three (note #278's own Chrome
     * harness, `a reloaded chat opens at its newest message too`).
     *
     * So an OPENING snap holds until it takes. It costs a few frames on a
     * conversation short enough not to scroll at all, it never touches the
     * smooth follow a live row asks for, and it stops the moment the pane
     * can scroll or the reader moves away from the end themselves.
     */
    let frames = 0;
    let queued = requestAnimationFrame(function settle() {
      const node = pane.current;
      if (!node || !stick.current) return;
      if (!nearBottom(node)) scrollToBottom(node);
      frames += 1;
      queued = frames < SNAP_SETTLE_FRAMES ? requestAnimationFrame(settle) : 0;
    });
    return () => cancelAnimationFrame(queued);
  }, [rows, liveUp, ready, pending]);

  // What the reader is doing right now, sampled as they scroll — and the line
  // they are on, kept for the Back that brings them here again.
  //
  // Not every scroll is the reader's. When the pane changes size under them —
  // a keyboard, a draft grown to five lines — the browser adjusts the offset
  // to keep the words they were reading in place, and reports that as a
  // scroll like any other. It happens to read as "a long way from the newest
  // message", which is exactly the wrong thing to conclude about someone who
  // was pinned to it: they never moved, the bottom did. So a scroll arriving
  // with the pane a different height than the last one is recorded but not
  // read; the next one, at a settled height, is the reader speaking again.
  useEffect(() => {
    const scroller = pane.current;
    if (!scroller) return;
    let height = scroller.clientHeight;
    const onScroll = () => {
      const now = scroller.clientHeight;
      if (now === height) {
        stick.current = nearBottom(scroller);
        readChatJump(jumpAnchor.current, scroller);
      }
      height = now;
      rememberPaneScroll(location.key, scroller.scrollTop);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [location.key, ready]);

  // The transient leaf covers this screen; the transcript and any unsent
  // draft stay standing behind it, and the reader returns to their own line.
  // Not before the persistent header the leaf brought out has gone again: it
  // is a row of the shell's own column while it stands there, and the pane
  // the line is being put back into is that much shorter for it.
  useLayoutEffect(() => {
    if (picking || back.claimed || parked.current === null) return;
    if (pane.current) pane.current.scrollTop = parked.current;
    parked.current = null;
  }, [picking, back.claimed]);

  const screen = useChatViewport(!picking && ready, pane, stick);
  // The owner's phone, recorded (see keyboard-trace.ts). Off unless asked.
  useKeyboardTrace(screen, pane, !picking && ready && keyboardTraceWanted(location.search));

  // The jobs strip is optional furniture above the transcript. When it
  // arrives or leaves it changes the pane's height without a viewport event;
  // carry a following reader to the new end and, through that scroll, let the
  // viewport hook learn the pane's new height before the next keyboard move.
  useLayoutEffect(() => {
    const visible = jobs.length > 0;
    if (visible === jobsWereVisible.current) return;
    jobsWereVisible.current = visible;
    if (stick.current) scrollToBottom(pane.current);
  }, [jobs.length]);

  /**
   * Send: the message is in the conversation NOW (note #658). The outbox
   * takes it, its bubble stands at the end of the transcript, and the box
   * empties in the same event — whatever the server then takes to put it on
   * the record, which is the whole of a machine rebuild when the agent's
   * machine has gone. Sending is reading the end, so the reader follows it
   * down — at once (note #764): the bubble's own rise is the motion, and a
   * smooth scroll under it started the message below the fold and slid it
   * in over the next frames.
   */
  const send = useCallback((message: string, files: File[]): boolean => {
    stick.current = true;
    follow.current = 'now';
    outbox.send(id, { text: message, files, after: transcriptCursor(rowsRef.current) });
    return true;
  }, [id, outbox]);

  const giveBack = useCallback(
    (take: (draft: ReturnedDraft) => void) => outbox.takeReturned(id, take),
    [id, outbox],
  );

  // A send the server has answered is on the record: read it now rather
  // than at the next poll, so its bubble becomes its row at once. The read
  // runs after the answer, so an answered send it does NOT bring never will
  // be brought — a row written differently than it was sent — and its bubble
  // stands down rather than beside the row for the outbox's whole grace.
  const delivered = outgoing
    .filter((message) => message.state === 'sent' || message.state === 'unsure')
    .map((message) => message.id)
    .join(' ');
  useEffect(() => {
    if (!delivered) return;
    stick.current = true;
    const ids = delivered.split(' ');
    void refreshRef.current(false).then((brought) => {
      if (Array.isArray(brought)) outbox.settle(id, ids, brought);
    });
  }, [delivered, id, outbox]);

  /**
   * Stop the running turn. The answer is honest either way, and WHERE it
   * lands differs deliberately: a turn that really stopped is answered by the
   * transcript itself, in the row the stop appends. Only the turn that was
   * already over gets a toast, because nothing else on the screen will say so
   * — and printing the fact twice reads as a rendering fault. Here it reads
   * worse than that: a toast is full-bleed along the BOTTOM, which on this
   * screen is the composer it would cover.
   */
  const stop = useCallback(async () => {
    setStopping(true);
    try {
      const answer = await api.api<WorkspaceAgentStopAnswer>(
        `api/agents/${encodeURIComponent(id)}/stop`,
        jsonBody({}),
      );
      if (!answer.stopped) banner.show(`${answer.name || nameRef.current || 'It'} had already finished.`, true);
      await refreshRef.current(false);
    } catch (error) {
      banner.show(errorMessage(error));
    } finally {
      if (alive.current) { setStopping(false); hideLive(); }
    }
  }, [api, banner, hideLive, id]);

  const openFile = useCallback(async (file: WorkspaceChatFile) => {
    try {
      const access = await api.api<WorkspaceChatFileAccessAnswer>(
        `api/agents/${encodeURIComponent(id)}/chat/files/${encodeURIComponent(file.id)}`,
      );
      // Not the picture path any more (note #294): a picture on screen opens
      // in the shared full-screen viewer, which the row does itself off the
      // URL it already has. What reaches here is everything else — a
      // document, an archive, a picture whose bytes never arrived, and the
      // viewer's own Download on a picture that did (note #552) — and it is
      // SAVED, under a URL minted at the tap because one minted at paint
      // could be dead by now. Saved through an anchor and not a new window:
      // by the time this URL exists the tap is over, and Safari refuses a
      // window opened after it in silence — which is how a tap on an
      // archive an agent sent came to do nothing at all.
      if (access?.url) saveFile(access.url, access.fileName || file.fileName);
    } catch (error) {
      banner.show(errorMessage(error));
    }
  }, [api, banner, id]);

  // Held, not written inline on every row: the rows are memoised on exactly
  // these, and an inline lambda is a new one per render.
  const openProposal = useCallback((open: { pr?: string; kp?: string }) => {
    navigate(toFor(open.pr ? { kind: 'pr', id: open.pr } : { kind: 'knowledge', id: open.kp! })!);
  }, [navigate]);
  const openFileRow = useCallback((file: WorkspaceChatFile) => { void openFile(file); }, [openFile]);
  // A picture of unknown size growing into the flow at the end of the
  // conversation has to carry a following reader with it; a framed one
  // (note #302) changes nothing and asks for nothing.
  const pictureLoaded = useCallback(() => { if (stick.current) scrollToBottom(pane.current); }, []);

  // The way back down (note #334): to the newest message, following it again
  // from there. The button goes at once rather than when the scroll lands —
  // a smooth scroll takes a few frames, and a button that stayed for them
  // would look like a tap that did nothing.
  const jump = useCallback(() => {
    stick.current = true;
    jumpToNewest(jumpAnchor.current, pane.current);
  }, []);

  const runtimeWritten = useCallback((result: WorkspaceAgentRuntimeAnswer) => {
    // The pinned header above the transcript names the model, and now marks
    // one of them, so it is corrected from the server's answer straight away;
    // the read that follows confirms it and brings everything else with it.
    patchAgentRuntime(id, { model: result.model, effort: result.effort });
    void reload().catch(() => { /* the next state read confirms the same values */ });
  }, [id, patchAgentRuntime, reload]);

  const goBack = () => {
    if (back.handle()) return;
    returnToParent();
  };

  // The fleet read is still out, so there is no name to pin and no agent to
  // send to: the whole screen is the wait, and it is drawn as the shape of a
  // chat rather than as a turning ring in an empty rectangle (note #309).
  // Nothing at all until the read is plainly late — a fleet already in memory
  // paints the real screen in the same frame, and a wait seen only as it
  // leaves is the flicker note #287 asked us to stop drawing.
  if (!agents) {
    return (
      <div className="screen" id="screenAgentChat" aria-busy="true">
        {shellWait === 'drawn'
          ? (
            <>
              <span className="sr-only" role="status">Loading this conversation…</span>
              <ChatShellWait turns={spoken} onBack={goBack} />
            </>
          )
          : null}
      </div>
    );
  }
  if (!agent) {
    return (
      <div className="screen" id="screenAgentChat">
        <div className="card authpanel" role="alert">
          <h2>That conversation is not here</h2>
          <div className="authsub">The agent may have been deleted, or it belongs to another workspace.</div>
          <button className="btn primary" type="button" onClick={() => navigate(overviewTo(workspace?.org?.orgId, { half: 'agents' }))}>Back to your agents</button>
        </div>
      </div>
    );
  }

  const runtime = agentRuntimeLine(agent);
  // The header named the room this agent worked in (note #657) until rooms
  // left the product (note #843): the chip under the name is gone.
  const details = toFor({ kind: 'agent', id })!;
  const fill = context ?? agent.context ?? null;
  let lastDay = '';

  // The leaf stands over the screen rather than replacing it: the transcript
  // and the unsent draft stay MOUNTED behind it, hidden, so the reader comes
  // back to both. The chat's own header is hidden with them, and the
  // persistent one comes out for exactly this — a claimed leaf over a screen
  // that carries no header of its own (`PageHead`) — so the leaf draws
  // itself and inherits the same Back every other leaf has.
  return (
    <>
    {picking ? <RuntimePicker agent={agent} onClose={() => setPicking(false)} onWritten={runtimeWritten} /> : null}
    <div className="screen" id="screenAgentChat" ref={screen} hidden={picking} onPointerDown={blurBoxOnInertTap}>
      <div className="chathead">
        <button className="back" type="button" onClick={goBack}><Svg name="back" size={20} />Back</button>
        {/* Who is answering — and, since note #439, the door to everything
            ABOUT them: the agent's own screen, with its machine, its
            subscription and its recap. The header was the one place in a
            conversation that names the agent and the only way onto that
            screen was Back, which is a guess about what is underneath rather
            than a door with a destination.

            Face and name are two anchors onto one screen rather than one
            wrapping both, because the runtime line under the name is a
            button and a button inside a link is neither valid nor pressable.
            The name's anchor wraps the h1 rather than sitting inside it: the
            crown rules key on `h1 > .crown`, and a link in between would put
            an ellipsis through the mark they exist to protect. */}
        <Link className="chatface" id="agentChatFace" to={details} draggable={false} tabIndex={-1} aria-hidden="true">
          <ContextRing context={fill}><AgentFace agent={agent} /></ContextRing>
        </Link>
        <div className="chatwho">
          {/* One door in the accessibility tree, not two: the face carries a
              decorative picture and repeats the name beside it, so it is the
              copy that steps out of the reading order. */}
          <Link
            className="chatnamedoor"
            to={details}
            draggable={false}
            aria-label={`${agent.name}: open agent details`}
          >
            <h1 id="agentChatTitle"><AgentName agent={agent} /></h1>
          </Link>
          {/* The @handle that used to stand here was the name a second time,
              and a workspace-native agent has none. What a reader of a
              conversation wants to know is who is answering and with what —
              and that same line is the door to changing it. */}
          <button
            className="sub chatruntime"
            id="agentChatStatus"
            type="button"
            aria-label={`Change model and effort. Current: ${runtime}`}
            onClick={() => { parked.current = pane.current?.scrollTop ?? 0; setPicking(true); }}
          >
            <span>{runtime}</span>
          </button>
        </div>
        <RadioButton />
      </div>

      {/* The row is the band under the header; the door is the pill centred
          in it (note #603), so it reads as something to press rather than as
          a second title line. */}
      {jobs.length ? (
        <div className="chatjobsrow" id="agentChatJobsRow">
          <button
            className="chatjobs"
            id="agentChatJobs"
            type="button"
            aria-label={`${jobs.length} background ${jobs.length === 1 ? 'job' : 'jobs'}. Open details`}
            aria-live="polite"
            onClick={() => navigate(toFor({ kind: 'agentJobs', id })!)}
          >
            <span className="chatjobdot" aria-hidden="true" />
            <span className="chatjobcount">{jobs.length} background {jobs.length === 1 ? 'job' : 'jobs'}</span>
            <Svg name="chev" size={14} />
          </button>
        </div>
      ) : null}

      {/* The one scroller on this screen: everything the reader reads, and
          nothing they act with. The header above it and the composer below
          it are the shell's own furniture and stay put (note #278). */}
      <div className="chatpane" id="agentChatScroll" ref={pane}>
        {/* The conversation's pictures, in order, for the viewer to step
            through (note #544): the rows write into it as they paint. */}
        <ChatGalleryProvider>
        <div id="agentChatLog" aria-busy={transcriptPending || undefined}>
          {/* An empty pane is four different things, and it used to draw the
              same nothing for all of them (note #301): a read in flight, a
              read that failed, a conversation with nothing in it, and rows.
              Only the third ever said so, so a chat that could not load was
              indistinguishable from one still loading — for as long as the
              reader cared to wait. Each state says which it is; `rows.map`
              over an empty list draws nothing, so they cannot overlap.

              The read in flight says it in the shape of the thing it is
              fetching now (note #309): held turns, in the boxes the real ones
              will stand in, once the read is late enough to be worth drawing
              at all. */}
          {transcriptPending && paneWait === 'drawn'
            ? (
              <>
                <span className="sr-only" role="status">Loading this conversation…</span>
                {spoken ? <ChatWaitTurns /> : null}
              </>
            )
            : null}
          {rows.length === 0 && failed
            ? (
              <div className="chatempty" id="agentChatFailed" role="alert">
                This conversation could not be loaded.
                <div className="chatemptyhint">{failed}</div>
                <button className="btn chatretry" type="button" onClick={retry}>Try again</button>
              </div>
            )
            : null}
          {rows.length === 0 && pending.length === 0 && answered && !failed
            ? (
              <div className="chatempty">
                Nothing here yet — say hello.
                <div className="chatemptyhint">Answers land here.</div>
                {/* A first job to tap rather than invent (the owner,
                    2026-10-08, from note #188): the newcomer's first act
                    here is a tap, and the agent asks for whatever it needs. */}
                <div className="chatstarters" id="chatStarters">
                  {CHAT_STARTERS.map((starter) => (
                    <button className="btn chatstarter" type="button" key={starter} onClick={() => { send(starter, []); }}>{starter}</button>
                  ))}
                </div>
              </div>
            )
            : null}
          {rows.map((row) => {
            // A message from a new day stands a divider first. Dividers ride
            // the rows rather than the paint, so a poll's rows get theirs too.
            const day = row.at ? new Date(row.at).toDateString() : lastDay;
            const divider = row.at && day !== lastDay ? chatDayLabel(row.at) : '';
            if (divider) lastDay = day;
            return (
              <Fragment key={row.seq}>
                {divider ? <div className={row.arriving ? 'chatday arriving' : 'chatday'}>{divider}</div> : null}
                <ChatMessageRow
                  row={row}
                  agentId={agent.id}
                  workspaceLinks
                  onOpenProposal={openProposal}
                  onOpenFile={openFileRow}
                  onPictureLoaded={pictureLoaded}
                />
              </Fragment>
            );
          })}
          {/* What the reader has sent that is not on the record yet (note
              #658): after every row, in the order it was written. */}
          {pending.map((message) => <OutgoingMessageRow key={message.id} message={message} />)}
        </div>
        </ChatGalleryProvider>

        {/* Visible only while a turn runs: the typing bubble carries the newest
            tool line, and Stop keeps the bot chat's contract — the in-flight
            step is dropped, the conversation and the disk keep everything else,
            and the next message resumes. */}
        <div className={liveUp ? 'chatlive arriving' : 'chatlive'} id="agentChatLive" hidden={!liveUp}>
          <div className="chatmsg agent">
            <span className="tdots"><i /><i /><i /></span>
            <span className="activity" id="agentChatActivity">
              {turn.activity || (turn.working
                ? `${agent.name} is working`
                : turn.preparing ? `Getting ${agent.name}’s machine ready` : '')}
            </span>
          </div>
          {/* Nothing to stop while the machine is still being built for the
              turn: the turn has not started, and a Stop there would only be
              told it had already finished. */}
          {turn.preparing && !turn.working ? null : (
            <button
              className="chatstop"
              id="agentChatStop"
              type="button"
              aria-label={stopping ? 'Stopping…' : 'Stop'}
              aria-busy={stopping || undefined}
              disabled={stopping}
              data-stopping={stopping ? '1' : undefined}
              onClick={() => { void stop(); }}
            >
              <Svg name="stop" size={18} />
            </button>
          )}
        </div>

        <ChatJump anchor={jumpAnchor} id="agentChatJump" onJump={jump} />
      </div>

      <ChatComposer onSend={send} giveBack={giveBack} onRefuse={(reason) => banner.show(reason)} memory={agentDraftKey(id)} lead={<AgentSwitch currentId={id} />} />
    </div>
    </>
  );
}
