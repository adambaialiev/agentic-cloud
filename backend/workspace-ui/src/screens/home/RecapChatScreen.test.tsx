import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App.js';
import { recallDraft, recapDraftKey } from '../../chrome/draft-memory.js';
import { agent, emptyState, scriptedApi, workspaceScript } from '../../test/fixtures.js';
import type { RecapChatAnswer } from '../../../../src/shared/workspace-recap-chat.js';
import { WorkspaceApiError } from '../../api/client.js';
import { forgetRecapChats, heldRecapChat } from './recap-chat-cache.js';
import { forgetAgents } from '../agent/agent-cache.js';
import { CHAT_TOUCH_QUERY } from '../chat/chat-compose.js';

const state = emptyState({
  org: { orgId: 'o1', name: 'Studio', role: 'admin', members: 1, seats: 0, seatProviders: [] },
  agents: [agent({ id: 'theo', name: 'Theo', avatarUrl: 'https://faces.test/theo.png' })],
});
const yesterday = new Date(Date.now() - 86_400_000).toISOString();
const now = new Date().toISOString();
const conversation: RecapChatAnswer = {
  orgId: 'o1', working: false, waiting: [],
  messages: [
    { id: 'm1', role: 'owner', text: 'Ask Theo for an update', at: yesterday },
    // Stored back when this receipt still carried a door into Theo's own
    // conversation: the address survives in every existing transcript, and
    // the screen is what has to stop honouring it (note #435).
    { id: 'm2', role: 'action', text: 'Sent your request to Theo.', at: yesterday, href: '/chat/theo' },
    { id: 'm2b', role: 'action', text: 'Created note: Call the printer.', at: yesterday, href: '/notes/12?org=o1&room=r1' },
    { id: 'm3', role: 'agent', name: 'Theo', text: 'The booking page is **live**.', at: now },
    { id: 'm4', role: 'assistant', text: 'Theo says the booking page is live.', at: now },
    { id: 'm5', role: 'assistant', text: 'Your call on [#415](/notes/415?room=r1) is still open.', at: now },
    { id: 'm6', role: 'action', kind: 'new-chat-divider', text: '──────────', at: now },
  ],
};
afterEach(() => { document.body.classList.remove('agent-chat-open'); localStorage.removeItem('chat-keyboard-phone'); });
function mount(answer: RecapChatAnswer = conversation, posted: () => RecapChatAnswer = () => ({ ...answer, working: true }), more: Record<string, (call: { init?: RequestInit }) => unknown> = {}) {
  const scripted = scriptedApi({
    ...workspaceScript(() => state),
    // The header reads the agent's OWN runtime (note #437); the briefing's
    // is a different answer, and the header must never show it.
    'GET api/recap/agent/settings': () => ({ orgId: 'o1', settings: { cli: 'claude', model: 'sonnet', effort: 'high' }, models: [{ cli: 'claude', value: 'sonnet', label: 'sonnet', available: true, efforts: [{ value: 'high', label: 'high' }, { value: 'max', label: 'max' }] }] }),
    'GET api/recap/settings': () => ({ orgId: 'o1', settings: { cli: 'codex', model: 'gpt-5.6-terra', effort: 'low' }, models: [] }),
    'POST api/recap/agent/settings': (call) => ({ orgId: 'o1', settings: JSON.parse(String(call.init?.body)), models: [] }),
    'GET api/recap/chat': () => answer,
    'POST api/recap/chat': posted,
    ...more,
  });
  render(<MemoryRouter initialEntries={['/']}><App api={scripted.api} /></MemoryRouter>);
  return scripted;
}

