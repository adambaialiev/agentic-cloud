/**
 * What leaves a note on the clipboard (note #262).
 *
 * A pure test, because every one of these is a LINE somebody would notice the
 * loss of the moment they pasted: a shopping list that arrives as one
 * run-on sentence, a heading welded to the sentence under it, a command whose
 * indentation is gone. The rendered screen cannot hold any of that — it shows
 * the shape, and the shape is exactly what plain text has to carry across.
 */

import { describe, expect, it } from 'vitest';
import { noteClipboardText } from './note-clipboard.js';

const copied = (html: string): string => noteClipboardText({ html });

describe('a note on the clipboard', () => {
  it('keeps a blank line between blocks, and the title with them', () => {
    expect(copied('<h2>Wifi</h2><p>The code is 4417.</p>'))
      .toBe('Wifi\n\nThe code is 4417.');
  });

  it('keeps a list a list, bulleted or numbered', () => {
    expect(copied('<p>Shopping</p><ul><li>milk</li><li>eggs</li></ul>'))
      .toBe('Shopping\n\n- milk\n- eggs');
    expect(copied('<ol><li>Ring the bell</li><li>Wait</li></ol>'))
      .toBe('1. Ring the bell\n2. Wait');
    expect(copied('<ol start="3"><li>Wait</li></ol>')).toBe('3. Wait');
  });

  it('breaks where a <br> breaks, which is how a typed note is stored', () => {
    expect(copied('<p>Call the plumber<br>He is closed Mondays</p>'))
      .toBe('Call the plumber\nHe is closed Mondays');
  });

  it('keeps every space inside a preformatted run, and none around it', () => {
    expect(copied('<p>Run</p><pre><code>  npm ci\n  npm test\n</code></pre>'))
      .toBe('Run\n\n  npm ci\n  npm test');
  });

  it('reads inline markup as the one sentence it is', () => {
    expect(copied('<p>The <b>code</b> is <a href="https://x.test">here</a>.</p>'))
      .toBe('The code is here.');
    // Two runs each bringing a space to the same gap is still one space.
    expect(copied('<p><b>Ring </b> <i>the bell</i></p>')).toBe('Ring the bell');
  });

  it('lays a table out row by row', () => {
    expect(copied('<table><thead><tr><th>Day</th><th>Who</th></tr></thead><tbody><tr><td>Mon</td><td>Ana</td></tr></tbody></table>'))
      .toBe('Day · Who\nMon · Ana');
  });

  it('gives the entities back as the characters they stand for', () => {
    expect(copied('<p>Tom &amp; Jerry &lt;3</p>')).toBe('Tom & Jerry <3');
  });

  it('takes nothing from a picture or a drawing — they are not words', () => {
    expect(copied('<p>Chart</p><figure><img src="files/c.png" alt="A chart"><svg><text>42</text></svg></figure>'))
      .toBe('Chart');
  });

  it('opens on the first word, whatever the markup opens on', () => {
    expect(copied('\n  <div>\n    <p>Wifi</p>\n  </div>\n')).toBe('Wifi');
    expect(copied('')).toBe('');
    expect(copied('<p></p>')).toBe('');
  });

  it('copies the reader’s OWN note as they typed it, not as it was rendered', () => {
    // The Workspace's own composer keeps the source; the note's HTML is what
    // the server made of it, and the indentation did not survive that trip.
    expect(noteClipboardText({ html: '<p>Shopping<br>- milk</p>', text: 'Shopping\n  - milk' }))
      .toBe('Shopping\n  - milk');
    // An agent's note arrives as markup alone, and is read from it.
    expect(noteClipboardText({ html: '<p>Shopping</p>' })).toBe('Shopping');
  });
});
