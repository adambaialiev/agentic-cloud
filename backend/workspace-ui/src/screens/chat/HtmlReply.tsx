/**
 * An agent's reply when it is HTML (notes #1186, #1191, #1193).
 *
 * Adam, 16 Nov 2026: the Chief of Staff answers in interactive HTML, and
 * what the person taps or fills in goes back to it as their answer; 18 Nov,
 * every agent may. Then, the same day, with a screenshot of one reply drawn
 * in three layers (four paragraphs set by the Workspace, a card with two
 * buttons and one stray sentence, a recap repeating both): "let's show agent
 * generated interactive html only" (note #1193). So a reply is ONE surface,
 * drawn whole as the agent laid it out. Nothing is lifted out of it and set
 * beside it any more.
 *
 * Two ways to draw one, chosen by what the WHOLE reply asks for:
 *
 *  - WORDS (headings, paragraphs, lists, tables, links, a drawing, and no
 *    style, script or control anywhere): built by the Workspace's own
 *    allowlisted renderer, the one a knowledge page and a note are drawn
 *    with. No frame, so it reads in the chat's type, selects and searches
 *    with the page, and costs nothing. It looks as the agent wrote it,
 *    because words are all it wrote.
 *  - ANYTHING THAT STYLES ITSELF, RUNS OR ASKS (style, script, a form, a
 *    button, a `data-reply`): the whole reply, opening words included, in
 *    the locked frame served at /workspace/reply-frame — see
 *    backend/src/routes/reply-frame.ts for why it is two frames and what
 *    each refuses. This component is the third wall: it listens only to ITS
 *    frame, takes one answer per reply and only while the reply is live, and
 *    opens only links that were in the HTML as written.
 *
 * The frame always sits in a card the Workspace draws (note #1188), and that
 * card is the safety line of this redesign, not decoration. Everything an
 * agent can style is inside its border, on every side and at every scroll
 * position; everything that is the platform's (a proposal card, the Send
 * email confirmation, a stopped or fresh-chat line, an attached file, the
 * person's own bubble) is drawn outside any such card. An agent reads mail
 * and web pages strangers wrote, so its HTML is a stranger's: it may draw
 * what it likes, and it cannot draw it where the platform speaks.
 *
 * A link to a Workspace screen (`/workspace/notes/12?org=…`, the path a
 * command printed) opens inside the Workspace from either way of drawing.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { flushSync } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { htmlReplyNeedsFrame, htmlReplyParts, replyOpening, type HtmlReplyAnswerState } from '../../../../src/shared/agent-html.js';
import { KnowledgeHtml } from '../../render/KnowledgeHtml.js';
import { Markdown, workspaceLinkTo } from '../../render/Markdown.js';
import type { NoteRefs } from '../../render/note-refs.js';
import { plainClick } from '../../ui/link-click.js';
import { htmlUiKey, isHtmlUiClosed, linksAsWritten, rememberedFrameHeight, rememberFrameHeight, REPLY_FRAME_SRC, setHtmlUiClosed } from './html-reply-links.js';
import { Svg } from '../../ui/icons.js';
import { jsonBody } from '../../api/client.js';
import { useSession } from '../../session/useSession.js';

/** What a frame stands at before it has said its height, and the most it
 *  may ask for. */
const FRAME_START_PX = 48;
const FRAME_MAX_PX = 20_000;
/** How far below the fold a frame is built before it is scrolled to. */
const FRAME_NEAR_MARGIN = '1200px 0px';
/** How far from the screen a frame nobody touched is let go again (note
 *  #1193): since every reply may be a frame, a long conversation read to its
 *  top would otherwise keep two documents alive per reply, on a phone. */
const FRAME_FAR_MARGIN = '6000px 0px';

/** The Workspace path a link in a reply leads to, or null when it leaves. */
function workspacePathOf(href: string): string | null {
  let url: URL;
  try { url = new URL(href, window.location.origin); } catch { return null; }
  if (url.origin !== window.location.origin) return null;
  return workspaceLinkTo(`${url.pathname}${url.search}`);
}

