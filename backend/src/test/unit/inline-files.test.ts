import { describe, expect, it } from 'vitest';
import { canServeInline, isAudioFile, isHtmlFile, isInlineImageFile, isMarkdownFile, isPdfFile, isVideoFile } from '../../shared/inline-files.js';

/**
 * The one rule two halves of the product read: the routes that sign a read
 * URL, and the shell that decides what to draw. Both of them are wrong in the
 * same direction if this drifts — a file drawn on one screen and downloaded
 * on the next — so the cases here are the ones that would drift.
 */
describe('what a browser may open rather than save', () => {
  it('takes a PDF by its stored type, whatever the name says', () => {
    expect(isPdfFile('application/pdf', 'design-review.pdf')).toBe(true);
    // A charset or a parameter on the end is the same claim.
    expect(isPdfFile('APPLICATION/PDF; charset=binary', 'x')).toBe(true);
    expect(isPdfFile('application/x-pdf', 'old.pdf')).toBe(true);
    expect(isPdfFile('image/png', 'lying.pdf')).toBe(false);
    expect(isPdfFile('text/html', 'report.pdf')).toBe(false);
  });

  it('falls back to the name only when nothing was claimed about the bytes', () => {
    // `application/octet-stream` is the ABSENCE of a claim — every raw-bytes
    // upload sends it — and the name is the better witness in that case, the
    // same deference `inferContentType` already makes for a picture.
    expect(isPdfFile('application/octet-stream', 'menu.pdf')).toBe(true);
    expect(isPdfFile(undefined, 'menu.pdf')).toBe(true);
    expect(isPdfFile('', 'MENU.PDF')).toBe(true);
    expect(isPdfFile('application/octet-stream', 'menu.zip')).toBe(false);
    expect(isPdfFile('application/octet-stream', 'pdf')).toBe(false);
    expect(isPdfFile('application/octet-stream', undefined)).toBe(false);
  });

  it('keeps SVG out of what may be served inline', () => {
    // The reason the shell has always given: it is a document that can carry
    // script, not a picture — and this flag is what decides whether a browser
    // is invited to open a stored object at all.
    expect(isInlineImageFile('image/svg+xml')).toBe(false);
    expect(canServeInline('image/svg+xml', 'diagram.svg')).toBe(false);
    expect(isInlineImageFile('image/png')).toBe(true);
    expect(isInlineImageFile('text/html')).toBe(false);
  });

  it('takes an HTML page by its stored type, and by its name only when nothing was claimed', () => {
    // Note #557: a report an agent wrote as a page opens where a PDF opens.
    expect(isHtmlFile('text/html; charset=utf-8', 'report.html')).toBe(true);
    expect(isHtmlFile('TEXT/HTML', 'x')).toBe(true);
    expect(isHtmlFile('application/xhtml+xml', 'page.xhtml')).toBe(true);
    expect(isHtmlFile('application/octet-stream', 'report.html')).toBe(true);
    expect(isHtmlFile(undefined, 'REPORT.HTM')).toBe(true);
    // A claim that it is something else wins over the name, both ways.
    expect(isHtmlFile('text/plain', 'report.html')).toBe(false);
    expect(isHtmlFile('image/png', 'lying.html')).toBe(false);
    expect(isHtmlFile('application/octet-stream', 'report.txt')).toBe(false);
    expect(isHtmlFile('application/octet-stream', undefined)).toBe(false);
  });

  it('knows a Markdown file by its type, or by its name when the type says only "text" or nothing (note #677)', () => {
    expect(isMarkdownFile('text/markdown; charset=utf-8', 'plan.md')).toBe(true);
    expect(isMarkdownFile('text/x-markdown', 'x')).toBe(true);
    expect(isMarkdownFile('application/octet-stream', 'SHIP-IT.MD')).toBe(true);
    expect(isMarkdownFile(undefined, 'notes.markdown')).toBe(true);
    // How several phones label a `.md` they did not recognise.
    expect(isMarkdownFile('text/plain', 'plan.md')).toBe(true);
    expect(isMarkdownFile('text/plain', 'plan.txt')).toBe(false);
    // A claim that it is something else wins over the name.
    expect(isMarkdownFile('application/zip', 'plan.md')).toBe(false);
    expect(isMarkdownFile('text/html', 'plan.md')).toBe(false);
    expect(isMarkdownFile('application/octet-stream', 'md')).toBe(false);
    // Drawn from its words by the Workspace, never handed to a browser to open.
    expect(canServeInline('text/markdown', 'plan.md')).toBe(false);
  });

  it('knows a video or a recording by its stored type, and by its name only when nothing was claimed (note #693)', () => {
    expect(isVideoFile('video/mp4', 'agenticcloud-second-brain.mp4')).toBe(true);
    expect(isVideoFile('VIDEO/QUICKTIME', 'IMG_0412.MOV')).toBe(true);
    expect(isVideoFile('application/octet-stream', 'clip.webm')).toBe(true);
    expect(isVideoFile(undefined, 'CLIP.M4V')).toBe(true);
    expect(isAudioFile('audio/mpeg', 'voiceover.mp3')).toBe(true);
    expect(isAudioFile('audio/webm; codecs=opus', 'x')).toBe(true);
    expect(isAudioFile('application/octet-stream', 'take-2.m4a')).toBe(true);
    // A claim that it is something else wins over the name, both ways.
    expect(isVideoFile('text/html', 'clip.mp4')).toBe(false);
    expect(isAudioFile('application/zip', 'song.mp3')).toBe(false);
    expect(isVideoFile('audio/mpeg', 'song.mp3')).toBe(false);
    // A container no browser here plays stays a download when nothing vouched for it.
    expect(isVideoFile('application/octet-stream', 'movie.avi')).toBe(false);
    expect(isVideoFile('application/octet-stream', 'mp4')).toBe(false);
  });

  it('admits pictures, PDFs, HTML pages, videos and recordings, and nothing else', () => {
    expect(canServeInline('image/jpeg', 'shot.jpg')).toBe(true);
    expect(canServeInline('application/pdf', 'report.pdf')).toBe(true);
    expect(canServeInline('text/html', 'page.html')).toBe(true);
    expect(canServeInline('application/octet-stream', 'page.html')).toBe(true);
    expect(canServeInline('video/mp4', 'demo.mp4')).toBe(true);
    expect(canServeInline('audio/mpeg', 'voiceover.mp3')).toBe(true);
    expect(canServeInline('application/octet-stream', 'demo.mov')).toBe(true);
    expect(canServeInline('application/zip', 'export.zip')).toBe(false);
    expect(canServeInline('text/markdown', 'notes.md')).toBe(false);
    // Markup that is not a page stays a download: an SVG is a document that
    // can carry script, and XML is data.
    expect(canServeInline('image/svg+xml', 'diagram.svg')).toBe(false);
    expect(canServeInline('application/xml', 'feed.xml')).toBe(false);
  });
});
