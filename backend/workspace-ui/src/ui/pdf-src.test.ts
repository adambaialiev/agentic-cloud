import { describe, expect, it } from 'vitest';
import { pdfPreviewSrc, pdfReadingSrc } from './pdf-src.js';

describe('how a PDF is asked to be drawn', () => {
  it('fits the page to the frame’s width, keeping the signed query intact', () => {
    // The query is the signature: strip a character of it and the media host
    // refuses the read.
    expect(pdfReadingSrc('https://media.example/doc.pdf?sig=abc&exp=1'))
      .toBe('https://media.example/doc.pdf?sig=abc&exp=1#view=FitH');
  });

  it('asks a preview for page one with the controls turned off', () => {
    expect(pdfPreviewSrc('https://media.example/doc.pdf'))
      .toBe('https://media.example/doc.pdf#page=1&toolbar=0&navpanes=0&scrollbar=0&statusbar=0&view=FitH');
  });

  it('replaces a fragment already on the URL rather than hiding behind it', () => {
    // A browser reads the LAST `#`, so appending to a URL that has one leaves
    // our reading inside somebody else's fragment, where it means nothing.
    expect(pdfReadingSrc('https://media.example/doc.pdf#page=9')).toBe('https://media.example/doc.pdf#view=FitH');
    expect(pdfPreviewSrc('https://media.example/doc.pdf?sig=a#zoom=200'))
      .toBe('https://media.example/doc.pdf?sig=a#page=1&toolbar=0&navpanes=0&scrollbar=0&statusbar=0&view=FitH');
  });
});