describe('the Chief of Staff\'s conversation, drawn with the room chat\'s parts', () => {
  it('wears its face in the header, in the context ring, from the picture the answer carries (the owner, 2026-10-11)', async () => {
    mount({ ...conversation, avatarUrl: '/workspace/avatars/workspace-agent', context: {
      usedPercent: 91, tokens: 910_000, window: 1_000_000, at: now,
    } });
    const heading = await screen.findByRole('heading', { name: 'Chief of Staff' });
    expect(heading.id).toBe('recapChatTitle');
    expect(heading.closest('a')).toBeNull();
    const face = await waitFor(() => document.getElementById('recapChatFace')!);
    expect(face.querySelector('.ctxring img.avatar')!.getAttribute('src')).toContain('/workspace/avatars/workspace-agent');
    // Home: the face and the name are the door to the Workplace window.
    expect(face.tagName).toBe('BUTTON');
    expect(document.getElementById('homeWorkplaceDoor')!.closest('h1')).toBe(heading);
  });
  it('wears the room chat header: name and the runtime line as the door to the agent\'s own picker', async () => {
    const { calls } = mount();
    await screen.findByRole('heading', { name: 'Chief of Staff' });
    const runtime = await screen.findByRole('button', { name: /Change Chief of Staff model and effort/ });
    await waitFor(() => expect(runtime.textContent).toContain('sonnet · high'));
    expect(document.body.classList.contains('agent-chat-open')).toBe(true);
    await act(async () => fireEvent.click(runtime));
    expect(document.getElementById('screenRecapRuntime')).toBeTruthy();
    expect(document.getElementById('screenHome')?.hidden).toBe(true);
    // The chat shell disables document scrolling while the conversation is
    // visible. The picker is taller than a phone viewport, so it must give
    // that lock back until Back restores the conversation.
    expect(document.body.classList.contains('agent-chat-open')).toBe(false);
    // The picker it opens is the agent's, and a tap writes the agent's route.
    await screen.findByRole('heading', { name: 'Chief of Staff model & effort' });
    await act(async () => fireEvent.click(within(document.getElementById('recapRuntimeEfforts')!).getByRole('radio', { name: 'Max' })));
    await waitFor(() => expect(calls.filter((c) => c.path === 'api/recap/agent/settings' && c.init?.method === 'POST')).toHaveLength(1));
    expect(calls.some((c) => c.path === 'api/recap/settings' && c.init?.method === 'POST')).toBe(false);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Back' })));
    expect(document.body.classList.contains('agent-chat-open')).toBe(true);
  });
  it('draws rows the way a room chat does: day dividers, what it did in the margin, a peer reply with face and name, Markdown replies', async () => {
    mount();
    await screen.findByText('Ask Theo for an update');
    const days = Array.from(document.querySelectorAll('.chatday')).map((el) => el.textContent);
    expect(days).toEqual(['Yesterday', 'Today']);
    expect(document.querySelector('.chatmsg.owner')?.textContent).toBe('Ask Theo for an update');
    // What it did for the reader is one quiet line in the margin (notes
    // #481, #725): this conversation is mostly the platform narrating what it
    // did on the reader's behalf, so that narration must not out-weigh the
    // replies between it. Only the reader keeps a bubble here. And a receipt
    // about another agent says the message went and stops there (note #435):
    // no door into that agent's own conversation — which is where the stored
    // address still points.
    const receipt = document.querySelector('.chatmsg.recapdid')!;
    expect(receipt.tagName).toBe('DIV');
    expect(receipt.textContent).toBe('Sent to Theo');
    expect(receipt.querySelector('.recapname')?.textContent).toBe('Theo');
    expect(document.querySelector('.chatmsg.owner')?.classList.contains('flat')).toBe(false);
    expect(receipt.querySelector('a, button')).toBeNull();
    const peer = document.querySelector('.chatmsg.peer')!;
    expect(peer.querySelector('.chatfrom')?.textContent).toBe('Theo');
    expect(peer.querySelector<HTMLImageElement>('.chatfrom img.face')?.src).toBe('https://faces.test/theo.png');
    expect(peer.querySelector('strong')?.textContent).toBe('live');
    expect(peer.classList.contains('flat')).toBe(true);
    expect(document.querySelector('.chatmsg.agent.rich')?.textContent).toBe('Theo says the booking page is live.');
    expect(document.querySelector('.chatmsg.agent.rich')?.classList.contains('flat')).toBe(true);
    // The agent writes its note references as Workspace addresses; they are
    // doors here, as they were before the screen took the room chat's rows —
    // drawn at the note's own address, without the room an older one still
    // names (note #843).
    const noteLink = screen.getByRole('link', { name: '#415' });
    expect(noteLink.getAttribute('href')).toBe('/notes/415');
    // A fresh chat's rule is drawn as the room chat draws it, not as a card,
    // and says what it divides (note #725).
    expect(document.querySelector('.chatmsg.newchatdivider')?.textContent).toBe('New conversation');
    expect(document.querySelectorAll('.chatmsg.platform')).toHaveLength(1);
    // Every other door stands: what the agent touched in the workplace is
    // still one tap away from the receipt that says it touched it.
    const note = screen.getByRole('button', { name: 'Open: Created note: Call the printer.' });
    expect(note.querySelector('.chatnoticedoor')?.textContent).toBe('Open');
    await act(async () => fireEvent.click(note));
    await waitFor(() => expect(document.getElementById('screenHome')).toBeNull());
  });
  it('keeps a Workspace Agent mail decision inside this conversation too', async () => {
    const approval = {
      id: 'ma_workspace', kind: 'reply' as const, from: { name: 'Saddam', address: 'saddam@agenticcloudcomputer.com' },
      to: { address: 'ada@example.com' }, subject: 'Re: Tuesday', text: 'Four works.',
      requestedBy: 'Workspace Agent', status: 'pending' as const, createdAt: now,
    };
    mount({
      ...conversation,
      messages: [...conversation.messages, {
        id: 'mail', role: 'action', text: 'Workspace Agent wants to reply.', at: now,
        mailApprovalId: approval.id, mailApproval: approval,
      }],
    });
    await screen.findByText('Workspace Agent wants to send this reply');
    expect(document.querySelector('[data-mail-approval="ma_workspace"]')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send email' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Don’t send' })).toBeTruthy();
    // The request itself has no door: this screen is where it is decided.
    expect(document.querySelector('[data-mail-approval="ma_workspace"] a')).toBeNull();
  });
  it('shows the typing bubble with the phase and a Stop while a request runs, and keeps the composer open with its paperclip (note #423)', async () => {
    mount({ ...conversation, working: true, phase: 'Thinking…', waiting: ['Theo'] });
    await screen.findByText('Ask Theo for an update');
    const live = document.getElementById('recapChatLive')!;
    expect(live.hidden).toBe(false);
    expect(live.querySelector('.tdots')).toBeTruthy();
    expect(live.querySelector('.activity')?.textContent).toBe('Thinking…');
    // The conversation says nothing about the replies it is collecting
    // (note #486): the explanatory line is gone and nothing replaced it.
    expect(screen.queryByText(/Waiting for Theo/)).toBeNull();
    expect(screen.queryByText(/Replies will appear here/)).toBeNull();
    expect(live.querySelector('#recapChatStop')?.getAttribute('aria-label')).toBe('Stop');
    // The room chat's composer, whole: a file can ride a message, and the
    // box stays open while a request runs because a message sent then
    // steers the turn rather than waiting for it.
    expect(document.getElementById('agentChatForm')).toBeTruthy();
    expect(document.getElementById('agentChatAttach')).toBeTruthy();
    expect(document.getElementById('agentChatFile')).toBeTruthy();
    expect((document.getElementById('agentChatText') as HTMLTextAreaElement).readOnly).toBe(false);
  });
  it('sends from the room chat composer with one request id per draft, and keeps the words when the send fails', async () => {
    let fail = true;
    const { calls } = mount(conversation, () => { if (fail) throw new Error('Connection lost'); return { ...conversation, working: true }; });
    await screen.findByText('Ask Theo for an update');
    const box = document.getElementById('agentChatText') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Thanks, archive note 12' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
    await screen.findByText('Connection lost');
    expect(box.value).toBe('Thanks, archive note 12');
    fail = false;
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
    await waitFor(() => expect(box.value).toBe(''));
    const sent = calls.filter((c) => c.path === 'api/recap/chat' && c.init?.method === 'POST').map((c) => JSON.parse(c.init!.body as string));
    expect(sent).toHaveLength(2);
    expect(sent[0].text).toBe('Thanks, archive note 12');
    expect(sent[0].clientId).toBe(sent[1].clientId);
    expect(calls.find((c) => c.path === 'api/recap/chat' && c.init?.method === 'POST')?.scope).toEqual({ org: 'o1' });
  });
  it('stops a running request from the bubble, and the transcript says so where a room chat\'s does (note #423)', async () => {
    let answer: RecapChatAnswer = { ...conversation, working: true, phase: 'Thinking…' };
    mount(conversation, () => answer, {
      'GET api/recap/chat': () => answer,
      'POST api/recap/chat/stop': () => {
        answer = { ...conversation, working: false, messages: [...conversation.messages, { id: 'm7', role: 'action', text: 'Turn stopped by the user.', at: now }] };
        return { ok: true, stopped: true, name: 'Workspace Agent' };
      },
    });
    await screen.findByText('Ask Theo for an update');
    await waitFor(() => expect((document.getElementById('recapChatLive') as HTMLElement).hidden).toBe(false));
    await act(async () => fireEvent.click(document.getElementById('recapChatStop')!));
    await waitFor(() => expect(document.getElementById('recapChatLog')!.textContent).toContain('You stopped this turn'));
    await waitFor(() => expect((document.getElementById('recapChatLive') as HTMLElement).hidden).toBe(true));
    expect(screen.queryByRole('alert')).toBeNull();
  });
  /**
   * Note #453. The owner pressed Stop on a real machine: the turn DID end and
   * the transcript said so, but the spinner and the Stop button stayed up for
   * as long as the machine took to unwind, so they pressed Stop again and
   * were told the turn had already finished. The tap is answered now.
   */
  it('answers Stop at once, while the machine is still winding the turn down', async () => {
    let answer: RecapChatAnswer = { ...conversation, working: true, phase: 'Thinking…' };
    let stops = 0;
    mount(conversation, () => answer, {
      'GET api/recap/chat': () => answer,
      'POST api/recap/chat/stop': () => {
        stops += 1;
        // What production actually answers: the run was found and aborted,
        // and the conversation is still running while that unwinds.
        answer = { ...answer, phase: 'Stopping…' };
        return { ok: true, stopped: true, name: 'Workspace Agent' };
      },
    });
    await screen.findByText('Ask Theo for an update');
    const live = () => document.getElementById('recapChatLive') as HTMLElement;
    await waitFor(() => expect(live().hidden).toBe(false));
    await act(async () => fireEvent.click(document.getElementById('recapChatStop')!));
    // Gone at once, though the server still says the turn is running...
    expect(live().hidden).toBe(true);
    expect(document.getElementById('recapChatStopped')!.textContent).toBe('You stopped this turn');
    // ...so there is nothing left to press a second time.
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    // The machine unwinds and the transcript says it permanently; the line
    // that stood in for it goes with the same answer.
    answer = { ...conversation, working: false, messages: [...conversation.messages, { id: 'm7', role: 'action', text: 'Turn stopped by the user.', at: now }] };
    await act(async () => { fireEvent(document, new Event('visibilitychange')); });
    await waitFor(() => expect(document.getElementById('recapChatStopped')).toBeNull());
    expect(document.getElementById('recapChatLog')!.textContent).toContain('You stopped this turn');
    expect(live().hidden).toBe(true);
    expect(stops).toBe(1);
  });
  it('says so when the turn had already finished before Stop', async () => {
    let answer: RecapChatAnswer = { ...conversation, working: true };
    mount(conversation, () => answer, {
      'GET api/recap/chat': () => answer,
      'POST api/recap/chat/stop': () => { answer = { ...conversation, working: false }; return { ok: true, stopped: false, name: 'Workspace Agent' }; },
    });
    await screen.findByText('Ask Theo for an update');
    await act(async () => fireEvent.click(document.getElementById('recapChatStop')!));
    expect((await screen.findByRole('alert')).textContent).toContain('Chief of Staff had already finished.');
  });
  it('leaves a half-typed message waiting under this workplace\u2019s conversation (note #515)', async () => {
    // The composer's own memory is held to the round trip in the room chat's
    // tests; what this screen owes is the right KEY — the Workspace Agent's
    // conversation is one per workplace, not one per agent.
    mount();
    await screen.findByRole('heading', { name: 'Chief of Staff' });
    fireEvent.change(document.getElementById('agentChatText') as HTMLTextAreaElement, { target: { value: 'half a thought' } });
    expect(recallDraft(recapDraftKey('o1'))).toBe('half a thought');
    expect(recallDraft(recapDraftKey('o2'))).toBe('');
  });
  it('sends files with the room chat\'s envelope under one request id, and draws a file row that asks for its picture by the reserved id', async () => {
    const withFile: RecapChatAnswer = { ...conversation, messages: [...conversation.messages, { id: 'm8', role: 'owner', text: 'Put this on note 3', at: now, files: [{ id: 'f1', fileName: 'brief.pdf', contentType: 'application/pdf', sizeBytes: 3 }] }] };
    const { calls } = mount(withFile, () => withFile, {
      'POST api/recap/chat/files': () => ({ ...withFile, working: true }),
      'GET api/agents/workspace-agent/chat/files/f1': () => ({ url: 'https://signed.example/brief.pdf', fileName: 'brief.pdf', expiresAt: 't' }),
    });
    await screen.findByText('Put this on note 3');
    expect(document.querySelector('.chatmsg.owner.chatfile')?.textContent).toContain('brief.pdf');
    const input = document.getElementById('agentChatFile') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' });
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
    fireEvent.change(document.getElementById('agentChatText') as HTMLTextAreaElement, { target: { value: 'And this' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
    const upload = calls.find((c) => c.path === 'api/recap/chat/files');
    expect(upload).toBeTruthy();
    const headers = upload!.init!.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/vnd.agentbuilt.chat-attachments');
    expect(headers['x-recap-client-id']).toMatch(/^[\w-]{8,}$/);
    expect(upload!.init!.body).toBeInstanceOf(Blob);
    expect(calls.some((c) => c.path === 'api/recap/chat' && c.init?.method === 'POST')).toBe(false);
  });
  it('draws the files on the Chief of Staff\'s own reply — its words as Markdown, then the picture on a row of its own (note #749)', async () => {
    const withReply: RecapChatAnswer = { ...conversation, messages: [...conversation.messages, { id: 'm9', role: 'assistant', text: 'Here is the **mask**:', at: now, files: [{ id: 'f2', fileName: 'webcam-circle-mask.png', contentType: 'image/png', sizeBytes: 24125, width: 1920, height: 1080 }] }] };
    mount(withReply, () => withReply, {
      'GET api/agents/workspace-agent/chat/files/f2?preview=1': () => ({ url: 'https://signed.example/mask.png', fileName: 'webcam-circle-mask.png', expiresAt: 't', width: 1920, height: 1080 }),
    });
    await screen.findByText('mask');
    // The words keep the reply's rendering: Markdown, on the page, no bubble.
    const words = screen.getByText('mask').closest('.chatmsg')!;
    expect(words.className).toContain('agent');
    expect(words.className).toContain('rich');
    expect(words.className).not.toContain('chatfile');
    // The file stands on the next row, and it is the picture itself.
    const fileRow = words.nextElementSibling!;
    expect(fileRow.className).toContain('chatmsg');
    expect(fileRow.className).toContain('chatfile');
    await waitFor(() => expect(fileRow.querySelector('img[alt="webcam-circle-mask.png"]')).toBeTruthy());
    expect(fileRow.querySelector('img')!.getAttribute('src')).toBe('https://signed.example/mask.png');
  });
});

describe('the agents stack here too (note #581)', () => {
  it('wears the WHOLE fleet, because no agent is the one being read', async () => {
    mount();
    await screen.findByRole('heading', { name: 'Chief of Staff' });
    // The heading is a constant and stands before the fleet read lands; the
    // stack is drawn from that read, so it is what has to be waited for.
    await waitFor(() => expect(document.getElementById('agentChatSwitch')).toBeTruthy());
    const stack = document.getElementById('agentChatSwitch')!;
    expect(stack.querySelectorAll('.face')).toHaveLength(1);
    fireEvent.click(stack);
    const sheet = await waitFor(() => document.getElementById('agentSwitchSheet')!);
    const faces = [...sheet.querySelectorAll('#agentSwitchGrid .crow')];
    // Nothing is left out here: the Workspace Agent is not one of the agents
    // the sheet lists, so every one of them is still a door.
    expect(faces.map((face) => face.getAttribute('data-agent'))).toEqual(['theo']);
    expect(faces[0]!.getAttribute('role')).toBe('button');
  });
});

describe('coming Back to the conversation from a door in it (note #615)', () => {
  /** jsdom lays nothing out, so the transcript's pane is given its geometry
   *  on the prototype — the pane a Back brings is a NEW node, measured in the
   *  commit it is created in. Every write to its scroll is recorded, and the
   *  last one is where it stands. */
  function geometry() {
    const writes: number[] = [];
    let top = 0;
    const names = ['scrollHeight', 'clientHeight', 'scrollTop'] as const;
    const saved = names.map((name) => [name, Object.getOwnPropertyDescriptor(Element.prototype, name)!] as const);
    const pane = (node: Element) => node.id === 'recapChatScroll';
    Object.defineProperty(Element.prototype, 'scrollHeight', { configurable: true, get() { return pane(this as Element) ? 3000 : 0; } });
    Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get() { return pane(this as Element) ? 600 : 0; } });
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      get() { return pane(this as Element) ? top : 0; },
      set(value: number) { if (pane(this as Element)) { writes.push(value); top = value; } },
    });
    return {
      writes,
      /** The reader scrolling the transcript themselves. */
      readTo(line: number) { top = line; fireEvent.scroll(document.getElementById('recapChatScroll')!); },
      restore() { for (const [name, descriptor] of saved) Object.defineProperty(Element.prototype, name, descriptor); },
    };
  }

  it('stands on the conversation it left, on the reader’s own line, before the catch-up read lands', async () => {
    const pane = geometry();
    // Once the reader has left, every read is held, so what a Back paints can
    // only be what the screen already had.
    let held = false, release: (answer: RecapChatAnswer) => void = () => {};
    const grown: RecapChatAnswer = { ...conversation, messages: [...conversation.messages, { id: 'm7', role: 'assistant', text: 'One more thing.', at: now }] };
    const scripted = scriptedApi({
      ...workspaceScript(() => state),
      'GET api/recap/agent/settings': () => ({ orgId: 'o1', settings: { cli: 'claude', model: 'opus', effort: 'medium' }, models: [] }),
      'GET api/recap/chat': () => (held ? new Promise<RecapChatAnswer>((resolve) => { release = resolve; }) : conversation),
    });
    try {
      render(<MemoryRouter initialEntries={[{ pathname: '/', search: '', key: 'n615-return' }]}><App api={scripted.api} /></MemoryRouter>);
      await screen.findByText('Ask Theo for an update');
      const runtime = await screen.findByRole('button', { name: /Change Chief of Staff model and effort/ });
      await waitFor(() => expect(runtime.textContent).toBe('opus · medium'));
      // Opened, it ends at its newest message.
      expect(pane.writes.at(-1)).toBe(3000);
      // The reader scrolls up to an older reply and walks through its door.
      pane.readTo(900);
      held = true;
      await act(async () => fireEvent.click(screen.getByRole('link', { name: '#415' })));
      await waitFor(() => expect(document.getElementById('screenHome')).toBeNull());
      const reads = scripted.calls.filter((call) => call.path === 'api/recap/chat').length;
      pane.writes.length = 0;
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Back' })));
      // Back: the whole conversation, in the first frame — the read that
      // went out with it is still in flight — and on the line it was left on,
      // with nothing dragging it to the end.
      expect(document.getElementById('screenHome')).toBeTruthy();
      expect(screen.getByText('Ask Theo for an update')).toBeTruthy();
      expect(document.getElementById('recapChatRuntime')?.textContent).toBe('opus · medium');
      expect(document.querySelector('#recapChatLog .arriving')).toBeNull();
      await waitFor(() => expect(scripted.calls.filter((call) => call.path === 'api/recap/chat').length).toBe(reads + 1));
      expect(pane.writes).toEqual([900]);
      // What arrived meanwhile is news for a reader who is not at the end: it
      // does not move them, and the way down says it is there.
      await act(async () => release(grown));
      expect(await screen.findByText('One more thing.')).toBeTruthy();
      expect(pane.writes).toEqual([900]);
      expect(document.querySelector<HTMLElement>('#screenHome .chatjump')?.hidden).toBe(false);
    } finally {
      pane.restore();
    }
  });

  it('a conversation opened afresh paints what this tab last read and still ends at its newest message', async () => {
    const pane = geometry();
    let held = false;
    const scripted = scriptedApi({
      ...workspaceScript(() => state),
      'GET api/recap/agent/settings': () => ({ orgId: 'o1', settings: { cli: 'claude', model: 'opus', effort: 'medium' }, models: [] }),
      'GET api/recap/chat': () => (held ? new Promise<never>(() => {}) : conversation),
    });
    try {
      const first = render(<MemoryRouter initialEntries={[{ pathname: '/', search: '', key: 'n615-first' }]}><App api={scripted.api} /></MemoryRouter>);
      await screen.findByText('Ask Theo for an update');
      pane.readTo(900);
      first.unmount();
      // A new visit — a new history entry, with no line of its own.
      held = true;
      pane.writes.length = 0;
      render(<MemoryRouter initialEntries={[{ pathname: '/', search: '', key: 'n615-again' }]}><App api={scripted.api} /></MemoryRouter>);
      expect(await screen.findByText('Ask Theo for an update')).toBeTruthy();
      expect(pane.writes).toContain(3000);
      expect(pane.writes).not.toContain(900);
    } finally {
      pane.restore();
    }
  });

  it('a workplace switched back to opens at its newest message, not on the line the other workplace’s chat was left on (note #754)', async () => {
    const pane = geometry();
    let active: 'o1' | 'o2' = 'o1';
    const named = { o1: 'ACC', o2: 'Demonstrations' };
    const workplaces = () => emptyState({
      org: { orgId: active, name: named[active], role: 'admin', members: 1, seats: 0, seatProviders: [] },
      organizations: (['o1', 'o2'] as const).map((orgId) => ({ orgId, name: named[orgId], role: 'admin' as const, active: orgId === active, members: 1, agents: 0 })),
    });
    const chats: Record<'o1' | 'o2', RecapChatAnswer> = {
      o1: conversation,
      o2: { orgId: 'o2', working: false, waiting: [], messages: [{ id: 'd1', role: 'owner', text: 'Is the demo ready?', at: now }, { id: 'd2', role: 'assistant', text: 'The demo is ready.', at: now }] },
    };
    const scripted = scriptedApi({
      ...workspaceScript(workplaces),
      'GET api/recap/chat': () => chats[active],
      'POST api/org/active': (call) => { active = JSON.parse(String(call.init?.body)).orgId; return { ok: true, orgId: active, name: named[active] }; },
    });
    const choose = async (name: string) => {
      fireEvent.click(screen.getByRole('button', { name: 'Switch workplace' }));
      await act(async () => fireEvent.click(within(await screen.findByRole('menu', { name: 'Workplaces' })).getByText(name).closest('button')!));
    };
    try {
      render(<MemoryRouter initialEntries={[{ pathname: '/', search: '', key: 'n754-acc' }]}><App api={scripted.api} /></MemoryRouter>);
      await screen.findByText('Ask Theo for an update');
      expect(pane.writes.at(-1)).toBe(3000);
      await choose('Demonstrations');
      await screen.findByText('The demo is ready.');
      // The reader scrolls up into Demonstrations' older messages, then goes back to ACC.
      pane.readTo(900);
      pane.writes.length = 0;
      await choose('ACC');
      await screen.findByText('Ask Theo for an update');
      await waitFor(() => expect(document.querySelector('.orgswapname')?.textContent).toBe('ACC'));
      // ACC is opened, not returned to: nothing puts it on Demonstrations' line.
      expect(pane.writes).not.toContain(900);
      expect(pane.writes.at(-1)).toBe(3000);
    } finally {
      pane.restore();
    }
  });

  it('drops the held conversation for a workplace the reader can no longer see', async () => {
    let refused = false;
    const scripted = scriptedApi({
      ...workspaceScript(() => state),
      'GET api/recap/agent/settings': () => ({ orgId: 'o1', settings: null, models: [] }),
      'GET api/recap/chat': () => { if (refused) throw new WorkspaceApiError('not a member', 403, { error: 'not a member' }); return conversation; },
    });
    const first = render(<MemoryRouter initialEntries={['/']}><App api={scripted.api} /></MemoryRouter>);
    await screen.findByText('Ask Theo for an update');
    refused = true;
    first.unmount();
    render(<MemoryRouter initialEntries={['/']}><App api={scripted.api} /></MemoryRouter>);
    // Home paints the held copy first and the refused read drops it.
    await waitFor(() => expect(heldRecapChat('o1')).toBeNull());
    await waitFor(() => expect(screen.queryByText('Ask Theo for an update')).toBeNull());
  });
});

