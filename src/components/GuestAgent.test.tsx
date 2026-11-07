import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUEST_CHIPS, GUEST_HEADING, GUEST_LIFE_LINE, GuestAgentSection, lineWords, minutesLeft, removedWords, whenWords, workingWords } from './GuestAgent';
import {
  GUEST_CREATING_POLL_MS,
  GUEST_IDLE_POLL_MS,
  GUEST_KEY_HEADER,
  GUEST_KEY_STORAGE,
  GUEST_TURN_POLL_MS,
  GUEST_WAITING_POLL_MS,
  type GuestStatus,
} from '../lib/guest-api';

void React;

// Notes #1036, #1038 and #1039: the home page section of the guest's own
// agent, against Rosa's fixed contract (backend/src/shared/guest-agent.ts,
// mirrored in src/lib/guest-api.ts).

type Reply = { status?: number; body: unknown };
let routes: Record<string, (init?: RequestInit) => Reply>;
let calls: Array<{ url: string; init?: RequestInit }>;

function stubFetch() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const route = routes[`${init?.method ?? 'GET'} ${url}`];
    const reply = route ? route(init) : { status: 404, body: {} };
    const status = reply.status ?? 200;
    return { ok: status < 400, status, json: async () => reply.body, text: async () => JSON.stringify(reply.body) } as Response;
  }));
}

/* Cloudflare's widget, standing in: it passes (or fails) at once. */
let turnstileRenders: Array<Record<string, unknown>> = [];
function stubTurnstile(pass = true) {
  turnstileRenders = [];
  (window as unknown as { turnstile: unknown }).turnstile = {
    render: (_el: HTMLElement, options: Record<string, (value?: string) => void>) => {
      turnstileRenders.push(options);
      window.setTimeout(() => (pass ? options.callback('tok-1') : options['error-callback']()), 0);
      return 'w1';
    },
    remove: () => undefined,
  };
}

const JUNO = { name: 'Juno', avatarUrl: '/agent-avatars/juno.jpg' };
const GREETING = "Hi, I'm Juno. I run on a computer of my own, with a copy of the Agentic Cloud's open-source code. Ask me how it works, or ask me to change something and I'll show you what I did.";
const KEY = 'k_abcdefghijklmnopqrstuvwxyz012345';
const GUEST = '/workspace/api/public/guest';
const MACHINE = { cores: 2, memoryGb: 4, dedicated: true, awake: true };

function status(patch: Partial<GuestStatus>): GuestStatus {
  return {
    state: 'none', agent: null, machine: null, messages: [], turn: null, steps: null, estimateSeconds: null, createdAt: null, quietUntil: null, endsAt: null,
    messagesLeft: null, linePosition: null, until: null, removedReason: null, turnstileSiteKey: null,
    limits: { messageMaxChars: 1000, quietMinutes: 30, lifetimeHours: 3, messagesMax: 40 },
    ...patch,
  };
}
const greeting = { id: 'm0', role: 'agent' as const, text: GREETING, at: '2026-11-06T17:00:00Z', state: 'answered' as const };
const readyStatus = (patch: Partial<GuestStatus> = {}) => status({ state: 'ready', agent: JUNO, machine: MACHINE, messages: [greeting], messagesLeft: 40, quietUntil: new Date(Date.now() + 30 * 60_000).toISOString(), ...patch });

const draw = () => render(<GuestAgentSection />);
const flush = async (ms = 0) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};
const words = () => document.querySelector('#your-agent')!.textContent ?? '';
const h2 = () => document.querySelector('#your-agent h2')!.textContent;
const keyOf = (call: { init?: RequestInit }) => (call.init?.headers as Record<string, string> | undefined)?.[GUEST_KEY_HEADER];

