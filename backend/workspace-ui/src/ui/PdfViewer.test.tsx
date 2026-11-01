import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PdfViewerProvider } from './PdfViewer.js';
import { usePdfViewer } from './usePdfViewer.js';

/**
 * jsdom draws no PDF, and never will — what the pages LOOK like is Chrome's
 * business and the harness's (`scripts/verify-workspace-react-agent-chat.mts`
 * frames a real one and photographs it).
 *
 * What jsdom can hold is the contract around the frame, and every line here
 * is a thing that would fail silently: a `src` without the reading fragment
 * opens a phone at page-fit and nobody can read it; a frame that is not
 * rebuilt on a fresh URL shows the browser's cached copy of an expired one;
 * and a viewer with no way out but Escape strands a reader the moment they
 * click into the document, because the frame owns the key from then on.
 */

function Opener({ url = 'https://signed.example/design-review.pdf', name = 'design-review.pdf', kind, save }: {
  url?: string; name?: string; kind?: 'pdf' | 'html'; save?: () => void;
}) {
  const open = usePdfViewer();
  return <button type="button" onClick={() => open({ url, name, ...(kind ? { kind } : {}), ...(save ? { save } : {}) })}>show</button>;
}

const openViewer = (props: { url?: string; name?: string; kind?: 'pdf' | 'html'; save?: () => void } = {}) => {
  render(<PdfViewerProvider><Opener {...props} /></PdfViewerProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'show' }));
};

const frame = () => document.getElementById('pdfViewerFrame') as HTMLIFrameElement | null;

