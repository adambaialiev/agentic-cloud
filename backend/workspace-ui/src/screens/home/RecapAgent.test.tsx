import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../App.js';
import type { WorkspaceStateAnswer } from '../../../../src/shared/workspace-api.js';
import { agent, emptyState, note, scriptedApi, workspaceScript, type Answer } from '../../test/fixtures.js';

/**
 * Note #439: the Workspace Agent's own screen, and the conversation header
 * that is now the door to it. Every other agent has a screen; the one a
 * person talks to most had none, and its header pointed nowhere.
 */
const plain = (over: Partial<WorkspaceStateAnswer> = {}) => emptyState({
  org: { orgId: 'o1', name: 'Studio', role: 'admin', members: 1, seats: 0, seatProviders: [] },
  ...over,
});
let state = plain();
const details = {
  orgId: 'o1',
  agentId: 'workspace-1',
  agent: { name: 'Workspace Agent', started: true, working: false, waiting: [], avatarUrl: '/workspace/avatars/workspace-agent', lastActiveAt: new Date(Date.now() - 5 * 60_000).toISOString() },
  settings: { cli: 'claude' as const, model: 'opus', effort: 'high' },
  machine: { cpuKind: 'shared', cpus: 1, memoryMb: 1024 },
};
/** The agent's cards are its own screen since note #960, the last row of
 *  Home's Workplace window; they stood at the foot of that window (note
 *  #715) until then. */
const OWN = ['/chief-of-staff?org=o1'];
/** Home, with the Workplace window the overview's old address opens. */
const WINDOW = ['/overview?org=o1&half=workplace'];
function setup(over: Record<string, unknown> = {}, entries = OWN, extra: Record<string, Answer> = {}) {
  const scripted = scriptedApi({
    ...workspaceScript(() => state),
    'GET api/recap/agent': () => ({ ...details, ...over }),
    'GET api/recap/agent/settings': () => ({ orgId: 'o1', settings: details.settings, models: [] }),
    'GET api/recap/chat': () => ({ orgId: 'o1', messages: [], working: false, waiting: [] }),
    'GET api/agents/workspace-1/machine': () => ({
      awake: false, cpuKind: 'shared', cpus: 1, memoryMb: 1024, current: 'shared-1x',
      sizes: [{ id: 'shared-1x', cpuKind: 'shared', cpus: 1, memoryMb: 2048, hourlyUsd: 0.01, standard: true }],
      canResize: true, disclaimer: 'Estimate.',
    }),
    ...extra,
  });
  render(<MemoryRouter initialEntries={entries}><App api={scripted.api} /></MemoryRouter>);
  return scripted;
}

