/**
 * The full-screen picture viewer — shared chrome that a proposal, a note, a
 * knowledge page and a repository file all borrow.
 *
 * It sat unmoved through slices 4, 5 and 6 on purpose: each of them wrote
 * "it belongs with the last of us", and slice 7 is the last of us. A tap on a
 * picture in any of those places now opens it here instead of in a new tab.
 *
 * What it keeps from the legacy viewer: the GALLERY (a proposal carrying
 * three screenshots is three slides, and the reader steps between them —
 * otherwise the second and third are reachable only by closing this and
 * finding them again), zoom with the buttons, drag to pan while zoomed,
 * Escape and the backdrop to close, and the scroll position and focus put
 * back exactly where they were.
 *
 * The PINCH came back after the port (note #288). The port left it out and
 * relied on the browser's own pinch, but the stage takes `touch-action:
 * none` and the page forbids scaling in its viewport tag, so two fingers on
 * a picture did nothing at all. Two fingers now scale the picture about the
 * point between them, and one finger pans it while zoomed. Native touch
 * events own that path on phones; pointer events keep mouse and pen input.
 * Swiping between pictures is still the buttons' job.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ImageViewerContext, type ImageViewerValue, type ViewerImage } from './image-viewer-context.js';
import { Svg } from './icons.js';
import { ViewerName } from './ViewerName.js';

export const IMAGE_VIEWER_MIN_ZOOM = 1;
/** How far in the reader may go. Most pictures opened here are SCREENSHOTS,
 *  and a screenshot fitted to the stage renders its text far below the size
 *  it was captured at — so the ceiling is not "how big can a photo get", it
 *  is "can the small print be read". 6× was not enough for a tall screenshot
 *  on a phone (the owner, note #522); 12× is. */
export const IMAGE_VIEWER_MAX_ZOOM = 12;
const ZOOM_STEP = 1.5;
/** How far below Fit a pinch may go while the fingers are still down. The
 *  picture gives a little, so the gesture is seen to work, and springs back
 *  to Fit on release — the shape every phone gallery has taught. */
const PINCH_UNDERSHOOT = 0.6;

interface Point { x: number; y: number }
interface Pinch {
  distance: number; scale: number; pan: Point; mid: Point;
  /** The stage's centre on screen: the transform origin the pinch keeps
   *  its midpoint still against. */
  centre: Point;
}

const distanceBetween = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

interface Open { images: readonly ViewerImage[]; index: number; host?: HTMLElement }

function zoomLabel(scale: number): string {
  return scale === 1 ? 'Fit' : `${scale.toFixed(scale % 1 ? 1 : 0)}×`;
}

