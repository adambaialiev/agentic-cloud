import { describe, expect, it } from 'vitest';
import {
  FRAME_MAX_ZOOM,
  FRAME_OUTPUT_MAX,
  FRAME_START,
  clampOffset,
  clampZoom,
  frameCrop,
  frameOutputType,
  moveBy,
  picturePlacement,
  pictureSpan,
  pinchTo,
  zoomAbout,
} from './picture-frame.js';

/** Framing a new profile picture under the circle (note #660). */
describe('picture framing', () => {
  const wide = { width: 400, height: 200 };
  const tall = { width: 300, height: 600 };

  it('starts with the short side exactly across the circle, centred', () => {
    expect(pictureSpan(wide, 1)).toEqual({ width: 2, height: 1 });
    expect(pictureSpan(tall, 2)).toEqual({ width: 2, height: 4 });
    expect(frameCrop(wide, FRAME_START)).toEqual({ x: 100, y: 0, side: 200, output: 200 });
    // The circle is 80% of the stage, centred: a square picture fills it.
    expect(picturePlacement({ width: 50, height: 50 }, FRAME_START)).toEqual({ left: 10, top: 10, width: 80, height: 80 });
  });

  it('moves only as far as the picture still covers the whole circle', () => {
    // Half a circle of spare picture each side, none above or below.
    expect(clampOffset(wide, 1, { x: 3, y: 3 })).toEqual({ x: 0.5, y: 0 });
    expect(clampOffset(wide, 1, { x: -3, y: -3 })).toEqual({ x: -0.5, y: 0 });
    expect(clampOffset(wide, 1, { x: Number.NaN, y: 0 })).toEqual({ x: 0, y: 0 });
    // Dragged all the way right, the circle holds the picture's left edge.
    expect(frameCrop(wide, moveBy(wide, FRAME_START, { x: 9, y: 0 }))).toMatchObject({ x: 0, y: 0 });
    expect(frameCrop(wide, moveBy(wide, FRAME_START, { x: -9, y: 0 }))).toMatchObject({ x: 200, y: 0 });
  });

  it('cuts a smaller square as it zooms in, and never blows one up', () => {
    const zoomed = zoomAbout(wide, FRAME_START, 2);
    expect(zoomed).toEqual({ zoom: 2, offset: { x: 0, y: 0 } });
    expect(frameCrop(wide, zoomed)).toEqual({ x: 150, y: 50, side: 100, output: 100 });
    // A camera photo goes up at the output size, not its own.
    expect(frameCrop({ width: 4032, height: 3024 }, FRAME_START).output).toBe(FRAME_OUTPUT_MAX);
  });

  it('holds zoom between Fit and its ceiling', () => {
    expect(clampZoom(0.2)).toBe(1);
    expect(clampZoom(40)).toBe(FRAME_MAX_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(1);
    // Zooming back out pulls the picture back over the circle.
    const out = zoomAbout(wide, { zoom: 3, offset: { x: 2.5, y: 1 } }, 1);
    expect(out).toEqual({ zoom: 1, offset: { x: 0.5, y: 0 } });
  });

  it('keeps the point under the wheel where it was', () => {
    const anchor = { x: 0.25, y: 0 };
    const before = FRAME_START;
    const after = zoomAbout(wide, before, 2, anchor);
    // The picture's own pixel under the anchor, before and after.
    const under = (framing: typeof before) => {
      const side = 200 / framing.zoom;
      return 200 + (anchor.x - framing.offset.x) * side;
    };
    expect(after.offset.x).toBeCloseTo(-0.25);
    expect(under(after)).toBeCloseTo(under(before));
  });

  it('pinches about the fingers and follows them as they travel', () => {
    // Fingers that only travel move the picture with them.
    expect(pinchTo(wide, FRAME_START, 1, { x: 0, y: 0 }, { x: 0.1, y: 0 })).toEqual({ zoom: 1, offset: { x: 0.1, y: 0 } });
    // Fingers that spread twice as far about the centre zoom 2x in place.
    expect(pinchTo(wide, FRAME_START, 2, { x: 0, y: 0 }, { x: 0, y: 0 })).toEqual({ zoom: 2, offset: { x: 0, y: 0 } });
  });

  it('keeps a picture that may be see-through a PNG', () => {
    expect(frameOutputType('image/png')).toBe('image/png');
    expect(frameOutputType('image/webp')).toBe('image/png');
    expect(frameOutputType('image/jpeg')).toBe('image/jpeg');
    expect(frameOutputType('')).toBe('image/jpeg');
  });
});
