import { act, render, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecapChatAnswer, RecapMessage } from '../../../../src/shared/workspace-recap-chat.js';
import { App } from '../../App.js';
import { emptyState, scriptedApi, workspaceScript } from '../../test/fixtures.js';
import { forgetFrameHeights, linksAsWritten, REPLY_FRAME_SRC } from './html-reply-links.js';
import { fireEvent } from '@testing-library/react';

/**
 * Note #1186: the Chief of Staff answers in HTML, in its own chat only. Words
 * are drawn by the allowlisted renderer; anything that runs or asks is a
 * locked frame, whose one way out is the person's answer.
 */

const state = emptyState({ org: { orgId: 'o1', name: 'Studio', role: 'admin', members: 1, seats: 0, seatProviders: [] } });
const now = new Date().toISOString();
const ask = '<p>Which one?</p><button data-reply="Ship A">A</button><a href="https://example.com/x">x</a><a href="/workspace/notes/12?org=o1">n</a>';

function Address() {
  const location = useLocation();
  return <div data-testid="address">{location.pathname}</div>;
}
afterEach(() => { document.body.classList.remove('agent-chat-open'); window.localStorage.clear(); forgetFrameHeights(); });

function mount(messages: RecapMessage[]) {
  const sent: unknown[] = [];
  const timings: unknown[] = [];
  const answer = (): RecapChatAnswer => ({ orgId: 'o1', working: false, waiting: [], messages });
  const scripted = scriptedApi({
    ...workspaceScript(() => state),
    'GET api/recap/agent/settings': () => ({ orgId: 'o1', settings: { cli: 'claude', model: 'opus', effort: 'high' }, models: [] }),
    'GET api/recap/settings': () => ({ orgId: 'o1', settings: { cli: 'claude', model: 'opus', effort: 'high' }, models: [] }),
    'GET api/recap/chat': () => answer(),
    'POST api/recap/chat': (call) => { sent.push(JSON.parse(String(call.init?.body))); return answer(); },
    'POST api/reply-frame/timing': (call) => { timings.push(JSON.parse(String(call.init?.body))); return null; },
  });
  render(<MemoryRouter initialEntries={['/']}><Address /><App api={scripted.api} /></MemoryRouter>);
  return { sent, timings };
}

const frameSays = (frame: HTMLIFrameElement, data: unknown) => act(async () => {
  window.dispatchEvent(new MessageEvent('message', { data, source: frame.contentWindow }));
});