function openLink(href: string, navigate: (to: string) => void): void {
  const inside = workspacePathOf(href);
  if (inside) { navigate(inside); return; }
  let url: URL;
  try { url = new URL(href); } catch { return; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'mailto:') return;
  window.open(url.href, '_blank', 'noopener,noreferrer');
}

/** Words only: the allowlisted renderer, with Workspace links kept inside. */
function HtmlWords({ source, notes }: { source: string; notes: NoteRefs }) {
  const navigate = useNavigate();
  const onClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const link = (event.target as Element | null)?.closest?.('a[href]');
    if (!link || !plainClick(event.nativeEvent)) return;
    const inside = workspacePathOf(link.getAttribute('href') ?? '');
    if (!inside) return;
    event.preventDefault();
    navigate(inside);
  }, [navigate]);
  return (
    <div className="chathtml" onClickCapture={onClick}>
      <KnowledgeHtml source={source} noteRefs={notes} extraClass="chathtmlpage" />
    </div>
  );
}

/**
 * The reader's place, held while a frame above it grows (note #1193).
 *
 * Every reply above the screen is first measured as it comes near, on the
 * way up a conversation, and a frame that grows above what is being read
 * pushes the page down under the reader's thumb. Chrome kept the place by
 * itself here; Safari's engine did not, and a row moved by more than a
 * screen (measured in WebKit at phone size, 120 framed replies). So the
 * Workspace does not leave it to the browser: before a frame above the
 * screen takes a new height, a row on screen and where it stands are noted;
 * the height is then drawn at once (`flushSync`), and the pane is moved by
 * exactly what that row moved, all in the one task, so no scroll of the
 * reader's falls in between and is undone. Where the browser already held
 * the place, the row has not moved and nothing is done.
 */
interface Place { pane: HTMLElement; row: Element; top: number }

function placeOf(box: HTMLElement | null): Place | null {
  const pane = box?.closest<HTMLElement>('.chatpane');
  if (!box || !pane) return null;
  const view = pane.getBoundingClientRect();
  // Growing on screen or below it moves only what is under it, as any new
  // row does; the end of the conversation is followed by the screen itself.
  if (!view.height || box.getBoundingClientRect().top >= view.top) return null;
  // A row on screen, near its top: a few tries, because a point may fall in
  // the gap between two rows.
  for (const down of [24, 64, 104, 144, 200]) {
    if (down >= view.height) break;
    const row = document.elementFromPoint(view.left + view.width / 2, view.top + down)?.closest('.chatmsg, .chatday');
    if (row && pane.contains(row)) return { pane, row, top: row.getBoundingClientRect().top };
  }
  return null;
}

function keepPlace(place: Place): void {
  if (!place.pane.contains(place.row)) return;
  const moved = place.row.getBoundingClientRect().top - place.top;
  if (Math.abs(moved) >= 1) place.pane.scrollTop += moved;
}

/**
 * Built when the reply comes near the screen, and let go again when it is
 * far from it and `keep` says nothing would be lost (note #1193). Its place
 * is held at its last height meanwhile (`rememberedFrameHeight`), so the
 * conversation does not move, and coming near again builds it afresh.
 */
function useNear(margin: string, farMargin: string, keep: () => boolean, onFar: () => void): [(node: HTMLDivElement | null) => void, boolean] {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  const observers = useRef<IntersectionObserver[]>([]);
  const now = useRef({ keep, onFar });
  useLayoutEffect(() => { now.current = { keep, onFar }; }, [keep, onFar]);
  const ref = useCallback((node: HTMLDivElement | null) => {
    for (const observer of observers.current) observer.disconnect();
    observers.current = [];
    if (!node || typeof IntersectionObserver === 'undefined') return;
    // Against the conversation's own scrolling pane when there is one: a
    // margin on the viewport does not reach past a scroll container's clip,
    // so without it a frame was built only once it was already on screen.
    const pane = node.closest('.chatpane');
    const build = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setNear(true);
    }, { root: pane, rootMargin: margin });
    const drop = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      // A screen that is hidden (not scrolled away) intersects nothing
      // either: that is not "far", and its frames stay.
      if (!last || last.isIntersecting || node.offsetParent === null || now.current.keep()) return;
      now.current.onFar();
      setNear(false);
    }, { root: pane, rootMargin: farMargin });
    build.observe(node);
    drop.observe(node);
    observers.current = [build, drop];
  }, [margin, farMargin]);
  return [ref, near];
}

