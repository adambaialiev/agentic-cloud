/**
 * The framing step between choosing a picture and it becoming your face
 * (note #660). The picture lies under a fixed circle; the reader drags it
 * until the circle holds what they want teammates to see, zooms with two
 * fingers, the wheel or the slider, and only then does anything go up —
 * the square behind the circle, cut on this device (picture-frame.ts).
 *
 * The gestures follow the image viewer's hard-won split: native touch
 * events, non-passive, own the phone path because iPhone Safari is the
 * compatibility boundary (notes #288, #366), and pointer events keep mouse
 * and pen. The stage takes `touch-action: none`, so a drag never scrolls
 * the page behind the dialog.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Scrim } from '../../ui/Ask.js';
import { Svg } from '../../ui/icons.js';
import { useBanner } from '../../chrome/useBanner.js';
import { errorMessage } from '../../ui/format.js';
import {
  FRAME_CIRCLE_SHARE,
  FRAME_MAX_ZOOM,
  FRAME_MIN_ZOOM,
  FRAME_START,
  frameCrop,
  frameOutputType,
  moveBy,
  picturePlacement,
  pinchTo,
  zoomAbout,
  type FrameOffset,
  type Framing,
  type PictureSize,
} from './picture-frame.js';

interface Point { x: number; y: number }
type Gesture =
  | { kind: 'drag'; from: Point; framing: Framing; circle: number }
  | { kind: 'pinch'; distance: number; mid: FrameOffset; framing: Framing; circle: number; centre: Point };

/** One arrow press moves the picture this share of the circle; Shift, five. */
const KEY_STEP = 0.02;
const KEY_ZOOM = 1.1;
/** A gesture that ends over the dim, or the tap a phone synthesises after
 *  it, must not read as the backdrop's "no" to the reader still framing. */
const SETTLE_MS = 400;

const distanceBetween = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

/** The chosen picture, cut to the square behind the circle. */
async function cutSquare(image: HTMLImageElement, size: PictureSize, framing: Framing, sourceType: string): Promise<Blob> {
  const crop = frameCrop(size, framing);
  const canvas = document.createElement('canvas');
  canvas.width = crop.output;
  canvas.height = crop.output;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser could not cut the picture — try another browser.');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, crop.x, crop.y, crop.side, crop.side, 0, 0, crop.output, crop.output);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, frameOutputType(sourceType), 0.9));
  if (!blob) throw new Error('This browser could not cut the picture — try another browser.');
  return blob;
}

