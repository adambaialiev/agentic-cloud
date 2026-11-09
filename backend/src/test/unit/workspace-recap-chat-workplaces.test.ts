import { describe, expect, it, vi } from 'vitest';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import {
  AGENT_REPLY_REACT_ASK, CROSS_REPLY_MAX_MS, eventTurnPermissionFor, WORKPLACE_MESSAGE_ASK, WorkspaceRecapChat, type RecapScope,
} from '../../services/workspace-recap-chat.js';
import type { RouteDeps } from '../../routes/deps.js';
import { workspaceAssistantId } from '../../types/user.js';
import { recapRowViews } from '../../shared/recap-chat-rows.js';

/**
 * Note #753, the owner, 2026-10-14: "As a user, I can create multiple
 * workplaces with each own chief of staff. Chief of staff should be able to
 * send message to another chief of staff, if user asks." Adam's two
 * workplaces, Studio and Bakery, one conversation service for both — as in
 * production — and a model mock per workplace that does what a turn would:
 * the route's call, `messageWorkplace`, made from inside Studio's turn.
 */
type Turn = (prompt: string) => Promise<{ text?: string; failure?: string }>;

async function setup() {
  const orgStorage = new InMemoryOrgStorage(), userStorage = new InMemoryUserStorage();
  await userStorage.createProfile('u1', { email: 'adam@example.com' });
  const studio = (await orgStorage.createOrg({ name: 'Studio', createdByUserId: 'u1' })).orgId;
  const bakery = (await orgStorage.createOrg({ name: 'Bakery', createdByUserId: 'u1' })).orgId;
  for (const org of [studio, bakery]) await orgStorage.addMember({ orgId: org, userId: 'u1', role: 'admin' });
  // A teammate in Studio, who must see none of it.
  await orgStorage.addMember({ orgId: studio, userId: 'u2', role: 'member' });
  const agents = Object.fromEntries([studio, bakery].map((org) => {
    const id = workspaceAssistantId('u1', org);
    return [id, { id, name: 'Workspace Agent', cli: 'codex', orgId: org, purpose: 'workspace-recap', connectedAt: 't', createdAt: 't' }];
  }));
  await userStorage.updateProfile('u1', { telegram: { chatId: '1', linkedAt: 't', notificationsEnabled: true, agents } as never });
  const turns: Record<string, Turn[]> = { [studio]: [], [bakery]: [] };
  const prompts: Array<{ org: string; prompt: string }> = [];
  const model = vi.fn(async (_user: string, org: string, prompt: string) => {
    prompts.push({ org, prompt });
    const next = turns[org]!.shift();
    return next ? next(prompt) : { text: 'Done.' };
  });
  const seated = new Set([studio, bakery]);
  const deps = { orgStorage, userStorage, agentLifecycle: { converseWorkspaceRecap: model, endWorkspaceAgentTurn: vi.fn(async () => 'none') } } as unknown as RouteDeps;
  const scope: RecapScope = { settings: { cli: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, activity: [], agents: [] };
  const chat = new WorkspaceRecapChat(deps, async (u, o) => await orgStorage.getMembership(o, u) ? scope : null, vi.fn(), {
    seated: async (_u, o) => seated.has(o), greeting: async () => null,
  });
  const idle = async (org: string) => { await vi.waitFor(async () => expect((await chat.read('u1', org)).working).toBe(false)); return chat.read('u1', org); };
  let clients = 0;
  const ask = (text: string) => chat.send('u1', studio, `client-${String(++clients).padStart(4, '0')}`, text);
  // What the route hands over once it has found Bakery among Adam's own workplaces.
  const toBakery = (message = 'How many orders came in today?') => chat.messageWorkplace({ userId: 'u1', orgId: studio, orgName: 'Studio', toOrgId: bakery, toName: 'Bakery', message });
  const toStudio = (message = 'And how many in yours?') => chat.messageWorkplace({ userId: 'u1', orgId: bakery, orgName: 'Bakery', toOrgId: studio, toName: 'Studio', message });
  const rows = (answer: { messages: Array<{ role: string; name?: string; text: string }> }) => answer.messages.map((m) => [m.role, m.name ?? null, m.text]);
  /** A turn that waits for the test to let it answer. */
  const held = (text: string) => {
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const turn: Turn = async () => { await gate; return { text }; };
    return { turn, release };
  };
  return { orgStorage, chat, model, prompts, turns, seated, idle, ask, toBakery, toStudio, rows, held, studio, bakery, release: undefined as undefined | (() => void) };
}

describe('the person’s Chiefs of Staff in two workplaces (note #753)', () => {
  it('passes the message to the same person’s Chief of Staff in the other workplace, and its answer comes back and starts a reaction', async () => {
    const x = await setup();
    const bakeryTurn = x.held('14 orders came in today.');
    let sent: unknown;
    x.turns[x.studio]!.push(async () => { sent = await x.toBakery(); return { text: 'I asked your Chief of Staff in Bakery.' }; });
    x.turns[x.bakery]!.push(bakeryTurn.turn);
    x.turns[x.studio]!.push(async () => ({ text: 'Bakery had 14 orders today.' }));
    await x.ask('Ask my Bakery workplace how many orders came in today.');
    // Studio has replied and is waiting for Bakery, which is answering.
    const waiting = await x.idle(x.studio);
    expect(sent).toEqual({ ok: true, name: 'Chief of Staff in Bakery', queued: false });
    expect(waiting.waiting).toEqual(['Chief of Staff in Bakery']);
    expect((await x.chat.read('u1', x.bakery)).working).toBe(true);
    bakeryTurn.release();
    await vi.waitFor(() => expect(x.model).toHaveBeenCalledTimes(3));
    const studio = await x.idle(x.studio), bakery = await x.idle(x.bakery);
    // Bakery: ONE row from Studio's Chief of Staff, answered under the workplace ask.
    expect(x.rows(bakery)).toEqual([
      ['agent', 'Chief of Staff in Studio', 'How many orders came in today?'],
      ['assistant', null, '14 orders came in today.'],
    ]);
    const bakeryPrompt = x.prompts.find((p) => p.org === x.bakery)!.prompt;
    expect(bakeryPrompt).toContain(WORKPLACE_MESSAGE_ASK);
    // Nothing of Studio's own conversation goes across — only the message.
    expect(bakeryPrompt).not.toContain('Ask my Bakery workplace');
    // Studio: the receipt, its reply, Bakery's answer as that Chief of Staff's
    // message, and the reaction it started.
    expect(x.rows(studio)).toEqual([
      ['owner', null, 'Ask my Bakery workplace how many orders came in today.'],
      ['action', null, 'Sent to Chief of Staff in Bakery: How many orders came in today?'],
      ['assistant', null, 'I asked your Chief of Staff in Bakery.'],
      ['agent', 'Chief of Staff in Bakery', '14 orders came in today.'],
      ['assistant', null, 'Bakery had 14 orders today.'],
    ]);
    expect(x.prompts.filter((p) => p.org === x.studio)[1]!.prompt).toContain(AGENT_REPLY_REACT_ASK);
    expect(studio.waiting).toEqual([]);
    expect(recapRowViews(studio.messages as never)).toContainEqual({ form: 'did', parts: ['Sent to ', { agent: 'Chief of Staff in Bakery' }], body: 'How many orders came in today?' });
    // Nobody else sees any of it: a teammate's membership holds no conversation.
    expect(await x.orgStorage.getRecapChat(x.studio, 'u2')).toBeNull();
  });

  it('never loops: the turn answering another workplace, and the reaction to its answer, cannot message a workplace', async () => {
    const x = await setup();
    const refusals: string[] = [];
    x.turns[x.studio]!.push(async () => { await x.toBakery(); return { text: 'Asked Bakery.' }; });
    x.turns[x.bakery]!.push(async () => {
      const back = await x.toStudio();
      if (!back.ok) refusals.push(back.reason);
      return { text: '14 orders.' };
    });
    x.turns[x.studio]!.push(async () => {
      const again = await x.toBakery('And yesterday?');
      if (!again.ok) refusals.push(again.reason);
      return { text: 'Bakery had 14.' };
    });
    await x.ask('Ask Bakery how many orders came in.');
    await vi.waitFor(() => expect(x.model).toHaveBeenCalledTimes(3));
    await x.idle(x.studio); await x.idle(x.bakery);
    expect(refusals).toEqual([
      'You are answering your Chief of Staff in Studio, so you cannot message another workplace in this turn. Nothing was sent; your reply goes back to it by itself.',
      expect.stringContaining('The person did not write this turn'),
    ]);
    expect(x.model).toHaveBeenCalledTimes(3);
    expect(x.rows(await x.chat.read('u1', x.bakery)).filter(([role]) => role === 'agent')).toHaveLength(1);
  });

  it('is refused in an event turn — the CLI’s fence refuses it, and so does the conversation', async () => {
    const x = await setup();
    // Not one of the person's standing permissions: the fence refuses it outright.
    expect(eventTurnPermissionFor('POST', '/workplaces/messages')).toBeNull();
    await x.orgStorage.touchMember(x.studio, 'u1', { workspaceAgentProactive: { events: true } as never });
    let refused = '';
    x.turns[x.studio]!.push(async () => { const r = await x.toBakery(); if (!r.ok) refused = r.reason; return { text: 'QUIET: nothing to do.' }; });
    expect(await x.chat.receiveEvents({ userId: 'u1', orgId: x.studio, events: [{ kind: 'checks-red', key: 'checks-red:pr1:abc', text: 'Checks failed on proposal #4.', at: '2026-10-14T08:00:00.000Z' }] })).toBe(true);
    await vi.waitFor(() => expect(x.model).toHaveBeenCalledTimes(1));
    await x.idle(x.studio);
    expect(refused).toContain('The person did not write this turn');
    expect((await x.chat.read('u1', x.bakery)).messages).toEqual([]);
  });

  it('waits for a busy Chief of Staff to finish its current request, then answers', async () => {
    const x = await setup();
    // Bakery is in the middle of Adam's own request there.
    const own = x.held('Your menu is updated.');
    x.turns[x.bakery]!.push(own.turn);
    await x.chat.send('u1', x.bakery, 'client-bakery-1', 'Update the menu.');
    let sent: unknown;
    x.turns[x.studio]!.push(async () => { sent = await x.toBakery(); return { text: 'Asked Bakery.' }; });
    x.turns[x.bakery]!.push(async () => ({ text: '14 orders.' }));
    await x.ask('Ask Bakery how many orders came in.');
    await x.idle(x.studio);
    expect(sent).toEqual({ ok: true, name: 'Chief of Staff in Bakery', queued: true });
    own.release();
    await vi.waitFor(async () => expect(x.rows(await x.chat.read('u1', x.studio))).toContainEqual(['agent', 'Chief of Staff in Bakery', '14 orders.']));
    expect(x.rows(await x.idle(x.bakery))).toEqual([
      ['owner', null, 'Update the menu.'],
      ['agent', 'Chief of Staff in Studio', 'How many orders came in today?'],
      ['assistant', null, 'Your menu is updated.'],
      ['assistant', null, '14 orders.'],
    ]);
  });

  it('says so, never silently, when the other Chief of Staff cannot answer', async () => {
    const x = await setup();
    // Its turn fails: Studio is told why, and nothing reacts to a failure.
    x.turns[x.studio]!.push(async () => { await x.toBakery(); return { text: 'Asked Bakery.' }; });
    x.turns[x.bakery]!.push(async () => ({ failure: 'unavailable' }));
    await x.ask('Ask Bakery how many orders came in.');
    await vi.waitFor(async () => expect((await x.chat.read('u1', x.studio)).messages.at(-1)?.text).toMatch(/^Your Chief of Staff in Bakery could not answer: /));
    const studio = await x.idle(x.studio);
    expect(studio.waiting).toEqual([]);
    expect(studio.messages.at(-1)?.text).toBe('Your Chief of Staff in Bakery could not answer: its model or the subscription there is not working.');
    expect(recapRowViews(studio.messages as never).at(-1)).toEqual({ form: 'attention', tone: 'warn', parts: [{ agent: 'Chief of Staff in Bakery' }, ' could not answer: its model or the subscription there is not working.'] });
    expect(x.model).toHaveBeenCalledTimes(2);
    // Nothing to think with there: refused up front, nothing sent, no wait left open.
    x.seated.delete(x.bakery);
    let refused = '';
    x.turns[x.studio]!.push(async () => { const r = await x.toBakery(); if (!r.ok) refused = r.reason; return { text: 'Bakery cannot answer yet.' }; });
    await x.ask('Ask Bakery again.');
    await vi.waitFor(() => expect(refused).toContain('no Claude or ChatGPT plan is signed in there'));
    expect((await x.idle(x.studio)).waiting).toEqual([]);
    expect(x.rows(await x.chat.read('u1', x.bakery)).filter(([role]) => role === 'agent')).toHaveLength(1);
  });

  it('tells the asking workplace when the person stops the other Chief of Staff’s turn', async () => {
    const x = await setup();
    let stopped!: () => void;
    const reached = new Promise<void>((done) => { stopped = done; });
    // Bakery's turn, holding until the person's Stop lets the machine go.
    x.turns[x.studio]!.push(async () => { await x.toBakery(); return { text: 'Asked Bakery.' }; });
    x.turns[x.bakery]!.push(() => new Promise((resolve) => { x.release = () => resolve({ failure: 'interrupted' }); stopped(); }));
    await x.ask('Ask Bakery how many orders came in.');
    await reached;
    expect((await x.chat.stop('u1', x.bakery)).stopped).toBe(true);
    x.release?.();
    await vi.waitFor(async () => expect((await x.chat.read('u1', x.studio)).messages.at(-1)?.text).toBe('Your Chief of Staff in Bakery could not answer: its turn was stopped there.'));
    expect((await x.idle(x.studio)).waiting).toEqual([]);
    expect(x.model).toHaveBeenCalledTimes(2);
  });

  it('closes a wait whose answer was lost, after two hours, in words', async () => {
    const x = await setup();
    x.turns[x.studio]!.push(async () => { await x.toBakery(); return { text: 'Asked Bakery.' }; });
    x.turns[x.bakery]!.push(() => new Promise(() => {}));
    await x.ask('Ask Bakery how many orders came in.');
    expect((await x.idle(x.studio)).waiting).toEqual(['Chief of Staff in Bakery']);
    const chat = (await x.orgStorage.getRecapChat(x.studio, 'u1'))!;
    chat.crossPending = chat.crossPending!.map((wait) => ({ ...wait, sentAt: new Date(Date.now() - CROSS_REPLY_MAX_MS - 1000).toISOString() }));
    await x.orgStorage.touchMember(x.studio, 'u1', { workspaceRecapChat: chat });
    const closed = await x.chat.read('u1', x.studio);
    expect(closed.waiting).toEqual([]);
    expect(closed.messages.at(-1)?.text).toBe('No answer came from your Chief of Staff in Bakery. Its own conversation has whatever it said.');
    expect(recapRowViews(closed.messages as never).at(-1)).toEqual({ form: 'attention', tone: 'warn', parts: [{ agent: 'Chief of Staff in Bakery' }, ' did not answer'] });
  });
});
