import React from 'react';
import { render } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AnswerText } from './agent-text';

void React;

// Note #1051: the guest chat on the home page drew a guest agent's table and
// list as one run-on line. This is Zoe's real reply to Adam (7 Nov 2026,
// 14:21 UTC), the one in the note's screenshot.
const ZOE = `The repository has about **485,000 lines** across 1,561 tracked files. That excludes lockfiles and images, and it counts blank lines and comments.

| Language | Lines |
|---|---|
| TypeScript (\`.ts\`) | ~240,000 |
| TypeScript/React (\`.tsx\`) | ~84,000 |
| Node scripts (\`.mjs\`, \`.js\`) | ~29,000 |
| CSS | ~9,000 |
| Shell scripts | ~5,600 |
| Markdown docs | ~12,000 |

Adding up the code languages (TypeScript, JavaScript, CSS, shell, HTML) gives roughly **370,000 lines of actual code**.

By top-level folder:
- \`backend/\`: ~319,000
- \`src/\` (the front end, plus \`src/docs\`): ~81,000
- \`scripts/\`: ~31,000

Most of the code is in \`backend/\`.`;

function draw(text: string) {
  const { container } = render(<AnswerText text={text} />);
  return container;
}

describe('a guest agent’s answer is drawn as Markdown (note #1051)', () => {
  it('draws Zoe’s table as a table, in a box that scrolls on its own', () => {
    const page = draw(ZOE);
    const box = page.querySelector('[data-answer-table]')!;
    expect(box.className).toContain('overflow-x-auto');
    expect(box.className).toContain('max-w-full');
    expect(box.getAttribute('tabindex')).toBe('0');
    const heads = [...box.querySelectorAll('thead th')].map((cell) => cell.textContent);
    expect(heads).toEqual(['Language', 'Lines']);
    const rows = [...box.querySelectorAll('tbody tr')].map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent));
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual(['TypeScript (.ts)', '~240,000']);
    expect(box.querySelector('tbody tr td code')!.textContent).toBe('.ts');
    expect(page.textContent).not.toContain('|---|');
  });

  it('draws a list written straight under its paragraph as a list', () => {
    const page = draw(ZOE);
    const lead = [...page.querySelectorAll('p')].find((p) => p.textContent === 'By top-level folder:');
    expect(lead).toBeTruthy();
    const items = [...page.querySelectorAll('ul > li')].map((li) => li.textContent);
    expect(items).toEqual(['backend/: ~319,000', 'src/ (the front end, plus src/docs): ~81,000', 'scripts/: ~31,000']);
    expect(page.querySelectorAll('strong')).toHaveLength(2);
  });

  it('numbers, nests, and keeps the number a list starts on', () => {
    const page = draw('1. one\n2. two\n   - two a\n   - two b\n3. three\n\n7. seven');
    const lists = page.querySelectorAll(':scope > ol');
    expect(lists).toHaveLength(1);
    const top = [...lists[0]!.children];
    expect(top).toHaveLength(4);
    expect(top[1]!.querySelectorAll('ul > li')).toHaveLength(2);
    expect(top[3]!.textContent).toBe('seven');
    const separate = draw('1. one\n\nwords\n\n7. seven').querySelectorAll('ol');
    expect(separate[1]!.getAttribute('start')).toBe('7');
  });

  it('keeps fenced code as written, Markdown and markup alike', () => {
    const page = draw('Run this:\n\n```bash\nnpm ci\n# not a heading\n- not a list\n<b>not bold</b>\n```\nAfter.');
    const code = page.querySelector('pre[data-answer-code] code')!;
    expect(code.getAttribute('data-lang')).toBe('bash');
    expect(code.textContent).toBe('npm ci\n# not a heading\n- not a list\n<b>not bold</b>');
    expect(page.querySelector('h3, h4, li, b')).toBeNull();
    expect(page.querySelector('pre')!.className).toContain('overflow-x-auto');
    expect(page.lastElementChild!.textContent).toBe('After.');
  });

  it('shows a half-written answer’s open fence and table as they stand', () => {
    const page = draw('Here:\n\n```ts\nconst a = 1;');
    expect(page.querySelector('pre code')!.textContent).toBe('const a = 1;');
    const table = draw('| a | b |\n|---|---|\n| 1');
    expect([...table.querySelectorAll('tbody td')].map((cell) => cell.textContent)).toEqual(['1', '']);
  });

  it('draws headings, quotes, rules and single line breaks', () => {
    const page = draw('# Title\n### Smaller\nline one\nline two\n\n> said\n\n---\n\n*soft* and ~~gone~~ and \\*stars\\*');
    expect(page.querySelector('h3')!.textContent).toBe('Title');
    expect(page.querySelector('h4')!.textContent).toBe('Smaller');
    expect(page.querySelector('p')!.querySelectorAll('br')).toHaveLength(1);
    expect(page.querySelector('blockquote')!.textContent).toBe('said');
    expect(page.querySelector('hr')).not.toBeNull();
    expect(page.querySelector('em')!.textContent).toBe('soft');
    expect(page.querySelector('s')!.textContent).toBe('gone');
    expect(page.lastElementChild!.textContent).toBe('soft and gone and *stars*');
  });

  it('splits table cells on unescaped pipes only, and pads short rows', () => {
    const page = draw('| a | b | c |\n|:--|:-:|--:|\n| x \\| y | 2 |');
    const cells = [...page.querySelectorAll('tbody td')];
    expect(cells.map((cell) => cell.textContent)).toEqual(['x | y', '2', '']);
    expect((cells[2] as HTMLElement).style.textAlign).toBe('right');
    expect((page.querySelectorAll('th')[1] as HTMLElement).style.textAlign).toBe('center');
  });

  it('never lets an answer write markup or link away, in any block', () => {
    const page = draw([
      '<script>alert(1)</script>',
      '| x | y |',
      '|---|---|',
      '| <img src=x onerror=alert(1)> | [bad](javascript:alert(1)) |',
      '',
      '- [ours](https://agenticcloudcomputer.com/docs)',
      '- [theirs](https://evil.example/x) and [sneaky](https://agenticcloudcomputer.com.evil.example/)',
      '',
      '# <iframe src=x>',
    ].join('\n'));
    expect(page.querySelector('script, img, iframe')).toBeNull();
    expect([...page.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['https://agenticcloudcomputer.com/docs']);
    expect(page.textContent).toContain('<script>alert(1)</script>');
    expect(page.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(page.textContent).toContain('theirs');
    expect(page.textContent).toContain('sneaky');
  });

  it('prerenders without a browser', () => {
    const html = renderToStaticMarkup(<AnswerText text={ZOE} />);
    expect(html).toContain('<table');
    expect(html).toContain('<ul');
  });
});