describe('the Chief of Staff\'s HTML replies (note #1186)', () => {
  it('draws words natively, a Markdown reply as Markdown, and a reply that asks in the locked frame', async () => {
    mount([
      { id: 'm1', role: 'owner', text: 'Hi', at: now },
      { id: 'm2', role: 'assistant', text: '**Old** Markdown reply', at: now },
      { id: 'm3', role: 'assistant', text: '<h3>Week</h3><p>See <a href="/workspace/notes/12?org=o1">the plan</a>.</p><script>x</script>', at: now },
      { id: 'm4', role: 'assistant', text: ask, at: now },
    ]);
    await waitFor(() => expect(document.querySelectorAll('#recapChatLog .chatmsg.rich')).toHaveLength(3));
    const [markdown, words, asks] = [...document.querySelectorAll('#recapChatLog .chatmsg.rich')];
    expect(markdown!.querySelector('strong')?.textContent).toBe('Old');
    // The script makes it a frame; without it, words. Here: it has one.
    expect(words!.querySelector('iframe')).not.toBeNull();
    const frame = asks!.querySelector('iframe')!;
    expect(frame.getAttribute('src')).toBe(REPLY_FRAME_SRC);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms');
    // Since note #1193 the whole reply is the card: none of its words are set
    // by the Workspace beside it.
    expect(asks!.querySelector('.chathtmlui iframe')).toBe(frame);
    expect(asks!.querySelector('.kpage')).toBeNull();
    expect(asks!.textContent).not.toContain('Which one?');
  });

  it('draws words-only HTML with the allowlisted renderer, and its Workspace link opens inside', async () => {
    mount([{ id: 'm1', role: 'assistant', text: '<h3>Week</h3><p>See <a href="/workspace/notes/12?org=o1">the plan</a>.</p>', at: now }]);
    await waitFor(() => expect(document.querySelector('#recapChatLog .chathtml .kpage h3')?.textContent).toBe('Week'));
    expect(document.querySelector('#recapChatLog iframe')).toBeNull();
    await act(async () => { (document.querySelector('#recapChatLog .chathtml a') as HTMLAnchorElement).click(); });
    await waitFor(() => expect(screen().textContent).toContain('/notes/12'));
  });

  it('sends a tap as the person\'s message naming the reply, once; an OLDER reply stays answerable after a newer one (note #1189); a foreign frame and a reply from before a fresh chat are not heard', async () => {
    const { sent } = mount([
      { id: 'm0', role: 'assistant', text: '<button data-reply="Gone">Gone</button>', at: now },
      { id: 'd1', role: 'action', text: '', at: now, kind: 'new-chat-divider' },
      { id: 'm1', role: 'assistant', text: '<button data-reply="Older">Older</button>', at: now },
      { id: 'm2', role: 'owner', text: 'Next', at: now },
      { id: 'm3', role: 'assistant', text: ask, at: now },
    ]);
    await waitFor(() => expect(document.querySelectorAll('#recapChatLog iframe')).toHaveLength(3));
    const [gone, older, live] = [...document.querySelectorAll<HTMLIFrameElement>('#recapChatLog iframe')];
    await frameSays(gone!, { t: 'reply', text: 'Gone' });
    await act(async () => { window.dispatchEvent(new MessageEvent('message', { data: { t: 'reply', text: 'Forged' }, source: window })); });
    await frameSays(live!, { t: 'h', h: 222 });
    expect(live!.style.height).toBe('222px');
    await frameSays(live!, { t: 'reply', text: 'Ship A' });
    await frameSays(live!, { t: 'reply', text: 'Ship A again' });
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ text: 'Ship A', answerTo: 'm3' });
    await frameSays(older!, { t: 'reply', text: 'Older' });
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({ text: 'Older', answerTo: 'm1' });
  });

  it('opens only links written in the HTML: a Workspace one inside, never one a script made up', async () => {
    mount([{ id: 'm1', role: 'assistant', text: ask, at: now }]);
    await waitFor(() => expect(document.querySelector('#recapChatLog iframe')).not.toBeNull());
    const frame = document.querySelector<HTMLIFrameElement>('#recapChatLog iframe')!;
    const opened: string[] = [];
    const real = window.open;
    window.open = ((url?: string | URL) => { opened.push(String(url)); return null; }) as typeof window.open;
    try {
      await frameSays(frame, { t: 'open', href: 'https://evil.example/?typed=secret' });
      await frameSays(frame, { t: 'open', href: 'https://example.com/x' });
      expect(opened).toEqual(['https://example.com/x']);
      await frameSays(frame, { t: 'open', href: new URL('/workspace/notes/12?org=o1', window.location.origin).href });
      await waitFor(() => expect(screen().textContent).toContain('/notes/12'));
    } finally { window.open = real; }
  });

  it('collects the links as the frame resolves them', () => {
    const links = linksAsWritten('<a href="/workspace/notes/1">a</a><a href="https://x.test/">b</a><a href="#top">c</a>');
    expect(links.has(new URL('/workspace/notes/1', window.location.origin).href)).toBe(true);
    expect(links.has('https://x.test/')).toBe(true);
  });
});

/** What the frame was handed: the reply as the page inside will draw it. */
async function handedTo(frame: HTMLIFrameElement): Promise<string[]> {
  const shown: string[] = [];
  frame.contentWindow!.postMessage = ((data: { t?: string; html?: string }) => { if (data.t === 'show') shown.push(data.html ?? ''); }) as never;
  await frameSays(frame, { t: 'ready' });
  return shown;
}