describe('the Workspace Agent\'s own screen', () => {
  // The state is a module-level fixture a test may swap for another; every
  // test starts from the plain one.
  beforeEach(() => { state = plain(); });

  it('says what it is, what it is doing, what it thinks with and what it runs on', async () => {
    const { calls } = setup();
    await waitFor(() => expect(document.getElementById('recapAgentFacts')).toBeTruthy());
    expect(document.getElementById('screenChiefOfStaff')).toBeTruthy();
    const facts = document.getElementById('recapAgentFacts')!;
    expect(facts.textContent).toContain('Ready');
    expect(facts.textContent).toContain('5m ago');
    expect(facts.textContent).toContain('1 GB');
    // No paragraph about what it is (note #960): the title names it.
    expect(document.getElementById('recapAgentAbout')).toBeNull();
    expect(calls.find((c) => c.path === 'api/recap/agent')?.scope).toEqual({ org: 'o1' });
    // The state is the plate's own words, so the two cannot disagree.
    expect(facts.textContent).not.toContain('Idle');
  });

  it('its header names the model and effort, never the harness (note #723)', async () => {
    setup({}, WINDOW, {
      'GET api/recap/agent/settings': () => ({ orgId: 'o1', settings: { cli: 'codex', model: 'gpt-5.5', effort: 'xhigh' }, models: [] }),
    });
    await waitFor(() => expect(document.getElementById('recapChatRuntime')!.textContent).toBe('gpt-5.5 · xhigh'));
    expect(document.getElementById('recapChatRuntime')!.getAttribute('aria-label')).toBe('Change Chief of Staff model and effort. Current: gpt-5.5 · xhigh');
    expect(document.querySelector('#screenRecapChat .chathead, #screenHome .chathead')?.textContent ?? '').not.toMatch(/Codex|Claude Code/);
  });

  it('a second visit opens on what the last one read, and refreshes it underneath (note #630)', async () => {
    const version = () => ({
      cliLabel: 'Claude Code', installed: '2.1.276', pinned: '2.1.276', cliUpdateAvailable: false,
      image: { current: true, canUpdate: false }, busy: false, turnCount: 12,
      docs: { file: 'CLAUDE.md', version: 129, latest: 129, current: true },
    });
    const models = [{ value: 'opus', label: 'Opus', cli: 'claude', available: true, efforts: [{ value: 'high', label: 'high' }] }];
    setup({}, OWN, {
      'GET api/agents/workspace-1/version': version,
      'GET api/recap/agent/settings': () => ({ orgId: 'o1', settings: details.settings, models }),
    });
    await waitFor(() => expect(document.getElementById('recapAgentVersion')!.textContent).toContain('2.1.276 · up to date'));
    cleanup();
    setup({}, ['/'], {
      'GET api/agents/workspace-1/version': version,
      'GET api/recap/agent/settings': () => ({ orgId: 'o1', settings: details.settings, models }),
    });
    await waitFor(() => expect(document.getElementById('recapChatRuntime')).toBeTruthy());
    fireEvent.click(document.getElementById('recapChatRuntime')!);
    await waitFor(() => expect(document.querySelector('#recapRuntimeModels .crow.current')?.textContent).toContain('Opus'));
    cleanup();

    const never = () => new Promise<never>(() => {});
    const again = setup({}, OWN, {
      'GET api/recap/agent': never,
      'GET api/agents/workspace-1/version': never,
      'GET api/recap/agent/settings': never,
    });
    await waitFor(() => expect(document.getElementById('recapAgentFacts')).toBeTruthy());
    // The first frame, before either read has answered.
    expect(document.getElementById('recapAgentFacts')!.textContent).toContain('1 GB');
    expect(document.getElementById('recapAgentVersion')!.textContent).toContain('2.1.276 · up to date');
    // The refresh is asked for underneath; wait for that state rather than
    // assume it was sent by the time the first frame was drawn.
    await waitFor(() => expect(again.calls.some((call) => call.path === 'api/recap/agent')).toBe(true));
    cleanup();
    // And Home's header, and its model & effort picker, open on what they
    // last read.
    setup({}, ['/'], {
      'GET api/recap/agent': never,
      'GET api/agents/workspace-1/version': never,
      'GET api/recap/agent/settings': never,
    });
    await waitFor(() => expect(document.getElementById('recapChatRuntime')).toBeTruthy());
    expect(document.getElementById('recapChatRuntime')!.textContent).toBe('opus · high');
    fireEvent.click(document.getElementById('recapChatRuntime')!);
    await waitFor(() => expect(document.getElementById('screenRecapRuntime')).toBeTruthy());
    expect(document.querySelector('#recapRuntimeModels .crow.current')?.textContent).toContain('Opus');
    expect(screen.queryByText('Loading choices…')).toBeNull();
  });

  it('its picker shows the choices at once on a cold open, for the harnesses this workplace reaches (note #718)', async () => {
    const never = () => new Promise<never>(() => {});
    // One Claude seat and one Codex agent: both catalogs are within reach.
    state = plain({
      org: { orgId: 'o1', name: 'Studio', role: 'admin', members: 1, seats: 1, seatProviders: ['claude'] },
      agents: [agent({ id: 'ada', name: 'Ada', cli: 'codex', model: 'gpt-6-sol', effort: 'high' })],
    });
    setup({}, ['/'], { 'GET api/recap/agent/settings': never });
    await waitFor(() => expect(document.getElementById('recapChatRuntime')).toBeTruthy());
    fireEvent.click(document.getElementById('recapChatRuntime')!);
    await waitFor(() => expect(document.getElementById('screenRecapRuntime')).toBeTruthy());
    expect(screen.queryByText('Loading choices…')).toBeNull();
    const names = Array.from(document.querySelectorAll('#recapRuntimeModels .crow .name')).map((node) => node.textContent);
    expect(names).toEqual(['GPT-6 Astra', 'GPT-6.1 Sol', 'GPT-6.1 Terra', 'GPT-6 Sol', 'GPT-6 Luna', 'GPT-5.6 Sol', 'GPT-5.6 Terra', 'GPT-5.6 Luna', 'GPT-5.5', 'Fable', 'Opus', 'Sonnet']);
    // Which is current is the read's to say; until then the levels wait for a model.
    expect(document.querySelector('#recapRuntimeModels .crow.current')).toBeNull();
    expect(document.getElementById('recapRuntimeEfforts')!.textContent).toBe('Effort choices follow the model.');
    cleanup();

    // A workplace that reaches only Claude lists only Claude.
    state = plain({ org: { orgId: 'o1', name: 'Studio', role: 'admin', members: 1, seats: 1, seatProviders: ['claude'] } });
    setup({}, ['/'], { 'GET api/recap/agent/settings': never });
    await waitFor(() => expect(document.getElementById('recapChatRuntime')).toBeTruthy());
    fireEvent.click(document.getElementById('recapChatRuntime')!);
    await waitFor(() => expect(document.getElementById('screenRecapRuntime')).toBeTruthy());
    expect(Array.from(document.querySelectorAll('#recapRuntimeModels .crow .name')).map((node) => node.textContent)).toEqual(['Fable', 'Opus', 'Sonnet']);
    cleanup();

    // A workplace that reaches nothing yet lists every model, none of them
    // pickable, and says what opens them (note #747).
    state = plain();
    setup({}, ['/'], { 'GET api/recap/agent/settings': never });
    await waitFor(() => expect(document.getElementById('recapChatRuntime')).toBeTruthy());
    fireEvent.click(document.getElementById('recapChatRuntime')!);
    await waitFor(() => expect(document.getElementById('screenRecapRuntime')).toBeTruthy());
    const rows = Array.from(document.querySelectorAll<HTMLButtonElement>('#recapRuntimeModels .crow'));
    expect(rows.map((row) => row.querySelector('.name')!.textContent)).toEqual(names);
    expect(rows.every((row) => row.disabled)).toBe(true);
    expect(document.getElementById('recapRuntimeLockWhy')!.textContent).toBe('Connect a Claude or ChatGPT subscription to change the model and effort.');
    expect(screen.queryByText('No model choices are available.')).toBeNull();
  });

  it('draws Opus at high for a fresh account, on a picker that waits for a sign-in (note #747)', async () => {
    const efforts = [{ value: 'medium', label: 'medium' }, { value: 'high', label: 'high' }];
    const models = [
      { cli: 'codex' as const, value: 'gpt-6.1-sol', label: 'gpt-6.1-sol', available: false, efforts },
      { cli: 'claude' as const, value: 'opus', label: 'opus', available: false, efforts },
    ];
    const { calls } = setup({}, ['/'], {
      'GET api/recap/agent/settings': () => ({ orgId: 'o1', settings: { cli: 'claude', model: 'opus', effort: 'high' }, models }),
      'GET api/seats': () => ({ seats: [], available: [] }),
    });
    await waitFor(() => expect(document.getElementById('recapChatRuntime')!.textContent).toBe('opus · high'));
    fireEvent.click(document.getElementById('recapChatRuntime')!);
    await waitFor(() => expect(document.querySelector('#recapRuntimeModels .crow.current')?.textContent).toContain('Opus'));
    // What there is and what is set stay legible; nothing can be picked.
    expect(document.querySelector('#recapRuntimeModels .crow.current')?.textContent).not.toContain('unavailable');
    expect(document.querySelector('#recapRuntimeEfforts .effortstep.current')?.textContent).toBe('High');
    const sol = screen.getByRole('button', { name: /GPT-6.1 Sol/ }) as HTMLButtonElement;
    expect(sol.disabled).toBe(true);
    expect(sol.textContent).not.toContain('unavailable');
    expect((screen.getByRole('radio', { name: 'Medium' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(sol);
    expect(calls.some((call) => call.init?.method === 'POST')).toBe(false);
    // "Saved as you tap" is not true of this page yet; what opens it is.
    expect(document.getElementById('recapRuntimeHint')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Connect a subscription' }));
    await waitFor(() => expect(document.getElementById('screenRecapRuntime')).toBeNull());
  });

  it('says the machine is not reserved until the first message has built one', async () => {
    setup({ agentId: undefined, machine: undefined, agent: { ...details.agent, started: false } });
    await waitFor(() => expect(document.getElementById('recapAgentFacts')).toBeTruthy());
    await waitFor(() => expect(document.getElementById('recapAgentFacts')!.textContent).toContain('Not reserved yet'));
  });

  it('opens the same machine picker as any other agent and keeps the workplace scope', async () => {
    const { calls } = setup();
    const machine = await screen.findByRole('button', { name: '1 shared core · 1 GB' });
    fireEvent.click(machine);
    await waitFor(() => expect(document.getElementById('screenAgentMachine')).toBeTruthy());
    await waitFor(() => expect(calls.some((call) => (
      call.path === 'api/agents/workspace-1/machine' && call.scope?.org === 'o1'
    ))).toBe(true));
    expect(screen.getByText('Workspace Agent’s machine')).toBeTruthy();
  });

  it('shows what it runs on — CLI, machine software, instructions — like any other agent’s details page', async () => {
    const { calls } = setup({}, undefined, {
      'GET api/agents/workspace-1/version': () => ({
        cliLabel: 'Claude Code', installed: '2.1.276', pinned: '2.1.276', cliUpdateAvailable: false,
        image: { current: true, canUpdate: false }, busy: false, turnCount: 12,
        docs: { file: 'CLAUDE.md', version: 129, latest: 129, current: true },
      }),
    });
    await waitFor(() => expect(document.getElementById('recapAgentVersion')).toBeTruthy());
    const card = document.getElementById('recapAgentVersion')!;
    expect(card.textContent).toContain('Claude Code');
    expect(card.textContent).toContain('2.1.276 · up to date');
    expect(card.textContent).toContain('Machine software');
    expect(card.textContent).toContain('Up to date');
    expect(card.textContent).toContain('CLAUDE.md');
    expect(card.textContent).toContain('v129 · up to date');
    expect(screen.queryByRole('button', { name: 'Update machine software' })).toBeNull();
    // Asked in this workplace, like its machine picker.
    expect(calls.find((c) => c.path === 'api/agents/workspace-1/version')?.scope).toEqual({ org: 'o1' });
  });

  it('offers the machine software update behind the same confirm, and reads the card again after', async () => {
    let current = false;
    const { calls } = setup({}, undefined, {
      'GET api/agents/workspace-1/version': () => ({
        cliLabel: 'Claude Code', installed: '2.1.276', pinned: '2.1.276', cliUpdateAvailable: false,
        image: { current, canUpdate: !current }, busy: false, turnCount: 12,
        docs: { file: 'CLAUDE.md', version: 129, latest: 129, current: true },
      }),
      'POST api/agents/workspace-1/update-machine': () => { current = true; return { ok: true }; },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Update machine software' }));
    expect(await screen.findByText('Update the machine software?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(document.getElementById('recapAgentVersion')!.textContent).toContain('Up to date'));
    expect(screen.queryByRole('button', { name: 'Update machine software' })).toBeNull();
    expect(calls.find((c) => c.path === 'api/agents/workspace-1/update-machine')?.scope).toEqual({ org: 'o1' });
  });

  it('locks the updates while it is answering a request', async () => {
    setup({ agent: { ...details.agent, working: true } }, undefined, {
      'GET api/agents/workspace-1/version': () => ({
        cliLabel: 'Codex', installed: '0.154.0', pinned: '0.155.0', cliUpdateAvailable: true,
        image: { current: true, canUpdate: false }, busy: true, turnCount: 12,
        docs: { file: 'AGENTS.md', version: 129, latest: 129, current: true },
      }),
    });
    const button = await screen.findByRole('button', { name: 'Update Codex' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('#recapAgentVersion .busyhint')!.hasAttribute('hidden')).toBe(false);
  });

  it('shows the same context reading as any other agent’s details page, and the ring on the face in Home’s header', async () => {
    setup({ agent: { ...details.agent, context: {
      usedPercent: 94, tokens: 940_000, window: 1_000_000, at: new Date().toISOString(),
    } } });
    await waitFor(() => expect(document.getElementById('recapAgentFacts')).toBeTruthy());
    await waitFor(() => expect(document.querySelector('#recapAgentContext .contextrow')).toBeTruthy());
    const row = document.querySelector('#recapAgentContext .contextrow')!;
    expect(row.textContent).toContain('94% used · 940k of 1M tokens');
    expect((row.querySelector('.meter-fill') as HTMLElement).style.width).toBe('94%');
  });

  it('asks the Workspace Agent to reset through its conversation, like any other agent', async () => {
    const sent: unknown[] = [];
    setup({ agent: { ...details.agent, context: {
      usedPercent: 94, tokens: 940_000, window: 1_000_000, at: new Date().toISOString(),
    } } }, undefined, {
      'POST api/recap/chat': (call) => {
        sent.push(JSON.parse(String(call.init?.body)));
        return { orgId: 'o1', messages: [], working: true, waiting: [] };
      },
    });
    await waitFor(() => expect(document.getElementById('recapAgentFacts')).toBeTruthy());
    const ask = await screen.findByRole('button', { name: 'Ask agent to reset chat' });
    fireEvent.click(ask);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ text: 'reset chat' });
    expect((sent[0] as { clientId?: string }).clientId).toBeTruthy();
    expect((await screen.findByRole('button', { name: 'Asked — it will answer in its chat' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('its cards are its own screen, the last row of Home\'s Workplace window, opened from its name in the header (notes #715, #960)', async () => {
    setup({}, ['/']);
    await waitFor(() => expect(document.getElementById('screenHome')).toBeTruthy());
    // Home is the chat: no Back; the face and the name are the door to the
    // Workplace window (the owner, 2026-10-11), and the chrome is in its header.
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(document.getElementById('recapChatFace')!.tagName).toBe('BUTTON');
    expect(screen.queryByRole('link', { name: /open agent details/ })).toBeNull();
    expect(document.getElementById('homeOrganizations')).toBeTruthy();
    expect(document.getElementById('homeAccount')).toBeTruthy();
    fireEvent.click(document.getElementById('homeWorkplaceDoor')!);
    await waitFor(() => expect(document.querySelector('#homeSheet #homeWorkplace #indexChiefOfStaff')).toBeTruthy());
    // Its row is the window's last (note #960), and its cards are its own
    // screen, no longer under the window's shelves.
    const rows = [...document.querySelectorAll('#homeWorkplace a.indexrow')];
    expect(rows.at(-1)!.id).toBe('indexChiefOfStaff');
    expect(document.querySelector('#homeWorkplace #recapAgentSection')).toBeNull();
    fireEvent.click(document.getElementById('indexChiefOfStaff')!);
    await waitFor(() => expect(document.querySelector('#screenChiefOfStaff #recapAgentFacts')).toBeTruthy());
  });

  // Note #487 gave it a door onto its own room ("Its room", with how many
  // notes it kept there), which opened that room's notes. Rooms left the
  // product (note #843) and its notes are among the workplace's, so the
  // door went; an older state still naming that room draws none.
  it('draws no door onto a room of its own, whatever an older state says', async () => {
    state = plain({ workspace: { room: 'ws', notes: [note({ number: 7, title: 'Call the printer' })], notesArchived: 0 } } as never);
    setup();
    await waitFor(() => expect(document.getElementById('recapAgentFacts')).toBeTruthy());
    expect(document.getElementById('recapAgentRoom')).toBeNull();
    expect(screen.queryByRole('link', { name: /Its room/ })).toBeNull();
    expect(screen.queryByText('Call the printer')).toBeNull();
  });

  it('opens the model picker from Home\'s header, on the agent\'s own settings', async () => {
    const { calls } = setup({}, ['/']);
    await waitFor(() => expect(document.getElementById('recapChatRuntime')).toBeTruthy());
    fireEvent.click(document.getElementById('recapChatRuntime')!);
    await waitFor(() => expect(document.getElementById('screenRecapAgent')).toBeNull());
    await waitFor(() => expect(calls.some((c) => c.path === 'api/recap/agent/settings')).toBe(true));
  });
});
