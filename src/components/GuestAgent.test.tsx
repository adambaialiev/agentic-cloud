import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUEST_HEADING, GUEST_MAKE, GUEST_STEP_DETAIL, GuestAgentSection, buildWords, jobClock, jobCount, minutesLeft, removedWords, stepTime, whenWords, workingWords } from './GuestAgent';
import {
  GUEST_CREATING_POLL_MS,
  GUEST_IDLE_POLL_MS,
  GUEST_JOB_POLL_MS,
  jobsOf,
  GUEST_KEY_HEADER,
  GUEST_KEY_STORAGE,
  GUEST_TURN_POLL_MS,
  type GuestCreateStep,
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
/** The build's five steps (note #1055), the first `done` of them finished. */
/* A build as the route reports it (note #1055): the computer is nearly the
   whole wait, the rest about a second each. `at` is the tap, `done` how many
   steps have finished. */
const TOOK = { machine: 25_400, agent: 800, code: 1_500, waking: 700, ready: 0 };
function timedSteps(at: number, done: number): GuestCreateStep[] {
  let t = at;
  return (['machine', 'agent', 'code', 'waking', 'ready'] as const).map((id, i) => {
    const startedAt = i <= done ? new Date(t).toISOString() : null;
    const doneAt = i < done ? new Date(t + TOOK[id]).toISOString() : null;
    if (i < done) t += TOOK[id];
    return { id, done: i < done, startedAt, doneAt };
  });
}
function buildSteps(done: number): GuestCreateStep[] {
  return (['machine', 'agent', 'code', 'waking', 'ready'] as const).map((id, i) => ({
    id, done: i < done, startedAt: i <= done ? '2026-11-07T16:00:00.000Z' : null, doneAt: i < done ? '2026-11-07T16:00:10.000Z' : null,
  }));
}
const GREETING = "Hi, I'm Juno, a Claude Code agent on a computer of my own, with the Agentic Cloud's open-source code to read and run. I'm here to help you find out whether it fits your team. Which coding agents does your team use today, and where do they run? And what gets in the way? Or just ask me how it works.";
const KEY = 'k_abcdefghijklmnopqrstuvwxyz012345';
const GUEST = '/workspace/api/public/guest';
const MACHINE = { cores: 2, memoryGb: 4, dedicated: true, awake: true };

function status(patch: Partial<GuestStatus>): GuestStatus {
  return {
    state: 'none', agent: null, machine: null, messages: [], turn: null, steps: null, estimateSeconds: null, createdAt: null, quietUntil: null, endsAt: null,
    messagesLeft: null, step: null, until: null, removedReason: null, turnstileSiteKey: null,
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

  it('invites at rest: the heading, the line, Start guest agent alone, and no Hugo', async () => {
    draw();
    await flush();
    expect(h2()).toBe(GUEST_HEADING);
    // Note #1046 (Adam, 7 Nov 2026): his words, exactly.
    expect(GUEST_HEADING).toBe('Meet your first agent. It knows us inside out.');
    expect(words()).toContain('A real Claude Code agent with our whole code and documentation to read. Ask it anything about the product, get advice on your setup, watch it work. Then delete it.');
    expect(words()).not.toMatch(/Make an agent of your own|computer of its own, reading our open-source code/);
    expect(document.querySelector('#your-agent')!.getAttribute('aria-label')).toBe('Meet your first agent');
    // Note #1084 (Adam, 8 Nov 2026): no chips, no sleep line, and the button
    // says it is a guest agent. Nothing is drawn under the button.
    expect(document.querySelector('[data-guest-chips]')).toBeNull();
    expect(words()).not.toMatch(/2 cores|its own|Sonnet|high effort|sleeps when|quiet minutes|Make my agent/);
    expect(GUEST_MAKE).toBe('Start guest agent');
    const button = screen.getByRole('button', { name: /^Start guest agent/ });
    expect(button.nextElementSibling).toBeNull();
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
    expect(screen.queryByRole('button', { name: /Start guest agent/ })).toBeNull();
  });

  it('makes the agent through Turnstile with the status’s site key, keeps the key, and ticks the real steps', async () => {
    routes[`POST ${GUEST}`] = () => ({ status: 201, body: { key: KEY, status: status({ state: 'creating', agent: JUNO, step: 'machine', estimateSeconds: 35, steps: buildSteps(0) }) } });
    draw();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Start guest agent/ }));
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

    routes[`GET ${GUEST}`] = () => ({ body: status({ state: 'creating', agent: JUNO, step: 'code', estimateSeconds: 35, steps: buildSteps(2) }) });
    await flush(GUEST_CREATING_POLL_MS);
    expect([...document.querySelectorAll('[data-guest-steps] li')].map((li) => [li.querySelector('p')!.textContent, li.getAttribute('data-step')])).toEqual([
      ['Making your computer, done', 'done'],
      ['Setting up your agent, done', 'done'],
      ['Copying our code, happening now', 'doing'],
      ['Waking up', 'next'],
      ['Ready', 'next'],
    ]);
    expect(keyOf(calls[calls.length - 1])).toBe(KEY);

    // Ready: the chat opens on the fixed greeting.
    routes[`GET ${GUEST}`] = () => ({ body: readyStatus() });
    await flush(GUEST_CREATING_POLL_MS);
    expect(document.querySelector('[data-guest-name]')!.textContent).toBe('Juno');
    expect(document.querySelector('[data-guest-chip]')!.textContent).toBe('Ready');
    expect(words()).toContain('Your agent · its own computer, 2 cores · Claude Code on Sonnet');
    expect(document.querySelector('[data-guest-messages]')!.textContent).toContain(GREETING);
    expect(document.querySelector('[data-guest-left]')!.textContent).toBe('Juno goes after 30 quiet minutes · 30 left');
  });

  // Note #1105: the build runs on our side, so "Keep this page open." is gone.
  // A visitor who taps, leaves mid-build and comes back finds the same agent,
  // further along, by the key this browser kept; then it is ready.
  it('leaving mid-build and coming back finds the same agent, and asks nobody to keep the page open', async () => {
    routes[`POST ${GUEST}`] = () => ({ status: 201, body: { key: KEY, status: status({ state: 'creating', agent: JUNO, step: 'machine', estimateSeconds: 35, steps: buildSteps(0) }) } });
    const first = draw();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Start guest agent/ }));
    await flush();
    await flush();
    expect(h2()).toBe('Juno is getting ready.');
    expect(words()).not.toMatch(/keep this page open/i);
    first.unmount();

    routes[`GET ${GUEST}`] = () => ({ body: status({ state: 'creating', agent: JUNO, step: 'code', estimateSeconds: 35, steps: buildSteps(2) }) });
    calls.length = 0;
    draw();
    await flush();
    expect(keyOf(calls[0])).toBe(KEY);
    expect(h2()).toBe('Juno is getting ready.');
    expect(document.querySelector('[data-step-id="code"]')!.getAttribute('data-step')).toBe('doing');
    expect(words()).not.toMatch(/keep this page open/i);
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false);

    routes[`GET ${GUEST}`] = () => ({ body: readyStatus() });
    await flush(GUEST_CREATING_POLL_MS);
    expect(document.querySelector('[data-guest-name]')!.textContent).toBe('Juno');
  });

  // Note #1060: the five steps, each with its own clock, the long first one
  // alive while it runs.
  it('draws the long first step alive: its clock ticks, it says what is happening, and the heading keeps time', async () => {
    window.localStorage.setItem(GUEST_KEY_STORAGE, KEY);
    const tap = Date.now();
    routes[`GET ${GUEST}`] = () => ({ body: status({ state: 'creating', agent: JUNO, estimateSeconds: 35, createdAt: new Date(tap).toISOString(), step: 'machine', steps: timedSteps(tap, 0) }) });
    draw();
    await flush();
    const row = (id: string) => document.querySelector(`[data-step-id="${id}"]`)!;
    expect(row('machine').getAttribute('data-step')).toBe('doing');
    expect(row('machine').querySelector('[data-step-detail]')!.textContent).toBe(GUEST_STEP_DETAIL.machine);
    expect(row('machine').querySelector('[data-step-time]')!.textContent).toBe('0 s');
    expect(row('agent').querySelector('[data-step-time]')).toBeNull();
    expect(document.querySelector('[data-guest-clock]')!.textContent).toContain('0:00 of about half a minute');
    await flush(12_000);
    expect(row('machine').querySelector('[data-step-time]')!.textContent).toBe('12 s');
    expect(document.querySelector('[data-guest-clock]')!.textContent).toContain('0:12 of about half a minute');
    // The clocks are not read aloud every second; the state is, in words.
    expect(row('machine').querySelector('[data-step-time]')!.getAttribute('aria-hidden')).toBe('true');
    expect(row('machine').querySelector('p')!.textContent).toBe('Making your computer, happening now');
    // Only the running step explains itself.
    expect(document.querySelectorAll('[data-step-detail]')).toHaveLength(1);
  });

  it('gives each finished step the time it took, and the running one its own clock from when it started', async () => {
    window.localStorage.setItem(GUEST_KEY_STORAGE, KEY);
    const tap = Date.now() - 27_000;
    routes[`GET ${GUEST}`] = () => ({ body: status({ state: 'creating', agent: JUNO, estimateSeconds: 35, createdAt: new Date(tap).toISOString(), step: 'code', steps: timedSteps(tap, 2) }) });
    draw();
    await flush();
    const times = [...document.querySelectorAll('[data-guest-steps] li')].map((li) => li.querySelector('[data-step-time]')?.textContent ?? null);
    // 25.4 s, 0.8 s done; code started at 26.2 s, so 0 s into its own clock at 27 s; nothing for what has not begun.
    expect(times).toEqual(['25 s', '0.8 s', '0 s', null, null]);
    expect(document.querySelector('[data-step-id="code"] [data-step-detail]')!.textContent).toBe(GUEST_STEP_DETAIL.code);
    expect(document.querySelector('[data-guest-clock]')!.textContent).toContain('0:27');
  });

  it('says it is taking longer than usual instead of promising half a minute', async () => {
    window.localStorage.setItem(GUEST_KEY_STORAGE, KEY);
    routes[`GET ${GUEST}`] = () => ({ body: status({ state: 'creating', agent: JUNO, estimateSeconds: 35, createdAt: new Date(Date.now() - 56_000).toISOString(), step: 'machine', steps: timedSteps(Date.now() - 56_000, 0) }) });
    draw();
    await flush();
    expect(document.querySelector('[data-guest-clock]')!.textContent).toContain('0:56 longer than usual');
    expect(buildWords(20, 35)).toBe('of about half a minute');
    expect(buildWords(20, 120)).toBe('of about a minute');
    expect(buildWords(51, 35)).toBe('longer than usual');
    expect(stepTime(800)).toBe('0.8 s');
    expect(stepTime(25_400)).toBe('25 s');
    expect(stepTime(-5)).toBe('0.0 s');
  });

  it('starts the clocks at 0:00 when the visitor’s computer clock is off', async () => {
    // The server's clock is 40 s behind this browser's: unadjusted, the clock would open at 0:40.
    const ahead = -40_000;
    routes[`POST ${GUEST}`] = () => ({ status: 201, body: { key: KEY, status: status({ state: 'creating', agent: JUNO, estimateSeconds: 35, createdAt: new Date(Date.now() + ahead).toISOString(), step: 'machine', steps: timedSteps(Date.now() + ahead, 0) }) } });
    routes[`GET ${GUEST}`] = () => ({ body: status({ turnstileSiteKey: null }) });
    draw();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Start guest agent/ }));
    await flush();
    await flush();
    expect(document.querySelector('[data-guest-clock]')!.textContent).toContain('0:00');
    expect(document.querySelector('[data-step-id="machine"] [data-step-time]')!.textContent).toBe('0 s');
  });

  it('has no waiting line any more: no line screen, no place in line (note #1060)', async () => {
    window.localStorage.setItem(GUEST_KEY_STORAGE, KEY);
    routes[`GET ${GUEST}`] = () => ({ body: status({ state: 'creating', agent: JUNO, step: 'machine', steps: buildSteps(0), estimateSeconds: 35 }) });
    draw();
    await flush();
    expect(words()).not.toMatch(/in line|taken right now|frees up/);
    const source = readFileSync(path.resolve(__dirname, 'GuestAgent.tsx'), 'utf8') + readFileSync(path.resolve(__dirname, '../lib/guest-api.ts'), 'utf8');
    expect(source).not.toMatch(/linePosition|GUEST_WAITING_POLL_MS|'waiting'|180 s/);
  });

  it('sends no token when the check is off (no site key)', async () => {
    routes[`GET ${GUEST}`] = () => ({ body: status({}) });
    routes[`POST ${GUEST}`] = () => ({ status: 201, body: { key: KEY, status: status({ state: 'creating', agent: JUNO }) } });
    draw();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Start guest agent/ }));
    await flush();
    expect(turnstileRenders).toHaveLength(0);
    expect(JSON.parse(String(calls.find((c) => c.init?.method === 'POST')!.init!.body))).toEqual({});
  });

  it('says so when the check does not pass, here or on the server, and keeps no key', async () => {
    stubTurnstile(false);
    draw();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /Start guest agent/ }));
    await flush();
    await flush();
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false);
    expect(document.querySelector('[data-guest-problem]')!.textContent).toMatch(/didn’t go through/);

    stubTurnstile(true);
    routes[`POST ${GUEST}`] = () => ({ status: 400, body: { state: 'invalid', error: 'challenge' } });
    fireEvent.click(screen.getByRole('button', { name: /Start guest agent/ }));
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
    // Note #1051: the Workspace chat's three staggered dots, all of them moving.
    const dots = document.querySelector('[data-guest-working] [data-guest-dots]')!;
    expect(dots.classList.contains('guest-dots')).toBe(true);
    expect(dots.querySelectorAll('i')).toHaveLength(3);
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

  it('counts the minutes left and the work in words', () => {
    expect(minutesLeft(new Date(60_000 * 19).toISOString(), 0)).toBe(19);
    expect(minutesLeft(null)).toBeNull();
    expect(removedWords('Juno', 'visitor')).toBe('Juno was removed.');
    expect(removedWords('Juno', 'messages')).toBe('Juno had its 40 messages, and was removed.');
    expect(workingWords([{ kind: 'edit', label: 'README.md' }], 12)).toBe('Changing its copy · 0:12');
    expect(workingWords([], 3)).toBe('Reading the code · 0:03');
  });
});