describe('a reply is one surface, drawn whole as the agent laid it out (note #1193)', () => {
  it('hands the WHOLE reply to the frame, opening words and closing words included, and sets none of it beside the card', async () => {
    const whole = '<p>Agreed. Theo designed the rest.</p><button data-reply="Elias">Give it to Elias now</button><button data-reply="Theo">Wait for Theo</button><p>My own chat is half full.</p>';
    mount([{ id: 'm1', role: 'assistant', text: whole, at: now }]);
    await waitFor(() => expect(document.querySelector('#recapChatLog .chathtmlui iframe')).not.toBeNull());
    const row = document.querySelector('#recapChatLog .chatmsg.html')!;
    expect(await handedTo(row.querySelector('iframe')!)).toEqual([whole]);
    // The row is the card and nothing else: no words by the Workspace.
    expect([...row.children].map((child) => child.className)).toEqual(['chathtmlui']);
    expect(row.querySelector('.kpage, .chatmarkdown')).toBeNull();
  });

  it('keeps a reply of words alone on the page, with no frame and no card; and a reply that is not HTML as words, never an empty space', async () => {
    mount([
      { id: 'm1', role: 'assistant', text: '<h3>Done</h3><p>It is live.</p>', at: now },
      { id: 'm2', role: 'assistant', text: 'API Error: 529 overloaded', at: now },
    ]);
    await waitFor(() => expect(document.querySelector('#recapChatLog .chathtml .kpage h3')?.textContent).toBe('Done'));
    expect(document.querySelector('#recapChatLog iframe, #recapChatLog .chathtmlui')).toBeNull();
    const [, plain] = [...document.querySelectorAll('#recapChatLog .chatmsg.rich')];
    expect(plain!.classList.contains('html')).toBe(false);
    expect(plain!.querySelector('.chatmarkdown')?.textContent).toBe('API Error: 529 overloaded');
  });

  it('draws a sentence written before the first tag at the top of the same card, and hands the frame the HTML', async () => {
    const html = '<form><label><input type="checkbox" name="q1"> One</label><button>Send</button></form>';
    mount([{ id: 'm1', role: 'assistant', text: `Six decisions are **open**:\n\n${html}`, at: now }]);
    await waitFor(() => expect(document.querySelector('#recapChatLog .chathtmlui iframe')).not.toBeNull());
    const card = document.querySelector('#recapChatLog .chathtmlui')!;
    expect(card.querySelector(':scope > .chathtmllead strong')?.textContent).toBe('open');
    expect(card.firstElementChild!.classList.contains('chathtmllead')).toBe(true);
    expect(await handedTo(card.querySelector('iframe')!)).toEqual([html]);
    expect(card.parentElement!.children).toHaveLength(1);
  });

  it('remembers a frame\'s height on the device, so a conversation opened again holds each reply\'s place', async () => {
    const reply: RecapMessage = { id: 'm1', role: 'assistant', text: '<p>Pick.</p><button data-reply="A">A</button>', at: now };
    mount([reply]);
    await waitFor(() => expect(document.querySelector('#recapChatLog .chathtmlui iframe')).not.toBeNull());
    await frameSays(document.querySelector<HTMLIFrameElement>('#recapChatLog iframe')!, { t: 'h', h: 310 });
    await waitFor(() => expect(window.localStorage.getItem('acc.htmlReplyHeights')).toContain('310'), { timeout: 2000 });
    document.body.innerHTML = '';
    forgetFrameHeights();
    mount([reply]);
    await waitFor(() => expect(document.querySelector('#recapChatLog .chathtmlframe')).not.toBeNull());
    const box = document.querySelector<HTMLElement>('#recapChatLog .chathtmlframe')!;
    // Still loading: the placeholder stands at the height the page had.
    expect(box.classList.contains('waiting')).toBe(true);
    expect(box.style.minHeight).toBe('310px');
  });
});