describe('GuestAgentSection (note #1039)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    window.localStorage.clear();
    routes = { [`GET ${GUEST}`]: () => ({ body: status({ turnstileSiteKey: '0x4AAAA-site-key' }) }) };
    stubFetch();
    stubTurnstile();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (window as unknown as { turnstile?: unknown }).turnstile;
  });

  it('invites at rest: the heading, the line, two chips, Make my agent, and no Hugo', async () => {
    draw();
    await flush();
    expect(h2()).toBe(GUEST_HEADING);
    // Note #1046 (Adam, 7 Nov 2026): his words, exactly.
    expect(GUEST_HEADING).toBe('Meet your first agent. It knows us inside out.');
    expect(words()).toContain('A real Claude Code agent with our whole code and documentation to read. Ask it anything about the product, get advice on your setup, watch it work. Then delete it.');
    expect(words()).not.toMatch(/Make an agent of your own|computer of its own, reading our open-source code/);
    expect(document.querySelector('#your-agent')!.getAttribute('aria-label')).toBe('Meet your first agent');
    // Decision 11 (Adam, 17:24 UTC): exactly these two chips.
    expect([...document.querySelectorAll('[data-guest-chips] li')].map((li) => li.textContent)).toEqual(['2 cores its own', 'Sonnet high effort']);
    expect(GUEST_CHIPS).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Make my agent/ })).toBeTruthy();
    expect(words()).toContain(GUEST_LIFE_LINE);
    // Decision 1: no Hugo, no question box. claims-we-never-make: no free, no hosted.
    expect(words()).not.toMatch(/Hugo|Ask about|no sign-up|free|hosted/i);
    expect(calls.map((c) => c.url)).toEqual([GUEST]);
    expect(keyOf(calls[0])).toBeUndefined();
  });

  it('shows the resting screen before the tap when no agent can be made', async () => {
    routes[`GET ${GUEST}`] = () => ({ body: status({ state: 'resting', until: '2026-11-06T18:00:00Z' }) });
    draw();
    await flush();
    expect(h2()).toMatch(/^Guest agents are resting until \d\d:\d\d\.$/);
    expect(screen.getByRole('link', { name: 'Build your own Agentic Cloud' }).getAttribute('href')).toBe('/#give-your-agent');
    expect(screen.queryByRole('button', { name: /Make my agent/ })).toBeNull();
  });

  it('makes the agent through Turnstile with the status’s site key, keeps the key, and ticks the real steps', async () => {
    routes[`POST ${GUEST}`] = () => ({ status: 201, body: { key: KEY, status: status({ state: 'creating', agent: JUNO, steps: [
      { id: 'computer', done: false }, { id: 'code', done: false }, { id: 'claude', done: false }, { id: 'hello', done: false },
    ] }) } });
    draw();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Make my agent/ }));
    await flush();
    await flush();
    expect(turnstileRenders).toHaveLength(1);
    expect(turnstileRenders[0].sitekey).toBe('0x4AAAA-site-key');
    expect(turnstileRenders[0].action).toBe('make-guest-agent');
    const post = calls.find((c) => c.init?.method === 'POST')!;
    expect(JSON.parse(String(post.init!.body))).toEqual({ turnstileToken: 'tok-1' });
    expect(window.localStorage.getItem(GUEST_KEY_STORAGE)).toBe(KEY);
    expect(h2()).toBe('Juno is getting ready.');
    expect(document.querySelector('[data-guest-steps] li')!.getAttribute('data-step')).toBe('doing');

    routes[`GET ${GUEST}`] = () => ({ body: status({ state: 'creating', agent: JUNO, steps: [
      { id: 'computer', done: true }, { id: 'code', done: true }, { id: 'claude', done: false }, { id: 'hello', done: false },
    ] }) });
    await flush(GUEST_CREATING_POLL_MS);
    expect([...document.querySelectorAll('[data-guest-steps] li')].map((li) => [li.textContent, li.getAttribute('data-step')])).toEqual([
      ['A computer of its own · 2 cores, 4 GB', 'done'],
      ['A copy of the open-source code', 'done'],
      ['Starting Claude Code on Sonnet', 'doing'],
      ['Saying hello', 'waiting'],
    ]);
    expect(words()).toContain('It takes about fifteen seconds.');
    expect(keyOf(calls[calls.length - 1])).toBe(KEY);
    // Past a spare's wait, the line says the longer one.
    await flush(45_000);
    expect(words()).toContain('This one takes about two minutes.');

    // Ready: the chat opens on the fixed greeting.
    routes[`GET ${GUEST}`] = () => ({ body: readyStatus() });
    await flush(GUEST_CREATING_POLL_MS);
    expect(document.querySelector('[data-guest-name]')!.textContent).toBe('Juno');
    expect(document.querySelector('[data-guest-chip]')!.textContent).toBe('Ready');
    expect(words()).toContain('Your agent · its own computer, 2 cores · Claude Code on Sonnet');
    expect(document.querySelector('[data-guest-messages]')!.textContent).toContain(GREETING);
    expect(document.querySelector('[data-guest-left]')!.textContent).toBe('Juno goes after 30 quiet minutes · 30 left');
  });

  it('says two minutes at once when the status expects a build from nothing', async () => {
    window.localStorage.setItem(GUEST_KEY_STORAGE, KEY);
    routes[`GET ${GUEST}`] = () => ({ body: status({ state: 'creating', agent: JUNO, estimateSeconds: 120, createdAt: new Date(Date.now() - 12_000).toISOString(), steps: [{ id: 'computer', done: false }] }) });
    draw();
    await flush();
    expect(words()).toContain('This one takes about two minutes.');
    expect(words()).toMatch(/Your agent · 0:1\d/);
  });

  it('sends no token when the check is off (no site key)', async () => {
    routes[`GET ${GUEST}`] = () => ({ body: status({}) });
    routes[`POST ${GUEST}`] = () => ({ status: 201, body: { key: KEY, status: status({ state: 'creating', agent: JUNO }) } });
    draw();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Make my agent/ }));
    await flush();
    expect(turnstileRenders).toHaveLength(0);
    expect(JSON.parse(String(calls.find((c) => c.init?.method === 'POST')!.init!.body))).toEqual({});
  });

  it('says so when the check does not pass, here or on the server, and keeps no key', async () => {
    stubTurnstile(false);
    draw();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Make my agent/ }));
    await flush();
    await flush();
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false);
    expect(document.querySelector('[data-guest-problem]')!.textContent).toMatch(/didn’t go through/);

    stubTurnstile(true);
    routes[`POST ${GUEST}`] = () => ({ status: 400, body: { state: 'invalid', error: 'challenge' } });
    fireEvent.click(screen.getByRole('button', { name: /Make my agent/ }));
    await flush();
    await flush();
    expect(document.querySelector('[data-guest-problem]')!.textContent).toMatch(/didn’t go through/);
    expect(window.localStorage.getItem(GUEST_KEY_STORAGE)).toBeNull();
  });

  it('sends a message with the key, shows the text as it is written and what it is doing, then the answer; Stop stops', async () => {
    window.localStorage.setItem(GUEST_KEY_STORAGE, KEY);
    routes[`GET ${GUEST}`] = () => ({ body: readyStatus() });
    routes[`POST ${GUEST}/messages`] = () => ({ status: 202, body: { state: 'accepted', turnId: 't1', messageId: 'm1' } });
    let reads = 0;
    routes[`GET ${GUEST}/turns/t1`] = () => {
      reads += 1;
      if (reads === 1) return { body: { turnId: 't1', state: 'working', partial: 'Yes. Each agent', answer: null, activity: [{ kind: 'read', label: 'backend/src/config/agent-machine-sizes.ts' }], files: ['backend/src/config/agent-machine-sizes.ts'], elapsedSeconds: 3 } };
      if (reads === 2) return { body: { turnId: 't1', state: 'working', partial: 'Yes. Each agent is built', answer: null, activity: [{ kind: 'read', label: 'backend/src/config/agent-machine-sizes.ts' }, { kind: 'run', label: 'npm test -- agent-machine-sizes' }], files: ['backend/src/config/agent-machine-sizes.ts'], elapsedSeconds: 4 } };
      // The backend now holds the whole exchange, as the real one does.
      routes[`GET ${GUEST}`] = () => ({ body: readyStatus({ messages: [greeting,
        { id: 'm1', role: 'visitor', text: 'Does every agent really get its own computer?', at: '2026-11-06T19:00:00Z' },
        { id: 'm2', role: 'agent', text: 'Yes. Each agent is built a machine of its own (`agent-machine-sizes.ts`).', at: '2026-11-06T19:00:09Z', state: 'answered', activity: [{ kind: 'read', label: 'backend/src/config/agent-machine-sizes.ts' }] },
      ] }) });
      return { body: { turnId: 't1', state: 'answered', partial: null, answer: 'Yes. Each agent is built a machine of its own (`agent-machine-sizes.ts`).', activity: [], files: ['backend/src/config/agent-machine-sizes.ts'], elapsedSeconds: 9 } };
    };
    routes[`POST ${GUEST}/turns/t1/stop`] = () => ({ body: { state: 'stopped' } });
    draw();
    await flush();
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Your message to Juno'), { target: { value: 'Does every agent really get its own computer?' } });
    expect(send.disabled).toBe(false);
    fireEvent.submit(screen.getByLabelText('Your message to Juno').closest('form')!);
    await flush();
    const post = calls.find((c) => c.url === `${GUEST}/messages`)!;
    expect(JSON.parse(String(post.init!.body))).toEqual({ text: 'Does every agent really get its own computer?' });
    expect(keyOf(post)).toBe(KEY);
    expect(document.querySelector('[data-guest-chip]')!.textContent).toBe('Reading');
    // During a turn, Stop takes the send circle's place.
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await flush();
    expect(calls.some((c) => c.url === `${GUEST}/turns/t1/stop` && c.init?.method === 'POST')).toBe(true);
    await flush(GUEST_TURN_POLL_MS);
    expect(words()).toContain('Yes. Each agent');
    expect(document.querySelector('[data-guest-working]')!.textContent).toMatch(/^Reading the code · 0:0\d$/);
    expect(document.querySelector('aside')!.textContent).toContain('agent-machine-sizes.ts');
    await flush(GUEST_TURN_POLL_MS);
    expect(document.querySelector('[data-guest-working]')!.textContent).toMatch(/^Running a command · 0:0\d$/);
    // The answer's text only arrives at the end, so what it does carries the
    // wait: the margin lists files and the command it runs, in order.
    expect([...document.querySelectorAll('[data-guest-activity] li')].map((li) => li.textContent)).toEqual([
      'readagent-machine-sizes.tsbackend/src/config/', 'rannpm test -- agent-machine-sizes',
    ]);
    expect(document.querySelector('[data-guest-activity] a')!.getAttribute('href')).toBe('https://agenticcloudcomputer.com/acc/agentic-cloud?path=backend/src/config/agent-machine-sizes.ts&file=1');
    expect([...document.querySelectorAll('[data-guest-doing] code')].map((c) => c.textContent)).toEqual(['agent-machine-sizes.ts', 'npm test -- agent-machine-sizes']);
    expect(document.querySelector('[data-guest-chip]')!.textContent).toBe('Working');
    await flush(GUEST_TURN_POLL_MS);
    const said = [...document.querySelectorAll('[data-guest-messages] > li')].map((li) => li.textContent);
    expect(said).toHaveLength(3);
    expect(said[2]).toContain('Yes. Each agent is built a machine of its own');
    expect(document.querySelector('[data-guest-chip]')!.textContent).toBe('Ready');
    expect(document.querySelector('aside')!.textContent).toMatch(/What it did.*agent-machine-sizes\.ts/);
  });

  it('shows a failed turn once, as the line the backend writes into the conversation', async () => {
    window.localStorage.setItem(GUEST_KEY_STORAGE, KEY);
    routes[`GET ${GUEST}`] = () => ({ body: readyStatus() });
    routes[`POST ${GUEST}/messages`] = () => ({ status: 202, body: { state: 'accepted', turnId: 't2', messageId: 'm1' } });
    routes[`GET ${GUEST}/turns/t2`] = () => ({ body: { turnId: 't2', state: 'failed', partial: null, answer: null, activity: [], files: [], elapsedSeconds: 5 } });
    draw();
    await flush();
    routes[`GET ${GUEST}`] = () => ({ body: readyStatus({ messages: [greeting,
      { id: 'm1', role: 'visitor', text: 'Hello?', at: '2026-11-06T19:00:00Z' },
      { id: 'm2', role: 'agent', text: 'Something went wrong on our side. Try that again.', at: '2026-11-06T19:00:05Z', state: 'failed' },
    ] }) });
    fireEvent.change(screen.getByLabelText('Your message to Juno'), { target: { value: 'Hello?' } });
    fireEvent.submit(screen.getByLabelText('Your message to Juno').closest('form')!);
    await flush();
    await flush(GUEST_TURN_POLL_MS);
    await flush();
    expect(words().match(/Something went wrong on our side/g)).toHaveLength(1);
    expect(document.querySelector('[data-guest-notice]')).toBeNull();
  });

  it('follows the running turn when the page reloads mid-answer, or a send finds one busy', async () => {
    window.localStorage.setItem(GUEST_KEY_STORAGE, KEY);
    routes[`GET ${GUEST}`] = () => ({ body: readyStatus({ state: 'working', turn: { turnId: 't9' } }) });
    routes[`GET ${GUEST}/turns/t9`] = () => ({ body: { turnId: 't9', state: 'working', partial: '', answer: null, activity: [], files: [], elapsedSeconds: 41 } });
    draw();
    await flush();
    await flush(GUEST_TURN_POLL_MS);
    expect(document.querySelector('[data-guest-working]')!.textContent).toMatch(/· 0:4\d$/);
  });

  it('shows the 40-messages notice from a status answer, and keeps the chat', async () => {
    window.localStorage.setItem(GUEST_KEY_STORAGE, KEY);
    routes[`GET ${GUEST}`] = () => ({ body: readyStatus() });
    routes[`POST ${GUEST}/messages`] = () => ({ body: { state: 'status', status: readyStatus({ state: 'limited', messagesLeft: 0 }) } });
    draw();
    await flush();
    fireEvent.change(screen.getByLabelText('Your message to Juno'), { target: { value: 'One more?' } });
    fireEvent.submit(screen.getByLabelText('Your message to Juno').closest('form')!);
    await flush();
    expect(document.querySelector('[data-guest-notice]')!.textContent).toBe('Juno has had its 40 messages.');
    expect(document.querySelector('[data-guest-messages]')!.textContent).toContain(GREETING);
  });

  it('deletes after one confirm, with the key, and offers the two doors', async () => {
    window.localStorage.setItem(GUEST_KEY_STORAGE, KEY);
    routes[`GET ${GUEST}`] = () => ({ body: readyStatus() });
    routes[`DELETE ${GUEST}`] = () => ({ body: { status: status({ state: 'removed', agent: JUNO, removedReason: 'visitor' }) } });
    draw();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Juno' }));
    expect(document.querySelector('[data-guest-confirm]')!.textContent).toContain('Juno and its computer are deleted now. This can’t be undone.');
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(document.querySelector('[data-guest-confirm]')).toBeNull();
    expect(calls.some((c) => c.init?.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Juno' }));
    fireEvent.click([...document.querySelectorAll('[data-guest-confirm] button')][0]);
    await flush();
    const del = calls.find((c) => c.init?.method === 'DELETE')!;
    expect(keyOf(del)).toBe(KEY);
    expect(window.localStorage.getItem(GUEST_KEY_STORAGE)).toBeNull();
    expect(h2()).toBe('Juno is deleted, computer and all.');
    expect(screen.getByRole('link', { name: 'Build your own Agentic Cloud' }).getAttribute('href')).toBe('/#give-your-agent');
    expect(screen.getByRole('button', { name: 'Make another agent' })).toBeTruthy();
    // claims-we-never-make: the words promise the agent and its computer, never the conversation.
    expect(words()).not.toMatch(/conversation|chat|messages? (is|are) deleted/i);
  });

  it('finds the conversation asleep when the visitor comes back, and says how long is left', async () => {
    window.localStorage.setItem(GUEST_KEY_STORAGE, KEY);
    routes[`GET ${GUEST}`] = () => ({ body: readyStatus({ state: 'asleep', machine: { ...MACHINE, awake: false }, quietUntil: new Date(Date.now() + 19 * 60_000).toISOString(), messages: [
      greeting,
      { id: 'm1', role: 'visitor', text: 'Then what happens to the computer when nobody talks to it?', at: '2026-11-06T17:01:00Z' },
      { id: 'm2', role: 'agent', text: 'It goes to sleep after a few quiet minutes.', at: '2026-11-06T17:01:20Z', state: 'answered', activity: [{ kind: 'read', label: 'backend/src/services/fly-idle-reaper.ts' }] },
    ] }) });
    draw();
    await flush();
    expect(document.querySelector('[data-guest-chip]')!.textContent).toBe('Asleep');
    expect(document.querySelector('[data-guest-asleep]')!.textContent).toContain('Juno’s computer went to sleep while you were away. Your next message wakes it, in about ten seconds.');
    expect(document.querySelector('[data-guest-left]')!.textContent).toBe('Juno goes after 30 quiet minutes · 19 left');
    expect(document.querySelector('[data-guest-computer]')!.textContent).toMatch(/^Asleep · 2 cores, 4 GB/);
    expect(document.querySelector('aside')!.textContent).toContain('fly-idle-reaper.ts');
  });

  it('says it was removed after 30 quiet minutes, forgets the key, and shows no conversation', async () => {
    window.localStorage.setItem(GUEST_KEY_STORAGE, KEY);
    routes[`GET ${GUEST}`] = () => ({ body: status({ state: 'removed', agent: JUNO, removedReason: 'quiet' }) });
    draw();
    await flush();
    expect(h2()).toBe('Juno was removed after 30 quiet minutes.');
    expect(words()).toContain('Its computer went with it. Make a new one any time.');
    expect(document.querySelector('[data-guest-messages]')).toBeNull();
    expect(window.localStorage.getItem(GUEST_KEY_STORAGE)).toBeNull();
  });

  it('notices a removal while the tab sits open', async () => {
    window.localStorage.setItem(GUEST_KEY_STORAGE, KEY);
    routes[`GET ${GUEST}`] = () => ({ body: readyStatus() });
    draw();
    await flush();
    routes[`GET ${GUEST}`] = () => ({ body: status({ state: 'removed', agent: JUNO, removedReason: 'lifetime' }) });
    await flush(GUEST_IDLE_POLL_MS);
    expect(h2()).toBe(removedWords('Juno', 'lifetime'));
  });

  it('puts the visitor in line when every slot is taken, with no Hugo, polls every 5 s, and starts theirs when one frees', async () => {
    routes[`POST ${GUEST}`] = () => ({ status: 201, body: { key: KEY, status: status({ state: 'waiting', linePosition: 2 }) } });
    draw();
    await flush();
    routes[`GET ${GUEST}`] = () => ({ body: status({ state: 'waiting', linePosition: 2 }) });
    fireEvent.click(screen.getByRole('button', { name: /Make my agent/ }));
    await flush();
    await flush();
    expect(window.localStorage.getItem(GUEST_KEY_STORAGE)).toBe(KEY);
    expect(h2()).toBe('Every guest agent is taken right now.');
    expect(words()).toContain(lineWords(2));
    expect(words()).not.toMatch(/Hugo|Ask about/);
    expect(document.querySelector('input')).toBeNull();
    const before = calls.length;
    await flush(GUEST_WAITING_POLL_MS);
    expect(calls.length).toBe(before + 1);
    expect(keyOf(calls[calls.length - 1])).toBe(KEY);
    routes[`GET ${GUEST}`] = () => ({ body: status({ state: 'creating', agent: JUNO, steps: [{ id: 'computer', done: false }] }) });
    await flush(GUEST_WAITING_POLL_MS);
    expect(h2()).toBe('Juno is getting ready.');
  });

  it('offers to try again when making it failed on our side', async () => {
    window.localStorage.setItem(GUEST_KEY_STORAGE, KEY);
    routes[`GET ${GUEST}`] = () => ({ body: status({ state: 'failed', agent: JUNO }) });
    draw();
    await flush();
    expect(h2()).toBe('Juno couldn’t be made.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  // Note #1049: on 7 Nov the route rested until 9 Nov 10:00 UTC and the
  // screen said only "until 10:00", which reads as today.
  it('names the day when the resting time is not today', async () => {
    const now = new Date(2026, 10, 7, 14, 0); // Saturday 7 Nov, local
    const at = (d: number, h: number) => new Date(2026, 10, d, h, 0).toISOString();
    expect(whenWords(at(7, 18), now)).toEqual({ until: '18:00', at: 'at 18:00' });
    expect(whenWords(at(8, 10), now)).toEqual({ until: 'tomorrow at 10:00', at: 'tomorrow at 10:00' });
    expect(whenWords(at(9, 10), now)).toEqual({ until: 'Monday at 10:00', at: 'on Monday at 10:00' });
    expect(whenWords(at(20, 10), now)).toEqual({ until: '20 November at 10:00', at: 'on 20 November at 10:00' });
    expect(whenWords(null, now)).toBeNull();

    vi.setSystemTime(now);
    routes[`GET ${GUEST}`] = () => ({ body: status({ state: 'resting', until: at(9, 10) }) });
    draw();
    await flush();
    expect(h2()).toBe('Guest agents are resting until Monday at 10:00.');
  });

  it('counts the minutes left, the place in line and the work in words', () => {
    expect(minutesLeft(new Date(60_000 * 19).toISOString(), 0)).toBe(19);
    expect(minutesLeft(null)).toBeNull();
    expect(lineWords(1)).toMatch(/^You’re next in line\./);
    expect(lineWords(3)).toMatch(/^You’re third in line\./);
    expect(removedWords('Juno', 'visitor')).toBe('Juno was removed.');
    expect(removedWords('Juno', 'messages')).toBe('Juno had its 40 messages, and was removed.');
    expect(workingWords([{ kind: 'edit', label: 'README.md' }], 12)).toBe('Changing its copy · 0:12');
    expect(workingWords([], 3)).toBe('Reading the code · 0:03');
  });
});