describe('an agent\'s report on the Chief of Staff\'s chat, folded (note #744)', () => {
  const report = '[Note #209](/workspace/notes/209) is done and with Adam to decide. Change proposal: PR #1365, checks green, rebased onto current main.\n\nWhat it does: the board keeps every week. Two arrows step back to last week and every earlier week, and forward again. A builder\'s page has an All time card.';
  const answer: RecapChatAnswer = { orgId: 'o1', working: false, waiting: [], messages: [
    { id: 'o1', role: 'owner', text: 'What is Willow doing? Please send me the whole long story of it, every detail, because I want to read it all here in this chat right now.', at: now },
    { id: 'g1', role: 'agent', name: 'Willow', text: report, at: now },
    { id: 'a1', role: 'assistant', text: 'Willow finished note #209: the Leaderboard keeps every week now. PR #1365 waits for you.\n\nNothing else is waiting on you today, and the rest of the team is idle.', at: now },
    { id: 'g2', role: 'agent', name: 'Mia', text: 'Back button fix is pushed; checks are running.', at: now },
  ] };
  const mount = () => {
    const scripted = scriptedApi({
      ...workspaceScript(() => state),
      'GET api/recap/agent/settings': () => ({ orgId: 'o1', settings: { cli: 'claude', model: 'opus', effort: 'high' }, models: [] }),
      'GET api/recap/chat': () => answer,
    });
    render(<MemoryRouter initialEntries={['/']}><App api={scripted.api} /></MemoryRouter>);
  };

  it('stands a long report as its sender and two lines, opens it in place with its links, and folds it again', async () => {
    mount();
    const fold = await screen.findByRole('button', { name: /^Read Willow's whole report: Note #209 is done/ });
    const row = fold.closest<HTMLElement>('.chatmsg')!;
    expect(row.className).toContain('peer');
    expect(row.className).toContain('report');
    expect(row.querySelector('.chatfrom')?.textContent).toBe('Willow');
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(row.querySelector('.peerpreview')?.textContent).toBe(`Note #209 is done and with Adam to decide. Change proposal: PR #1365, checks green, rebased onto current main. What it does: the board keeps every week. Two arrows step back to last week and every earlier week, and forward again. A builder's page has an All time card.`);
    // Folded, nothing of the drawn report is on the page: no links to tab into.
    expect(row.querySelector('.peerreportbody')).toBeNull();
    expect(row.querySelector('a[href*="notes"]')).toBeNull();

    fireEvent.click(fold);
    const body = row.querySelector<HTMLElement>('.peerreportbody')!;
    expect(body.textContent).toContain('What it does: the board keeps every week.');
    expect(body.querySelectorAll('p')).toHaveLength(2);
    expect(within(row).getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe('true');
    // A link inside works and does not fold it.
    const link = within(body).getByText('Note #209');
    expect(link.closest('a, button')).toBeTruthy();
    // A tap on the words folds it again …
    fireEvent.click(body.querySelector('p')!);
    expect(row.querySelector('.peerreportbody')).toBeNull();
    // … and so does Show less.
    fireEvent.click(within(row).getByRole('button', { name: /^Read Willow's whole report/ }));
    fireEvent.click(within(row).getByRole('button', { name: 'Show less' }));
    expect(row.querySelector('.peerreportbody')).toBeNull();
  });

  it('leaves a short report, the reader\'s words and the Chief of Staff\'s replies as they were', async () => {
    mount();
    await screen.findByRole('button', { name: /^Read Willow's whole report/ });
    const mia = [...document.querySelectorAll<HTMLElement>('#recapChatLog .chatmsg.peer')].find((node) => node.textContent?.includes('Mia'))!;
    expect(mia.className).not.toContain('report');
    expect(mia.querySelector('.peerfold')).toBeNull();
    expect(mia.textContent).toBe('MiaBack button fix is pushed; checks are running.');
    expect(document.querySelector('.chatmsg.owner')?.textContent).toContain('every detail, because I want to read it all');
    const reply = document.querySelector<HTMLElement>('.chatmsg.agent.rich')!;
    expect(reply.textContent).toContain('Nothing else is waiting on you today');
    expect(reply.querySelector('.peerfold')).toBeNull();
    expect(document.querySelectorAll('#recapChatLog .peerfold')).toHaveLength(1);
  });
});

describe('what the conversation shows of the platform\'s narration (note #725)', () => {
  const asked = { id: 'q1', role: 'owner' as const, text: 'Which agent is working on back button problem?', at: now };
  const said = (messages: RecapChatAnswer['messages'], working = false): RecapChatAnswer => ({ orgId: 'o1', working, waiting: [], messages });
  function mountWith(answer: RecapChatAnswer, agents = state.agents) {
    const scripted = scriptedApi({
      ...workspaceScript(() => ({ ...state, agents })),
      'GET api/recap/agent/settings': () => ({ orgId: 'o1', settings: { cli: 'claude', model: 'opus', effort: 'high' }, models: [] }),
      'GET api/recap/chat': () => answer,
      'POST api/recap/chat': () => ({ ...answer, working: true }),
    });
    render(<MemoryRouter initialEntries={['/']}><App api={scripted.api} /></MemoryRouter>);
    return scripted;
  }

  it('never shows a restart the work carried on through — the row in the owner\'s screenshot', async () => {
    mountWith(said([asked, { id: 'r1', role: 'action', at: now, text: 'The connection restarted before your request "Which agent is working on back button problem?" finished. Nothing had been recorded for it. Picking it up again now.' }], true));
    await screen.findByText(asked.text);
    const log = document.getElementById('recapChatLog')!;
    expect(log.textContent).not.toContain('connection restarted');
    expect(log.querySelectorAll('.chatmsg')).toHaveLength(1);
    expect(document.getElementById('recapChatActivity')?.textContent).toBe('Thinking…');
  });

  it('marks a request that did not complete under the person\'s words, and sends it again from there', async () => {
    const { calls } = mountWith(said([asked, { id: 'r1', role: 'action', at: now, text: 'The connection restarted before your request "Which agent is working on back button problem?" finished, and that was too long ago to pick up safely. Nothing had been recorded for it. Send it again if you still want it done.' }]));
    const again = await screen.findByRole('button', { name: 'Send again' });
    expect(again.closest('.chatmsg.recapunfinished')?.textContent).toBe('Not finished · Send again');
    expect(document.getElementById('recapChatLog')!.textContent).not.toContain('connection restarted');
    await act(async () => fireEvent.click(again));
    await waitFor(() => expect(calls.filter((c) => c.path === 'api/recap/chat' && c.init?.method === 'POST')).toHaveLength(1));
    const posted = calls.find((c) => c.path === 'api/recap/chat' && c.init?.method === 'POST')!;
    expect(JSON.parse(String(posted.init?.body))).toMatchObject({ text: asked.text });
  });

  it('asks a turn that ran out of time to carry on, rather than to start over', async () => {
    const { calls } = mountWith(said([asked, { id: 'a1', role: 'assistant', at: now, text: 'The agent took too long. Any actions it completed are recorded above; ask it to continue.' }]));
    const carry = await screen.findByRole('button', { name: 'Continue' });
    expect(carry.closest('.chatmsg.recapunfinished')?.textContent).toBe('Ran out of time — what was done is above · Continue');
    expect(document.querySelector('#recapChatLog .chatmsg.agent')).toBeNull();
    await act(async () => fireEvent.click(carry));
    await waitFor(() => expect(calls.some((c) => c.path === 'api/recap/chat' && c.init?.method === 'POST' && JSON.parse(String(c.init.body)).text === 'Continue')).toBe(true));
  });

  it('says what it did in one line, the message behind a tap, and what it did on its own tagged', async () => {
    mountWith(said([
      asked,
      { id: 'f1', role: 'action', at: now, text: 'Asked Theo for a fresh chat.' },
      { id: 's1', role: 'action', at: now, text: 'Sent to Theo: Adam asked for note #718. Claim it and read it with the picture.' },
      { id: 'h1', role: 'action', at: now, text: 'On its own: handed note #725 to Theo: Rethink the chat\'s events' },
    ]));
    await screen.findByText(asked.text);
    const [sent, handed] = Array.from(document.querySelectorAll<HTMLElement>('#recapChatLog .chatmsg.recapdid'));
    expect(sent!.tagName).toBe('DETAILS');
    expect(sent!.querySelector('summary')!.textContent).toBe('Sent to Theo · fresh chat first');
    expect(sent!.querySelector('.recapdidbody')!.textContent).toBe('Adam asked for note #718. Claim it and read it with the picture.');
    // The fresh-chat ask folded into the send it prepared: no row of its own.
    expect(document.getElementById('recapChatLog')!.textContent).not.toContain('Asked Theo');
    expect(handed!.querySelector('.recaptag')?.textContent).toBe('on its own');
    expect(handed!.textContent).toBe('on its ownHanded note #725 to Theo — Rethink the chat\'s events');
    expect(document.querySelector('.chatmsg.platform')).toBeNull();
  });

  it('gives a hand-off that fell through the door to the agent\'s own conversation', async () => {
    mountWith(said([asked, { id: 'n1', role: 'action', at: now, text: 'Theo finished without sending a reply here. Its own conversation has the details.' }]));
    const door = await screen.findByRole('link', { name: 'Open Theo\'s chat' });
    expect(door.getAttribute('href')).toBe('/chat/theo');
    expect(door.closest('.chatmsg.recapattention.warn')?.textContent).toBe('Theo finished without answeringOpen Theo\'s chat');
  });

  it('makes the ask to remove an agent a decision card that opens the agent, and says what was decided', async () => {
    const removal = said([{ id: 'x1', role: 'action', at: now, text: 'Asked the person to remove Theo: its work is finished.' }]);
    mountWith(removal, [agent({ id: 'theo', name: 'Theo', removeAsk: { at: now, canDecide: true, byAgentName: 'Chief of Staff', reason: 'its work is finished.' } })]);
    const card = await screen.findByRole('button', { name: 'Decide on Theo\'s screen: Remove Theo?' });
    expect(card.querySelector('.badge')?.textContent).toBe('Your decision');
    expect(card.querySelector('.chatnoticedetail')?.textContent).toBe('Its work is finished.');
    await act(async () => fireEvent.click(card));
    await waitFor(() => expect(document.getElementById('screenHome')).toBeNull());
  });

  it('says an agent that was removed was removed, with no door to a screen that is gone', async () => {
    mountWith(said([{ id: 'x1', role: 'action', at: now, text: 'Asked the person to remove Theo: its work is finished.' }]), []);
    const card = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('#recapChatLog .chatmsg.recapremove .chatnoticetitle');
      expect(found?.textContent).toBe('Theo was removed');
      return found!.closest<HTMLElement>('.chatmsg')!;
    });
    expect(card.tagName).toBe('DIV');
    expect(card.querySelector('.chatnoticetitle')?.textContent).toBe('Theo was removed');
    expect(card.querySelector('.badge')?.textContent).toBe('Removed');
  });

  // The ask to delete a room was a decision card that opened the room's
  // screen, and then said whether it was kept or deleted (note #740), until
  // rooms left the product (note #843): there is nothing left to decide, and
  // no screen to open, so an old row of it is not drawn at all.
  it('draws nothing for an old ask to delete a room, and everything around it as before', async () => {
    mountWith(said([
      asked,
      { id: 'x1', role: 'action', at: now, href: '/rooms/r9?org=o1', text: 'Asked the person to delete the room Launch: the launch is over.' },
      { id: 'a1', role: 'assistant', at: now, text: 'I asked about the launch room.' },
    ]));
    await screen.findByText('I asked about the launch room.');
    expect(screen.getByText(asked.text)).toBeTruthy();
    expect(screen.queryByText(/delete the room/)).toBeNull();
    expect(document.querySelector('#recapChatLog .chatmsg.recapremove')).toBeNull();
    expect(document.querySelector('#recapChatLog a[href^="/rooms/"]')).toBeNull();
  });

  it('puts what it noticed over its reply, with the door to the thing itself', async () => {
    mountWith(said([
      { id: 'e1', role: 'action', kind: 'event', at: now, href: '/decisions/pr/p1', text: 'Checks failed on proposal #1324 "Back button" by Theo: ci/checks.' },
      { id: 'a1', role: 'assistant', at: now, text: 'Theo\'s fix failed its checks.' },
    ]));
    const door = await screen.findByRole('link', { name: 'Open' });
    expect(door.getAttribute('href')).toBe('/decisions/pr/p1');
    expect(door.closest('.chatmsg.recapnoticed')?.textContent).toBe('NoticedChecks failed on proposal #1324 "Back button" by Theo: ci/checks.Open');
  });

  it('sends the reader to its model when the model cannot run', async () => {
    mountWith(said([asked, { id: 'a1', role: 'assistant', at: now, text: 'I could not run the selected model. Check the agent\'s model and your subscription, then try again.' }]));
    await screen.findByText(asked.text);
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: 'Check my settings' })));
    expect(document.getElementById('screenRecapRuntime')).toBeTruthy();
/**
 * The first run (note #726): a brand-new workplace — no plan, no
 * agents — whose Chief of Staff's conversation opens on the platform's own
 * greeting. The words are the server's rows (`shared/first-run.ts`); what is
 * checked here is what the screen adds to them: the starters, the sign-in
 * card under the first ask, and the team's progress card.
 */
  });
});

describe('the first run, in the Chief of Staff\'s conversation (note #726)', () => {
  const fresh = (overrides: Partial<ReturnType<typeof emptyState>> = {}) => emptyState({
    org: { orgId: 'o1', name: 'Saddam’s workplace', role: 'admin', members: 1, seats: 0, seatProviders: [], unnamed: true },
    organizations: [{ orgId: 'o1', name: 'Saddam’s workplace', role: 'admin', active: true, members: 1, agents: 0 }],
    canCreateOrg: true,
    ...overrides,
  });
  const greeting: RecapChatAnswer['messages'][number] = { id: 'g1', role: 'assistant', kind: 'greeting', text: 'Hi Saddam, I\'m your Chief of Staff. Tell me what you\'re working on, and I\'ll put a team of agents on it.', at: now };
  const Where = () => { const here = useLocation(); return <div data-testid="where">{`${here.pathname}${here.search}|${JSON.stringify(here.state ?? null)}`}</div>; };
  function mountFresh(state: () => ReturnType<typeof emptyState>, chat: () => RecapChatAnswer, more: Record<string, (call: { init?: RequestInit }) => unknown> = {}) {
    const scripted = scriptedApi({
      ...workspaceScript(state),
      'GET api/recap/chat': chat,
      'GET api/org/signin': () => ({ signin: null }),
      'GET api/org/seats': () => ({ seats: [], available: [] }),
      ...more,
    });
    render(<MemoryRouter initialEntries={['/']}><Where /><App api={scripted.api} /></MemoryRouter>);
    return scripted;
  }
  const EMPTY_LINE = 'I run your agents. Tell me what you\'re working on, and I\'ll put a team on it.';

  it('draws a joiner\'s welcome as the Chief of Staff\'s own words, with its rooms in bold and its notes as links, and no starters (note #820)', async () => {
    const welcome: RecapChatAnswer['messages'][number] = {
      id: 'w1', role: 'assistant', kind: 'welcome', at: now,
      text: 'Hi Cara, welcome to Acme. I\'m your Chief of Staff here. Here\'s what\'s already going on.\n\n**Website**\n- **Ruby**, Adam\'s agent: Put the pricing page live.\n\n**Latest notes**\n- [Launch checklist](/notes/12?org=o1&room=r1) in Website\n\nAsk me about any of it, or tell me what you\'d like to work on.',
    };
    mountFresh(() => emptyState({
      org: { orgId: 'o1', name: 'Acme', role: 'member', members: 2, seats: 0, seatProviders: [] },
      organizations: [{ orgId: 'o1', name: 'Acme', role: 'member', active: true, members: 2, agents: 1 }],
    }), () => ({ orgId: 'o1', working: false, waiting: [], messages: [welcome] }));
    await screen.findByText(/Hi Cara, welcome to Acme/);
    expect(document.querySelector('.chatempty')).toBeNull();
    expect(document.getElementById('chiefOfStaffEmpty')).toBeNull();
    expect(screen.getByText('Website').tagName).toBe('STRONG');
    // The workplace stays on the link; the room an older welcome names does not (note #843).
    expect(screen.getByRole('link', { name: 'Launch checklist' }).getAttribute('href')).toBe('/notes/12?org=o1');
  });
  it('draws a founder\'s greeting as the pane\'s empty state — one line, no day, no time, no bubble, no starters — and the conversation once the first message lands, with the sign-in card under the first ask (note #967)', async () => {
    let answer: RecapChatAnswer = { orgId: 'o1', working: false, waiting: [], messages: [greeting] };
    const { calls } = mountFresh(fresh, () => answer, {
      'POST api/recap/chat': (call) => {
        const sent = JSON.parse(String(call.init?.body)) as { text: string; clientId: string };
        answer = {
          orgId: 'o1', working: false, waiting: [], awaitingSeat: true,
          messages: [
            greeting,
            { id: 'o1', role: 'owner', text: sent.text, at: now },
            { id: 'a1', role: 'assistant', kind: 'signin-ask', text: 'Got it. Your agents and I run on your own Claude or ChatGPT plan. Sign it in below, and I\'ll start.', at: now },
          ],
        };
        return answer;
      },
    });
    const empty = await screen.findByText(EMPTY_LINE);
    expect(document.getElementById('screenHome')).toBeTruthy();
    expect(empty.closest('#chiefOfStaffEmpty')).toBeTruthy();
    expect(document.getElementById('recapChatScroll')!.classList.contains('isempty')).toBe(true);
    // The stored greeting is not drawn: no message row, no day label, no time, no taps.
    expect(screen.queryByText(/Hi Saddam/)).toBeNull();
    expect(document.querySelector('#recapChatLog .chatmsg, #recapChatLog .chatday, #recapChatLog button')).toBeNull();
    expect(document.getElementById('firstRunSignIn')).toBeNull();

    // The person types their own first ask.
    fireEvent.change(document.getElementById('agentChatText') as HTMLTextAreaElement, { target: { value: 'Set up a team for my startup.' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
    const sent = calls.filter((call) => call.path === 'api/recap/chat' && call.init?.method === 'POST').map((call) => JSON.parse(String(call.init!.body)) as { text: string; clientId: string });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe('Set up a team for my startup.');
    expect(sent[0]!.clientId).toBeTruthy();
    // The owner's words, the ask, and the card under the ask — the empty
    // state is gone, and the greeting is still not drawn.
    await screen.findByText('Set up a team for my startup.');
    await screen.findByText(/Sign it in below, and I'll start\./);
    await waitFor(() => expect(document.getElementById('firstRunSignIn')).toBeTruthy());
    expect(document.getElementById('chiefOfStaffEmpty')).toBeNull();
    expect(document.getElementById('recapChatScroll')!.classList.contains('isempty')).toBe(false);
    expect(screen.queryByText(/Hi Saddam/)).toBeNull();
    const rows = [...document.querySelectorAll<HTMLButtonElement>('#firstRunSignIn .crow.open')];
    expect(rows.map((row) => row.dataset.provider)).toEqual(['claude', 'codex']);
    expect(rows.map((row) => row.querySelector('.name')?.textContent)).toEqual(['Claude', 'Codex']);
    expect(document.getElementById('firstRunSignInWhere')!.textContent).toBe('You sign in on Claude\'s or OpenAI\'s own page, and your password never touches us.');
    // Right under the ask's own row.
    const ask = screen.getByText(/Sign it in below, and I'll start\./).closest('.chatmsg')!;
    expect(ask.nextElementSibling?.id).toBe('firstRunSignIn');

    // A row opens the provider's own sign-in page, told to come back to
    // Home when the plan lands.
    fireEvent.click(rows[0]!);
    expect(await screen.findByRole('heading', { name: 'Sign in to Claude' })).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('/seats/sign-in/claude?org=o1|{"afterSignIn":"/"}');
  });

  it('the card stands under the FIRST ask only, and the Codex row opens ChatGPT\'s page', async () => {
    const ask = (id: string, text: string): RecapChatAnswer['messages'][number] => ({ id, role: 'assistant', kind: 'signin-ask', text, at: now });
    mountFresh(fresh, () => ({
      orgId: 'o1', working: false, waiting: [], awaitingSeat: true,
      messages: [
        greeting,
        { id: 'o1', role: 'owner', text: 'Set up a team for my startup.', at: now },
        ask('a1', 'Got it. Your agents and I run on your own Claude or ChatGPT plan. Sign it in below, and I\'ll start.'),
        { id: 'o2', role: 'owner', text: 'Also a waitlist page.', at: now },
        ask('a2', 'I\'ve kept that too. Sign in your plan above, and I\'ll start on all of it.'),
      ],
    }));
    await screen.findByText('Also a waitlist page.');
    await waitFor(() => expect(document.querySelectorAll('#firstRunSignIn')).toHaveLength(1));
    expect(screen.getByText(/Sign it in below/).closest('.chatmsg')!.nextElementSibling?.id).toBe('firstRunSignIn');
    expect(screen.getByText(/Sign in your plan above/).closest('.chatmsg')!.nextElementSibling?.id).not.toBe('firstRunSignIn');
    expect(document.getElementById('chiefOfStaffEmpty')).toBeNull();
    fireEvent.click(document.querySelector<HTMLButtonElement>('#firstRunSignIn .crow[data-provider="codex"]')!);
    expect(await screen.findByRole('heading', { name: 'Sign in to ChatGPT' })).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('/seats/sign-in/chatgpt?org=o1|{"afterSignIn":"/"}');
  });

  it('draws no card once the plan is in — the ask\'s row stays, the receipt follows it', async () => {
    mountFresh(() => fresh({ org: { orgId: 'o1', name: 'Saddam’s workplace', role: 'admin', members: 1, seats: 1, seatProviders: ['claude'] } }), () => ({
      orgId: 'o1', working: true, phase: 'Thinking…', waiting: [],
      messages: [
        greeting,
        { id: 'o1', role: 'owner', text: 'Set up a team for my startup.', at: now },
        { id: 'a1', role: 'assistant', kind: 'signin-ask', text: 'Got it. Your agents and I run on your own Claude or ChatGPT plan. Sign it in below, and I\'ll start.', at: now },
        { id: 'r1', role: 'action', text: 'Your Claude plan is signed in.', at: now },
      ],
    }));
    await screen.findByText('Your Claude plan is signed in.');
    expect(screen.getByText(/Sign it in below/)).toBeTruthy();
    expect(document.getElementById('firstRunSignIn')).toBeNull();
    expect(document.getElementById('chiefOfStaffEmpty')).toBeNull();
  });

  it('draws the same empty state for a conversation with no rows at all', async () => {
    mountFresh(fresh, () => ({ orgId: 'o1', working: false, waiting: [], messages: [] }));
    expect((await screen.findByText(EMPTY_LINE)).closest('#chiefOfStaffEmpty')).toBeTruthy();
    expect(document.getElementById('firstRunSignIn')).toBeNull();
  });

  // It was a card per ROOM, under the room's name, with the room's whole
  // roster in it, until rooms left the product (note #843): one card,
  // headed "Arriving", of the agents on their way.
  it('shows the team being brought in at the foot of the log — one card, Starting… and Computer being built… — and takes the card away once all are ready', async () => {
    let built = false;
    let miloBuilt = false;
    const team = () => [
      agent({ id: 'ruby', name: 'Ruby', status: built ? 'ready' : 'planned', avatarUrl: 'https://faces.test/ruby.png' }),
      agent({ id: 'milo', name: 'Milo', status: built || miloBuilt ? 'ready' : 'setting-up', avatarUrl: 'https://faces.test/milo.png' }),
      // An agent that was ready all along is not arriving.
      agent({ id: 'ada', name: 'Ada', status: 'ready' }),
    ];
    const state = () => fresh({
      org: { orgId: 'o1', name: 'Saddam’s workplace', role: 'admin', members: 1, seats: 1, seatProviders: ['claude'] },
      agents: team(),
    });
    mountFresh(state, () => ({
      orgId: 'o1', working: true, phase: 'Thinking…', waiting: [],
      messages: [
        greeting,
        { id: 'o1', role: 'owner', text: 'Set up a team for my startup.', at: now },
        { id: 'r1', role: 'action', text: 'Your Claude plan is signed in.', at: now },
        { id: 'r3', role: 'action', text: 'Brought in Ruby.', at: now },
        { id: 'r4', role: 'action', text: 'Brought in Milo.', at: now },
      ],
    }));
    await screen.findByText('Brought in Milo.');
    const card = await waitFor(() => document.getElementById('firstRunTeam')!);
    // At the foot of the log, after the last row.
    expect(card.closest('#recapChatLog')).toBeTruthy();
    expect(card.previousElementSibling?.textContent).toContain('Brought in Milo.');
    expect([...card.querySelectorAll('.arrivinghead')].map((node) => node.textContent)).toEqual(['Arriving']);
    const rows = [...card.querySelectorAll<HTMLElement>('.crow[data-agent]')];
    expect(rows.map((row) => row.dataset.agent)).toEqual(['ruby', 'milo']);
    expect(rows.map((row) => row.className)).toEqual(['crow arriving-planned', 'crow arriving-setting-up']);
    expect(rows.map((row) => row.querySelector('.name')?.textContent)).toEqual(['Ruby', 'Milo']);
    expect(rows.map((row) => row.querySelector('.ctext')?.textContent)).toEqual(['Starting…', 'Computer being built…']);
    expect(rows.map((row) => row.querySelector('img.avatar')?.getAttribute('src'))).toEqual(['https://faces.test/ruby.png', 'https://faces.test/milo.png']);
    expect(within(card).queryByText('Ada')).toBeNull();

    // One of them ready while the other is still built: it keeps its row,
    // now Ready, beside the one still on its way.
    miloBuilt = true;
    await waitFor(() => expect(card.querySelector('.crow[data-agent="milo"] .ctext')?.textContent).toBe('Ready'), { timeout: 8000 });
    expect([...card.querySelectorAll<HTMLElement>('.crow[data-agent]')].map((row) => row.dataset.agent)).toEqual(['ruby', 'milo']);

    // The state re-reads on its own while any agent is planned or setting
    // up; once every one is ready the card goes, and the roster takes over.
    built = true;
    await waitFor(() => expect(document.getElementById('firstRunTeam')).toBeNull(), { timeout: 8000 });
    expect(screen.getByText('Brought in Milo.')).toBeTruthy();
  });
});

describe('the keyboard on a phone (notes #727, #736)', () => {
  it('a tap on the conversation puts the keyboard away, as in a room chat; a tap on a control leaves it', async () => {
    mount();
    await screen.findByText('Ask Theo for an update');
    const box = document.getElementById('agentChatText') as HTMLTextAreaElement;
    act(() => { box.focus(); });
    fireEvent.pointerDown(document.getElementById('recapChatRuntime')!);
    expect(document.activeElement).toBe(box);
    fireEvent.pointerDown(screen.getByText('Ask Theo for an update'));
    expect(document.activeElement).not.toBe(box);
  });

  // The iPhone the restore was measured on (note #351): with the keyboard up
  // `innerHeight` IS the visible height, the layout height stays the whole
  // screen, and the phone has scrolled the page. Safari refuses the first
  // scroll back on the keyboard's closing frame, so the page comes back only
  // because the box's blur arms a retry — the blur a tap on the conversation
  // now gives this screen too.
  it('gives the page back after the keyboard leaves on that tap, even when Safari refuses the first scroll', async () => {
    const listeners = new Set<() => void>();
    const layout = 775;
    let inner = layout, height = layout, offsetTop = 0, scrollY = 0;
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(layout);
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => inner });
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
    vi.stubGlobal('visualViewport', {
      get height() { return height; },
      get offsetTop() { return offsetTop; },
      addEventListener: (_: string, fn: () => void) => { listeners.add(fn); },
      removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn); },
    });
    try {
      mount();
      await screen.findByText('Ask Theo for an update');
      const box = document.getElementById('agentChatText') as HTMLTextAreaElement;
      let refused = false;
      const scrollTo = vi.fn((_x: number, y: number) => { if (!refused) { refused = true; return; } scrollY = y; });
      Object.defineProperty(window, 'scrollTo', { configurable: true, value: scrollTo });
      act(() => { box.focus(); });
      inner = 455; height = 455; scrollY = 320;
      act(() => { listeners.forEach((fn) => fn()); });
      offsetTop = 320;
      act(() => { listeners.forEach((fn) => fn()); });
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(scrollTo).not.toHaveBeenCalled();
      fireEvent.pointerDown(screen.getByText('Ask Theo for an update'));
      inner = layout; height = layout; offsetTop = 0;
      act(() => { listeners.forEach((fn) => fn()); });
      await waitFor(() => expect(scrollY).toBe(0));
      expect(scrollTo.mock.calls.length).toBeGreaterThan(1);
      expect(document.documentElement.style.getPropertyValue('--chat-shell-height')).toBe('');
    } finally {
      Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: layout });
      Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 0 });
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it('gives the page back even when the keyboard leaves with the box still focused', async () => {
    const listeners = new Set<() => void>();
    const layout = 775;
    let inner = layout, height = layout, offsetTop = 0, scrollY = 0;
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(layout);
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => inner });
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
    vi.stubGlobal('visualViewport', {
      get height() { return height; },
      get offsetTop() { return offsetTop; },
      addEventListener: (_: string, fn: () => void) => { listeners.add(fn); },
      removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn); },
    });
    try {
      mount();
      await screen.findByText('Ask Theo for an update');
      const box = document.getElementById('agentChatText') as HTMLTextAreaElement;
      let refused = false;
      const scrollTo = vi.fn((_x: number, y: number) => { if (!refused) { refused = true; return; } scrollY = y; });
      Object.defineProperty(window, 'scrollTo', { configurable: true, value: scrollTo });
      act(() => { box.focus(); });
      inner = 455; height = 455; scrollY = 320;
      act(() => { listeners.forEach((fn) => fn()); });
      await new Promise((resolve) => setTimeout(resolve, 700));
      // The keys go and nothing blurs the box: one viewport event, and the
      // first scroll back refused.
      inner = layout; height = layout; offsetTop = 0;
      act(() => { listeners.forEach((fn) => fn()); });
      expect(document.activeElement).toBe(box);
      await waitFor(() => expect(scrollY).toBe(0));
      expect(scrollTo.mock.calls.length).toBeGreaterThan(1);
    } finally {
      Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: layout });
      Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 0 });
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  // Adam's trace from the Chief of Staff's chat (2026-10-11, keyboard-trace.ts):
  // the hook had a remembered keyboard (455px over a 775px layout, 320px
  // down) and placed the shell for it the frame the box took the focus. The
  // phone then scrolled the page 516px to reach the lowered box instead of
  // its own 320, and never gave it back. The room chat, placed for nothing,
  // came back on its own 54ms after the keys left. That phone is now known
  // and gets nothing written for its keyboard, remembered or read.
  it('never places the shell for a remembered keyboard on the phone that moves its own page (Adam\'s trace, 2026-10-11)', async () => {
    const listeners = new Set<() => void>();
    const layout = 775;
    let inner = layout, height = layout, offsetTop = 0, scrollY = 0;
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(layout);
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => inner });
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
    Object.defineProperty(window, 'scrollTo', { configurable: true, value: (_x: number, y: number) => { scrollY = y; } });
    vi.stubGlobal('visualViewport', {
      get height() { return height; },
      get offsetTop() { return offsetTop; },
      get pageTop() { return scrollY; },
      addEventListener: (_: string, fn: () => void) => { listeners.add(fn); },
      removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn); },
    });
    localStorage.setItem('chat-keyboard', JSON.stringify({ height: 455, top: 320, width: window.innerWidth, window: layout }));
    localStorage.removeItem('chat-keyboard-phone');
    const shell = () => document.documentElement.style.getPropertyValue('--chat-shell-height');
    const shift = () => document.getElementById('screenHome')!.style.transform;
    try {
      mount();
      await screen.findByText('Ask Theo for an update');
      const box = document.getElementById('agentChatText') as HTMLTextAreaElement;
      act(() => { box.focus(); });
      // Placed for the memory before the keys move: the frame-2 reading.
      expect(shell()).toBe('455px');
      expect(shift()).toBe('translateY(320px)');
      // The keyboard rises the phone's way: innerHeight becomes the visible
      // height and the page is scrolled.
      inner = 455; height = 455; offsetTop = 320; scrollY = 516;
      act(() => { listeners.forEach((fn) => fn()); });
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(shell()).toBe('');
      expect(shift()).toBe('');
      expect(localStorage.getItem('chat-keyboard')).toBeNull();
      expect(localStorage.getItem('chat-keyboard-phone')).toBe('1');
      // The keys go: first the frame where innerHeight is already back while
      // the visual viewport is still the keyboard's (what the memory was
      // written from), then the whole viewport.
      fireEvent.pointerDown(screen.getByText('Ask Theo for an update'));
      inner = layout;
      act(() => { listeners.forEach((fn) => fn()); });
      expect(shell()).toBe('');
      expect(shift()).toBe('');
      height = layout; offsetTop = 0;
      act(() => { listeners.forEach((fn) => fn()); });
      await waitFor(() => expect(scrollY).toBe(0));
      // Known from then on: the next visit is placed for nothing from the
      // first frame.
      cleanup();
      localStorage.setItem('chat-keyboard', JSON.stringify({ height: 455, top: 320, width: window.innerWidth, window: layout }));
      mount();
      await screen.findByText('Ask Theo for an update');
      act(() => { (document.getElementById('agentChatText') as HTMLTextAreaElement).focus(); });
      expect(shell()).toBe('');
      expect(shift()).toBe('');
    } finally {
      localStorage.removeItem('chat-keyboard');
      localStorage.removeItem('chat-keyboard-phone');
      Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: layout });
      Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 0 });
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  // The owner's lab (2026-10-11) reproduced the strand only in 'shrink' mode:
  // setting the shell to the keyboard's height on the iPhone, which no
  // scroll-back on blur recovered. That shrink came from ONE real frame where
  // the visual viewport has shrunk (455) and been offset (320) while
  // innerHeight still reads full (775): windowIsVisual is briefly false, and
  // the old readViewport answered it with a real height. On a coarse pointer
  // an offset cover must write NOTHING.
  it('writes no shell height on the offset frame where innerHeight lags, on a touch screen (the owner\'s lab, 2026-10-11)', async () => {
    const listeners = new Set<() => void>();
    const layout = 775;
    let inner = layout, height = layout, offsetTop = 0, scrollY = 0;
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(layout);
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => inner });
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
    Object.defineProperty(window, 'scrollTo', { configurable: true, value: (_x: number, y: number) => { scrollY = y; } });
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: (q: string) => ({ media: q, matches: q === '(pointer: coarse)', addEventListener() {}, removeEventListener() {} }) });
    vi.stubGlobal('visualViewport', {
      get height() { return height; },
      get offsetTop() { return offsetTop; },
      get pageTop() { return scrollY; },
      addEventListener: (_: string, fn: () => void) => { listeners.add(fn); },
      removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn); },
    });
    const shell = () => document.documentElement.style.getPropertyValue('--chat-shell-height');
    try {
      mount();
      await screen.findByText('Ask Theo for an update');
      const box = document.getElementById('agentChatText') as HTMLTextAreaElement;
      act(() => { box.focus(); });
      // The lagging frame, standing still so the settle loop would write it.
      height = 455; offsetTop = 320; scrollY = 320;
      for (let i = 0; i < 4; i += 1) {
        act(() => { listeners.forEach((fn) => fn()); });
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      }
      expect(shell()).toBe('');
      // innerHeight catches up; still nothing.
      inner = 455;
      act(() => { listeners.forEach((fn) => fn()); });
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(shell()).toBe('');
      // The keys leave and the page comes back.
      fireEvent.pointerDown(screen.getByText('Ask Theo for an update'));
      inner = layout; height = layout; offsetTop = 0;
      act(() => { listeners.forEach((fn) => fn()); });
      await waitFor(() => expect(scrollY).toBe(0));
      expect(shell()).toBe('');
    } finally {
      delete (window as { matchMedia?: unknown }).matchMedia;
      localStorage.removeItem('chat-keyboard');
      localStorage.removeItem('chat-keyboard-phone');
      Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: layout });
      Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 0 });
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  // After #1357 the owner's phone still showed the box mid-screen over a gap
  // WITH the keys up. Mid-slide there is a frame where the visual viewport is
  // still the keyboard's (455) while innerHeight reads full (775) and the
  // offset is not yet reported (0): not the phone's keyboard by the reading,
  // so the restore asked the page back while the keys were up, and iOS
  // revealed the box again by scrolling the page further. The restore must
  // wait for the whole viewport.
  it('does not ask the page back while the visual viewport is still the keyboard\'s (the owner\'s phone, 2026-10-11)', async () => {
    const listeners = new Set<() => void>();
    const layout = 775;
    let inner = layout, height = layout, offsetTop = 0, scrollY = 0;
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(layout);
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => inner });
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
    vi.stubGlobal('visualViewport', {
      get height() { return height; },
      get offsetTop() { return offsetTop; },
      get pageTop() { return scrollY; },
      addEventListener: (_: string, fn: () => void) => { listeners.add(fn); },
      removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn); },
    });
    try {
      mount();
      await screen.findByText('Ask Theo for an update');
      const box = document.getElementById('agentChatText') as HTMLTextAreaElement;
      // Spied only from here: the screen's own opening scroll is not what
      // this test is about.
      const scrollTo = vi.fn((_x: number, y: number) => { scrollY = y; });
      Object.defineProperty(window, 'scrollTo', { configurable: true, value: scrollTo });
      act(() => { box.focus(); });
      // The keyboard lands the phone's way: seen.
      inner = 455; height = 455; offsetTop = 320; scrollY = 320;
      for (let i = 0; i < 3; i += 1) {
        act(() => { listeners.forEach((fn) => fn()); });
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      }
      // A frame where innerHeight reads full while the visual viewport is
      // still the keyboard's and the offset not yet reported: keys still up.
      inner = layout; offsetTop = 0;
      for (let i = 0; i < 4; i += 1) {
        act(() => { listeners.forEach((fn) => fn()); });
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(scrollTo).not.toHaveBeenCalled();
      expect(scrollY).toBe(320);
      // The keys leave: the whole viewport is back, and so is the page.
      fireEvent.pointerDown(screen.getByText('Ask Theo for an update'));
      height = layout;
      act(() => { listeners.forEach((fn) => fn()); });
      await waitFor(() => expect(scrollY).toBe(0));
      expect(scrollTo).toHaveBeenCalled();
    } finally {
      localStorage.removeItem('chat-keyboard');
      localStorage.removeItem('chat-keyboard-phone');
      Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: layout });
      Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 0 });
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});

