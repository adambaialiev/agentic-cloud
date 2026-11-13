/**
 * The same words as HTML, beside the plain text of a letter an app sends
 * (notes #1112, #1178): paragraphs, line breaks, links as links, a quoted
 * letter as a quote, everything escaped. Nothing is added, so the provider's
 * open pixel has a place and the reader sees exactly the words.
 */
export function mailHtml(text: string): string {
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const linked = (line: string) => escape(line).replace(/https?:\/\/[^\s<>"]+[^\s<>".,;:!?)']/g, (url) => `<a href="${url}">${url}</a>`);
  const blocks: string[] = [];
  const lines = String(text ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  let paragraph: string[] = [];
  let quote: string[] = [];
  const flushParagraph = () => { if (paragraph.length) blocks.push(`<p>${paragraph.map(linked).join('<br>\n')}</p>`); paragraph = []; };
  const flushQuote = () => { if (quote.length) blocks.push(`<blockquote>${mailHtml(quote.join('\n'))}</blockquote>`); quote = []; };
  for (const line of lines) {
    if (/^>/.test(line)) { flushParagraph(); quote.push(line.replace(/^> ?/, '')); continue; }
    flushQuote();
    if (!line.trim()) { flushParagraph(); continue; }
    paragraph.push(line);
  }
  flushParagraph();
  flushQuote();
  return blocks.join('\n');
}
