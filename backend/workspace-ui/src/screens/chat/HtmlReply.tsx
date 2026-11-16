/**
 * The Chief of Staff's reply when it is HTML (note #1186).
 *
 * Adam, 16 Nov 2026: the Chief of Staff answers in interactive HTML, not
 * Markdown, and what the person taps or fills in goes back to it as their
 * answer — in the Chief of Staff's chat only ("chief of staff only,
 * actually"). Every other agent's chat keeps Markdown.
 *
 * Two ways to draw one, chosen by what the HTML asks for:
 *
 *  - WORDS (headings, paragraphs, lists, tables, links, a drawing): built by
 *    the Workspace's own allowlisted renderer, the one a knowledge page and a
 *    note are drawn with. No script, no style, no frame; it reads in the
 *    chat's type and costs nothing.
 *  - ANYTHING THAT RUNS OR ASKS (script, style, a form, a button, a
 *    `data-reply`): the locked frame served at /workspace/reply-frame — see
 *    backend/src/routes/reply-frame.ts for why it is two frames and what each
 *    refuses. This component is the third wall: it listens only to ITS
 *    frame, takes one answer per reply and only while the reply is live, and
 *    opens only links that were in the HTML as written.
 *
 * A link to a Workspace screen (`/workspace/notes/12?org=…`, the path a
 * command printed) opens inside the Workspace from either way of drawing.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { htmlReplyNeedsFrame, type HtmlReplyAnswerState } from '../../../../src/shared/agent-html.js';
import { KnowledgeHtml } from '../../render/KnowledgeHtml.js';
import { workspaceLinkTo } from '../../render/Markdown.js';
import type { NoteRefs } from '../../render/note-refs.js';
import { plainClick } from '../../ui/link-click.js';
import { linksAsWritten, REPLY_FRAME_SRC } from './html-reply-links.js';

/** What a frame stands at before it has said its height, and the most it
 *  may ask for. */
const FRAME_START_PX = 48;
const FRAME_MAX_PX = 20_000;
/** How far below the fold a frame is built before it is scrolled to. */
const FRAME_NEAR_MARGIN = '1200px 0px';

/** Each reply's last measured height, so a frame built again (the screen
 *  left and came back) reserves its place instead of growing into it. */
const heights = new Map<string, number>();

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

/** Built once the reply is near the screen, and kept from then on. */
function useNear(margin: string): [(node: HTMLDivElement | null) => void, boolean] {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  const observer = useRef<IntersectionObserver | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node || near || typeof IntersectionObserver === 'undefined') return;
    observer.current = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setNear(true); observer.current?.disconnect(); }
    }, { rootMargin: margin });
    observer.current.observe(node);
  }, [margin, near]);
  return [ref, near];
}

function HtmlFrame({ source, replyKey, state, onAnswer }: {
  source: string;
  replyKey: string;
  state: HtmlReplyAnswerState;
  onAnswer?: (text: string) => void;
}) {
  const navigate = useNavigate();
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(() => heights.get(replyKey) ?? FRAME_START_PX);
  const [nearRef, near] = useNear(FRAME_NEAR_MARGIN);
  const links = useMemo(() => linksAsWritten(source), [source]);
  // Read by the listener, which is attached once per frame.
  const live = useRef({ state, onAnswer, answered: state !== 'live' });
  useLayoutEffect(() => {
    live.current.state = state;
    live.current.onAnswer = onAnswer;
    if (state !== 'live') live.current.answered = true;
  }, [state, onAnswer]);

  useEffect(() => {
    if (!near) return;
    const onMessage = (event: MessageEvent) => {
      const own = frame.current?.contentWindow;
      if (!own || event.source !== own) return;
      const data: unknown = event.data;
      if (!data || typeof data !== 'object') return;
      const message = data as { t?: unknown; h?: unknown; text?: unknown; href?: unknown };
      if (message.t === 'ready') {
        own.postMessage({ t: 'show', html: source, state: live.current.state, title: 'Reply from the Chief of Staff' }, '*');
      } else if (message.t === 'h' && typeof message.h === 'number' && Number.isFinite(message.h)) {
        const next = Math.max(0, Math.min(FRAME_MAX_PX, Math.ceil(message.h)));
        heights.set(replyKey, next);
        setHeight(next);
      } else if (message.t === 'reply' && typeof message.text === 'string') {
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
  }, [near, source, replyKey, links, navigate]);

  // An answer sent, or a newer reply arrived: the frame's controls lock.
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ t: 'state', state }, '*');
  }, [state]);

  return (
    <div className={`chathtml chathtmlframe${state === 'live' ? '' : ` ${state}`}`} ref={nearRef} style={{ height }}>
      {near ? (
        <iframe
          ref={frame}
          src={REPLY_FRAME_SRC}
          title="Reply from the Chief of Staff"
          sandbox="allow-scripts allow-forms"
          referrerPolicy="no-referrer"
          loading="eager"
          style={{ height }}
        />
      ) : null}
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
  if (!htmlReplyNeedsFrame(source)) return <HtmlWords source={source} notes={notes} />;
  return <HtmlFrame source={source} replyKey={`${seq}:${source.length}`} state={state} onAnswer={onAnswer ? answer : undefined} />;
});