describe('a send on a phone lets go of the box as the room chat\'s does (note #736)', () => {
  // The room chat's send answers at once (note #658): the box empties and
  // gives up the focus inside the Send tap, so an iPhone's keyboard goes
  // with a blur. This screen used to hold the box focused and read-only for
  // the whole request — the keyboard left with the box still focused, the
  // one way of leaving the room chat never takes — and the page stayed up.
  it('empties the box and blurs it in the tap, never read-only, with the words as Sending… until their row arrives', async () => {
    vi.stubGlobal('matchMedia', (media: string) => ({
      media, matches: media === CHAT_TOUCH_QUERY, addEventListener: () => {}, removeEventListener: () => {},
    }));
    let answer: (value: RecapChatAnswer) => void = () => {};
    const reply = new Promise<RecapChatAnswer>((resolve) => { answer = resolve; });
    try {
      mount(conversation, (() => reply) as never);
      await screen.findByText('Ask Theo for an update');
      const box = document.getElementById('agentChatText') as HTMLTextAreaElement;
      act(() => { box.focus(); });
      fireEvent.change(box, { target: { value: 'Is the booking page fast?' } });
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
      expect(document.activeElement).not.toBe(box);
      expect(box.readOnly).toBe(false);
      expect(box.value).toBe('');
      const bubble = document.querySelector('#recapChatLog .chatmsg.owner.sending')!;
      expect(bubble.textContent).toBe('Is the booking page fast?');
      expect(bubble.getAttribute('data-time')).toBe('Sending…');
      await act(async () => {
        answer({ ...conversation, working: true, messages: [...conversation.messages, { id: 'm7', role: 'owner', text: 'Is the booking page fast?', at: now }] });
        await reply;
      });
      await waitFor(() => expect(document.querySelector('#recapChatLog .chatmsg.owner.sending')).toBeNull());
      expect(within(document.getElementById('recapChatLog')!).getAllByText('Is the booking page fast?')).toHaveLength(1);
    } finally { vi.unstubAllGlobals(); }
  });

  it('puts the words back in the box when the send is refused after all', async () => {
    const { calls } = mount(conversation, () => { throw new Error('Connection lost'); });
    await screen.findByText('Ask Theo for an update');
    const box = document.getElementById('agentChatText') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Archive note 12' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
    await screen.findByText('Connection lost');
    expect(box.value).toBe('Archive note 12');
    expect(document.querySelector('#recapChatLog .chatmsg.owner.sending')).toBeNull();
    expect(calls.filter((c) => c.path === 'api/recap/chat' && c.init?.method === 'POST')).toHaveLength(1);
  });

  // An iPhone can leave its VISUAL viewport panned once the keys have gone
  // while `scrollY` already reads zero. A restore that only looked at
  // `scrollY` called that page back and stopped asking.
  it('gives the page back when the keys leave the visual viewport panned and scrollY already reads zero', async () => {
    const listeners = new Set<() => void>();
    const layout = 775;
    let inner = layout, height = layout, offsetTop = 0, pageTop = 0, scrollY = 0;
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(layout);
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => inner });
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
    vi.stubGlobal('visualViewport', {
      get height() { return height; },
      get offsetTop() { return offsetTop; },
      get pageTop() { return pageTop; },
      addEventListener: (_: string, fn: () => void) => { listeners.add(fn); },
      removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn); },
    });
    try {
      mount();
      await screen.findByText('Ask Theo for an update');
      const box = document.getElementById('agentChatText') as HTMLTextAreaElement;
      const scrollTo = vi.fn((_x: number, y: number) => { scrollY = y; pageTop = y; offsetTop = 0; });
      Object.defineProperty(window, 'scrollTo', { configurable: true, value: scrollTo });
      act(() => { box.focus(); });
      inner = 455; height = 455; scrollY = 320; pageTop = 320;
      act(() => { listeners.forEach((fn) => fn()); });
      await new Promise((resolve) => setTimeout(resolve, 700));
      // The keys go; the document scroll reads zero, the visible page does not.
      inner = layout; height = layout; scrollY = 0; offsetTop = 320; pageTop = 320;
      act(() => { listeners.forEach((fn) => fn()); });
      await waitFor(() => expect(pageTop).toBe(0));
      expect(scrollTo).toHaveBeenCalledWith(0, 0);
    } finally {
      Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: layout });
      Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 0 });
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});

