import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { Diff } from './Diff.js';
import { DIFF_LINE_CAP, parseDiff } from './diff.js';
import { HTML_BLOCK_TAGS, HTML_INLINE_TAGS } from './html-runs.js';
import { KnowledgeHtml } from './KnowledgeHtml.js';
import { KNOWLEDGE_TAGS } from './knowledge-html.js';
import { diffOps, knowledgePatch } from './knowledge-diff.js';
import { Markdown } from './Markdown.js';
import type { NoteRefs } from './note-refs.js';

/**
 * The three secure renderers the decision screens are built from, held to
 * exactly what the legacy page's own tests hold them to: the markdown a
 * write-up is, the patch a change is, and the allowlisted HTML a knowledge
 * page is. The invariant under all three is that no byte of agent-written
 * content ever becomes live markup.
 */

const draw = (node: React.ReactElement) => render(node).container;

describe('the write-up renderer', () => {
  it('renders markdown structure — headings, emphasis, links, lists, tables, code', () => {
    const box = draw(<Markdown source={[
      '# Title',
      '',
      'Some **bold** and *italic* and `code` and [a link](https://example.com/x).',
      '',
      '- one',
      '- two',
      '',
      '1. first',
      '',
      '> quoted',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      '---',
    ].join('\n')} />);
    expect(box.querySelector('.md h1')!.textContent).toBe('Title');
    expect(box.querySelector('strong')!.textContent).toBe('bold');
    expect(box.querySelector('em')!.textContent).toBe('italic');
    expect(box.querySelector('p code')!.textContent).toBe('code');
    const link = box.querySelector('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://example.com/x');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect([...box.querySelectorAll('ul li')].map((li) => li.textContent)).toEqual(['one', 'two']);
    expect(box.querySelector('ol li')!.textContent).toBe('first');
    expect(box.querySelector('blockquote p')!.textContent).toBe('quoted');
    expect([...box.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['a', 'b']);
    expect([...box.querySelectorAll('tbody td')].map((td) => td.textContent)).toEqual(['1', '2']);
    // The fence's info string names the language, as DATA, never as markup.
    expect(box.querySelector('pre code')!.getAttribute('data-lang')).toBe('ts');
    expect(box.querySelector('pre code')!.textContent).toBe('const x = 1;');
    expect(box.querySelector('hr')).toBeTruthy();
  });

  it('puts every table inside a sideways scroller', () => {
    const box = draw(<Markdown source={'| a |\n| - |\n| 1 |'} />);
    expect(box.querySelector('.tablewrap > table')).toBeTruthy();
  });

  it('keeps numbered sections counting when bullet details split their lists', () => {
    const box = draw(<Markdown source={[
      '1. **Workspace and data**',
      '',
      '- Keep the room namespace.',
      '',
      '2. **Backend permissions**',
      '',
      '- Keep owner checks.',
      '',
      '3. **Full runtime**',
    ].join('\n')} />);
    const lists = [...box.querySelectorAll('ol')];
    expect(lists).toHaveLength(3);
    expect(lists.map((list) => list.start)).toEqual([1, 2, 3]);
    expect([...box.querySelectorAll('ol > li')].map((item) => item.textContent)).toEqual([
      'Workspace and data',
      'Backend permissions',
      'Full runtime',
    ]);
  });

  it('nests an indented item under the one above it (note #565)', () => {
    const box = draw(<Markdown source={[
      '- **Repositories:**',
      '  - The full history is copied.',
      '  - The clone address changes.',
      '- **Sites:** rebuilt in the destination.',
      '1. Numbered',
      '   - detail',
      '',
      '     - deeper, after a blank line',
      '2. Next',
    ].join('\n')} />);
    const top = box.querySelector('.md > ul')!;
    expect([...top.children].map((li) => li.firstChild!.textContent)).toEqual(['Repositories:', 'Sites:']);
    expect([...top.querySelectorAll(':scope > li:first-child > ul > li')].map((li) => li.textContent))
      .toEqual(['The full history is copied.', 'The clone address changes.']);
    const lists = [...box.querySelectorAll('.md > ol')];
    expect(lists).toHaveLength(1);
    expect([...lists[0]!.children].map((li) => li.firstChild!.textContent)).toEqual(['Numbered', 'Next']);
    expect(lists[0]!.querySelector('li > ul > li')!.firstChild!.textContent).toBe('detail');
    expect(lists[0]!.querySelector('li > ul > li > ul > li')!.textContent).toBe('deeper, after a blank line');
  });

  it('starts a new list when the kind changes at the same level', () => {
    const box = draw(<Markdown source={'1. **One**\n- detail\n2. **Two**'} />);
    expect([...box.querySelectorAll('.md > *')].map((node) => node.tagName)).toEqual(['OL', 'UL', 'OL']);
    expect([...box.querySelectorAll('.md > ol')].map((list) => (list as HTMLOListElement).start)).toEqual([1, 2]);
  });

  it('never turns a write-up into live markup, whatever it contains', () => {
    const box = draw(<Markdown source={[
      '<img src=x onerror="alert(1)">',
      '',
      '[click](javascript:alert(1))',
      '',
      '<script>alert(2)</script>',
    ].join('\n')} />);
    expect(box.querySelector('script')).toBeNull();
    // The image tag is TEXT, not an element: nothing here parsed as HTML.
    expect(box.querySelectorAll('img').length).toBe(0);
    expect(box.textContent).toContain('<img src=x onerror="alert(1)">');
    // A `javascript:` target never becomes an href at all — the words stay.
    expect(box.querySelector('a')).toBeNull();
    expect(box.textContent).toContain('[click](javascript:alert(1))');
  });

  it('links a bare URL, and leaves anything that is not http(s) as words', () => {
    expect(draw(<Markdown source="go to https://example.com/a" />).querySelector('a')!.textContent)
      .toBe('https://example.com/a');
    for (const source of ['[x](/local/path)', '[x](#anchor)', '![x](javascript:alert(1))']) {
      const box = draw(<Markdown source={source} />);
      expect(box.querySelector('a')).toBeNull();
      expect(box.querySelector('img')).toBeNull();
      expect(box.textContent).toContain('x');
    }
  });

  it('leaves the sentence’s punctuation out of a bare URL (note #686)', () => {
    const box = draw(<Markdown source="Your build is live at https://ship-it.agentbuilt.app." />);
    const link = box.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://ship-it.agentbuilt.app');
    expect(link.textContent).toBe('https://ship-it.agentbuilt.app');
    // The full stop is still on the page, as words after the link.
    expect(box.textContent).toBe('Your build is live at https://ship-it.agentbuilt.app.');
    const cases: [string, string][] = [
      ['See https://example.com/a, then', 'https://example.com/a'],
      ['Ready? https://example.com/a?q=1!', 'https://example.com/a?q=1'],
      ['it said "https://example.com/a".', 'https://example.com/a'],
      ['is it https://example.com/a?', 'https://example.com/a'],
      ['open https://example.com/a...', 'https://example.com/a'],
      // Punctuation INSIDE the address is the address's.
      ['at https://example.com/v1.2/a_b?x=a.b;c=d.', 'https://example.com/v1.2/a_b?x=a.b;c=d'],
      ['home https://example.com/', 'https://example.com/'],
    ];
    for (const [source, href] of cases) {
      expect(draw(<Markdown source={source} />).querySelector('a')!.getAttribute('href')).toBe(href);
    }
  });

  it('takes an extra class on the container, and only there', () => {
    const box = draw(<Markdown source="words" className="chatmarkdown" />);
    expect(box.querySelector('.md.chatmarkdown')).toBeTruthy();
  });
});

/**
 * A write-up arrives in HTML often enough to matter (note #317): every quick
 * note and knowledge page on this platform is written in it, so agents write
 * proposals that way too, and their tags used to be read out as words.
 *
 * What is held here is the LINE — what becomes markup and what stays the
 * characters an author typed — because getting that wrong in either direction
 * loses somebody's words.
 */
describe('a write-up written in HTML', () => {
  it('renders HTML blocks, and the markdown around them', () => {
    const box = draw(<Markdown source={[
      '<p><strong>What changed:</strong> the deploy rolls itself back.</p>',
      '<ul><li>one</li><li>two</li></ul>',
      '',
      'And **markdown** after it, with `code`.',
    ].join('\n')} />);
    expect(box.querySelector('.md p strong')!.textContent).toBe('What changed:');
    expect([...box.querySelectorAll('.md li')].map((li) => li.textContent)).toEqual(['one', 'two']);
    // The tags are gone from the words, which is the whole complaint.
    expect(box.textContent).not.toContain('<p>');
    expect(box.textContent).not.toContain('</strong>');
    expect(box.querySelector('.md p em')).toBeNull();
    expect(box.querySelector('.md p + .htmlrun')).toBeNull();
    const markdown = [...box.querySelectorAll('.md > p')].pop()!;
    expect(markdown.querySelector('strong')!.textContent).toBe('markdown');
    expect(markdown.querySelector('code')!.textContent).toBe('code');
  });

  it('lets an HTML block interrupt a paragraph, as a heading or a list does', () => {
    // Nobody types a blank line between "Here is what changed:" and the list
    // that answers it.
    const box = draw(<Markdown source={'Here is what changed:\n<ul><li>one</li></ul>'} />);
    expect(box.querySelector('.md > p')!.textContent).toBe('Here is what changed:');
    expect(box.querySelector('.md li')!.textContent).toBe('one');
  });

  it('renders a matched pair of an inline tag inside markdown', () => {
    const box = draw(<Markdown source={'- <b>Tap a heading to sort</b> — by who has the most\n- and <i>you</i> stay signed in<br>next line'} />);
    expect(box.querySelector('li b')!.textContent).toBe('Tap a heading to sort');
    expect(box.querySelector('li i')!.textContent).toBe('you');
    expect(box.querySelector('li br')).toBeTruthy();
    expect(box.textContent).not.toContain('<b>');
  });

  it('leaves a tag QUOTED in prose exactly as it was written', () => {
    // A block tag mid-sentence is an example, not a paragraph: this is the
    // line an agent's own write-up about quick notes stands on.
    const box = draw(<Markdown source={'Run agentbuilt note add "<h2>Wifi</h2><p>The code is 4417.</p>"'} />);
    expect(box.querySelector('h2')).toBeNull();
    expect(box.textContent).toContain('"<h2>Wifi</h2><p>The code is 4417.</p>"');
  });

  it('leaves a tag nobody closed, and a tag nothing renders, as words', () => {
    const box = draw(<Markdown source={'The <Markdown> component takes a <div and Array<string> stays itself.'} />);
    expect(box.querySelector('.md div')).toBeNull();
    expect(box.textContent).toBe('The <Markdown> component takes a <div and Array<string> stays itself.');
  });

  it('leaves HTML inside a fence as the example it is', () => {
    const box = draw(<Markdown source={'```html\n<p>hello</p>\n```'} />);
    expect(box.querySelector('pre code')!.textContent).toBe('<p>hello</p>');
    expect(box.querySelector('.md > .htmlrun')).toBeNull();
  });

  it('never turns HTML into live markup, and drops what the allowlist drops', () => {
    const box = draw(<Markdown source={[
      '<p onclick="alert(1)" style="color:red">words <script>alert(2)</script></p>',
      '',
      '<div><a href="javascript:alert(3)">link</a> and <a href="https://example.com/x">out</a></div>',
    ].join('\n')} />);
    const paragraph = box.querySelector('.md p')!;
    expect(paragraph.textContent).toContain('words');
    expect(paragraph.getAttribute('onclick')).toBeNull();
    expect(paragraph.getAttribute('style')).toBeNull();
    expect(box.querySelector('script')).toBeNull();
    // A refused target keeps its words and stops being a target at all; a
    // real one opens outside this app, as every link a renderer builds does.
    const links = [...box.querySelectorAll('.md a')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual([null, 'https://example.com/x']);
    expect(links[1]!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(box.textContent).toContain('link');
  });

  it('turns a note named inside an HTML run into a door to it', () => {
    const box = draw(
      <MemoryRouter><Markdown source="<p>Rebased for note #284.</p>" notes={noteRefs()} /></MemoryRouter>,
    );
    const link = box.querySelector('.md p a.noteref') as HTMLAnchorElement;
    expect(link.textContent).toBe('note #284');
    expect(link.getAttribute('href')).toBe('/notes/284?org=o1');
  });

  it('names only tags the walker will actually build', () => {
    for (const tag of [...HTML_BLOCK_TAGS, ...HTML_INLINE_TAGS]) expect(KNOWLEDGE_TAGS.has(tag)).toBe(true);
  });
});

/**
 * A note named in written words is a door to it — in a write-up, in a chat
 * message, in a quick note, in a margin remark (notes #263 and #284). Both
 * renderers are held to the same three things: the phrase becomes a link, a
 * number the words did not call a note stays ink, and the source's own
 * characters are all still there.
 */

const noteRefs = (open: (number: number) => void = () => {}): NoteRefs => ({
  link: (number) => ({ href: `/notes/${number}?org=o1`, to: `/notes/${number}?org=o1` }),
  open,
});

/** Without a `notes` of its own a renderer draws exactly what it drew before,
 *  which is what a repository's README still gets. */
const noRefs: NoteRefs = { link: () => null, open: () => {} };

describe('a note named in the words', () => {
  const drawn = (node: React.ReactElement) => render(<MemoryRouter>{node}</MemoryRouter>).container;

  it('is a link in a write-up, and a bare number is not', () => {
    const box = drawn(<Markdown source="PR #560 closes note #284." notes={noteRefs()} />);
    const links = Array.from(box.querySelectorAll('a.noteref'));
    expect(links.map((link) => link.textContent)).toEqual(['note #284']);
    expect(links[0]!.getAttribute('href')).toBe('/notes/284?org=o1');
    expect(box.textContent).toBe('PR #560 closes note #284.');
  });

  it('stays words where the author already said what they meant', () => {
    for (const source of ['`note #284`', '[note #284](https://example.com/x)']) {
      const box = drawn(<Markdown source={source} notes={noteRefs()} />);
      expect(box.querySelector('a.noteref'), source).toBeNull();
    }
  });

  it('keeps the mention inside emphasis and lists', () => {
    const box = drawn(<Markdown source={'- **note #12** and note #13'} notes={noteRefs()} />);
    expect(Array.from(box.querySelectorAll('li a.noteref')).map((link) => link.textContent))
      .toEqual(['note #12', 'note #13']);
    expect(box.querySelector('strong a.noteref')).toBeTruthy();
  });

  it('follows a list only as far as the words run', () => {
    // "**note #12** and #13" is two runs to this renderer, and the second one
    // has no anchor in it — a bare number that formatting cut off from the
    // note that named it is left as the number it is.
    const box = drawn(<Markdown source={'**note #12** and #13'} notes={noteRefs()} />);
    expect(Array.from(box.querySelectorAll('a.noteref')).map((link) => link.textContent))
      .toEqual(['note #12']);
  });

  it('is a link in a quick note, and follows without reloading the shell', () => {
    const open = vi.fn();
    const box = drawn(<KnowledgeHtml source="<p>see note #284, and PR #560</p>" noteRefs={noteRefs(open)} />);
    const link = box.querySelector('a.noteref')!;
    expect(link.textContent).toBe('note #284');
    // A REAL address: copyable, and openable in another tab by the browser.
    expect(link.getAttribute('href')).toBe('/notes/284?org=o1');
    expect(box.textContent).toBe('see note #284, and PR #560');
    const plain = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    fireEvent(link, plain);
    expect(open).toHaveBeenCalledWith(284);
    expect(plain.defaultPrevented).toBe(true);
  });

  it('leaves a modifier-click to the browser', () => {
    const open = vi.fn();
    const box = drawn(<KnowledgeHtml source="<p>note #284</p>" noteRefs={noteRefs(open)} />);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true });
    fireEvent(box.querySelector('a.noteref')!, event);
    expect(open).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('never puts a link inside a link, inside code, or in a drawing', () => {
    const box = drawn(
      <KnowledgeHtml
        source={'<p><a href="https://example.com/x">note #1</a></p><pre><code>note #2</code></pre>'
          + '<svg viewBox="0 0 10 10"><text>note #3</text></svg>'
          // Deeper in: emphasis inside a link is still inside that link.
          + '<p><a href="https://example.com/y">see <strong>note #4</strong></a></p>'}
        noteRefs={noteRefs()}
      />,
    );
    expect(box.querySelector('a.noteref')).toBeNull();
    expect(box.querySelectorAll('a').length).toBe(2);
  });

  it('draws the words unchanged when there is nothing to link to yet', () => {
    const box = drawn(<KnowledgeHtml source="<p>note #284</p>" noteRefs={noRefs} />);
    expect(box.querySelector('a')).toBeNull();
    expect(box.textContent).toBe('note #284');
  });
});

const PATCH = [
  'diff --git a/src/one.ts b/src/one.ts',
  'index 111..222 100644',
  '--- a/src/one.ts',
  '+++ b/src/one.ts',
  '@@ -1,3 +1,3 @@',
  ' kept',
  '-gone',
  '+new',
  'diff --git a/docs/two.md b/docs/two.md',
  '@@ -1,2 +1,2 @@',
  ' intro',
  '---',
  '+++',
].join('\n');

describe('the diff renderer', () => {
  it('is one card per changed file, byte for byte, with each file’s own counts', () => {
    const box = draw(<Diff patch={PATCH} />);
    const cards = box.querySelectorAll('.difffile');
    expect(cards.length).toBe(2);
    // The b/ side names the file as it will exist after the merge.
    expect([...box.querySelectorAll('.diffpath')].map((node) => node.textContent))
      .toEqual(['src/one.ts', 'docs/two.md']);
    const first = cards[0]!;
    expect(first.querySelector('.plus')!.textContent).toBe('+1');
    expect(first.querySelector('.minus')!.textContent).toBe('−1');
    const lines = [...first.querySelectorAll('.difflines > div')];
    expect(lines.map((node) => `${node.className}:${node.textContent}`)).toEqual([
      'hunk:@@ -1,3 +1,3 @@', 'ctx: kept', 'del:-gone', 'add:+new',
    ]);
  });

  it('keeps a removed markdown rule a removal — headers only exist before the first @@', () => {
    const second = draw(<Diff patch={PATCH} />).querySelectorAll('.difffile')[1]!;
    const kinds = [...second.querySelectorAll('.difflines > div')].map((node) => node.className);
    expect(kinds).toEqual(['hunk', 'ctx', 'del', 'add']);
    expect(second.querySelector('.minus')!.textContent).toBe('−1');
  });

  it('hides a card’s lines while it is closed, and opens the one caller that IS the diff', () => {
    const closed = draw(<Diff patch={PATCH} />).querySelector('.difffile')!;
    expect(closed.className).toContain('closed');
    expect(closed.querySelector('.diffhead')!.getAttribute('aria-expanded')).toBe('false');
    const open = draw(<Diff patch={PATCH} open />).querySelector('.difffile')!;
    expect(open.className).not.toContain('closed');
    expect(open.querySelector('.diffhead')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('stops at the cap and says so rather than building tens of thousands of nodes', () => {
    const huge = ['diff --git a/big.txt b/big.txt', '@@ -1 +1 @@']
      .concat(Array.from({ length: DIFF_LINE_CAP + 200 }, (_, at) => `+line ${at}`))
      .join('\n');
    expect(parseDiff(huge).capped).toBe(true);
    const box = draw(<Diff patch={huge} />);
    expect(box.querySelectorAll('.difflines > div').length).toBe(DIFF_LINE_CAP);
    expect(box.querySelector('.empty')!.textContent)
      .toBe(`This diff is longer than what fits here — showing the first ${DIFF_LINE_CAP} lines.`
        + ' `agentbuilt pr diff` has all of it.');
  });
});

describe('the knowledge renderer', () => {
  it('keeps the structure a document is made of', () => {
    const box = draw(<KnowledgeHtml source={
      '<h2>Head</h2><p>Words with <strong>weight</strong> and <code>code</code>.</p>'
      + '<ul><li>one</li></ul><table><tr><td>cell</td></tr></table>'
    } />);
    expect(box.querySelector('.kpage h2')!.textContent).toBe('Head');
    expect(box.querySelector('strong')!.textContent).toBe('weight');
    expect(box.querySelector('code')!.textContent).toBe('code');
    expect(box.querySelector('li')!.textContent).toBe('one');
    expect(box.querySelector('td')!.textContent).toBe('cell');
  });

  it('gives every table a sideways scroller of its own', () => {
    const box = draw(<KnowledgeHtml source="<table><tr><td>1</td></tr></table>" />);
    expect(box.querySelector('.kpage > .tablewrap > table')).toBeTruthy();
  });

  it('draws inline SVG in the SVG namespace, or it would render nothing at all', () => {
    const box = draw(<KnowledgeHtml source='<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>' />);
    const svg = box.querySelector('svg')!;
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg.getAttribute('viewBox')).toBe('0 0 10 10');
    expect(box.querySelector('circle')!.namespaceURI).toBe('http://www.w3.org/2000/svg');
  });

  it('drops script entirely — tag, contents and all', () => {
    const box = draw(<KnowledgeHtml source={'<p>before</p><script>alert(1)</script><p>after</p>'} />);
    expect(box.querySelector('script')).toBeNull();
    expect(box.textContent).toBe('beforeafter');
  });

  it('drops event handlers and author styling, keeping the text', () => {
    const box = draw(<KnowledgeHtml source={'<p onclick="alert(1)" style="color:red" title="ok">words</p>'} />);
    const p = box.querySelector('p')!;
    expect(p.getAttribute('onclick')).toBeNull();
    expect(p.getAttribute('style')).toBeNull();
    expect(p.getAttribute('title')).toBe('ok');
    expect(p.textContent).toBe('words');
  });

  it('refuses a javascript: link but keeps its words, and sends real links out of the app', () => {
    const box = draw(<KnowledgeHtml source={
      '<a href="javascript:alert(1)">bad</a><a href="https://example.com">good</a>'
    } />);
    const links = [...box.querySelectorAll('a')];
    expect(links[0]!.getAttribute('href')).toBeNull();
    expect(links[0]!.textContent).toBe('bad');
    expect(links[1]!.getAttribute('href')).toBe('https://example.com');
    expect(links[1]!.getAttribute('target')).toBe('_blank');
    expect(links[1]!.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('drops embedding outright', () => {
    const box = draw(<KnowledgeHtml source={'<iframe src="https://example.com"></iframe><object></object><p>k</p>'} />);
    expect(box.querySelector('iframe')).toBeNull();
    expect(box.querySelector('object')).toBeNull();
    expect(box.querySelector('p')!.textContent).toBe('k');
  });

  it('says so rather than rendering a blank screen', () => {
    const box = draw(<KnowledgeHtml source="" empty="This note is empty." />);
    expect(box.querySelector('.kpage .empty')!.textContent).toBe('This note is empty.');
  });

  it('drops a first heading that only repeats the title the screen already carries', () => {
    const box = draw(<KnowledgeHtml source="<h1>How we deploy</h1><p>body</p>" dropTitle="How we deploy" />);
    expect(box.querySelector('h1')).toBeNull();
    expect(box.querySelector('p')!.textContent).toBe('body');
    const kept = draw(<KnowledgeHtml source="<h1>Something else</h1><p>body</p>" dropTitle="How we deploy" />);
    expect(kept.querySelector('h1')!.textContent).toBe('Something else');
  });
});

describe('a page’s own files', () => {
  const files = { 'chart.png': 'https://signed.example/chart?sig=1' };

  it('puts the signed URL in the img, so the page shows the picture', () => {
    const box = draw(<KnowledgeHtml source='<img src="files/chart.png" alt="Chart">' files={files} />);
    const img = box.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(files['chart.png']);
    expect(img.getAttribute('alt')).toBe('Chart');
  });

  it('drops the src when there is no such file, rather than leaving a path this app would fetch', () => {
    const box = draw(<KnowledgeHtml source='<img src="files/missing.png">' files={files} />);
    expect(box.querySelector('img')!.getAttribute('src')).toBeNull();
  });

  it('reads the one shape it accepts, and nothing else', () => {
    for (const bad of ['files/../secret', 'files/a/b.png', 'files/', '/files/chart.png']) {
      const box = draw(<KnowledgeHtml source={`<img src="${bad}">`} files={files} />);
      const src = box.querySelector('img')!.getAttribute('src');
      // Either dropped outright, or left as an ordinary URL the allowlist
      // already judges — never resolved against the page's own file store.
      expect(src === null || src === bad).toBe(true);
      expect(src).not.toBe(files['chart.png']);
    }
  });

  it('does not lend one page’s URLs to whatever is rendered next', () => {
    draw(<KnowledgeHtml source='<img src="files/chart.png">' files={files} />);
    const next = draw(<KnowledgeHtml source='<img src="files/chart.png">' />);
    expect(next.querySelector('img')!.getAttribute('src')).toBeNull();
  });

  it('makes a page’s own picture something the reader can open', () => {
    render(<KnowledgeHtml source='<img src="files/chart.png">' files={files} onImage={() => {}} />);
    const img = screen.getByRole('button', { name: 'Open chart.png' });
    expect(img.classList.contains('openimage')).toBe(true);
  });
});

describe('the diff a knowledge change makes', () => {
  const page = 'runbook.html';
  const before = ['<h1>Runbook</h1>', '<p>one</p>', '<p>two</p>', '<p>three</p>'].join('\n');

  it('is empty when the two versions are the same', () => {
    expect(knowledgePatch(page, before, before)).toBe('');
  });

  it('keeps an untouched page out of the diff and holds three lines of context', () => {
    const long = Array.from({ length: 40 }, (_, at) => `<p>${at}</p>`).join('\n');
    const after = long.replace('<p>20</p>', '<p>twenty</p>');
    const patch = knowledgePatch(page, long, after);
    expect(patch.startsWith(`diff --git a/${page} b/${page}`)).toBe(true);
    const hunks = patch.split('\n').filter((line) => line.startsWith('@@'));
    expect(hunks.length).toBe(1);
    const body = patch.split('\n').slice(2);
    expect(body.filter((line) => line.startsWith(' ')).length).toBe(6);
    expect(body.filter((line) => line.startsWith('-'))).toEqual(['-<p>20</p>']);
    expect(body.filter((line) => line.startsWith('+'))).toEqual(['+<p>twenty</p>']);
  });

  it('gives two far-apart edits a hunk each, and neighbours one hunk between them', () => {
    const long = Array.from({ length: 60 }, (_, at) => `<p>${at}</p>`).join('\n');
    const far = long.replace('<p>5</p>', '<p>five</p>').replace('<p>50</p>', '<p>fifty</p>');
    expect(knowledgePatch(page, long, far).split('\n').filter((l) => l.startsWith('@@')).length).toBe(2);
    const near = long.replace('<p>20</p>', '<p>twenty</p>').replace('<p>23</p>', '<p>twentythree</p>');
    expect(knowledgePatch(page, long, near).split('\n').filter((l) => l.startsWith('@@')).length).toBe(1);
  });

  it('aligns what stayed rather than calling the whole middle new', () => {
    const ops = diffOps('a\nb\nc\nd', 'a\nx\nc\nd');
    expect(ops.map((op) => op.op).join('')).toBe(' -+  ');
  });

  it('gives up on aligning two enormous pages instead of hanging the browser', () => {
    const a = Array.from({ length: 1300 }, (_, at) => `a${at}`).join('\n');
    const b = Array.from({ length: 1300 }, (_, at) => `b${at}`).join('\n');
    const ops = diffOps(a, b);
    expect(ops.every((op) => op.op !== ' ')).toBe(true);
    expect(ops.filter((op) => op.op === '-').length).toBe(1300);
    expect(ops.filter((op) => op.op === '+').length).toBe(1300);
  });

  it('a new page is all additions, and a removal all deletions', () => {
    const created = knowledgePatch(page, '', '<p>one</p>\n<p>two</p>').split('\n').slice(2);
    expect(created.every((line) => line.startsWith('+'))).toBe(true);
    const removed = knowledgePatch(page, '<p>one</p>\n<p>two</p>', '').split('\n').slice(2);
    expect(removed.every((line) => line.startsWith('-'))).toBe(true);
    // Both sides carry the page's own name: git would write /dev/null, and the
    // card would then be titled with it.
    expect(knowledgePatch(page, '<p>x</p>', '').split('\n')[0])
      .toBe(`diff --git a/${page} b/${page}`);
  });
});
