import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageViewerProvider } from './ImageViewer.js';
import { useImageViewer } from './useImageViewer.js';

/**
 * jsdom has no layout, so it can say nothing about the SIZE the viewer draws
 * a picture at — that is the Chrome harness's job
 * (`scripts/verify-workspace-react-repos.mts`, which measures the painted box
 * against the picture's own ratio).
 *
 * What jsdom can hold is the STRUCTURE the sizing rules need, and that is
 * what actually broke in note #274: the picture was wrapped in the legacy
 * carousel's rail and carried no class, so the stylesheet's fitting rule
 * (`.ivimage`) never reached it and the rail's own flex layout sized it
 * instead. Nothing failed; it just came out the wrong shape. These tests pin
 * the two facts the CSS depends on.
 */

function Opener({ url = 'blob:one', name = 'wide.png', save }: { url?: string; name?: string; save?: () => void }) {
  const open = useImageViewer();
  return <button type="button" onClick={() => open([{ url, name, ...(save ? { save } : {}) }], 0)}>show</button>;
}

const openViewer = () => {
  render(<ImageViewerProvider><Opener /></ImageViewerProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'show' }));
};

describe('ImageViewerProvider', () => {
  beforeEach(() => {
    // jsdom implements neither, and the viewer puts the page back on close.
    vi.stubGlobal('scrollTo', vi.fn());
  });

  it('hangs the picture straight off the stage, wearing the class that fits it', () => {
    openViewer();

    const stage = document.getElementById('imageViewerStage');
    const picture = document.getElementById('imageViewerImage');
    expect(picture?.className).toBe('ivimage');
    // Straight off the stage: anything in between is a box with a layout of
    // its own, and the picture is sized by whichever one is nearest.
    expect(picture?.parentElement).toBe(stage);
    expect(stage?.querySelector('.ivtrack, .ivslide, .ivpan')).toBeNull();
  });

  it('focuses the dialog without painting the iPhone focus ring over Close', () => {
    openViewer();

    expect(document.activeElement).toBe(document.getElementById('imageViewer'));
    expect(document.activeElement).not.toBe(document.getElementById('imageViewerClose'));
  });

  // Note #552: Download is the surface's to offer, and the viewer shows it
  // only for a picture that came with a way to save it.
  it('offers Download beside Close only for a picture that can be saved', () => {
    const plain = render(<ImageViewerProvider><Opener /></ImageViewerProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'show' }));
    expect(document.getElementById('imageViewerSave')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Download/ })).toBeNull();
    plain.unmount();

    const save = vi.fn();
    render(<ImageViewerProvider><Opener name="shot.png" save={save} /></ImageViewerProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'show' }));
    const button = screen.getByRole('button', { name: 'Download shot.png' });
    expect(button.id).toBe('imageViewerSave');
    // In the head, beside Close: saving is not a way of looking at the picture.
    expect(button.parentElement).toBe(document.getElementById('imageViewerClose')!.parentElement);
    fireEvent.click(button);
    expect(save).toHaveBeenCalledTimes(1);
    // …and saving does not close what the reader is still looking at.
    expect(document.getElementById('imageViewer')).not.toBeNull();
  });

  // Note #561: the name in the head copies in one tap, and says so where
  // the tap was — a toast would land under the viewer.
  it('copies the file name from the icon beside it, and answers on the icon', async () => {
    const writes: string[] = [];
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: async (text: string) => { writes.push(text); } } });
    render(<ImageViewerProvider><Opener name="07-leo-request-to-join.mobile.png" /></ImageViewerProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'show' }));

    const copy = document.getElementById('imageViewerNameCopy')!;
    expect(copy.getAttribute('aria-label')).toBe('Copy the name 07-leo-request-to-join.mobile.png');
    // Beside the name, not out among Download and Close.
    expect(copy.previousElementSibling).toBe(document.getElementById('imageViewerName'));
    fireEvent.click(copy);

    await waitFor(() => expect(writes).toEqual(['07-leo-request-to-join.mobile.png']));
    await waitFor(() => expect(copy.getAttribute('aria-label')).toBe('Copied 07-leo-request-to-join.mobile.png'));
    expect(screen.getByRole('status').textContent).toBe('Copied 07-leo-request-to-join.mobile.png');
  });

  it('selects the name for the reader when the clipboard refuses', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: async () => { throw new Error('denied'); } } });
    render(<ImageViewerProvider><Opener name="shot.png" /></ImageViewerProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'show' }));

    fireEvent.click(document.getElementById('imageViewerNameCopy')!);

    await waitFor(() => expect(window.getSelection()?.toString()).toBe('shot.png'));
    expect(screen.getByRole('status').textContent).toBe('Could not copy — the name is selected instead.');
  });

  it('closes on a tap beside the picture, and not on the picture itself', () => {
    openViewer();

    fireEvent.click(document.getElementById('imageViewerImage')!);
    expect(document.getElementById('imageViewer')).not.toBeNull();

    fireEvent.click(document.getElementById('imageViewerStage')!);
    expect(document.getElementById('imageViewer')).toBeNull();
  });

  it('does not close when the tap was the end of a pan', () => {
    openViewer();

    // Panning is only offered while zoomed, so zoom first.
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    const stage = document.getElementById('imageViewerStage')!;
    stage.setPointerCapture = vi.fn();
    fireEvent.pointerDown(stage, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(stage, { clientX: 160, clientY: 140, pointerId: 1 });
    fireEvent.pointerUp(stage, { pointerId: 1 });
    fireEvent.click(stage);

    expect(document.getElementById('imageViewer')).not.toBeNull();
    expect(document.getElementById('imageViewerImage')?.getAttribute('style'))
      .toContain('translate(60px, 40px)');

    // …and the tap after it, which moved nothing, still closes.
    fireEvent.click(stage);
    expect(document.getElementById('imageViewer')).toBeNull();
  });

  // Note #288: two fingers on the stage zoom the picture. jsdom has no
  // geometry, so the stage's box is all zeros and its centre is the origin;
  // the arithmetic is the same one a phone runs.
  const stageForPinch = () => {
    const stage = document.getElementById('imageViewerStage')!;
    stage.setPointerCapture = vi.fn();
    return stage;
  };
  const style = () => document.getElementById('imageViewerImage')!.getAttribute('style') ?? '';

  it('zooms in when two fingers spread, and keeps the picture under them', () => {
    openViewer();
    const stage = stageForPinch();
    fireEvent.pointerDown(stage, { clientX: 100, clientY: 200, pointerId: 1 });
    fireEvent.pointerDown(stage, { clientX: 200, clientY: 200, pointerId: 2 });
    // Fingers 100 apart become 200 apart, around the same midpoint: 2×.
    fireEvent.pointerMove(stage, { clientX: 50, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(stage, { clientX: 250, clientY: 200, pointerId: 2 });
    expect(style()).toContain('scale(2)');
    // The midpoint (150, 200) stays put: it sat 150,200 from the origin at
    // 1×, so at 2× the picture shifts back by that much.
    expect(style()).toContain('translate(-150px, -200px)');
    expect(screen.getByRole('button', { name: 'Reset zoom' }).textContent).toBe('2×');

    fireEvent.pointerUp(stage, { pointerId: 1 });
    fireEvent.pointerUp(stage, { pointerId: 2 });
    expect(style()).toContain('scale(2)');
    // …and the tap that a lifted pinch delivers does not close the viewer.
    fireEvent.click(stage);
    expect(document.getElementById('imageViewer')).not.toBeNull();
  });

  it('springs back to Fit when a pinch closes below it', () => {
    openViewer();
    const stage = stageForPinch();
    fireEvent.pointerDown(stage, { clientX: 100, clientY: 200, pointerId: 1 });
    fireEvent.pointerDown(stage, { clientX: 300, clientY: 200, pointerId: 2 });
    fireEvent.pointerMove(stage, { clientX: 180, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(stage, { clientX: 220, clientY: 200, pointerId: 2 });
    // Gives a little while held, so the gesture is seen to work…
    expect(style()).toContain('scale(0.6)');
    fireEvent.pointerUp(stage, { pointerId: 1 });
    fireEvent.pointerUp(stage, { pointerId: 2 });
    // …and settles at Fit, centred, once released.
    expect(style()).toContain('scale(1)');
    expect(style()).toContain('translate(0px, 0px)');
    expect(screen.getByRole('button', { name: 'Reset zoom' }).textContent).toBe('Fit');
  });

  it('lets the finger left behind by a pinch carry on panning', () => {
    openViewer();
    const stage = stageForPinch();
    fireEvent.pointerDown(stage, { clientX: 100, clientY: 200, pointerId: 1 });
    fireEvent.pointerDown(stage, { clientX: 200, clientY: 200, pointerId: 2 });
    fireEvent.pointerMove(stage, { clientX: 50, clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(stage, { clientX: 250, clientY: 200, pointerId: 2 });
    fireEvent.pointerUp(stage, { pointerId: 2 });
    fireEvent.pointerMove(stage, { clientX: 70, clientY: 230, pointerId: 1 });
    expect(style()).toContain('scale(2)');
    expect(style()).toContain('translate(-130px, -170px)');
    fireEvent.pointerUp(stage, { pointerId: 1 });
  });

  it('uses the native touch stream when Mobile Safari does not keep a pinch in pointer events', () => {
    openViewer();
    const stage = document.getElementById('imageViewerStage')!;
    const finger = (identifier: number, clientX: number, clientY = 200) => (
      { identifier, clientX, clientY }
    );

    fireEvent.touchStart(stage, { touches: [finger(1, 100), finger(2, 200)] });
    fireEvent.touchMove(stage, { touches: [finger(1, 50), finger(2, 250)] });
    expect(style()).toContain('scale(2)');
    fireEvent.touchEnd(stage, { touches: [] });

    expect(style()).toContain('scale(2)');
    expect(screen.getByRole('button', { name: 'Reset zoom' }).textContent).toBe('2×');
  });

  it('double-taps between a useful close look and Fit', () => {
    openViewer();
    const picture = document.getElementById('imageViewerImage')!;

    fireEvent.doubleClick(picture);
    expect(style()).toContain('scale(2)');
    expect(screen.getByRole('button', { name: 'Reset zoom' }).textContent).toBe('2×');

    fireEvent.doubleClick(picture);
    expect(style()).toContain('scale(1)');
    expect(screen.getByRole('button', { name: 'Reset zoom' }).textContent).toBe('Fit');
  });

  it('climbs to 12x and stops there, with the button saying so', () => {
    openViewer();
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
    const label = screen.getByRole('button', { name: 'Reset zoom' });
    const style = () => document.getElementById('imageViewerImage')?.getAttribute('style') ?? '';

    // The ceiling is what note #522 asked for: a screenshot of small print
    // fitted to the stage is unreadable at 6x. Click past the old ceiling.
    for (let i = 0; i < 20 && !(zoomIn as HTMLButtonElement).disabled; i += 1) {
      fireEvent.click(zoomIn);
    }

    expect(style()).toContain('scale(12)');
    expect(label.textContent).toBe('12\u00d7');
    expect((zoomIn as HTMLButtonElement).disabled).toBe(true);

    // And the way back down is still open from the top.
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(style()).toContain('scale(8)');
  });

  it('scales the picture from the box the fit produced, and says so', () => {
    openViewer();

    const label = screen.getByRole('button', { name: 'Reset zoom' });
    expect(label.textContent).toBe('Fit');

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(document.getElementById('imageViewerImage')?.getAttribute('style'))
      .toContain('scale(1.5)');
    expect(label.textContent).toBe('1.5×');

    fireEvent.click(label);
    expect(label.textContent).toBe('Fit');
    expect(document.getElementById('imageViewerImage')?.getAttribute('style'))
      .toContain('scale(1)');
  });
});

/**
 * The one fact about the picture that is not in the component: how sharply it
 * is drawn once it is zoomed. jsdom lays nothing out, so this comes off the
 * stylesheet itself, the way the other CSS guards in this tree do.
 */
describe('the zoomed picture stays sharp', () => {
  const css = readFileSync(
    path.join(path.resolve(__dirname, '../..'), 'src/workspace.css'),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '');
  /** The body of one rule, found by its exact selector: the selector has to
   *  start the line (or follow the previous rule's brace), so asking for
   *  `.ivimage` cannot be answered by `.ivstage.dragging .ivimage`. */
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return css.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'))?.[1] ?? '';
  };

  it('lets the name in the head be selected, though the viewer is not', () => {
    // The dialog refuses selection so a drag on the stage pans; the name
    // inherited that and could not be copied by hand (note #561).
    expect(rule('.imageviewer, .pdfviewer')).toContain('user-select: none');
    expect(rule('.ivname')).toMatch(/(^|[^-])user-select: text/);
    expect(rule('.ivname')).toContain('-webkit-user-select: text');
  });

  it('draws the copy icon with no plate behind it, hovered or not', () => {
    // A background behind the tick read as too heavy beside the name (#1024).
    expect(css.match(/\.ivcopy[^{]*\{[^}]*\}/g)?.join('\n') ?? '').not.toMatch(/background/);
  });

  it('promotes the picture to its own layer only while a gesture moves it', () => {
    // A promoted layer is rasterised once and then STRETCHED by the
    // transform instead of being redrawn at the scale on screen. Standing
    // still at 12x (note #522) that is the difference between reading the
    // small print and guessing at it, so `.ivimage` must not carry it.
    expect(rule('.ivimage')).not.toContain('will-change');
    // During a drag it is exactly what is wanted: only the translation
    // changes, so the cached texture is still exact and the pan stays off
    // the paint thread.
    expect(rule('.ivstage.dragging .ivimage')).toContain('will-change: transform');
  });
});