/** Note #1192: how long a frame may take before the card says so. A frame
 *  has no network to wait on, so on a working phone it shows in well under a
 *  second; past this, something is wrong and the person gets words and a
 *  way to try again rather than an empty box. Past the first, a frame that
 *  is merely slow is written down for us (`api/reply-frame/timing`). */
const FRAME_GIVE_UP_MS = 8_000;
const FRAME_SLOW_MS = 2_500;

type FramePhase = 'loading' | 'shown' | 'failed';

/** How the frame document's own fetch went, as the browser timed it. */
function frameFetchTiming(): { fetch?: number; transfer?: number } {
  try {
    const url = new URL(REPLY_FRAME_SRC, window.location.origin).href;
    const entries = performance.getEntriesByName(url) as PerformanceResourceTiming[];
    const last = entries[entries.length - 1];
    if (!last) return {};
    return { fetch: last.duration, transfer: last.transferSize };
  } catch { return {}; }
}

function HtmlFrame({ source, state, onAnswer }: {
  source: string;
  state: HtmlReplyAnswerState;
  onAnswer?: (text: string) => void;
}) {
  const navigate = useNavigate();
  const { api } = useSession();
  const frame = useRef<HTMLIFrameElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  // Its last measured height at this screen width, kept on the device, so a
  // frame built again (the screen left and came back, the page reloaded, the
  // frame let go while far away) reserves its place instead of growing into it.
  const heightKey = useMemo(() => htmlUiKey(source), [source]);
  const [height, setHeight] = useState(() => rememberedFrameHeight(heightKey) ?? FRAME_START_PX);
  // Touched by the person (a tap, a key, focus inside): from then on the
  // frame is kept wherever the conversation scrolls, because what they typed
  // or opened in it lives nowhere else (note #1189).
  const heightNow = useRef(height);
  const touched = useRef(false);
  const keep = useCallback(() => touched.current || document.activeElement === frame.current, []);
  // Note #1192: nothing of the frame is shown until its page has said how
  // tall it is — until then the card holds a quiet placeholder, so a frame
  // the browser has not painted yet (black, on Adam's phone) is never seen.
  const [phase, setPhaseState] = useState<FramePhase>('loading');
  const phaseNow = useRef<FramePhase>('loading');
  const setPhase = useCallback((next: FramePhase) => { phaseNow.current = next; setPhaseState(next); }, []);
  // A frame let go while far away comes back loading, behind its placeholder.
  const letGo = useCallback(() => setPhase('loading'), [setPhase]);
  const [nearRef, near] = useNear(FRAME_NEAR_MARGIN, FRAME_FAR_MARGIN, keep, letGo);
  const setBox = useCallback((node: HTMLDivElement | null) => { box.current = node; nearRef(node); }, [nearRef]);
  const [attempt, setAttempt] = useState(0);
  const timing = useRef({ start: 0, loaded: -1, ready: -1, reported: false });
  const links = useMemo(() => linksAsWritten(source), [source]);
  // Read by the listener, which is attached once per frame.
  const live = useRef({ state, onAnswer, answered: state !== 'live' });
  useLayoutEffect(() => {
    live.current.state = state;
    live.current.onAnswer = onAnswer;
    if (state !== 'live') live.current.answered = true;
  }, [state, onAnswer]);

  const report = useCallback((outcome: 'slow' | 'failed', shown: number) => {
    const t = timing.current;
    if (t.reported) return;
    t.reported = true;
    const body = {
      outcome,
      attempt,
      ...(t.loaded >= 0 ? { loaded: t.loaded } : {}),
      ...(t.ready >= 0 ? { ready: t.ready } : {}),
      ...(shown >= 0 ? { shown } : {}),
      ...frameFetchTiming(),
    };
    void api.api('api/reply-frame/timing', jsonBody(body)).catch(() => { /* a report is never worth an error */ });
  }, [api, attempt]);

  // The page inside is handed its reply when the frame says it is ready —
  // and again when the frame has loaded, in case that first word arrived
  // before anyone was listening. The frame takes the first and ignores the
  // rest.
  const show = useCallback(() => {
    frame.current?.contentWindow?.postMessage({ t: 'show', html: source, state: live.current.state, title: 'Interactive reply' }, '*');
  }, [source]);

  // The clock runs per frame: from when it is put on the page (first near,
  // or Try again) — never restarted by the screen drawing again.
  const reportNow = useRef(report);
  useLayoutEffect(() => { reportNow.current = report; }, [report]);
  useEffect(() => {
    if (!near) return;
    timing.current = { start: performance.now(), loaded: -1, ready: -1, reported: false };
    const giveUp = window.setTimeout(() => {
      if (phaseNow.current !== 'loading') return;
      setPhase('failed');
      reportNow.current('failed', -1);
    }, FRAME_GIVE_UP_MS);
    return () => window.clearTimeout(giveUp);
  }, [near, attempt, setPhase]);

  useEffect(() => {
    if (!near) return;
    const since = () => Math.round(performance.now() - timing.current.start);
    const onMessage = (event: MessageEvent) => {
      const own = frame.current?.contentWindow;
      if (!own || event.source !== own) return;
      const data: unknown = event.data;
      if (!data || typeof data !== 'object') return;
      const message = data as { t?: unknown; h?: unknown; text?: unknown; href?: unknown };
      if (message.t === 'ready') {
        if (timing.current.ready < 0) timing.current.ready = since();
        show();
      } else if (message.t === 'h' && typeof message.h === 'number' && Number.isFinite(message.h)) {
        const next = Math.max(0, Math.min(FRAME_MAX_PX, Math.ceil(message.h)));
        rememberFrameHeight(heightKey, next);
        const showing = phaseNow.current !== 'shown';
        if (showing) {
          // Shown after all, late or after the card gave up: written down
          // with the step that took the time.
          const took = since();
          if (phaseNow.current === 'failed' || took > FRAME_SLOW_MS) { timing.current.reported = false; report('slow', took); }
        }
        const draw = () => { setHeight(next); if (showing) setPhase('shown'); };
        // A frame above what is being read: its new height is drawn here and
        // now, and the reader's place given back, before anything can scroll.
        const place = showing || next !== heightNow.current ? placeOf(box.current) : null;
        heightNow.current = next;
        if (place) { flushSync(draw); keepPlace(place); } else draw();
      } else if (message.t === 'touched') {
        touched.current = true;
      } else if (message.t === 'reply' && typeof message.text === 'string') {
        touched.current = true;
        // One answer per reply, and only while it is the live one: a frame
        // whose script keeps posting is heard once.
        if (live.current.answered || live.current.state !== 'live' || !live.current.onAnswer) return;
        const text = message.text.trim().slice(0, 10_000);
        if (!text) return;
        live.current.answered = true;
        live.current.onAnswer(text);
      } else if (message.t === 'open' && typeof message.href === 'string') {
        // Only an address the HTML carried as written: never one a script
        // built after the person typed something into the reply.
        if (!links.has(message.href)) return;
        openLink(message.href, navigate);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [near, show, heightKey, links, navigate, report, setPhase]);

  // Focus moving into the frame is the person touching it, whatever the page
  // inside says or does not say: the window blurs with the frame as the
  // focused element.
  useEffect(() => {
    if (!near) return;
    const onBlur = () => { if (document.activeElement === frame.current) touched.current = true; };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [near]);

  const onLoad = useCallback(() => {
    if (timing.current.loaded < 0 && timing.current.start) timing.current.loaded = Math.round(performance.now() - timing.current.start);
    show();
  }, [show]);

  const retry = useCallback(() => {
    setPhase('loading');
    setAttempt((n) => n + 1);
  }, [setPhase]);

  // An answer sent, or a newer reply arrived: the frame's controls lock.
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ t: 'state', state }, '*');
  }, [state]);

  const shown = phase === 'shown';
  return (
    <div
      className={`chathtml chathtmlframe${state === 'live' ? '' : ` ${state}`}${shown ? '' : ' waiting'}`}
      ref={setBox}
      style={shown ? { height } : { minHeight: height }}
      aria-busy={phase === 'loading' ? true : undefined}
    >
      {phase === 'loading' ? (
        <div className="chathtmlwait" role="status">
          <span className="chathtmlbar" /><span className="chathtmlbar short" />
          <span className="sr-only">Loading the rest of this reply</span>
        </div>
      ) : null}
      {phase === 'failed' ? (
        <div className="chathtmlfailed" role="alert">
          <span>This part of the reply did not load.</span>
          <button type="button" className="chathtmlretry" onClick={retry}>Try again</button>
        </div>
      ) : null}
      {near ? (
        <iframe
          key={attempt}
          ref={frame}
          src={REPLY_FRAME_SRC}
          title="Interactive reply"
          sandbox="allow-scripts allow-forms"
          referrerPolicy="no-referrer"
          loading="eager"
          onLoad={onLoad}
          tabIndex={shown ? undefined : -1}
          aria-hidden={shown ? undefined : true}
          style={{ height }}
        />
      ) : null}
    </div>
  );
}