// Note #1064: the background job pill, fixed above the composer, as the
// Workspace chat's. The status's `jobs` field is Rosa's (note #1063, shape
// agreed there): [{ id, label, startedAt }], running jobs only.
describe('the background job pill (note #1064)', () => {
  const job = (id: string, label: string, secondsAgo: number) => ({ id, label, startedAt: new Date(Date.now() - secondsAgo * 1000).toISOString() });
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    window.localStorage.clear();
    window.localStorage.setItem(GUEST_KEY_STORAGE, KEY);
    stubFetch();
    stubTurnstile();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (window as unknown as { turnstile?: unknown }).turnstile;
  });
  const pill = () => document.querySelector('[data-guest-jobs-pill]') as HTMLButtonElement | null;
  const withJobs = (jobs: unknown, patch: Partial<GuestStatus> = {}) => ({ ...readyStatus(patch), jobs });

  it('shows the count with the breathing dot, sticks above the composer, and is gone with no job', async () => {
    routes = { [`GET ${GUEST}`]: () => ({ body: withJobs([job('j1', 'npm run test:coverage', 74)]) }) };
    draw();
    await flush();
    expect(pill()!.textContent).toBe('1 background job');
    expect(pill()!.querySelector('.guest-breathe')).not.toBeNull();
    const holder = document.querySelector('[data-guest-jobs]')!;
    expect(holder.className).toContain('sticky');
    expect(holder.className).toContain('bottom-3');
    // Right above the composer, after the conversation: it never scrolls away with the messages.
    expect(holder.nextElementSibling!.tagName).toBe('FORM');
    expect(document.querySelector('[data-guest-left]')!.textContent).toBe('Juno stays awake while its background job runs.');

    routes[`GET ${GUEST}`] = () => ({ body: withJobs([job('j1', 'npm run test:coverage', 80), job('j2', 'npm run build', 3)]) });
    await flush(GUEST_JOB_POLL_MS);
    expect(pill()!.textContent).toBe('2 background jobs');

    routes[`GET ${GUEST}`] = () => ({ body: withJobs([]) });
    await flush(GUEST_JOB_POLL_MS);
    expect(pill()).toBeNull();
    expect(document.querySelector('[data-guest-left]')!.textContent).toMatch(/goes after 30 quiet minutes/);
  });

  it('opens the running list with a stopwatch that runs on its own, and Back closes it where it was', async () => {
    routes = { [`GET ${GUEST}`]: () => ({ body: withJobs([job('j1', 'npm run test:coverage', 74)]) }) };
    draw();
    await flush();
    expect(document.querySelector('[data-guest-jobs-list]')).toBeNull();
    fireEvent.click(pill()!);
    expect(pill()!.getAttribute('aria-expanded')).toBe('true');
    const list = document.querySelector('[data-guest-jobs-list]')!;
    expect(list.querySelector('code')!.textContent).toBe('npm run test:coverage');
    expect(list.querySelector('[data-job-clock]')!.textContent).toBe('1:14');
    expect(list.textContent).not.toMatch(/RUNNING|Running(?! for)/);
    await flush(3000);
    expect(document.querySelector('[data-job-clock]')!.textContent).toBe('1:17');
    // The ticking clocks are not read aloud every second.
    expect(list.querySelector('ul')!.getAttribute('aria-live')).toBe('off');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(document.querySelector('[data-guest-jobs-list]')).toBeNull();
    expect(document.activeElement).toBe(pill());
    fireEvent.click(pill()!);
    fireEvent.keyDown(document.querySelector('[data-guest-jobs-list]')!, { key: 'Escape' });
    expect(document.querySelector('[data-guest-jobs-list]')).toBeNull();
  });

  it('reads every 5 s while a job runs, not while the tab is hidden, and draws the answer its finish brings', async () => {
    routes = { [`GET ${GUEST}`]: () => ({ body: withJobs([job('j1', 'npm run test:coverage', 10)]) }) };
    draw();
    await flush();
    const reads = () => calls.filter((c) => c.url === GUEST && !c.init?.method).length;
    const before = reads();
    await flush(GUEST_JOB_POLL_MS);
    expect(reads()).toBe(before + 1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    await flush(GUEST_JOB_POLL_MS * 2);
    expect(reads()).toBe(before + 1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    // The job ended; its receipt turn answered; the visitor typed nothing.
    routes[`GET ${GUEST}`] = () => ({ body: withJobs([], { messages: [greeting, { id: 'm9', role: 'agent', text: 'Coverage is 81% of lines.', at: new Date().toISOString(), state: 'answered', activity: [] }] }) });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(reads()).toBe(before + 2);
    expect(document.querySelector('[data-guest-messages]')!.textContent).toContain('Coverage is 81% of lines.');
    expect(pill()).toBeNull();
    // Back to the quiet pace.
    await flush(GUEST_JOB_POLL_MS);
    expect(reads()).toBe(before + 2);
    await flush(GUEST_IDLE_POLL_MS);
    expect(reads()).toBe(before + 3);
  });

  it('follows the turn a finished job starts, like a visitor’s', async () => {
    routes = { [`GET ${GUEST}`]: () => ({ body: withJobs([job('j1', 'npm test', 50)]) }) };
    draw();
    await flush();
    routes[`GET ${GUEST}`] = () => ({ body: withJobs([], { state: 'working', turn: { turnId: 't7' } }) });
    routes[`GET ${GUEST}/turns/t7`] = () => ({ body: { turnId: 't7', state: 'working', partial: 'The tests finished:', answer: null, activity: [], files: [], elapsedSeconds: 2 } });
    await flush(GUEST_JOB_POLL_MS);
    expect(document.querySelector('[data-guest-working]')).not.toBeNull();
    await flush(GUEST_TURN_POLL_MS);
    expect(document.querySelector('[data-guest-messages]')!.textContent).toContain('The tests finished:');
  });

  it('never says the computer went to sleep while a job keeps it awake', async () => {
    routes = { [`GET ${GUEST}`]: () => ({ body: withJobs([job('j1', 'npm test', 50)], { state: 'asleep', machine: { ...MACHINE, awake: false } }) }) };
    draw();
    await flush();
    expect(document.querySelector('[data-guest-asleep]')).toBeNull();
    expect(document.querySelector('[data-guest-chip]')!.textContent).toBe('Ready');
    expect(document.querySelector('[data-guest-computer]')!.textContent).toContain('Stays awake while its job runs');
  });

  it('reads the field strictly, and as none while the route does not carry it', () => {
    expect(jobsOf(status({}))).toEqual([]);
    expect(jobsOf({ ...status({}), jobs: 'x' } as unknown as GuestStatus)).toEqual([]);
    const ok = { id: 'a', label: 'npm test', startedAt: '2026-11-07T19:00:00Z' };
    expect(jobsOf({ ...status({}), jobs: [ok, { id: 'b' }, null, { ...ok, startedAt: 'never' }, ok, ok, ok, ok] } as unknown as GuestStatus)).toHaveLength(4);
    expect(jobCount(1)).toBe('1 background job');
    expect(jobCount(3)).toBe('3 background jobs');
    const t0 = Date.parse('2026-11-07T19:00:00Z');
    expect(jobClock('2026-11-07T19:00:00Z', t0 + 42_000)).toBe('0:42');
    expect(jobClock('2026-11-07T19:00:00Z', t0 + 725_000)).toBe('12:05');
    expect(jobClock('2026-11-07T19:00:00Z', t0 + 3_789_000)).toBe('1:03:09');
    expect(jobClock('2026-11-07T19:00:00Z', t0 - 5_000)).toBe('0:00');
  });

  it('breathes like the Workspace chat’s dot, still under reduced motion', () => {
    const css = readFileSync(path.resolve(__dirname, '../index.css'), 'utf8');
    expect(css).toMatch(/@keyframes guest-breathe \{ 0%, 100% \{ opacity: \.35; \} 50% \{ opacity: 1; \} \}/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.guest-breathe \{ animation: none; \} \}/);
  });
});

describe('the working dots move (note #1051)', () => {
  it('stagger the Workspace chat\'s keyframe, fading only when motion is reduced', () => {
    const css = readFileSync(path.resolve(__dirname, '../index.css'), 'utf8');
    expect(css).toMatch(/\.guest-dots i \{ animation: guest-dot 1\.2s infinite/);
    expect(css).toMatch(/\.guest-dots i:nth-child\(2\) \{ animation-delay: \.15s; \}/);
    expect(css).toMatch(/\.guest-dots i:nth-child\(3\) \{ animation-delay: \.3s; \}/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.guest-dots i \{ animation-name: guest-dot-still; \} \}/);
  });
});
