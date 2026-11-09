import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App.js';
import { ANSWER_UNREADABLE_SENTENCE, WorkspaceApiError } from '../../api/client.js';
import { emptyState, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';
import type { DirectMessage, DirectMessagePage } from '../../../../src/shared/direct-messages.js';
import { forgetDirectMessages, heldInbox, heldThread, holdInbox, holdThread } from './messages-cache.js';
const org = { orgId: 'o1', name: 'Studio', role: 'member', members: 2, seats: 0, seatProviders: [] };
const people = [{ userId: 'alice', name: 'Alice', you: true, role: 'member', agents: 0, joinedAt: 't' }, { userId: 'bob', name: 'Bob', you: false, role: 'member', agents: 0, joinedAt: 't' }];
const msg = (id: number, text = `Message ${id}`, senderId = 'bob'): DirectMessage => ({ id, text, senderId, clientId: `message-test-${id}`, createdAt: '2026-09-06T12:00:00Z' });
const page = (messages: DirectMessage[] = [], available = true): DirectMessagePage => ({ orgName: 'Studio', person: { userId: 'bob', name: 'Bob', available }, viewerId: 'alice', messages, hasMore: false });
function Switch() { const go = useNavigate(); return <button onClick={() => go('/messages/bob?org=o2')}>Switch workplace</button>; }
function open(path: string, extra: Record<string, Answer>) {
  const scripted = scriptedApi({ ...workspaceScript(() => emptyState({ org, messagesAvailable: true })),
    'GET api/org/people': () => ({ org, people }), 'GET api/org/people/live': () => ({ people: [] }),
    'GET api/messages/unread': () => ({ unread: 2 }), 'POST api/messages/bob/read': () => ({ ok: true }), ...extra });
  render(<MemoryRouter initialEntries={[path]}><Switch /><App api={scripted.api} /></MemoryRouter>);
  return scripted;
}
const flush = async (ms = 10) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('human messages', () => {
  it('opens an unread conversation from the inbox and renders text without interpreting HTML', async () => {
    const scripted = open('/messages?org=o1', {
      'GET api/messages': () => ({ threads: [{ person: page().person, lastMessage: msg(1, 'Hello'), unread: 2 }], unread: 2 }),
      'GET api/messages/bob': () => page([msg(1, '<img src=x onerror=alert(1)>')]),
    });
    await flush(); expect(screen.getByLabelText('2 unread messages')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: /Bob/ })); await flush();
    expect(screen.queryByRole('button', { name: 'Home' })).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(document.querySelector('[role=log] img')).toBeNull();
    expect(scripted.calls.find(c => c.path === 'api/messages/bob')?.scope).toEqual({ org: 'o1' });
    expect(scripted.calls.find(c => c.path === 'api/messages/bob/read')?.init?.body).toBe('{"through":1}');
  });
  it('waits quietly while the messaging machine wakes, then shows what it holds (note #608)', async () => {
    // Messages live on the workplace's own machine, which sleeps when nobody
    // writes. Waking is a state, not a fault: no alert, no "Retrying…".
    let awake = false;
    const opening = () => { throw new WorkspaceApiError('Opening messages…', 503, { error: 'Opening messages…', code: 'opening' }); };
    open('/messages?org=o1', {
      'GET api/messages': () => awake ? { threads: [{ person: page().person, lastMessage: msg(1, 'Hello'), unread: 1 }], unread: 1 } : opening(),
      'GET api/messages/bob': () => awake ? page([msg(1, 'Hello')]) : opening(),
    });
    await flush();
    expect(screen.getByRole('status').textContent).toBe('Opening messages…');
    expect(screen.queryByRole('alert')).toBeNull();
    awake = true; await flush(3100);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('link', { name: /Bob/ })).toBeTruthy();
    awake = false; fireEvent.click(screen.getByRole('link', { name: /Bob/ })); await flush();
    expect(screen.getByRole('status').textContent).toBe('Opening messages…');
    expect(screen.queryByRole('alert')).toBeNull();
    awake = true; await flush(3100);
    expect(screen.getByText('Hello')).toBeTruthy();
  });
  it('keeps a bubble on BOTH sides, because both sides are people', async () => {
    // Note #481 took the balloon off an agent's words and left it to the
    // reader — in an agent's chat, where one side is prose a machine wrote.
    // Here both sides are human, and both keep the bubble they have always
    // worn: this screen shares `.chatmsg.owner`/`.chatmsg.agent` with that
    // one, so the rule is written against a class only the agent transcript
    // emits, and this is the check that holds it there.
    open('/messages/bob?org=o1', { 'GET api/messages/bob': () => page([msg(1, 'Hello'), msg(2, 'Hi back', 'alice')]) });
    await flush();
    const said = [...document.querySelectorAll('[role=log] .chatmsg')];
    expect(said.map(one => one.className)).toEqual(['chatmsg agent', 'chatmsg owner']);
    expect(said.some(one => one.classList.contains('flat'))).toBe(false);
  });
  it('previews a Chief of Staff message as its words, without the Markdown that draws them (note #1090)', async () => {
    open('/messages?org=o1', {
      'GET api/messages': () => ({ threads: [{ person: page().person, lastMessage: { ...msg(1, 'Hi **Alice**\n\n- one\n- two'), clientId: 'via-cos-0123456789abcdef01234567' }, unread: 1 }], unread: 1 }),
    });
    await flush();
    expect(document.querySelector('#screenMessages .ctext')?.textContent).toBe('Hi Alice one two');
  });
  it('marks a message its sender released from their Chief of Staff\'s card, on both sides (note #1090)', async () => {
    open('/messages/bob?org=o1', { 'GET api/messages/bob': () => page([
      { ...msg(1, 'From Bob, via his agent.\nLine two.\n\n- one\n- **two**'), clientId: 'via-cos-0123456789abcdef01234567' },
      { ...msg(2, 'From me, via mine', 'alice'), clientId: 'via-cos-89abcdef0123456789abcdef' },
      msg(3, 'Typed by Bob'),
    ]) });
    await flush();
    const said = [...document.querySelectorAll('[role=log] .chatmsg')];
    expect(said.map(one => one.querySelector('.dmvia')?.textContent ?? null)).toEqual(['via their Chief of Staff', 'via your Chief of Staff', null]);
    // The agent's Markdown is drawn as its card drew it; a person's words stay as typed.
    expect([...said[0]!.querySelectorAll('.chatmarkdown p')].map(p => p.textContent)).toEqual(['From Bob, via his agent.\nLine two.']);
    expect([...said[0]!.querySelectorAll('.chatmarkdown li')].map(li => li.textContent)).toEqual(['one', 'two']);
    expect(said[0]!.textContent).not.toContain('**');
    expect(said[2]!.querySelector('.chatmarkdown')).toBeNull();
    expect(said[2]!.firstChild?.textContent).toBe('Typed by Bob');
  });
  describe('kept in this browser for this person (note #1102)', () => {
    const kept = (rows: DirectMessage[]) => holdThread('saddam', 'o1', 'bob', { viewerId: 'alice', orgName: 'Studio', person: page().person, messages: rows, hasMore: false });
    it('paints a kept conversation at once, then appends what the read behind it brings, never emptying', async () => {
      kept([msg(1, 'Seen before'), msg(2, 'Also seen', 'alice')]);
      let answer!: (value: DirectMessagePage) => void;
      const scripted = open('/messages/bob?org=o1', {
        'GET api/messages/bob?after=2': () => new Promise<DirectMessagePage>((resolve) => { answer = resolve; }),
      });
      await flush();
      // The read is still out, and the conversation is already there.
      expect([...document.querySelectorAll('[role=log] .chatmsg')].map(one => one.textContent)).toEqual(['Seen before', 'Also seen']);
      expect(screen.queryByText('Loading conversation…')).toBeNull();
      expect(scripted.calls.some(call => call.path === 'api/messages/bob')).toBe(false);
      await act(async () => { answer(page([msg(3, 'New since')])); });
      await flush();
      expect([...document.querySelectorAll('[role=log] .chatmsg')].map(one => one.textContent)).toEqual(['Seen before', 'Also seen', 'New since']);
      expect(heldThread('saddam', 'o1', 'bob')!.messages.map(one => one.id)).toEqual([1, 2, 3]);
    });
    it('paints the kept list at once and replaces it with the fresh one', async () => {
      holdInbox('saddam', 'o1', { threads: [{ person: page().person, lastMessage: msg(1, 'Old line'), unread: 0 }], unread: 0 });
      let answer!: (value: unknown) => void;
      open('/messages?org=o1', { 'GET api/messages': () => new Promise((resolve) => { answer = resolve; }) });
      await flush();
      expect(document.querySelector('#screenMessages .ctext')?.textContent).toBe('Old line');
      expect(screen.queryByText('Loading messages…')).toBeNull();
      await act(async () => { answer({ threads: [{ person: page().person, lastMessage: msg(2, 'Newer line'), unread: 1 }], unread: 1 }); });
      await flush();
      expect(document.querySelector('#screenMessages .ctext')?.textContent).toBe('Newer line');
      expect(heldInbox('saddam', 'o1')?.threads[0]!.lastMessage.text).toBe('Newer line');
    });
    it('never shows one person what was kept for another, and drops it from the browser', async () => {
      holdThread('someone-else', 'o1', 'bob', { viewerId: 'carol', orgName: 'Studio', person: page().person, messages: [msg(1, 'Carol\'s secret')], hasMore: false });
      expect(Object.keys(localStorage).some(key => key.includes('someone-else'))).toBe(true);
      let answer!: (value: DirectMessagePage) => void;
      open('/messages/bob?org=o1', { 'GET api/messages/bob': () => new Promise<DirectMessagePage>((resolve) => { answer = resolve; }) });
      await flush();
      expect(screen.queryByText("Carol's secret")).toBeNull();
      expect(screen.getByText('Loading conversation…')).toBeTruthy();
      expect(Object.keys(localStorage).some(key => key.includes('someone-else'))).toBe(false);
      await act(async () => { answer(page([msg(1, 'Hello')])); });
    });
    it('far behind its kept copy, a conversation starts again from the newest page rather than walking forward', async () => {
      kept([msg(1, 'Long ago')]);
      open('/messages/bob?org=o1', {
        'GET api/messages/bob?after=1': () => ({ ...page([msg(2), msg(3)]), hasMore: true }),
        'GET api/messages/bob': () => ({ ...page([msg(80, 'Newest page start'), msg(81, 'Newest of all')]), hasMore: true }),
      });
      await flush(); await flush();
      expect([...document.querySelectorAll('[role=log] .chatmsg')].map(one => one.textContent)).toEqual(['Newest page start', 'Newest of all']);
      expect(screen.getByRole('button', { name: 'Earlier messages' })).toBeTruthy();
    });
    it('a kept conversation the server no longer gives this reader is forgotten', async () => {
      kept([msg(1, 'Seen before')]);
      open('/messages/bob?org=o1', { 'GET api/messages/bob?after=1': () => { throw new WorkspaceApiError('No such conversation.', 404, { error: 'No such conversation.' }); } });
      await flush();
      expect(screen.queryByText('Seen before')).toBeNull();
      expect(heldThread('saddam', 'o1', 'bob')).toBeNull();
    });
    it('sign-out empties every kept list and conversation', () => {
      kept([msg(1)]); holdInbox('saddam', 'o1', { threads: [], unread: 0 });
      forgetDirectMessages();
      expect(Object.keys(localStorage).filter(key => key.startsWith('agentbuilt.dm.'))).toEqual([]);
      expect(heldThread('saddam', 'o1', 'bob')).toBeNull();
    });
  });
  it('keeps a failed send for retry, reuses its identifier and catches concurrent incoming text', async () => {
    let attempts = 0;
    const scripted = open('/messages/bob?org=o1', {
      'GET api/messages/bob': () => page([msg(1)]),
      'GET api/messages/bob?after=1': () => page([msg(2, 'Concurrent reply'), msg(3, 'My answer', 'alice')]),
      'POST api/messages/bob': () => { if (++attempts === 1) throw new Error('Connection lost.'); return { message: msg(3, 'My answer', 'alice') }; },
    });
    await flush(); fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'My answer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' })); await flush();
    // Not sent, and said so: the words are back in the box, not left as a
    // bubble that looks sent (note #764).
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('My answer');
    expect(within(screen.getByRole('log')).queryByText('My answer')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('was not sent');
    fireEvent.click(screen.getByRole('button', { name: 'Send' })); await flush();
    const sends = scripted.calls.filter(c => c.init?.method === 'POST' && c.path === 'api/messages/bob');
    expect(sends).toHaveLength(2); expect(sends[0]!.init!.body).toBe(sends[1]!.init!.body);
    await flush(3000); expect(screen.getByText('Concurrent reply')).toBeTruthy();
    expect(within(screen.getByRole('log')).getAllByText('My answer')).toHaveLength(1);
  });
  it('pauses hidden reads and receipts and resumes on visibility', async () => {
    const scripted = open('/messages/bob?org=o1', { 'GET api/messages/bob': () => page([msg(1)]), 'GET api/messages/bob?after=1': () => page([msg(2)]) });
    await flush(); const before = scripted.calls.filter(c => c.path.startsWith('api/messages/bob')).length;
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange')); await flush(9000);
    expect(scripted.calls.filter(c => c.path.startsWith('api/messages/bob'))).toHaveLength(before);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    fireEvent(document, new Event('visibilitychange')); await flush(); expect(screen.getByText('Message 2')).toBeTruthy();
  });
  it('leaves new arrivals unread while the reader is looking at older messages', async () => {
    const scripted = open('/messages/bob?org=o1', { 'GET api/messages/bob': () => page([msg(1)]), 'GET api/messages/bob?after=1': () => page([msg(2)]) });
    await flush();
    const pane = document.querySelector('.chatpane')!;
    Object.defineProperties(pane, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 400 } });
    pane.scrollTop = 0; fireEvent.scroll(pane); await flush(3000);
    expect(screen.getByRole('button', { name: 'New messages' })).toBeTruthy();
    expect(scripted.calls.filter(c => c.path.endsWith('/read')).map(c => c.init?.body)).toEqual(['{"through":1}']);
    fireEvent.click(screen.getByRole('button', { name: 'New messages' })); await flush();
    expect(scripted.calls.filter(c => c.path.endsWith('/read')).at(-1)?.init?.body).toBe('{"through":2}');
  });
  it('drops private rows when membership is revoked and prevents sending', async () => {
    open('/messages/bob?org=o1', { 'GET api/messages/bob': () => page([msg(1)]), 'GET api/messages/bob?after=1': () => { throw new WorkspaceApiError('Membership ended.', 403, {}); } });
    await flush(); expect(screen.getByText('Message 1')).toBeTruthy(); await flush(3000);
    expect(screen.queryByText('Message 1')).toBeNull(); expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
  });
  it('retains history but disables the composer for a former member', async () => {
    open('/messages/bob?org=o1', { 'GET api/messages/bob': () => page([msg(1)], false) });
    await flush(); expect(screen.getByText('Message 1')).toBeTruthy(); expect(screen.getByText(/This person has left/)).toBeTruthy();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
  });
  it('keys drafts and pending reads by workplace as well as person', async () => {
    let resolveOld!: (value: DirectMessagePage) => void;
    const scripted = open('/messages/bob?org=o1', { 'GET api/messages/bob': c => c.scope?.org === 'o1' ? new Promise<DirectMessagePage>(resolve => { resolveOld = resolve; }) : page([msg(2, 'Other workplace')]) });
    await flush(); fireEvent.click(screen.getByText('Switch workplace')); await flush();
    await act(async () => { resolveOld(page([msg(1, 'Private old workplace')])); });
    expect(screen.queryByText('Private old workplace')).toBeNull(); expect(screen.getByText('Other workplace')).toBeTruthy();
    expect(scripted.calls.filter(c => c.path === 'api/messages/bob').map(c => c.scope?.org)).toEqual(['o1', 'o2']);
  });
  it('uses the normal Back control to close the teammate picker', async () => {
    open('/messages?org=o1', { 'GET api/messages': () => ({ threads: [], unread: 0 }) });
    await flush(); fireEvent.click(screen.getByRole('button', { name: 'New message' })); await flush();
    expect(screen.getByLabelText('Choose a teammate')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' })); await flush();
    expect(screen.queryByLabelText('Choose a teammate')).toBeNull();
    expect(screen.getByRole('button', { name: 'New message' })).toBeTruthy();
  });
  it('sends with desktop Enter and keeps the composer focused during delivery', async () => {
    let finish!: (answer: unknown) => void;
    const scripted = open('/messages/bob?org=o1', {
      'GET api/messages/bob': () => page([]),
      'POST api/messages/bob': () => new Promise(resolve => { finish = resolve; }),
    });
    await flush();
    const box = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    box.focus(); fireEvent.change(box, { target: { value: 'Hello' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(scripted.calls.some(call => call.init?.method === 'POST')).toBe(false);
    fireEvent.keyDown(box, { key: 'Enter' }); await flush();
    // In the conversation from the keypress (note #764): the box is empty and
    // open for the next message, the words stand as Sending….
    expect(box.disabled).toBe(false); expect(box.readOnly).toBe(false); expect(document.activeElement).toBe(box);
    expect(box.value).toBe('');
    const bubble = within(screen.getByRole('log')).getByText('Hello');
    expect(bubble.classList.contains('sending')).toBe(true); expect(bubble.getAttribute('data-time')).toBe('Sending…');
    const sent = JSON.parse(String(scripted.calls.find(call => call.init?.method === 'POST' && call.path === 'api/messages/bob')!.init!.body)) as { clientId: string };
    await act(async () => { finish({ message: { ...msg(1, 'Hello', 'alice'), clientId: sent.clientId } }); });
    expect(box.value).toBe(''); expect(box.readOnly).toBe(false);
    expect(within(screen.getByRole('log')).getAllByText('Hello')).toHaveLength(1);
    expect(within(screen.getByRole('log')).getByText('Hello').classList.contains('sending')).toBe(false);
  });
  it('shows one copy when a read brings the sent row before the send is answered (note #764)', async () => {
    let finish!: (answer: unknown) => void;
    const scripted = open('/messages/bob?org=o1', {
      'GET api/messages/bob': () => page([msg(1)]),
      'GET api/messages/bob?after=1': () => {
        const post = scripted.calls.find(call => call.init?.method === 'POST' && call.path === 'api/messages/bob');
        return page(post ? [{ ...msg(2, 'On my way', 'alice'), clientId: (JSON.parse(String(post.init!.body)) as { clientId: string }).clientId }] : []);
      },
      'POST api/messages/bob': () => new Promise(resolve => { finish = resolve; }),
    });
    await flush();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'On my way' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' })); await flush();
    expect(within(screen.getByRole('log')).getAllByText('On my way')).toHaveLength(1);
    await flush(3000);
    expect(within(screen.getByRole('log')).getAllByText('On my way')).toHaveLength(1);
    expect(within(screen.getByRole('log')).getByText('On my way').classList.contains('sending')).toBe(false);
    const sent = JSON.parse(String(scripted.calls.find(call => call.init?.method === 'POST')!.init!.body)) as { clientId: string };
    await act(async () => { finish({ message: { ...msg(2, 'On my way', 'alice'), clientId: sent.clientId } }); });
    expect(within(screen.getByRole('log')).getAllByText('On my way')).toHaveLength(1);
  });
  it('keeps a half-typed message while the reader steps out to the inbox (note #515)', async () => {
    open('/messages/bob?org=o1', {
      'GET api/messages': () => ({ threads: [{ person: page().person, lastMessage: msg(1), unread: 0 }], unread: 0 }),
      'GET api/messages/bob': () => page([msg(1)]),
      // Back again, the kept conversation asks only for what is new (note #1102).
      'GET api/messages/bob?after=1': () => page([]),
    });
    await flush();
    const box = () => screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    fireEvent.change(box(), { target: { value: 'half a thought' } });
    fireEvent.click(screen.getByRole('button', { name: 'Back' })); await flush();
    fireEvent.click(screen.getByRole('link', { name: /Bob/ })); await flush();
    expect(box().value).toBe('half a thought');
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false);
  });
  // Note #540: on Home this door stands beside Mail's, and Mail's says with a
  // chevron that it opens onto a screen. Two rows in one card, one wearing the
  // mark and the other bare, reads as the bare one being a fact, not a door.
  // The glyph carries no class of its own, so the check is the path it draws.
  const chevronIn = (row: Element) => [...row.querySelectorAll('span.icon > svg > path')]
    .some((drawn) => drawn.getAttribute('d') === 'm9 18 6-6-6-6');
  it('asks for the messaging machine to wake when Home draws the door, and never waits for it (note #1104)', async () => {
    const scripted = open('/overview?org=o1', {
      'GET api/messages/unread': () => ({ unread: 0 }),
      // A wake that never answers: Home must not care.
      'POST api/messages/wake': () => new Promise(() => {}),
    });
    await flush();
    expect(screen.getByText('Direct messages')).toBeTruthy();
    const wakes = scripted.calls.filter(call => call.path === 'api/messages/wake');
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.init?.method).toBe('POST');
    expect(wakes[0]!.scope).toEqual({ org: 'o1' });
    // Nothing that reads a conversation went out from Home.
    expect(scripted.calls.some(call => call.path === 'api/messages' || /^api\/messages\/(?!unread|wake)/.test(call.path))).toBe(false);
  });
  it('wears the chevron on Home, exactly as the Mail door beside it does', async () => {
    open('/overview?org=o1', { 'GET api/messages/unread': () => ({ unread: 0 }) });
    await flush();
    const door = screen.getByText('Direct messages').closest('.crow')!;
    expect(chevronIn(door)).toBe(true);
    expect(door.querySelector('.unreaddot')).toBeNull();
  });

  it('puts the unread dot where the chevron was, rather than beside it', async () => {
    open('/overview?org=o1', { 'GET api/messages/unread': () => ({ unread: 2 }) });
    await flush();
    const door = screen.getByText('2 unread messages').closest('.crow')!;
    expect(door.querySelector('.unreaddot')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Unread messages' })).toBeTruthy();
    expect(chevronIn(door)).toBe(false);
  });

  it('offers teammates but never self in the new-message picker', async () => {
    open('/messages?org=o1', { 'GET api/messages': () => ({ threads: [], unread: 0 }) });
    await flush(); fireEvent.click(screen.getByText('New message'));
    const picker = screen.getByLabelText('Choose a teammate'); expect(within(picker).getByText('Bob')).toBeTruthy(); expect(within(picker).queryByText('Alice')).toBeNull();
  });
  it('reads a non-object answer on the inbox and in a conversation as a quiet miss, says so after three, and redraws when reads land (note #1069)', async () => {
    let bad = false;
    const alert = () => screen.queryAllByRole('alert').find((node) => /Retrying/.test(node.textContent ?? '')) ?? null;
    open('/messages?org=o1', {
      'GET api/messages': () => bad ? null : { threads: [{ person: page().person, lastMessage: msg(1, 'Hello'), unread: 1 }], unread: 1 },
      'GET api/messages/bob': () => bad ? null : page([msg(1, 'Hello')]),
      'GET api/messages/bob?after=1': () => bad ? null : page([]),
    });
    await flush();
    expect(screen.getByRole('link', { name: /Bob/ })).toBeTruthy();
    bad = true;
    await flush(3100); await flush(3100);
    expect(alert()).toBeNull();
    expect(screen.getByRole('link', { name: /Bob/ })).toBeTruthy();
    await flush(3100);
    expect(alert()?.textContent).toBe(`${ANSWER_UNREADABLE_SENTENCE} Retrying…`);
    bad = false; await flush(3100);
    expect(alert()).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: /Bob/ })); await flush();
    expect(screen.getByText('Hello')).toBeTruthy();
    bad = true;
    await flush(3100); await flush(3100);
    expect(alert()).toBeNull();
    expect(screen.getByText('Hello')).toBeTruthy();
    await flush(3100);
    expect(alert()?.textContent).toBe(`${ANSWER_UNREADABLE_SENTENCE} Retrying…`);
    bad = false; await flush(3100);
    expect(alert()).toBeNull();
  });
});
