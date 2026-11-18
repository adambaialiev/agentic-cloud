import { act, render, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecapChatAnswer, RecapMessage } from '../../../../src/shared/workspace-recap-chat.js';
import { App } from '../../App.js';
import { emptyState, scriptedApi, workspaceScript } from '../../test/fixtures.js';
import { htmlReplyNeedsFrame } from '../../../../src/shared/agent-html.js';
import { linksAsWritten, REPLY_FRAME_SRC, splitHtmlReply } from './html-reply-links.js';
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
afterEach(() => { document.body.classList.remove('agent-chat-open'); window.localStorage.clear(); });

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
    // Since note #1188 the words a reply opens with stand on the page, and its UI in a card.
    // The words are built in an effect: wait for them, never read the first paint.
    await waitFor(() => expect(asks!.querySelector('.chathtml')?.textContent).toContain('Which one?'));
    expect(asks!.querySelector('.chathtmlui iframe')).toBe(frame);
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

describe('the UI a reply carries sits in a card with a quiet close (note #1188)', () => {
  it('splits the words a reply opens with from the UI it sends; a leading style keeps the whole reply as UI', () => {
    expect(splitHtmlReply('<p>Pick one.</p><form><input name="a"><button>Go</button></form><p>Or type.</p>', htmlReplyNeedsFrame))
      .toEqual({ words: '<p>Pick one.</p>', ui: '<form><input name="a"><button>Go</button></form><p>Or type.</p>' });
    expect(splitHtmlReply('<p>Only words.</p>', htmlReplyNeedsFrame)).toEqual({ words: '<p>Only words.</p>', ui: '' });
    const styled = '<style>p{color:red}</style><p>x</p><button data-reply="y">y</button>';
    expect(splitHtmlReply(styled, htmlReplyNeedsFrame)).toEqual({ words: '', ui: styled });
    expect(splitHtmlReply('<button data-reply="y">y</button>', htmlReplyNeedsFrame)).toEqual({ words: '', ui: '<button data-reply="y">y</button>' });
  });

  it('draws the words on the page and the UI in a card whose close mark is the Workspace\'s; closing sends nothing, Show brings it back, and it stays closed when drawn again', async () => {
    const reply: RecapMessage = { id: 'm1', role: 'assistant', text: '<p>Pick one.</p><button data-reply="A">A</button>', at: now };
    const first = mount([reply]);
    await waitFor(() => expect(document.querySelector('#recapChatLog .chathtmlui iframe')).not.toBeNull());
    const row = document.querySelector('#recapChatLog .chatmsg.html')!;
    await waitFor(() => expect(row.querySelector('.chathtml .kpage p')?.textContent).toBe('Pick one.'));
    const close = row.querySelector<HTMLButtonElement>('.chathtmlui > .chathtmlclose')!;
    expect(close.getAttribute('aria-label')).toBe('Hide this');
    await act(async () => fireEvent.click(close));
    expect(row.querySelector('.chathtmlui')).toBeNull();
    expect(row.querySelector('.chathtml .kpage p')?.textContent).toBe('Pick one.');
    expect(row.querySelector('.chathtmlhidden')?.textContent).toBe('HiddenShow');
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