describe('a sent message is on screen from the tap (note #764)', () => {
  // The owner, 2026-10-16: "when I send a message, I want it to be rendered
  // smoothly right away, without some delay". The bubble was drawn at the
  // end of the conversation but nothing scrolled to it until an answer came
  // back — the send's own, which is the whole conversation, or the next poll
  // — and the row that then replaced it rose in from nothing.
  /** jsdom lays nothing out: the pane is a 3000px conversation in a 600px
   *  window, and every write to its scroll is recorded. */
  function pane() {
    const writes: number[] = [];
    let top = 2400;
    const names = ['scrollHeight', 'clientHeight', 'scrollTop'] as const;
    const saved = names.map((name) => [name, Object.getOwnPropertyDescriptor(Element.prototype, name)!] as const);
    const ours = (node: Element) => node.id === 'recapChatScroll';
    Object.defineProperty(Element.prototype, 'scrollHeight', { configurable: true, get() { return ours(this as Element) ? 3000 : 0; } });
    Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get() { return ours(this as Element) ? 600 : 0; } });
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      get() { return ours(this as Element) ? top : 0; },
      set(value: number) { if (ours(this as Element)) { writes.push(value); top = value; } },
    });
    return { writes, restore() { for (const [name, descriptor] of saved) Object.defineProperty(Element.prototype, name, descriptor); } };
  }
  const words = 'Is the booking page fast?';
  const recorded: RecapChatAnswer = { ...conversation, working: true, messages: [...conversation.messages, { id: 'm7', role: 'owner', text: words, at: now }] };
  const copies = () => within(document.getElementById('recapChatLog')!).queryAllByText(words);
  async function sendHeld(read: () => RecapChatAnswer) {
    let answer: (value: RecapChatAnswer) => void = () => {};
    const reply = new Promise<RecapChatAnswer>((resolve) => { answer = resolve; });
    mount(conversation, (() => reply) as never, { 'GET api/recap/chat': read });
    await screen.findByText('Ask Theo for an update');
    return { answer: async (value: RecapChatAnswer) => { await act(async () => { answer(value); await reply; }); } };
  }

  it('scrolls the bubble into view in the commit it is drawn in, before the server answers', async () => {
    const geometry = pane();
    try {
      const { answer } = await sendHeld(() => conversation);
      geometry.writes.length = 0;
      fireEvent.change(document.getElementById('agentChatText')!, { target: { value: words } });
      await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
      expect(document.querySelector('#recapChatLog .chatmsg.owner.sending')?.textContent).toBe(words);
      expect(geometry.writes).toContain(3000);
      await answer(recorded);
    } finally { geometry.restore(); }
  });

  it('the server\'s row takes the bubble\'s place: one copy, standing, not rising in again', async () => {
    const { answer } = await sendHeld(() => conversation);
    fireEvent.change(document.getElementById('agentChatText')!, { target: { value: words } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
    expect(copies()).toHaveLength(1);
    await answer(recorded);
    await waitFor(() => expect(document.querySelector('#recapChatLog .chatmsg.owner.sending')).toBeNull());
    expect(copies()).toHaveLength(1);
    expect(copies()[0]!.closest('.chatmsg')!.classList.contains('arriving')).toBe(false);
  });

  it('a poll that brings the row before the send\'s answer still shows one copy', async () => {
    let read = conversation;
    const { answer } = await sendHeld(() => read);
    fireEvent.change(document.getElementById('agentChatText')!, { target: { value: words } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
    // The message is on the record; the send's answer is still on its way.
    read = recorded;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(document.querySelector('#recapChatLog .chatmsg.owner.sending')).toBeNull());
    expect(copies()).toHaveLength(1);
    expect(copies()[0]!.closest('.chatmsg')!.classList.contains('arriving')).toBe(false);
    await answer(recorded);
    expect(copies()).toHaveLength(1);
  });

  it('an answer that does not carry the row lets the bubble go rather than stand beside it', async () => {
    const { answer } = await sendHeld(() => conversation);
    fireEvent.change(document.getElementById('agentChatText')!, { target: { value: words } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
    await answer({ ...conversation, working: true });
    await waitFor(() => expect(document.querySelector('#recapChatLog .chatmsg.owner.sending')).toBeNull());
  });
});

describe('the way back to the newest message is the room chat\'s (note #730)', () => {
  const anchor = () => document.getElementById('recapChatJump')!.parentElement as HTMLElement;
  /** The room chat test's geometry, by hand (jsdom lays nothing out): a
   *  transcript five panes tall, and the line the reader is on. Writes to the
   *  scroll are recorded, not applied — what the jump WROTE is the fact. */
  function paneAt(scrollTop: number, writes: number[] = []) {
    const node = document.getElementById('recapChatScroll')!;
    Object.defineProperty(node, 'scrollHeight', { configurable: true, get: () => 3000 });
    Object.defineProperty(node, 'clientHeight', { configurable: true, get: () => 600 });
    Object.defineProperty(node, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value: number) => { writes.push(value); } });
    return node;
  }
  /** A first scroll at a new pane height is the pane resizing, not the reader; the second is the reader. */
  const reader = (node: HTMLElement) => { fireEvent.scroll(node); fireEvent.scroll(node); };

  it('is the same button, not there at the end, there a pane up, and gone again on the way back', async () => {
    mount();
    await screen.findByText('Ask Theo for an update');
    expect(anchor().className).toBe('chatjump');
    expect(anchor().hidden).toBe(true);
    reader(paneAt(3000 - 600 - 900));
    expect(anchor().hidden).toBe(false);
    reader(paneAt(3000 - 600 - 300));
    expect(anchor().hidden).toBe(true);
  });

  it('a scroll from the pane resizing under the reader decides nothing', async () => {
    mount();
    await screen.findByText('Ask Theo for an update');
    fireEvent.scroll(paneAt(0));
    expect(anchor().hidden).toBe(true);
  });

  it('takes the reader to the newest message when tapped, and goes at once', async () => {
    mount();
    await screen.findByText('Ask Theo for an update');
    const writes: number[] = [];
    reader(paneAt(0, writes));
    expect(anchor().hidden).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Scroll to the newest message' }));
    expect(writes).toContain(3000);
    expect(anchor().hidden).toBe(true);
  });

  it('stays gone for the whole trip down, and comes back if the reader turns up again', async () => {
    mount();
    await screen.findByText('Ask Theo for an update');
    reader(paneAt(0));
    fireEvent.click(screen.getByRole('button', { name: 'Scroll to the newest message' }));
    // A frame of the smooth scroll: still far from the end, on the way down.
    reader(paneAt(1000));
    expect(anchor().hidden).toBe(true);
    // The reader stops it and goes back up.
    reader(paneAt(500));
    expect(anchor().hidden).toBe(false);
  });
});

describe('the phone\'s screen going dark and coming back (note #750)', () => {
  /** jsdom lays nothing out: the pane's box and scroll by hand, as a phone's
   *  would move them. A write to the scroll lands, clamped as a browser's. */
  function phonePane() {
    const node = document.getElementById('recapChatScroll')!;
    const pane = { top: 2400, height: 600, content: 3000, writes: [] as number[] };
    Object.defineProperty(node, 'scrollHeight', { configurable: true, get: () => pane.content });
    Object.defineProperty(node, 'clientHeight', { configurable: true, get: () => pane.height });
    Object.defineProperty(node, 'scrollTop', {
      configurable: true,
      get: () => pane.top,
      set: (value: number) => { pane.writes.push(value); pane.top = Math.max(0, Math.min(value, pane.content - pane.height)); },
    });
    // The reader at the newest message, at a settled size: the first scroll
    // at a new size is the pane's, the second the reader's.
    fireEvent.scroll(node); fireEvent.scroll(node);
    return { node, pane };
  }
  let hidden = false;
  const visibility = (dark: boolean) => act(async () => { hidden = dark; document.dispatchEvent(new Event('visibilitychange')); });
  beforeEach(() => { hidden = false; Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden }); });
  afterEach(() => { delete (document as { hidden?: boolean }).hidden; });
  const grown: RecapChatAnswer = { ...conversation, messages: [...conversation.messages, { id: 'm7', role: 'assistant', text: 'Theo finished while you were away.', at: now }] };
  const jumpShown = () => !(document.getElementById('recapChatJump')!.parentElement as HTMLElement).hidden;

  it('a scroll Safari makes as the pane changes size leaves the reader following the conversation (the owner, 2026-10-14)', async () => {
    let answer = conversation;
    mount(conversation, undefined, { 'GET api/recap/chat': () => answer });
    await screen.findByText('Ask Theo for an update');
    const { node, pane } = phonePane();
    // The page laid out a sliver tall and back, the conversation grown
    // meanwhile — WebKit, measured: it keeps the words in place both ways,
    // and both scrolls stand a long way from the newest message.
    pane.height = 12; pane.top = 2458; fireEvent.scroll(node);
    pane.height = 600; pane.content = 3202; fireEvent.scroll(node);
    pane.writes.length = 0;
    answer = grown;
    // The next read lands, and the reader is carried down to it.
    expect(await screen.findByText('Theo finished while you were away.', undefined, { timeout: 4500 })).toBeTruthy();
    expect(pane.writes.at(-1)).toBe(3202);
    expect(jumpShown()).toBe(false);
  });

  it('nothing scrolls for the reader while the page wakes, and a reader at the end is put back on it', async () => {
    const scripted = mount();
    await screen.findByText('Ask Theo for an update');
    const { node, pane } = phonePane();
    await visibility(true);
    const reads = scripted.calls.filter((call) => call.path === 'api/recap/chat').length;
    await visibility(false);
    await waitFor(() => expect(scripted.calls.filter((call) => call.path === 'api/recap/chat').length).toBe(reads + 1));
    // Laid out wider and back between two frames: the pane never reads as
    // resized, but the words were kept in place and the end moved on.
    pane.top = 1400; fireEvent.scroll(node); fireEvent.scroll(node);
    pane.writes.length = 0;
    expect(jumpShown()).toBe(false);
    await waitFor(() => expect(pane.writes).toContain(3000), { timeout: 2000 });
    expect(pane.top).toBe(2400);
  });

  it('a reader who touches the conversation as it wakes is reading it again at once', async () => {
    mount();
    await screen.findByText('Ask Theo for an update');
    const { node, pane } = phonePane();
    await visibility(true);
    await visibility(false);
    fireEvent.touchStart(node);
    pane.top = 300; fireEvent.scroll(node);
    expect(jumpShown()).toBe(true);
    pane.writes.length = 0;
    await act(() => new Promise((resolve) => { setTimeout(resolve, 1300); }));
    expect(pane.writes).not.toContain(3000);
    expect(pane.top).toBe(300);
  });
});