export function ImageViewerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<Open | null>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // The same two, readable from a pointer handler the moment they change:
  // the end of a pinch arms the next pan from where the pinch left the
  // picture, before React has drawn it.
  const view = useRef({ scale: 1, pan: { x: 0, y: 0 } });
  const place = useCallback((nextScale: number, nextPan: Point) => {
    view.current = { scale: nextScale, pan: nextPan };
    setScale(nextScale);
    setPan(nextPan);
  }, []);
  const [broken, setBroken] = useState(false);
  // Held in STATE, not a ref: the stage's class is drawn from it, and this
  // shell lints against reading a ref during render (slice 4 paid for that
  // lesson once already).
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; from: { x: number; y: number } } | null>(null);
  // Every mouse/pen pointer on the stage, by id. Touch has its native path
  // below because an iPhone is the compatibility boundary for this viewer.
  const pointers = useRef(new Map<number, Point>());
  const pinch = useRef<Pinch | null>(null);
  // Whether the pointer that is going up actually MOVED the picture. Now
  // that the stage is reachable again, a pan that ends over the space beside
  // the picture would otherwise be delivered as a click on the stage and
  // close the viewer the reader is still working in.
  const panned = useRef(false);
  const restore = useRef<{ scrollY: number; focus: Element | null }>({ scrollY: 0, focus: null });
  const dialog = useRef<HTMLDivElement | null>(null);
  const stage = useRef<HTMLDivElement | null>(null);

  const show = useCallback((images: readonly ViewerImage[], index: number, host?: HTMLElement) => {
    if (!images.length) return;
    restore.current = { scrollY: window.scrollY, focus: document.activeElement };
    setOpen({ images, index: Math.min(Math.max(index, 0), images.length - 1), ...(host ? { host } : {}) });
    place(1, { x: 0, y: 0 });
    setBroken(false);
  }, [place]);

  const close = useCallback(() => {
    setOpen(null);
    drag.current = null;
    pinch.current = null;
    pointers.current.clear();
    setDragging(false);
  }, []);

  const step = useCallback((by: number) => {
    setOpen((current) => {
      if (!current) return current;
      const next = current.index + by;
      if (next < 0 || next >= current.images.length) return current;
      return { ...current, index: next };
    });
    // Stepping outside zoom: moving between pictures and moving within one
    // are different acts, and the order says so.
    place(1, { x: 0, y: 0 });
    setBroken(false);
  }, [place]);

  // Whatever is under the viewer must not scroll with it, and must be exactly
  // where it was when this closes.
  //
  // WHICH surface that is depends on where this opened (note #387). Hosted
  // inside a full-screen modal, the document is already sealed off by that
  // modal and the only thing that can move is the host's own column: locking
  // the body there reflows a page nobody can see, and on a phone that reflow
  // shifts the visible rectangle the host measured itself against — which is
  // how closing a picture used to leave the screen behind it broken.
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
    // Focus the dialog, not Close. On iPhone Safari, programmatically
    // focusing the button leaves the browser's blue focus ring painted over
    // the viewer, and a hardware Enter immediately closes the picture that
    // was just opened. The dialog is still the modal focus destination; Tab
    // reaches Close first and closing restores the opener below.
    dialog.current?.focus({ preventScroll: true });
    return () => {
      if (host) {
        if (column) column.scrollTop = held;
      } else {
        document.body.classList.remove('image-open');
        document.body.style.removeProperty('--image-scroll-top');
        window.scrollTo(0, scrolled);
      }
      const back = restore.current.focus;
      // `preventScroll`, or handing the opener its focus back scrolls it into
      // view — undoing the position just restored a line above.
      if (back instanceof HTMLElement && document.contains(back)) back.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      else if (event.key === 'ArrowRight') step(1);
      else if (event.key === 'ArrowLeft') step(-1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close, step]);

  const startPinch = useCallback((points: readonly Point[], box: DOMRect) => {
    panned.current = true;
    drag.current = null;
    setDragging(false);
    const current = view.current;
    pinch.current = {
      distance: distanceBetween(points[0]!, points[1]!),
      scale: current.scale,
      pan: current.pan,
      mid: midpoint(points[0]!, points[1]!),
      centre: { x: box.left + box.width / 2, y: box.top + box.height / 2 },
    };
  }, []);

  const movePinch = useCallback((points: readonly Point[]): boolean => {
    const held = pinch.current;
    if (!held || points.length !== 2) return false;
    const now = midpoint(points[0]!, points[1]!);
    const ratio = held.distance > 0
      ? distanceBetween(points[0]!, points[1]!) / held.distance
      : 1;
    const next = Math.min(
      IMAGE_VIEWER_MAX_ZOOM,
      Math.max(PINCH_UNDERSHOOT, held.scale * ratio),
    );
    // The picture is drawn as translate(pan) scale(s) about the stage's
    // centre. Carrying the fingers' midpoint by the same growth keeps the
    // point they started over underneath them.
    const grown = next / held.scale;
    place(next, {
      x: now.x - held.centre.x - grown * (held.mid.x - held.centre.x - held.pan.x),
      y: now.y - held.centre.y - grown * (held.mid.y - held.centre.y - held.pan.y),
    });
    return true;
  }, [place]);

  const startDrag = useCallback((point: Point) => {
    panned.current = false;
    const current = view.current;
    if (current.scale === IMAGE_VIEWER_MIN_ZOOM) return;
    drag.current = { x: point.x, y: point.y, from: current.pan };
    setDragging(true);
  }, []);

  const moveDrag = useCallback((point: Point): boolean => {
    const held = drag.current;
    if (!held) return false;
    const dx = point.x - held.x;
    const dy = point.y - held.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panned.current = true;
    place(view.current.scale, { x: held.from.x + dx, y: held.from.y + dy });
    return true;
  }, [place]);

  /** A finger leaves the stage. The end of a pinch settles the zoom — under
   *  Fit springs back to Fit — and the finger still down, if any, carries
   *  on as a pan so the picture does not jump when one finger lifts first. */
  const settleGesture = useCallback((rest: Point[]) => {
    if (pinch.current) {
      pinch.current = null;
      const left = view.current;
      if (left.scale < IMAGE_VIEWER_MIN_ZOOM) place(IMAGE_VIEWER_MIN_ZOOM, { x: 0, y: 0 });
      const settled = view.current;
      if (rest.length === 1 && settled.scale > IMAGE_VIEWER_MIN_ZOOM) {
        drag.current = { x: rest[0]!.x, y: rest[0]!.y, from: settled.pan };
        setDragging(true);
        return;
      }
    }
    drag.current = null;
    setDragging(false);
  }, [place]);

  const liftFinger = useCallback((pointerId: number) => {
    pointers.current.delete(pointerId);
    settleGesture([...pointers.current.values()]);
  }, [settleGesture]);

  // The previous proof stopped at Chrome turning touch into pointer events;
  // the iPhone report in note #366 is the evidence that this is not a safe
  // compatibility boundary. Listen to the native touch stream as the phone
  // path, non-passively so Safari's own recognizer never wins the gesture;
  // pointer events remain the mouse/pen path.
  useEffect(() => {
    const node = stage.current;
    if (!open || !node) return undefined;
    const points = (touches: TouchList): Point[] => (
      Array.from(touches, (touch) => ({ x: touch.clientX, y: touch.clientY }))
    );
    const start = (event: TouchEvent) => {
      const held = points(event.touches);
      if (held.length === 2) {
        event.preventDefault();
        startPinch(held, node.getBoundingClientRect());
        return;
      }
      if (held.length !== 1) return;
      startDrag(held[0]!);
    };
    const move = (event: TouchEvent) => {
      const held = points(event.touches);
      if (movePinch(held)) {
        event.preventDefault();
        return;
      }
      if (held.length !== 1 || !moveDrag(held[0]!)) return;
      event.preventDefault();
    };
    const end = (event: TouchEvent) => settleGesture(points(event.touches));
    node.addEventListener('touchstart', start, { passive: false });
    node.addEventListener('touchmove', move, { passive: false });
    node.addEventListener('touchend', end);
    node.addEventListener('touchcancel', end);
    return () => {
      node.removeEventListener('touchstart', start);
      node.removeEventListener('touchmove', move);
      node.removeEventListener('touchend', end);
      node.removeEventListener('touchcancel', end);
    };
  }, [moveDrag, movePinch, open, settleGesture, startDrag, startPinch]);

  const value = useMemo<ImageViewerValue>(() => ({ open: show }), [show]);
  const current = open ? open.images[open.index] : null;
  const many = (open?.images.length ?? 0) > 1;

  const overlay = open && current ? (
        <div
          className="imageviewer"
          id="imageViewer"
          role="dialog"
          aria-modal="true"
          aria-labelledby="imageViewerName"
          tabIndex={-1}
          ref={dialog}
        >
          <div className="ivhead">
            <ViewerName key={current.name} id="imageViewerName" name={current.name} />
            {many
              ? <div className="ivcount" id="imageViewerCount" aria-live="polite">{open.index + 1} of {open.images.length}</div>
              : null}
            {/* Download, for a picture whose surface can save it (note #552).
                In the head beside Close rather than in the bar below: the bar
                is how the picture is LOOKED AT, and saving it is not a way of
                looking. Absent, not disabled, for a picture nobody can save. */}
            {current.save
              ? (
                <button
                  className="ivsave"
                  id="imageViewerSave"
                  type="button"
                  aria-label={`Download ${current.name}`}
                  onClick={current.save}
                >
                  <Svg name="arrowdown" size={22} />
                </button>
              )
              : null}
            <button
              className="ivclose"
              id="imageViewerClose"
              type="button"
              aria-label="Close image"
              onClick={close}
            >
              <Svg name="x" size={22} />
            </button>
          </div>
          {/* A tap on the STAGE — the space around the picture, not the
              picture — is the gesture everyone knows for "done". */}
          <div
            className={`ivstage${dragging ? ' dragging' : ''}`}
            id="imageViewerStage"
            ref={stage}
            onPointerDown={(event) => {
              // Touch has a native path above. Handling both streams would
              // count every iPhone finger twice.
              if (event.pointerType === 'touch') return;
              const point = { x: event.clientX, y: event.clientY };
              pointers.current.set(event.pointerId, point);
              event.currentTarget.setPointerCapture?.(event.pointerId);
              const points = [...pointers.current.values()];
              if (points.length === 2) {
                // A second finger is a pinch, whatever the first was doing.
                // A pinch is never a tap, so the click that follows it must
                // not close the viewer the reader is zooming in.
                startPinch(points, event.currentTarget.getBoundingClientRect());
                return;
              }
              if (points.length > 2) return;
              // Cleared on every single-finger press, above the guard below:
              // a pan that ended in a cancel rather than a tap must not leave
              // the flag standing for the next, unrelated tap to be eaten by.
              startDrag(point);
            }}
            onPointerMove={(event) => {
              if (event.pointerType === 'touch') return;
              if (!pointers.current.has(event.pointerId)) return;
              pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
              const held = pinch.current;
              const points = [...pointers.current.values()];
              if (held && movePinch(points)) return;
              moveDrag({ x: event.clientX, y: event.clientY });
            }}
            onPointerUp={(event) => { if (event.pointerType !== 'touch') liftFinger(event.pointerId); }}
            onPointerCancel={(event) => { if (event.pointerType !== 'touch') liftFinger(event.pointerId); }}
            onClick={(event) => {
              if (panned.current) { panned.current = false; return; }
              if (event.target === event.currentTarget) close();
            }}
            onDoubleClick={(event) => {
              // The familiar one-finger shortcut as well as the explicit
              // controls: double tap the picture to inspect it, then again
              // to return to Fit. It was present before the React move and
              // was silently lost in that port.
              if (event.target === event.currentTarget) return;
              event.preventDefault();
              const next = view.current.scale === IMAGE_VIEWER_MIN_ZOOM ? 2 : IMAGE_VIEWER_MIN_ZOOM;
              place(next, { x: 0, y: 0 });
            }}
          >
            {/* The picture is a direct child of the stage, and carries
                `ivimage` — the class that fits it and keeps its shape. The
                `ivtrack` wrapper that used to sit here was the legacy
                carousel's rail (absolute, `display: flex`), and this viewer
                has no carousel: it swaps `src` and re-renders. Kept, it did
                two things nobody asked for — its flex `align-items: stretch`
                pulled the unclassed picture to the full height of the stage
                whatever its shape, and being `inset: 0` it covered the stage
                so the tap-to-close below could never fire (note #274). */}
            {broken
              ? <div className="empty">{current.name} could not be shown.</div>
              : (
                <img
                  className="ivimage"
                  id="imageViewerImage"
                  alt={current.name}
                  src={current.url}
                  style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}
                  onError={() => setBroken(true)}
                  draggable={false}
                />
              )}
          </div>
          <div className="ivcontrols" aria-label="Image controls">
            {/* Both step buttons are absent for a single image, which leaves
                the bar exactly the three controls it has always been. */}
            {many ? (
              <button
                className="ivcontrol" id="imageViewerPrev" type="button" aria-label="Previous image"
                disabled={open.index === 0} onClick={() => step(-1)}
              >
                <Svg name="back" size={22} />
              </button>
            ) : null}
            <button
              className="ivcontrol" id="imageZoomOut" type="button" aria-label="Zoom out"
              disabled={scale <= IMAGE_VIEWER_MIN_ZOOM}
              onClick={() => place(
                Math.max(IMAGE_VIEWER_MIN_ZOOM, view.current.scale / ZOOM_STEP),
                { x: 0, y: 0 },
              )}
            >
              −
            </button>
            <button
              className="ivcontrol fit" id="imageZoomReset" type="button" aria-label="Reset zoom"
              onClick={() => place(1, { x: 0, y: 0 })}
            >
              {zoomLabel(scale)}
            </button>
            <button
              className="ivcontrol" id="imageZoomIn" type="button" aria-label="Zoom in"
              disabled={scale >= IMAGE_VIEWER_MAX_ZOOM}
              onClick={() => place(
                Math.min(IMAGE_VIEWER_MAX_ZOOM, view.current.scale * ZOOM_STEP),
                view.current.pan,
              )}
            >
              +
            </button>
            {many ? (
              <button
                className="ivcontrol" id="imageViewerNext" type="button" aria-label="Next image"
                disabled={open.index === open.images.length - 1} onClick={() => step(1)}
              >
                <Svg name="chev" size={22} />
              </button>
            ) : null}
          </div>
        </div>
      ) : null;

  return (
    <ImageViewerContext value={value}>
      {children}
      {overlay && open?.host?.isConnected ? createPortal(overlay, open.host) : overlay}
    </ImageViewerContext>
  );
}