export function PictureFrame({ file, url, onCancel, onUse, onBroken }: {
  file: File;
  /** An object URL for `file`, made and revoked by the opener. */
  url: string;
  onCancel: () => void;
  /** Upload the cut square. Throws to keep the dialog open with the reason. */
  onUse: (picture: Blob) => Promise<void>;
  /** The browser could not open the file as a picture. */
  onBroken: () => void;
}) {
  const banner = useBanner();
  const [size, setSize] = useState<PictureSize | null>(null);
  const [framing, setFraming] = useState<Framing>(FRAME_START);
  const [saving, setSaving] = useState(false);
  // The same two, readable from a native listener the moment they change.
  const view = useRef<{ size: PictureSize | null; framing: Framing }>({ size: null, framing: FRAME_START });
  const gesture = useRef<Gesture | null>(null);
  const settledAt = useRef(0);
  const stage = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  // Held in STATE for the stage's class, like the image viewer's.
  const [dragging, setDragging] = useState(false);

  const place = useCallback((next: Framing) => {
    view.current.framing = next;
    setFraming(next);
  }, []);

  /** The circle's width on screen and the stage's centre, measured when a
   *  gesture starts — the only moments pixels matter here. */
  const measure = useCallback((): { circle: number; centre: Point } => {
    const box = stage.current?.getBoundingClientRect();
    if (!box || !box.width) return { circle: 1, centre: { x: 0, y: 0 } };
    return { circle: box.width * FRAME_CIRCLE_SHARE, centre: { x: box.left + box.width / 2, y: box.top + box.height / 2 } };
  }, []);

  const startDrag = useCallback((point: Point) => {
    if (!view.current.size) return;
    gesture.current = { kind: 'drag', from: point, framing: view.current.framing, circle: measure().circle };
    setDragging(true);
  }, [measure]);

  const startPinch = useCallback((a: Point, b: Point) => {
    if (!view.current.size) return;
    const { circle, centre } = measure();
    gesture.current = {
      kind: 'pinch',
      distance: distanceBetween(a, b),
      mid: { x: ((a.x + b.x) / 2 - centre.x) / circle, y: ((a.y + b.y) / 2 - centre.y) / circle },
      framing: view.current.framing,
      circle,
      centre,
    };
    setDragging(true);
  }, [measure]);

  const move = useCallback((points: readonly Point[]): boolean => {
    const held = gesture.current;
    const size = view.current.size;
    if (!held || !size) return false;
    if (held.kind === 'pinch') {
      if (points.length !== 2) return false;
      const [a, b] = [points[0]!, points[1]!];
      const now = { x: ((a.x + b.x) / 2 - held.centre.x) / held.circle, y: ((a.y + b.y) / 2 - held.centre.y) / held.circle };
      const ratio = held.distance > 0 ? distanceBetween(a, b) / held.distance : 1;
      place(pinchTo(size, held.framing, ratio, held.mid, now));
      return true;
    }
    if (points.length !== 1) return false;
    const point = points[0]!;
    place(moveBy(size, held.framing, { x: (point.x - held.from.x) / held.circle, y: (point.y - held.from.y) / held.circle }));
    return true;
  }, [place]);

  /** A finger or the button comes up. A finger still down after a pinch
   *  carries on as a drag from where the pinch left the picture, so it
   *  does not jump when one finger lifts first. */
  const settle = useCallback((rest: readonly Point[]) => {
    settledAt.current = performance.now();
    gesture.current = null;
    if (rest.length === 1) { startDrag(rest[0]!); return; }
    setDragging(false);
  }, [startDrag]);

  useEffect(() => {
    const node = stage.current;
    if (!node) return undefined;
    const points = (touches: TouchList): Point[] => Array.from(touches, (touch) => ({ x: touch.clientX, y: touch.clientY }));
    const start = (event: TouchEvent) => {
      const held = points(event.touches);
      event.preventDefault();
      if (held.length === 2) startPinch(held[0]!, held[1]!);
      else if (held.length === 1) startDrag(held[0]!);
    };
    const touchMove = (event: TouchEvent) => {
      if (move(points(event.touches))) event.preventDefault();
    };
    const end = (event: TouchEvent) => settle(points(event.touches));
    // The wheel zooms about the point under the mouse, the way every map
    // and photo editor on a desk does.
    const wheel = (event: WheelEvent) => {
      const size = view.current.size;
      if (!size) return;
      event.preventDefault();
      const { circle, centre } = measure();
      const from = view.current.framing;
      const anchor = { x: (event.clientX - centre.x) / circle, y: (event.clientY - centre.y) / circle };
      place(zoomAbout(size, from, from.zoom * Math.exp(-event.deltaY * 0.002), anchor));
    };
    node.addEventListener('touchstart', start, { passive: false });
    node.addEventListener('touchmove', touchMove, { passive: false });
    node.addEventListener('touchend', end);
    node.addEventListener('touchcancel', end);
    node.addEventListener('wheel', wheel, { passive: false });
    return () => {
      node.removeEventListener('touchstart', start);
      node.removeEventListener('touchmove', touchMove);
      node.removeEventListener('touchend', end);
      node.removeEventListener('touchcancel', end);
      node.removeEventListener('wheel', wheel);
    };
  }, [measure, move, place, settle, startDrag, startPinch]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch' || event.button !== 0) return;
    event.preventDefault();
    // Captured, so a drag that ends out over the dim is still this stage's —
    // its click lands here and not on the backdrop.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    startDrag({ x: event.clientX, y: event.clientY });
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') return;
    move([{ x: event.clientX, y: event.clientY }]);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') return;
    settle([]);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const size = view.current.size;
    if (!size) return;
    const from = view.current.framing;
    const step = KEY_STEP * (event.shiftKey ? 5 : 1);
    const by: Record<string, FrameOffset> = {
      ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step },
    };
    if (by[event.key]) place(moveBy(size, from, by[event.key]!));
    else if (event.key === '+' || event.key === '=') place(zoomAbout(size, from, from.zoom * KEY_ZOOM));
    else if (event.key === '-') place(zoomAbout(size, from, from.zoom / KEY_ZOOM));
    else return;
    event.preventDefault();
  };

  const use = async () => {
    const size = view.current.size;
    if (!image.current || !size) return;
    setSaving(true);
    try {
      await onUse(await cutSquare(image.current, size, view.current.framing, file.type));
    } catch (error) {
      banner.show(errorMessage(error));
    }
    setSaving(false);
  };

  const dismiss = () => {
    if (saving || gesture.current || performance.now() - settledAt.current < SETTLE_MS) return;
    onCancel();
  };

  const at = size ? picturePlacement(size, framing) : null;
  return (
    <Scrim onDismiss={dismiss}>
      <div className="pictureframe" id="pictureFrame">
        <h3>Position your picture</h3>
        <p>Drag it until the circle frames you. Pinch or use the slider to zoom.</p>
        <div
          className={dragging ? 'framestage dragging' : 'framestage'}
          id="pictureFrameStage"
          ref={stage}
          tabIndex={0}
          role="group"
          aria-label="Your picture. Drag it, or use the arrow keys, to move it inside the circle."
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
        >
          <img
            ref={image}
            src={url}
            alt=""
            draggable={false}
            hidden={!at}
            style={at ? { left: `${at.left}%`, top: `${at.top}%`, width: `${at.width}%`, height: `${at.height}%` } : undefined}
            onLoad={(event) => {
              const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
              if (!width || !height) { onBroken(); return; }
              view.current = { size: { width, height }, framing: FRAME_START };
              setSize({ width, height });
              setFraming(FRAME_START);
            }}
            onError={onBroken}
          />
          <div className="framemask" aria-hidden="true" />
        </div>
        <label className="framezoom">
          <Svg name="image" size={14} />
          <input
            type="range"
            id="pictureFrameZoom"
            aria-label="Zoom"
            min={FRAME_MIN_ZOOM}
            max={FRAME_MAX_ZOOM}
            step={0.01}
            value={framing.zoom}
            disabled={!size}
            onChange={(event) => { if (size) place(zoomAbout(size, view.current.framing, Number(event.target.value))); }}
          />
          <Svg name="image" size={20} />
        </label>
        <div className="btns">
          <button className="btn ghost" type="button" disabled={saving} onClick={onCancel}>Cancel</button>
          <button className="btn primary" id="pictureFrameUse" type="button" disabled={!size || saving} onClick={() => { void use(); }}>
            {saving ? 'Saving…' : 'Use this picture'}
          </button>
        </div>
      </div>
    </Scrim>
  );
}