describe('a framed reply far from the screen (note #1193)', () => {
  type Seen = { callback: IntersectionObserverCallback; margin: string; node?: Element };
  let seen: Seen[] = [];
  const real = globalThis.IntersectionObserver;
  afterEach(() => { globalThis.IntersectionObserver = real; seen = []; });
  const says = (margin: string, isIntersecting: boolean) => act(async () => {
    for (const observer of seen.filter((entry) => entry.margin === margin && entry.node)) {
      observer.callback([{ isIntersecting, target: observer.node! } as IntersectionObserverEntry], {} as IntersectionObserver);
    }
  });

  it('is built when it comes near, let go when it is far and untouched, held at its height, and kept once the person has touched it', async () => {
    globalThis.IntersectionObserver = class {
      private readonly entry: Seen;
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) { this.entry = { callback, margin: options?.rootMargin ?? '' }; seen.push(this.entry); }
      observe(node: Element) { this.entry.node = node; }
      disconnect() { this.entry.node = undefined; }
      unobserve() { /* unused */ }
      takeRecords() { return []; }
    } as unknown as typeof IntersectionObserver;
    mount([{ id: 'm1', role: 'assistant', text: '<p>Pick.</p><button data-reply="A">A</button>', at: now }]);
    await waitFor(() => expect(document.querySelector('#recapChatLog .chathtmlframe')).not.toBeNull());
    const box = document.querySelector<HTMLElement>('#recapChatLog .chathtmlframe')!;
    // jsdom lays nothing out: say the row is on a visible screen.
    Object.defineProperty(box, 'offsetParent', { configurable: true, get: () => document.body });
    expect(box.querySelector('iframe')).toBeNull();
    await says('1200px 0px', true);
    const first = box.querySelector('iframe')!;
    expect(first).not.toBeNull();
    await frameSays(first, { t: 'h', h: 240 });
    expect(box.style.height).toBe('240px');
    // Far away, untouched: the frame goes, its place stays.
    await says('6000px 0px', false);
    expect(box.querySelector('iframe')).toBeNull();
    expect(box.style.minHeight).toBe('240px');
    // Near again: a fresh frame, loading, then shown.
    await says('1200px 0px', true);
    const second = box.querySelector('iframe')!;
    expect(second).not.toBe(first);
    expect(box.classList.contains('waiting')).toBe(true);
    await frameSays(second, { t: 'h', h: 240 });
    expect(box.classList.contains('waiting')).toBe(false);
    // Touched: what the person typed lives only in this frame, so it stays.
    await frameSays(second, { t: 'touched' });
    await says('6000px 0px', false);
    expect(box.querySelector('iframe')).toBe(second);
  });

  it('keeps every frame of a screen that is hidden rather than scrolled away', async () => {
    globalThis.IntersectionObserver = class {
      private readonly entry: Seen;
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) { this.entry = { callback, margin: options?.rootMargin ?? '' }; seen.push(this.entry); }
      observe(node: Element) { this.entry.node = node; }
      disconnect() { this.entry.node = undefined; }
      unobserve() { /* unused */ }
      takeRecords() { return []; }
    } as unknown as typeof IntersectionObserver;
    mount([{ id: 'm1', role: 'assistant', text: '<p>Pick.</p><button data-reply="A">A</button>', at: now }]);
    await waitFor(() => expect(document.querySelector('#recapChatLog .chathtmlframe')).not.toBeNull());
    const box = document.querySelector<HTMLElement>('#recapChatLog .chathtmlframe')!;
    await says('1200px 0px', true);
    const frame = box.querySelector('iframe')!;
    // jsdom's offsetParent is null, which is what a hidden screen's is.
    await says('6000px 0px', false);
    expect(box.querySelector('iframe')).toBe(frame);
  });
});

describe('the card a framed reply sits in has a quiet close (note #1188)', () => {
  it('closes the whole reply with the Workspace\'s own mark; closing sends nothing, the line left says how it began, Show brings it back, and it stays closed when drawn again', async () => {
    const reply: RecapMessage = { id: 'm1', role: 'assistant', text: '<p>Pick one.</p><button data-reply="A">A</button>', at: now };
    const first = mount([reply]);
    await waitFor(() => expect(document.querySelector('#recapChatLog .chathtmlui iframe')).not.toBeNull());
    const row = document.querySelector('#recapChatLog .chatmsg.html')!;
    const close = row.querySelector<HTMLButtonElement>('.chathtmlui > .chathtmlclose')!;
    expect(close.getAttribute('aria-label')).toBe('Hide this');
    await act(async () => fireEvent.click(close));
    expect(row.querySelector('.chathtmlui')).toBeNull();
    expect([...row.querySelector('.chathtmlhidden')!.children].map((child) => child.textContent)).toEqual(['Hidden', 'Pick one. [A]', 'Show']);
    expect(first.sent).toEqual([]);
    await act(async () => fireEvent.click(row.querySelector('.chathtmlshow')!));
    expect(row.querySelector('.chathtmlui iframe')).not.toBeNull();
    await act(async () => fireEvent.click(row.querySelector('.chathtmlclose')!));
    document.body.innerHTML = '';
    mount([reply]);
    await waitFor(() => expect(document.querySelector('#recapChatLog .chathtmlhidden')).not.toBeNull());
    expect(document.querySelector('#recapChatLog .chathtmlui')).toBeNull();
  });
});

