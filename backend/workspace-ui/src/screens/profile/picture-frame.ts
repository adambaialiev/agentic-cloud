/**
 * Where a new profile picture sits under the circle (note #660).
 *
 * Every face of a person in this app is a circle, and a picture used to go
 * up exactly as it was chosen, so the circle took whatever happened to be in
 * the middle of it — the top of a head, a shoulder, a lot of wall. The
 * framing step lets the reader drag the picture under a fixed circle and
 * zoom it, and what goes up is the square behind that circle, cut here.
 *
 * All of it is measured in CIRCLES rather than pixels: the circle is one
 * unit across, the picture at zoom 1 exactly covers it along its short side,
 * and the offset is how far the picture's centre sits from the circle's.
 * That keeps the arithmetic free of the stage's size, which a phone rotated
 * mid-drag is allowed to change.
 */

export interface PictureSize { width: number; height: number }
export interface FrameOffset { x: number; y: number }
export interface Framing { zoom: number; offset: FrameOffset }

export const FRAME_MIN_ZOOM = 1;
/** Four times in: far enough for a face in a group photo, not so far that
 *  the square behind the circle is a handful of pixels blown up. */
export const FRAME_MAX_ZOOM = 4;
/** The side of the square that goes up — the size Telegram keeps a profile
 *  photo at. The largest face here is 72px (a person's public page), so it
 *  is sharp on the densest screen, and even a PNG this size stays far under
 *  the 5 MB the server takes. */
export const FRAME_OUTPUT_MAX = 640;
/** The circle's share of the stage. What is outside it stays visible under
 *  the dim, so the reader can see what they are cutting away. */
export const FRAME_CIRCLE_SHARE = 0.8;

export const FRAME_START: Framing = { zoom: FRAME_MIN_ZOOM, offset: { x: 0, y: 0 } };

/** The picture's size on screen, in circles. */
export function pictureSpan(size: PictureSize, zoom: number): { width: number; height: number } {
  const short = Math.min(size.width, size.height);
  return { width: (zoom * size.width) / short, height: (zoom * size.height) / short };
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return FRAME_MIN_ZOOM;
  return Math.min(FRAME_MAX_ZOOM, Math.max(FRAME_MIN_ZOOM, zoom));
}

/** The picture may move only as far as it still covers the whole circle —
 *  an empty crescent inside the circle would go up as a black one. */
export function clampOffset(size: PictureSize, zoom: number, offset: FrameOffset): FrameOffset {
  const span = pictureSpan(size, zoom);
  const room = { x: Math.max(0, (span.width - 1) / 2), y: Math.max(0, (span.height - 1) / 2) };
  const hold = (value: number, limit: number) => (Number.isFinite(value) ? Math.min(limit, Math.max(-limit, value)) : 0);
  // `+ 0` so a clamp to zero is never the -0 a test would print.
  return { x: hold(offset.x, room.x) + 0, y: hold(offset.y, room.y) + 0 };
}

/**
 * Two fingers: the picture grows by `ratio` since they came down, and the
 * point that was between them at `start` stays under them as they travel
 * to `now` (both in circles from the circle's centre). One clamp at the
 * end, so a pinch pressed against an edge still zooms.
 */
export function pinchTo(size: PictureSize, from: Framing, ratio: number, start: FrameOffset, now: FrameOffset): Framing {
  const zoom = clampZoom(from.zoom * ratio);
  const grown = zoom / from.zoom;
  return {
    zoom,
    offset: clampOffset(size, zoom, {
      x: now.x - (start.x - from.offset.x) * grown,
      y: now.y - (start.y - from.offset.y) * grown,
    }),
  };
}

/**
 * Zoom to `next` keeping the point `anchor` still — the mouse under a wheel,
 * or the circle's own centre for the slider and the keys.
 */
export function zoomAbout(size: PictureSize, from: Framing, next: number, anchor: FrameOffset = { x: 0, y: 0 }): Framing {
  return pinchTo(size, from, clampZoom(next) / from.zoom, anchor, anchor);
}

/** Move by a drag, measured in circles. */
export function moveBy(size: PictureSize, from: Framing, by: FrameOffset): Framing {
  return { zoom: from.zoom, offset: clampOffset(size, from.zoom, { x: from.offset.x + by.x, y: from.offset.y + by.y }) };
}

/** Where the picture stands in the stage, in percent of the stage — the
 *  circle is `FRAME_CIRCLE_SHARE` of it, centred. */
export function picturePlacement(size: PictureSize, framing: Framing): { left: number; top: number; width: number; height: number } {
  const span = pictureSpan(size, framing.zoom);
  const unit = FRAME_CIRCLE_SHARE * 100;
  return {
    left: 50 + unit * (framing.offset.x - span.width / 2),
    top: 50 + unit * (framing.offset.y - span.height / 2),
    width: unit * span.width,
    height: unit * span.height,
  };
}

/** The square behind the circle, in the picture's own pixels, and the side
 *  it goes up at — never larger than it was, so nothing is blown up. */
export function frameCrop(size: PictureSize, framing: Framing): { x: number; y: number; side: number; output: number } {
  const zoom = clampZoom(framing.zoom);
  const offset = clampOffset(size, zoom, framing.offset);
  const side = Math.min(size.width, size.height) / zoom;
  const x = size.width / 2 - offset.x * side - side / 2;
  const y = size.height / 2 - offset.y * side - side / 2;
  // Rounding can put an edge a hair outside the picture; the clamp keeps
  // the cut inside it.
  const fit = (value: number, total: number) => Math.min(Math.max(0, value), Math.max(0, total - side));
  return {
    x: fit(x, size.width),
    y: fit(y, size.height),
    side,
    output: Math.max(1, Math.min(FRAME_OUTPUT_MAX, Math.round(side))),
  };
}

/** A PNG or WebP may be see-through and goes up as a PNG, which keeps that;
 *  a JPEG never is, and stays a JPEG. */
export function frameOutputType(sourceType: string): 'image/png' | 'image/jpeg' {
  return sourceType === 'image/png' || sourceType === 'image/webp' ? 'image/png' : 'image/jpeg';
}
