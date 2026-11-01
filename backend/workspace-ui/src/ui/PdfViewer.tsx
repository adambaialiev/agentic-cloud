/**
 * The full-screen document viewer — the document half of the shared chrome
 * the picture viewer already is (note #403 for a PDF; note #557 for an HTML
 * page, which is framed by the same chrome and described at the end).
 *
 * Until this landed, a PDF in the Workspace was a name and a size, and a tap
 * on it left for the browser's own handler: the file downloaded, the reader
 * left the Workspace to look at it, and on a phone that is a trip through
 * Files and back. A PDF is the second most common thing an agent hands its
 * owner — a write-up, a report, an export — so it now opens where a
 * screenshot opens, over the chat, at the tap.
 *
 * What draws the pages is the BROWSER'S own PDF viewer, in a frame. The shell
 * ships no PDF engine and cannot: its policy is `script-src 'self'` with no
 * `unsafe-eval` and `connect-src 'self'`, so a bundled renderer could neither
 * run its own worker code the way it wants to nor fetch the bytes, which live
 * on the media host under a signed URL. `frame-src 'self' blob: https:`
 * already allows exactly this frame. What we get for free is real page
 * navigation, text selection, search, zoom, print and download — every one of
 * them better than a first attempt at our own.
 *
 * What we give up is control of what that frame looks like, and one thing
 * more: a browser whose framed PDF shows page one and refuses to scroll —
 * WebKit has drawn framed PDFs that way for years — leaves the reader stuck
 * on the first page. That is what the one control in the bar is for. It is
 * not a fallback bolted on for a failure we can detect (a cross-origin frame
 * never tells us it went wrong); it is the way out of the frame, always
 * there, on every browser.
 *
 * An HTML page (note #557) is the third thing an agent hands over that has
 * a look to it — a report written as a page, because that is the shape a
 * table-heavy write-up takes — and it used to download. It opens in this
 * same frame, with two differences. The frame is SANDBOXED: `allow-scripts`
 * without `allow-same-origin` gives the page an opaque origin, so its script
 * can draw its own charts but cannot read the media host it was served from,
 * cannot reach this page, and cannot navigate it away; `allow-popups` (with
 * `-to-escape-sandbox`) is what lets a link in a report open in a new tab,
 * which is what a link in a report is for. And there is no Open-in-a-new-tab
 * control: a browser scrolls a framed page fine, and a new tab would run the
 * page UNsandboxed on the media host's origin, which is exactly the thing the
 * sandbox is here to avoid. A Download stands in the head instead, when the
 * opener supplies one, because a page has no viewer chrome of its own to save
 * from.
 *
 * A Markdown file (note #677) is the write-up an agent hands over most — a
 * plan, a report, a set of drafts — and until that note it downloaded, to be read
 * as a wall of asterisks in whatever the phone opened it with. It opens here
 * as a PAGE: its words drawn by the Workspace's own renderer (the one Drive
 * and a repository's README already use, which builds elements and never
 * assigns markup), set in the reading type a conversation is set in, in one
 * column that scrolls. It is the one kind that is not dark around the
 * edges: the dark stage is for inspecting media, where a white document
 * glares against the page behind it, and this is not media — it is words in
 * the Workspace's own type, so it wears the Workspace's own paper, head
 * included. Same head as the others, same Download beside Close.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PdfViewerContext, type PdfViewerValue, type ViewerDocument } from './pdf-viewer-context.js';
import { pdfReadingSrc } from './pdf-src.js';
import { Markdown } from '../render/Markdown.js';
import { Svg } from './icons.js';
import { ViewerName } from './ViewerName.js';

type Open = ViewerDocument & { host?: HTMLElement };

export function PdfViewerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<Open | null>(null);
  const restore = useRef<{ scrollY: number; focus: Element | null }>({ scrollY: 0, focus: null });
  const dialog = useRef<HTMLDivElement | null>(null);
  const page = useRef<HTMLDivElement | null>(null);

  const show = useCallback((document_: ViewerDocument, host?: HTMLElement) => {
    if (document_.kind !== 'markdown' && !document_.url) return;
    restore.current = { scrollY: window.scrollY, focus: document.activeElement };
    setOpen({ ...document_, ...(host ? { host } : {}) });
  }, []);
  const close = useCallback(() => setOpen(null), []);

  // Whatever is under the viewer must not scroll with it, and must be exactly
  // where it was when this closes. Every rule here is the picture viewer's,
  // learned there and copied rather than re-derived: which surface to lock
  // depends on where this opened (note #387), the dialog takes the focus
  // instead of Close because iPhone Safari paints a ring on the button and
  // then closes on a hardware Enter, and the opener gets its focus back with
  // `preventScroll` so it does not scroll itself into view over the position
  // just restored. `image-open` is the class both wear: it is one state — a
  // viewer is up and the page under it is held — and a second name for it is
  // how two overlays end up disagreeing about where the page was.
  useEffect(() => {
    if (!open) return undefined;
    const host = open.host ?? null;
    const column = host?.querySelector<HTMLElement>('[data-scroller]') ?? null;
    const held = column?.scrollTop ?? 0;
    const scrolled = restore.current.scrollY;
    if (!host) {
      document.body.style.setProperty('--image-scroll-top', `${-scrolled}px`);
      document.body.classList.add('image-open');
    }
    // A page of words takes the focus on its own column instead, so the
    // keys a reader scrolls a page with — arrows, space, Page Down — scroll
    // it from the first press rather than after a click into it.
    (page.current ?? dialog.current)?.focus({ preventScroll: true });
    return () => {
      if (host) {
        if (column) column.scrollTop = held;
      } else {
        document.body.classList.remove('image-open');
        document.body.style.removeProperty('--image-scroll-top');
        window.scrollTo(0, scrolled);
      }
      const back = restore.current.focus;
      if (back instanceof HTMLElement && document.contains(back)) back.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    // Escape reaches us only while the keyboard is on our own chrome: once
    // the reader clicks INTO the document the frame owns the key, and the
    // close button in the header is the way out. That is why the header is a
    // band of its own rather than something drawn over the page.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  const value = useMemo<PdfViewerValue>(() => ({ open: show }), [show]);

  const html = open?.kind === 'html';
  const markdown = open?.kind === 'markdown';
  const overlay = open ? (
    <div
      className={markdown ? 'mdviewer' : html ? 'pdfviewer htmlviewer' : 'pdfviewer'}
      id="pdfViewer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pdfViewerName"
      tabIndex={-1}
      ref={dialog}
    >
      <div className="ivhead">
        <ViewerName key={open.name} id="pdfViewerName" name={open.name} />
        {open.save ? (
          <button
            className="ivsave"
            id="pdfViewerSave"
            type="button"
            aria-label="Download"
            title="Download"
            onClick={open.save}
          >
            <Svg name="arrowdown" size={22} />
          </button>
        ) : null}
        <button
          className="ivclose"
          id="pdfViewerClose"
          type="button"
          aria-label="Close document"
          onClick={close}
        >
          <Svg name="x" size={22} />
        </button>
      </div>
      {open.kind === 'markdown' ? (
        <div className="mdstage" id="pdfViewerStage" ref={page} tabIndex={-1}>
          <article className="mdsheet" aria-label={open.name}>
            <Markdown source={open.text} className="mdpage" />
          </article>
        </div>
      ) : <div className="pdfstage" id="pdfViewerStage">
        {/* The frame is keyed by URL so reopening on a freshly minted link
            reloads rather than showing the expired one the browser cached. */}
        {html ? (
          <iframe
            className="pdfframe"
            id="pdfViewerFrame"
            key={open.url}
            title={open.name}
            src={open.url}
            sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
          />
        ) : (
          <iframe
            className="pdfframe"
            id="pdfViewerFrame"
            key={open.url}
            title={open.name}
            src={pdfReadingSrc(open.url)}
          />
        )}
      </div>}
      {html || open.kind === 'markdown' ? null : (
        <div className="ivcontrols" aria-label="Document controls">
          <button
            className="ivcontrol wide"
            id="pdfViewerOpenOut"
            type="button"
            onClick={() => window.open(pdfReadingSrc(open.url), '_blank', 'noopener')}
          >
            Open in a new tab
          </button>
        </div>
      )}
    </div>
  ) : null;

  return (
    <PdfViewerContext value={value}>
      {children}
      {overlay && open?.host?.isConnected ? createPortal(overlay, open.host) : overlay}
    </PdfViewerContext>
  );
}