/**
 * The card a framed reply sits in (note #1188), and since note #1193 the
 * whole reply sits in it. Adam, 17 Nov 2026: "this UI should have some
 * container and a close button. And the close button just hides this UI
 * that was sent by the agent … button should be subtle". The card and its
 * close mark are the Workspace's own, outside the locked frame, so the
 * agent's page can neither fake nor cover them.
 *
 * Closing hides the reply on this device and sends nothing; since the whole
 * reply is now what closes, the quiet line left in its place says how it
 * began, and Show brings it back, still answerable. Answered and older
 * replies are cards too.
 *
 * A sentence the agent wrote BEFORE its first tag (note #1191) is not HTML,
 * so it is drawn as Markdown, at the top of the same card: one surface.
 */
function HtmlCard({ html, lead, opening, notes, state, onAnswer }: {
  html: string;
  lead: string;
  opening: string;
  notes: NoteRefs;
  state: HtmlReplyAnswerState;
  onAnswer?: (text: string) => void;
}) {
  const key = useMemo(() => htmlUiKey(`${lead}\n${html}`), [lead, html]);
  const [closed, setClosed] = useState(() => isHtmlUiClosed(key));
  const close = useCallback(() => { setHtmlUiClosed(key, true); setClosed(true); }, [key]);
  const open = useCallback(() => { setHtmlUiClosed(key, false); setClosed(false); }, [key]);
  if (closed) {
    return (
      <div className="chathtmlhidden">
        <span>Hidden</span>
        {opening ? <span className="chathtmlwas">{opening}</span> : null}
        <button type="button" className="chathtmlshow" onClick={open}>Show</button>
      </div>
    );
  }
  return (
    <div className={`chathtmlui${state === 'live' ? '' : ` ${state}`}`}>
      {lead ? <Markdown source={lead} className="chatmarkdown chathtmllead" notes={notes} workspaceLinks /> : null}
      <HtmlFrame source={html} state={state} onAnswer={onAnswer} />
      <button type="button" className="chathtmlclose" onClick={close} aria-label="Hide this" title="Hide this">
        <Svg name="x" size={14} />
      </button>
    </div>
  );
}

export const HtmlReply = memo(function HtmlReply({ source, seq, state, notes, onAnswer }: {
  source: string;
  seq: number;
  state: HtmlReplyAnswerState;
  notes: NoteRefs;
  onAnswer?: (seq: number, text: string) => void;
}) {
  const answer = useCallback((text: string) => onAnswer?.(seq, text), [onAnswer, seq]);
  const parts = useMemo(() => htmlReplyParts(source) ?? { lead: '', html: source }, [source]);
  const opening = useMemo(() => replyOpening(source, 80), [source]);
  // Words alone: the Workspace's own renderer, on the page. A Markdown
  // lead-in is only ever taken before HTML that asks, so there is none here.
  if (!htmlReplyNeedsFrame(parts.html)) return <HtmlWords source={parts.html} notes={notes} />;
  // Anything else: the whole reply, in the locked frame, in one card.
  return <HtmlCard html={parts.html} lead={parts.lead} opening={opening} notes={notes} state={state} onAnswer={onAnswer ? answer : undefined} />;
});