describe('the header\'s model and effort while the chat loads (note #735)', () => {
  /** A visit whose settings read is still out: the network is slow. */
  function visitWithSlowSettings() {
    const scripted = scriptedApi({
      ...workspaceScript(() => state),
      'GET api/recap/agent/settings': () => new Promise<never>(() => {}),
      'GET api/recap/chat': () => conversation,
    });
    render(<MemoryRouter initialEntries={['/']}><App api={scripted.api} /></MemoryRouter>);
    return scripted;
  }
  const runtimeLine = () => document.getElementById('recapChatRuntime')?.textContent ?? '';
  /** A reload: everything the tab held in memory is gone; the browser's own storage is not. */
  const reload = () => { cleanup(); forgetRecapChats(); forgetAgents(); };

  it('a fresh open shows the model and effort it last showed, not the placeholder, while its read is out', async () => {
    mount();
    await waitFor(() => expect(runtimeLine()).toContain('sonnet · high'));
    reload();
    visitWithSlowSettings();
    await screen.findByText('Ask Theo for an update');
    expect(runtimeLine()).toContain('sonnet · high');
    expect(runtimeLine()).not.toContain('Model & effort');
  });

  it('keeps the general words in a browser that has never seen a choice', async () => {
    visitWithSlowSettings();
    await screen.findByText('Ask Theo for an update');
    expect(runtimeLine()).toContain('Model & effort');
  });

  it('lets the fresh read replace it, and a read that says nothing is chosen bring the general words back', async () => {
    mount();
    await waitFor(() => expect(runtimeLine()).toContain('sonnet · high'));
    reload();
    let answer: unknown = { orgId: 'o1', settings: { cli: 'claude', model: 'opus', effort: 'max' }, models: [] };
    const scripted = scriptedApi({
      ...workspaceScript(() => state),
      'GET api/recap/agent/settings': () => answer,
      'GET api/recap/chat': () => conversation,
    });
    render(<MemoryRouter initialEntries={['/']}><App api={scripted.api} /></MemoryRouter>);
    await waitFor(() => expect(runtimeLine()).toContain('opus · max'));
    answer = { orgId: 'o1', settings: null, models: [] };
    reload();
    render(<MemoryRouter initialEntries={['/']}><App api={scripted.api} /></MemoryRouter>);
    await waitFor(() => expect(runtimeLine()).toContain('Model & effort'));
    // …and it is not kept for the next open either.
    reload();
    visitWithSlowSettings();
    await screen.findByText('Ask Theo for an update');
    expect(runtimeLine()).toContain('Model & effort');
  });

  it('opens the picker on the remembered choice while its read is out', async () => {
    mount();
    await waitFor(() => expect(runtimeLine()).toContain('sonnet · high'));
    reload();
    visitWithSlowSettings();
    await screen.findByText('Ask Theo for an update');
    await act(async () => fireEvent.click(document.getElementById('recapChatRuntime')!));
    await screen.findByRole('heading', { name: 'Chief of Staff model & effort' });
    expect(document.querySelector('#recapRuntimeModels .crow.current .name')?.textContent).toBe('Sonnet');
  });
  it('records the keyboard for the owner\'s phone with the room chat\'s recorder, only when asked (note #736)', async () => {
    mount();
    await screen.findByText('Ask Theo for an update');
    expect(document.getElementById('agentChatTrace')).toBeNull();
    localStorage.setItem('chat-keyboard-trace', '1');
    try {
      cleanup();
      mount();
      await screen.findByText('Ask Theo for an update');
      expect(document.getElementById('agentChatTrace')!.textContent).toContain('screenHome');
      const box = document.getElementById('agentChatText') as HTMLTextAreaElement;
      act(() => { box.focus(); });
      act(() => { box.blur(); });
      await waitFor(() => expect(document.getElementById('agentChatTrace')!.textContent).toContain('screenHome blur'), { timeout: 5000 });
    } finally {
      localStorage.removeItem('chat-keyboard-trace');
    }
  });
});