describe('PdfViewerProvider', () => {
  beforeEach(() => {
    // jsdom implements neither, and the viewer puts the page back on close.
    vi.stubGlobal('scrollTo', vi.fn());
  });

  it('frames the document, fitted to the width, under its own name', () => {
    openViewer();

    const viewer = screen.getByRole('dialog');
    expect(viewer.id).toBe('pdfViewer');
    expect(document.getElementById('pdfViewerName')!.textContent).toBe('design-review.pdf');
    // Fit to the WIDTH: a page fitted to the height of a phone is a page
    // nobody can read.
    expect(frame()!.getAttribute('src')).toBe('https://signed.example/design-review.pdf#view=FitH');
    // Straight off the stage, so the stylesheet's sizing rule reaches it.
    expect(frame()!.parentElement).toBe(document.getElementById('pdfViewerStage'));
    expect(frame()!.getAttribute('title')).toBe('design-review.pdf');
  });

  it('freezes the page under it and puts it back on close', () => {
    openViewer();
    // The same state the picture viewer holds, under the same name: one
    // viewer is up and the page beneath it is held.
    expect(document.body.classList.contains('image-open')).toBe(true);

    fireEvent.click(document.getElementById('pdfViewerClose')!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.classList.contains('image-open')).toBe(false);
  });

  it('closes on Escape while the keyboard is still on its own chrome', () => {
    openViewer();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('offers the way out of the frame that every browser has', () => {
    const opened = vi.fn();
    vi.stubGlobal('open', opened);
    openViewer();

    // The one control in the bar, and it carries the same reading the frame
    // was given: a browser that will not scroll a framed PDF — WebKit has
    // drawn them that way for years — is the whole reason it is there.
    fireEvent.click(document.getElementById('pdfViewerOpenOut')!);
    expect(opened).toHaveBeenCalledWith(
      'https://signed.example/design-review.pdf#view=FitH', '_blank', 'noopener',
    );
  });

  it('rebuilds the frame for a freshly minted URL', () => {
    render(
      <PdfViewerProvider>
        <Opener url="https://signed.example/doc.pdf?sig=one" />
        <Opener url="https://signed.example/doc.pdf?sig=two" />
      </PdfViewerProvider>,
    );
    const [first, second] = screen.getAllByRole('button', { name: 'show' });

    fireEvent.click(first!);
    const before = frame();
    fireEvent.click(second!);
    // A NEW element, not the same one with a new attribute: a signed URL
    // lives fifteen minutes, and the second open is the reader coming back to
    // a document whose first link has expired.
    expect(frame()!.getAttribute('src')).toBe('https://signed.example/doc.pdf?sig=two#view=FitH');
    expect(frame()).not.toBe(before);
  });

  /**
   * Note #557: an HTML page in the same chrome. What jsdom can hold is the
   * contract that makes framing one safe, and each line is a thing that
   * would fail silently: a frame without the sandbox runs the page on the
   * media host's origin; one WITH `allow-same-origin` does the same; the
   * PDF reading fragment on a page is a scroll to an anchor nobody wrote;
   * and the way out of the frame a PDF needs would open the page
   * unsandboxed in a tab.
   */
  it('frames an HTML page sandboxed, without a way out of the frame', () => {
    openViewer({ url: 'https://signed.example/report.html?sig=one', name: 'report.html', kind: 'html' });

    const viewer = screen.getByRole('dialog');
    expect(viewer.id).toBe('pdfViewer');
    expect(viewer.className).toBe('pdfviewer htmlviewer');
    expect(document.getElementById('pdfViewerName')!.textContent).toBe('report.html');
    // The URL as signed, no PDF reading on the end of it.
    expect(frame()!.getAttribute('src')).toBe('https://signed.example/report.html?sig=one');
    // No origin: scripts may run and draw, links may open a tab, and nothing
    // else — not the Workspace, not the media host, not this page's address.
    expect(frame()!.getAttribute('sandbox')).toBe('allow-scripts allow-popups allow-popups-to-escape-sandbox');
    expect(frame()!.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(document.getElementById('pdfViewerOpenOut')).toBeNull();
    // Nothing to save from: the opener supplied no save path.
    expect(document.getElementById('pdfViewerSave')).toBeNull();
  });

  it('puts the opener’s Download beside Close, when it brings one', () => {
    const save = vi.fn();
    openViewer({ url: 'https://signed.example/report.html', name: 'report.html', kind: 'html', save });

    const button = document.getElementById('pdfViewerSave')!;
    expect(button.getAttribute('aria-label')).toBe('Download');
    expect(button.parentElement!.className).toBe('ivhead');
    fireEvent.click(button);
    expect(save).toHaveBeenCalledTimes(1);
    // Saving does not close the page: the reader asked for a copy, not out.
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  // Note #561: the document's head carries the same copyable name.
  it('copies the document name from the icon beside it', async () => {
    const writes: string[] = [];
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: async (text: string) => { writes.push(text); } } });
    openViewer({ url: 'https://signed.example/report.html', name: 'report.html', kind: 'html' });

    expect(document.getElementById('pdfViewerName')!.textContent).toBe('report.html');
    fireEvent.click(document.getElementById('pdfViewerNameCopy')!);
    await waitFor(() => expect(writes).toEqual(['report.html']));
  });

  it('draws a Markdown file as a page of its own words, with no frame (note #677)', () => {
    const save = vi.fn();
    function MarkdownOpener() {
      const open = usePdfViewer();
      return <button type="button" onClick={() => open({ kind: 'markdown', name: 'SHIP-IT.md', text: '# Ship it\n\n- **one** thing\n\n[winners](https://example.com/w)', save })}>show</button>;
    }
    render(<PdfViewerProvider><MarkdownOpener /></PdfViewerProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'show' }));

    const viewer = screen.getByRole('dialog');
    expect(viewer.id).toBe('pdfViewer');
    // Its own class and not the dark viewer's: a page of words wears the
    // Workspace's paper (workspace.css says why).
    expect(viewer.className).toBe('mdviewer');
    expect(document.getElementById('pdfViewerName')!.textContent).toBe('SHIP-IT.md');
    const stage = document.getElementById('pdfViewerStage')!;
    expect(stage.querySelector('.mdsheet .md.mdpage h1')!.textContent).toBe('Ship it');
    expect(stage.querySelector('li strong')!.textContent).toBe('one');
    // Built, never poured: a link opens outside, and nothing is framed.
    expect(stage.querySelector('a')!.getAttribute('target')).toBe('_blank');
    expect(frame()).toBeNull();
    expect(document.getElementById('pdfViewerOpenOut')).toBeNull();
    // The column takes the focus, so the keys that scroll a page scroll it.
    expect(document.activeElement).toBe(stage);
    fireEvent.click(document.getElementById('pdfViewerSave')!);
    expect(save).toHaveBeenCalledTimes(1);
    fireEvent.click(document.getElementById('pdfViewerClose')!);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps a PDF unsandboxed: Chromium blocks its own viewer under one', () => {
    openViewer();
    expect(frame()!.hasAttribute('sandbox')).toBe(false);
    expect(document.getElementById('pdfViewerOpenOut')).not.toBeNull();
  });

  it('opens nothing when there is no URL to open', () => {
    openViewer({ url: '' });

    // A viewer over an empty frame is a black screen with a filename on it —
    // the same rule the picture viewer keeps for a picture that never landed.
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