describe('an HTML reply while its frame loads (note #1192)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('holds a quiet placeholder, not an empty box, until the page inside says its height; the reply is handed over on ready AND on load', async () => {
    mount([{ id: 'm1', role: 'assistant', text: '<p>Pick.</p><button data-reply="A">A</button>', at: now }]);
    await waitFor(() => expect(document.querySelector('#recapChatLog .chathtmlui iframe')).not.toBeNull());
    const box = document.querySelector<HTMLElement>('#recapChatLog .chathtmlframe')!;
    const frame = box.querySelector('iframe')!;
    expect(box.classList.contains('waiting')).toBe(true);
    expect(box.getAttribute('aria-busy')).toBe('true');
    expect(box.querySelectorAll('.chathtmlwait .chathtmlbar')).toHaveLength(2);
    expect(box.querySelector('.chathtmlwait')?.textContent).toBe('Loading the rest of this reply');
    expect(frame.getAttribute('aria-hidden')).toBe('true');
    const posted: unknown[] = [];
    frame.contentWindow!.postMessage = ((data: unknown) => { posted.push(data); }) as never;
    // The frame's first word may come before anyone listens: its load hands the reply over too.
    await act(async () => { fireEvent.load(frame); });
    await frameSays(frame, { t: 'ready' });
    expect(posted.filter((m) => (m as { t: string }).t === 'show')).toHaveLength(2);
    expect(box.querySelector('.chathtmlwait')).not.toBeNull();
    await frameSays(frame, { t: 'h', h: 90 });
    expect(box.classList.contains('waiting')).toBe(false);
    expect(box.querySelector('.chathtmlwait')).toBeNull();
    expect(box.style.height).toBe('90px');
    expect(frame.hasAttribute('aria-hidden')).toBe(false);
  });

  it('says so when the frame never comes, offers Try again with a fresh frame, and writes down how long each step took', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
    const { timings } = mount([{ id: 'm1', role: 'assistant', text: '<p>Pick.</p><button data-reply="A">A</button>', at: now }]);
    await waitFor(() => expect(document.querySelector('#recapChatLog .chathtmlui iframe')).not.toBeNull());
    const box = document.querySelector<HTMLElement>('#recapChatLog .chathtmlframe')!;
    const first = box.querySelector('iframe')!;
    await act(async () => { vi.advanceTimersByTime(0); });
    await frameSays(first, { t: 'ready' });
    await act(async () => { vi.advanceTimersByTime(8_100); });
    expect(box.querySelector('.chathtmlwait')).toBeNull();
    expect(box.querySelector('.chathtmlfailed')?.textContent).toBe('This part of the reply did not load.Try again');
    await waitFor(() => expect(timings).toHaveLength(1));
    expect(timings[0]).toMatchObject({ outcome: 'failed', attempt: 0 });
    expect((timings[0] as { ready: number }).ready).toBeGreaterThanOrEqual(0);
    expect(timings[0]).not.toHaveProperty('shown');
    await act(async () => fireEvent.click(box.querySelector('.chathtmlretry')!));
    const second = box.querySelector('iframe')!;
    expect(second).not.toBe(first);
    expect(box.querySelector('.chathtmlfailed')).toBeNull();
    expect(box.querySelector('.chathtmlwait')).not.toBeNull();
    // The old frame is no longer heard; the new one is.
    await frameSays(first, { t: 'h', h: 70 });
    expect(box.classList.contains('waiting')).toBe(true);
    await frameSays(second, { t: 'h', h: 70 });
    expect(box.classList.contains('waiting')).toBe(false);
  });

  it('writes down a frame that showed, but slowly; a quick one is not reported', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
    const { timings } = mount([
      { id: 'm1', role: 'assistant', text: '<p>One.</p><button data-reply="A">A</button>', at: now },
    ]);
    await waitFor(() => expect(document.querySelector('#recapChatLog .chathtmlui iframe')).not.toBeNull());
    const frame = document.querySelector<HTMLIFrameElement>('#recapChatLog .chathtmlui iframe')!;
    await act(async () => { vi.advanceTimersByTime(0); });
    await act(async () => { vi.advanceTimersByTime(3_000); });
    await frameSays(frame, { t: 'h', h: 60 });
    await waitFor(() => expect(timings).toHaveLength(1));
    expect(timings[0]).toMatchObject({ outcome: 'slow' });
    expect((timings[0] as { shown: number }).shown).toBeGreaterThanOrEqual(2_500);
    await frameSays(frame, { t: 'h', h: 61 });
    expect(timings).toHaveLength(1);
  });
});

function screen() { return document.querySelector('[data-testid="address"]')!; }