/** Note #945: the same recap line under the Chief of Staff's latest request. */
describe('the recap line under its latest request (note #945)', () => {
  const ended = { startedAt: new Date(Date.now() - 65_000).toISOString(), endedAt: new Date(Date.now() - 1_000).toISOString() };
  const asked: RecapChatAnswer = {
    orgId: 'o1', working: false, waiting: [],
    messages: [
      { id: 'a1', role: 'owner', text: 'Ask Theo to ship the booking page', at: ended.startedAt },
      { id: 'a2', role: 'assistant', text: 'Asked Theo; I will tell you when it lands.', at: new Date(Date.now() - 2_000).toISOString() },
    ],
  };
  const line = () => document.getElementById('recapChatRecap');

  it('stands under the request once it is over, centred in the column, saying whose answer it still waits for', async () => {
    mount({ ...asked, waiting: ['Theo'], lastTurn: { ...ended, recap: 'Theo is shipping the booking page. Nothing for you until he reports.' } });
    await waitFor(() => expect(line()).toBeTruthy());
    expect(line()!.querySelector('.turnfacts')!.textContent).toMatch(/^Worked for 1m 4s · done .+ · waiting on Theo$/);
    expect(line()!.querySelector('.turnrecaptext')!.textContent).toBe('Recap: Theo is shipping the booking page. Nothing for you until he reports.');
    // In the conversation's scroller, after its log: the column's own child.
    expect(line()!.parentElement!.id).toBe('recapChatScroll');
    expect(document.getElementById('recapChatLog')!.contains(line())).toBe(false);
  });

  it('draws no recap before it arrives, then the recap in place when it does', async () => {
    let answer: RecapChatAnswer = { ...asked, lastTurn: ended };
    mount(answer, undefined, { 'GET api/recap/chat': () => answer });
    await waitFor(() => expect(line()).toBeTruthy());
    expect(line()!.querySelector('.turnrecaptext')).toBeNull();
    answer = { ...asked, lastTurn: { ...ended, recap: 'Theo is on it.' } };
    await waitFor(() => expect(line()!.querySelector('.turnrecaptext')?.textContent).toBe('Recap: Theo is on it.'), { timeout: 5000 });
  });

  it('is absent while a request runs and under the person\'s own newest words', async () => {
    let answer: RecapChatAnswer = { ...asked, working: true, phase: 'Thinking…', lastTurn: { ...ended, recap: 'Done.' } };
    mount(answer, undefined, { 'GET api/recap/chat': () => answer });
    await screen.findByText('Ask Theo to ship the booking page');
    expect(line()).toBeNull();
    answer = { ...asked, messages: [...asked.messages, { id: 'a3', role: 'owner', text: 'Thanks', at: new Date().toISOString() }], lastTurn: { ...ended, recap: 'Done.' } };
    await screen.findByText('Thanks', undefined, { timeout: 5000 });
    expect(line()).toBeNull();
  });
});
