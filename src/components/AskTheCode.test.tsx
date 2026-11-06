import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AnswerText,
  ASK_FAILED,
  ASK_HEADING,
  ASK_QUESTIONS,
  AskTheCode,
  aheadLine,
  clock,
  repoFileUrl,
} from './AskTheCode';
import { NewTabContext } from '../lib/new-tab';
import { ASK_GIVE_UP_MS, ASK_POLL_MS } from '../lib/ask-api';

void React;

// Note #1010: the home page's "Ask an agent that reads the code." screen,
// against the route contract on the note (section 10).

type Reply = { status?: number; body: unknown };
let routes: Record<string, (init?: RequestInit) => Reply>;
let calls: Array<{ url: string; init?: RequestInit }>;

function stubFetch() {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = `${init?.method ?? 'GET'} ${url}`;
    const route = routes[key];
    const reply = route ? route(init) : { status: 404, body: {} };
    const status = reply.status ?? 200;
    return { ok: status < 400, status, json: async () => reply.body } as Response;
  }));
}

const STATUS_OPEN = { state: 'open', agent: { name: 'Wren', avatarUrl: '/agent-avatars/kai.jpg' } };
const FILES = ['src/docs/chapters/your-cloud-and-subscriptions.tsx', 'backend/src/agent/harness-auth-failure.ts'];

const draw = () => render(<NewTabContext.Provider value={true}><AskTheCode /></NewTabContext.Provider>);
/* A step of the clock: let the fetches settle and React schedule its
   effects first, then advance. */
const flush = async (ms = 0) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};

