import { act, render, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
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
  const answer = (): RecapChatAnswer => ({ orgId: 'o1', working: false, waiting: [], messages });
  const scripted = scriptedApi({
    ...workspaceScript(() => state),
    'GET api/recap/agent/settings': () => ({ orgId: 'o1', settings: { cli: 'claude', model: 'opus', effort: 'high' }, models: [] }),
    'GET api/recap/settings': () => ({ orgId: 'o1', settings: { cli: 'claude', model: 'opus', effort: 'high' }, models: [] }),
    'GET api/recap/chat': () => answer(),
    'POST api/recap/chat': (call) => { sent.push(JSON.parse(String(call.init?.body))); return answer(); },
  });
  render(<MemoryRouter initialEntries={['/']}><Address /><App api={scripted.api} /></MemoryRouter>);
  return { sent };
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
    expect(asks!.querySelector('.chathtml')?.textContent).toContain('Which one?');
    expect(asks!.querySelector('.chathtmlui iframe')).toBe(frame);
  });

  it('draws words-only HTML with the allowlisted renderer, and its Workspace link opens inside', async () => {
    mount([{ id: 'm1', role: 'assistant', text: '<h3>Week</h3><p>See <a href="/workspace/notes/12?org=o1">the plan</a>.</p>', at: now }]);
    await waitFor(() => expect(document.querySelector('#recapChatLog .chathtml .kpage h3')?.textContent).toBe('Week'));
    expect(document.querySelector('#recapChatLog iframe')).toBeNull();
    await act(async () => { (document.querySelector('#recapChatLog .chathtml a') as HTMLAnchorElement).click(); });
    await waitFor(() => expect(screen().textContent).toContain('/notes/12'));
  });

  it('sends a tap as the person\'s message naming the reply, once; a foreign frame and an old reply are not heard', async () => {
    const { sent } = mount([
      { id: 'm1', role: 'assistant', text: '<button data-reply="Old">Old</button>', at: now },
      { id: 'm2', role: 'owner', text: 'Next', at: now },
      { id: 'm3', role: 'assistant', text: ask, at: now },
    ]);
    await waitFor(() => expect(document.querySelectorAll('#recapChatLog iframe')).toHaveLength(2));
    const [old, live] = [...document.querySelectorAll<HTMLIFrameElement>('#recapChatLog iframe')];
    await frameSays(old!, { t: 'reply', text: 'Old' });
    await act(async () => { window.dispatchEvent(new MessageEvent('message', { data: { t: 'reply', text: 'Forged' }, source: window })); });
    await frameSays(live!, { t: 'h', h: 222 });
    expect(live!.style.height).toBe('222px');
    await frameSays(live!, { t: 'reply', text: 'Ship A' });
    await frameSays(live!, { t: 'reply', text: 'Ship A again' });
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ text: 'Ship A', answerTo: 'm3' });
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

function screen() { return document.querySelector('[data-testid="address"]')!; }