describe('AskTheCode (note #1010)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    window.sessionStorage.clear();
    routes = { 'GET /workspace/api/public/ask/status': () => ({ body: STATUS_OPEN }) };
    stubFetch();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('draws the screen at rest: heading, the agent, three questions and the box, with no fine print', async () => {
    draw();
    await flush();
    const section = document.querySelector('#ask')!;
    expect(section.querySelector('h2')!.textContent).toBe(ASK_HEADING);
    // Note #1015 (Adam: "too much helper text"): the name alone under the heading.
    expect(section.querySelector('[data-ask-agent]')!.textContent).toBe('Wren');
    expect([...section.querySelectorAll('[data-ask-questions] button')].map((b) => b.textContent)).toEqual([...ASK_QUESTIONS]);
    expect(screen.getByLabelText('Your question about Agentic Cloud Computer').getAttribute('maxlength')).toBe('500');
    // No fine print under the box (note #1017): no founder line, no Privacy link.
    expect(section.querySelector('#ask-fine-print')).toBeNull();
    expect(section.querySelector('a[href="/privacy"]')).toBeNull();
    expect(section.textContent).not.toMatch(/founder reads/i);
    // No margin at rest, and none of the old helper lines anywhere.
    expect(section.querySelector('[data-ask-margin]')).toBeNull();
    expect(section.textContent).not.toMatch(/What it reads|Claude Code on Sonnet|Nothing about you is kept/);
  });

  // Note #1034 (Adam's yes to note #1033's A1): the send button is a circle
  // with an up arrow, "Ask" its spoken name only; grey until there is a
  // question.
  it('sends with an arrow in a circle, named Ask, that waits for a question', async () => {
    draw();
    await flush();
    const button = screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement;
    expect(button.getAttribute('type')).toBe('submit');
    expect(button.textContent).toBe('');
    expect(button.querySelector('svg')).toBeTruthy();
    expect(button.querySelector('.rounded-full.h-10.w-10')).toBeTruthy();
    expect(button.className).toMatch(/\bh-11\b/);
    expect(button.disabled).toBe(true);
    const field = screen.getByLabelText('Your question about Agentic Cloud Computer');
    fireEvent.change(field, { target: { value: '   ' } });
    expect(button.disabled).toBe(true);
    fireEvent.change(field, { target: { value: 'Can I use my own GitHub?' } });
    expect(button.disabled).toBe(false);
    fireEvent.change(field, { target: { value: '' } });
    expect(button.disabled).toBe(true);
  });

  it('asks a tapped question, polls it, and draws the answer with the files linked to the public code in a new tab', async () => {
    let reads = 0;
    routes['POST /workspace/api/public/ask'] = () => ({ body: { state: 'accepted', questionId: 'q1', position: 1 } });
    routes['GET /workspace/api/public/ask/q1'] = () => {
      reads += 1;
      if (reads === 1) return { body: { questionId: 'q1', state: 'reading', position: 0, files: FILES.slice(0, 1) } };
      return { body: { questionId: 'q1', state: 'answered', files: FILES, answer: 'It **stops** cleanly.\n\nThen it `resumes`.', seconds: 12 } };
    };
    draw();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: ASK_QUESTIONS[1] }));
    await flush();
    const post = calls.find((call) => call.init?.method === 'POST')!;
    const body = JSON.parse(String(post.init!.body));
    expect(body.question).toBe(ASK_QUESTIONS[1]);
    expect(body.visitId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(window.sessionStorage.getItem('acc-ask-visit')).toBe(body.visitId);
    expect(document.querySelector('[data-ask-pending]')!.textContent).toBe('One question ahead of yours · about a minute');
    expect(document.querySelector('[data-ask-questions]')).toBeNull();
    expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(true);

    await flush(ASK_POLL_MS);
    expect(document.querySelector('[data-ask-pending]')!.textContent).toMatch(/^Reading the code · 0:0\d · answers take up to a minute$/);
    expect(document.querySelector('[data-ask-margin]')!.textContent).toMatch(/^Reading/);

    await flush(ASK_POLL_MS);
    const answer = document.querySelector('[data-ask-answer]')!;
    expect(answer.querySelectorAll('p')).toHaveLength(2);
    expect(answer.querySelector('strong')!.textContent).toBe('stops');
    expect(answer.querySelector('code')!.textContent).toBe('resumes');
    const margin = document.querySelector('[data-ask-margin]')!;
    expect(margin.textContent).toMatch(/^It read/);
    const links = [...margin.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(FILES.map(repoFileUrl));
    expect(links[1].getAttribute('href')).toBe('https://agenticcloudcomputer.com/acc/agentic-cloud?path=backend/src/agent/harness-auth-failure.ts&file=1');
    for (const link of links) expect(link.getAttribute('target')).toBe('_blank');
    expect(document.querySelector('[data-ask-readlist]')!.textContent).toMatch(/^It read 2 files/);
    // Answered, the box is free again: grey while empty, ready once typed in.
    expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Your question about Agentic Cloud Computer'), { target: { value: 'And then?' } });
    expect((screen.getByRole('button', { name: 'Ask' }) as HTMLButtonElement).disabled).toBe(false);
    // Answered: polling stops.
    const before = calls.length;
    await flush(ASK_POLL_MS * 3);
    expect(calls.length).toBe(before);
  });

  it('keeps one visit id per tab, so follow-ups resume the same conversation, and folds the earlier question', async () => {
    let n = 0;
    routes['POST /workspace/api/public/ask'] = () => ({ body: { state: 'accepted', questionId: `q${++n}`, position: 0 } });
    routes['GET /workspace/api/public/ask/q1'] = () => ({ body: { questionId: 'q1', state: 'answered', files: [], answer: 'First.' } });
    routes['GET /workspace/api/public/ask/q2'] = () => ({ body: { questionId: 'q2', state: 'answered', files: [], answer: 'Second.' } });
    draw();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: ASK_QUESTIONS[0] }));
    await flush(ASK_POLL_MS);
    fireEvent.change(screen.getByLabelText('Your question about Agentic Cloud Computer'), { target: { value: 'And the price?' } });
    fireEvent.submit(screen.getByLabelText('Your question about Agentic Cloud Computer').closest('form')!);
    await flush(ASK_POLL_MS);
    const posts = calls.filter((call) => call.init?.method === 'POST').map((call) => JSON.parse(String(call.init!.body)));
    expect(posts.map((p) => p.question)).toEqual([ASK_QUESTIONS[0], 'And the price?']);
    expect(posts[0].visitId).toBe(posts[1].visitId);
    expect(document.querySelector('details summary')!.textContent).toBe(ASK_QUESTIONS[0]);
    expect(document.querySelector('[data-ask-answer]')!.textContent).toBe('Second.');
  });

  it('draws a declined reply in grey with the three questions again', async () => {
    routes['POST /workspace/api/public/ask'] = () => ({ body: { state: 'accepted', questionId: 'q1', position: 0 } });
    routes['GET /workspace/api/public/ask/q1'] = () => ({ body: { questionId: 'q1', state: 'declined', files: [], answer: 'I only answer questions about Agentic Cloud Computer.' } });
    draw();
    await flush();
    fireEvent.change(screen.getByLabelText('Your question about Agentic Cloud Computer'), { target: { value: 'Write me a poem' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await flush(ASK_POLL_MS);
    expect(document.querySelector('[data-ask-declined]')!.className).toMatch(/\btext-hint\b/);
    expect(document.querySelectorAll('[data-ask-questions] button')).toHaveLength(3);
  });

  it('says the visitor limit with the visitor’s own time, and keeps what they typed', async () => {
    routes['POST /workspace/api/public/ask'] = () => ({ body: { state: 'limited', until: '2026-11-05T19:42:00Z' } });
    draw();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: ASK_QUESTIONS[2] }));
    await flush();
    const wall = document.querySelector('[data-ask-wall]')!;
    expect(wall.textContent).toMatch(/^That’s ten questions this hour\.You can ask again at \d\d:\d\d\. The code is open in the meantime\./);
    expect([...wall.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Read the code (opens in a new tab)', 'Write to the founder (opens in a new tab)']);
    expect(document.querySelector('form')).toBeNull();
    expect(document.querySelector('[data-ask-questions]')).toBeNull();
  });

  it('rests when the status says so, or when there is no agent yet, and takes no question', async () => {
    routes['GET /workspace/api/public/ask/status'] = () => ({ body: { state: 'resting', until: '2026-11-05T22:00:00Z', agent: { name: 'Wren', avatarUrl: '/a.jpg' } } });
    const { unmount } = draw();
    await flush();
    expect(document.querySelector('[data-ask-wall]')!.textContent).toMatch(/^Wren is resting until \d\d:\d\d\.It answers again then\./);
    expect(document.querySelector('form')).toBeNull();
    expect(document.querySelector('[data-ask-questions]')).toBeNull();
    unmount();

    routes['GET /workspace/api/public/ask/status'] = () => ({ body: { state: 'resting', agent: null } });
    draw();
    await flush();
    expect(document.querySelector('[data-ask-wall]')!.textContent).toMatch(/^The agent is resting for now\./);
  });

  it('turns a mid-turn rest into the resting box, not an error', async () => {
    routes['POST /workspace/api/public/ask'] = () => ({ body: { state: 'accepted', questionId: 'q1', position: 0 } });
    routes['GET /workspace/api/public/ask/q1'] = () => ({ body: { questionId: 'q1', state: 'resting', files: [], until: '2026-11-05T22:00:00Z' } });
    draw();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: ASK_QUESTIONS[0] }));
    await flush(ASK_POLL_MS);
    expect(document.querySelector('[data-ask-wall]')!.textContent).toMatch(/^Wren is resting until/);
    expect(document.querySelector('[data-ask-question]')).toBeNull();
  });

  it('says busy and keeps the question when five are already waiting', async () => {
    routes['POST /workspace/api/public/ask'] = () => ({ body: { state: 'busy' } });
    draw();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: ASK_QUESTIONS[0] }));
    await flush();
    expect(document.querySelector('[data-ask-busy]')!.textContent).toBe('A few questions are ahead of yours. Ask again in a minute.');
    expect((screen.getByLabelText('Your question about Agentic Cloud Computer') as HTMLInputElement).value).toBe(ASK_QUESTIONS[0]);
  });

  it('gives up after three minutes and says failed', async () => {
    routes['POST /workspace/api/public/ask'] = () => ({ body: { state: 'accepted', questionId: 'q1', position: 0 } });
    routes['GET /workspace/api/public/ask/q1'] = () => ({ body: { questionId: 'q1', state: 'reading', position: 0, files: [] } });
    draw();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: ASK_QUESTIONS[0] }));
    await flush(ASK_GIVE_UP_MS + ASK_POLL_MS * 2);
    expect(document.querySelector('[data-ask-failed]')!.textContent).toBe(ASK_FAILED);
  });

  it('says failed when the route cannot be reached', async () => {
    routes['POST /workspace/api/public/ask'] = () => ({ status: 502, body: {} });
    draw();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: ASK_QUESTIONS[0] }));
    await flush();
    expect(document.querySelector('[data-ask-failed]')!.textContent).toBe(ASK_FAILED);
  });
});

describe('the answer is read strictly', () => {
  it('never renders raw HTML, and links only to our own address', () => {
    render(<AnswerText text={'<img src=x onerror=alert(1)> [ours](https://agenticcloudcomputer.com/docs) [theirs](https://evil.example/x)\n\n- one\n- two'} />);
    expect(document.querySelector('img')).toBeNull();
    expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>');
    const links = [...document.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://agenticcloudcomputer.com/docs']);
    expect(document.body.textContent).toContain('theirs');
    expect(document.querySelectorAll('li')).toHaveLength(2);
  });

  it('counts and clocks in the page’s words', () => {
    expect(aheadLine(2)).toBe('Two questions ahead of yours · about a minute');
    expect(aheadLine(1)).toBe('One question ahead of yours · about a minute');
    expect(clock(74)).toBe('1:14');
    expect(clock(9)).toBe('0:09');
  });
});
