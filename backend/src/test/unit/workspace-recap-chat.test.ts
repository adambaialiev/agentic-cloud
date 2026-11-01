import { describe, expect, it, vi } from 'vitest';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { InMemoryQuickNoteStorage } from '../../services/quick-note-storage.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import { TELEGRAM_CLAUDE_MODEL_CATALOG, TELEGRAM_CODEX_MODEL_CATALOG } from '../../shared/model-catalog.js';
import { AGENT_REPLY_REACT_ASK, EVENT_QUIET, eventTurnPermissionFor, freshChatAsk, quietLine, WorkspaceRecapChat, cleanRecapReply, RECAP_TURN_STOPPED, RESTART_RESUME_NOTICE, STOP_UNWIND_WAIT_MS, WORKSPACE_AGENT_INSTRUCTIONS, type RecapScope } from '../../services/workspace-recap-chat.js';
import { STEERING_RESUME_NOTICE } from '../../agent/background-runner.js';
import type { RouteDeps } from '../../routes/deps.js';
import { workspaceAssistantId } from '../../types/user.js';
import { DEFAULT_WORKSPACE_AGENT_PROACTIVE, type WorkspaceAgentEvent } from '../../shared/workspace-agent-proactive.js';
// Every sentence these tests see the conversation write is also read back the
// way the screen reads it (note #725): a reworded receipt fails here instead
// of quietly turning back into a grey row the person was never meant to see.
import { recapRowViews } from '../../shared/recap-chat-rows.js';
import { freshChatRowText } from '../../shared/workspace-recap-chat.js';

/** Media storage as the conversation needs it: bytes in, a signed URL out. */
class FakeMediaStorage {
  objects = new Map<string, Buffer>();
  async uploadObject(args: { storagePath: string; contentType: string; data: Buffer }) { this.objects.set(args.storagePath, args.data); }
  async createReadAccess(args: { storagePath: string }) {
    if (!this.objects.has(args.storagePath)) throw new Error('no such object');
    return { url: `https://signed.example/${args.storagePath}`, expiresAt: 'soon' };
  }
  async downloadObject(args: { storagePath: string }) { return this.objects.get(args.storagePath) ?? Buffer.alloc(0); }
  async deleteObject(args: { storagePath: string }) { this.objects.delete(args.storagePath); }
}
/** A 2×3 PNG header — enough for the picture measurement, nothing else. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0])]);
type TurnOptions = { act?: boolean; signal?: AbortSignal; attachments?: Array<{ fileName: string; storagePath: string }> };
/** A model turn that runs until the person stops or steers it — what a real machine does. */
const untilAborted = (...args: unknown[]) => new Promise<{ failure: 'interrupted' }>((resolve) => {
  const options = args[5] as TurnOptions;
  // Already stopped or steered before the machine was reached: the real
  // runner returns at once rather than starting anything.
  if (options.signal!.aborted) { resolve({ failure: 'interrupted' }); return; }
  options.signal!.addEventListener('abort', () => resolve({ failure: 'interrupted' }), { once: true });
});

/**
 * The Workspace Agent's conversation: one model turn per request on the
 * agent's own machine, acting through the agentbuilt CLI. The CLI routes are
 * not here — what they do is call the two hooks (`receipt`, `messageAgent`)
 * this class implements, so the model mock calls them the way a route would
 * while the turn runs.
 */
/** The row the Chief of Staff writes when its machine would not wake (agent-service's WORKSPACE_AGENT_WAKE_FAILED). */
const WAKE_FAILED = 'Your Workspace Agent\'s computer would not wake up, so it could not answer. Send your message again in a minute.';

async function setup(replies: string[], options: { wakeRetryDelayMs?: number } = {}) {
  const orgStorage = new InMemoryOrgStorage(), notes = new InMemoryQuickNoteStorage(), userStorage = new InMemoryUserStorage();
  await userStorage.createProfile('u1', { email: 'one@example.com' });
  const org = await orgStorage.createOrg({ name: 'Studio', createdByUserId: 'u1' });
  // The person's Workspace Agent as a started one really is: the reserved
  // record id, carrying the purpose that makes it one (note #539).
  const waId = workspaceAssistantId('u1', org.orgId);
  await userStorage.updateProfile('u1', { telegram: { chatId: '1', linkedAt: 't', notificationsEnabled: true, agents: {
    a1: { id: 'a1', name: 'Theo', cli: 'codex', orgId: org.orgId, connectedAt: 't', createdAt: 't' } as never,
    [waId]: { id: waId, name: 'Workspace Agent', cli: 'codex', orgId: org.orgId, purpose: 'workspace-recap', connectedAt: 't', createdAt: 't' } as never,
  } } });
  await orgStorage.addMember({ orgId: org.orgId, userId: 'u1', role: 'admin' });
  await orgStorage.addMember({ orgId: org.orgId, userId: 'u2', role: 'member' });
  const model = vi.fn(async (..._args: unknown[]) => ({ text: replies.shift() ?? 'Done.' }));
  const message = vi.fn(async (_args: { userId: string; senderAgentId: string; recipient: string; message: string }) => ({ ok: true as const, recipient: { id: 'a1', name: 'Theo', cli: 'codex' } }));
  const rows: Array<{ seq: number; role: 'owner' | 'agent' | 'platform'; text: string; at: string }> = [];
  const scope: RecapScope = { settings: { cli: 'codex', model: 'gpt-5.6-terra', effort: 'high' }, activity: [], agents: [
    { record: { id: 'a1', orgId: org.orgId, name: 'Theo', cli: 'codex', connectedAt: 't', recap: { text: 'Shipped the booking page.', at: 't' }, contextUsage: { tokens: 150_000, model: 'gpt-5.6-terra', window: 200_000, at: '2026-09-09T10:30:00.000Z' } } as never, own: true, working: false },
    { record: { id: 'a2', orgId: org.orgId, name: 'Other', cli: 'codex', connectedAt: 't' }, own: false, working: false },
  ] };
  const media = new FakeMediaStorage();
  const ended = vi.fn(async (_u: string, _o: string): Promise<'ended' | 'none' | 'unreachable'> => 'none');
  const stopTurn = vi.fn(async (_args: unknown) => ({ ok: true as const, stopped: true, name: 'Theo', idle: true }));
  /** The owner's own door to an idle agent — what `agent reset` sends "reset chat" through (note #710). */
  const fromUser = vi.fn(async (_args: { userId: string; agentId: string; message: string }) => ({ ok: true as const, recipient: { id: 'a1', name: 'Theo', cli: 'codex' } }));
  /** A row in one agent's own chat — what `agent model` leaves there (note #776). */
  const platformRow = vi.fn(async (_u: string, _a: string, _text: string) => true);
  const deps = { orgStorage, userStorage, quickNoteStorage: notes, mediaStorage: media, agentLifecycle: { converseWorkspaceRecap: model, messagePeer: message, endWorkspaceAgentTurn: ended, stopAgentTurn: stopTurn, messageAgentFromUser: fromUser, recordAgentPlatformRow: platformRow, agentChatMessages: vi.fn(async (_u: string, _a: string, after: number) => rows.filter(r => r.seq > after)) } } as unknown as RouteDeps;
  const resolve = async (u: string, o: string) => await orgStorage.getMembership(o, u) ? scope : null;
  const changed = vi.fn();
  const chat = new WorkspaceRecapChat(deps, resolve, changed, undefined, options);
  const done = async () => { await vi.waitFor(async () => expect((await chat.read('u1', org.orgId)).working).toBe(false)); return chat.read('u1', org.orgId); };
  const sendFromAgent = (recipient: string, text = 'What is the status?') => chat.messageAgent({ userId: 'u1', orgId: org.orgId, senderAgentId: 'wa', recipient, message: text });
  const history = (agent: string, limit = 4) => chat.agentHistory({ userId: 'u1', orgId: org.orgId, agent, limit });
  const answerFrom = (senderAgentId: string, text: string) => chat.receiveFromAgent({ userId: 'u1', orgId: org.orgId, senderAgentId, message: text });
  const stopFromAgent = (agent: string, reason?: string) => chat.stopAgent({ userId: 'u1', orgId: org.orgId, agent, ...(reason ? { reason } : {}) });
  const resetFromAgent = (agent: string) => chat.resetAgent({ userId: 'u1', orgId: org.orgId, agent });
  const removeFromAgent = (agent: string, reason?: string) => chat.askRemoveAgent({ userId: 'u1', orgId: org.orgId, agent, ...(reason ? { reason } : {}) });
  const modelFromAgent = (agent: string, asked: { model?: string; effort?: string }) => chat.changeAgentRuntime({ userId: 'u1', orgId: org.orgId, agent, ...asked });
  /** The person has never started their Workspace Agent: no record, no machine (note #539). */
  const neverStarted = async () => {
    const profile = (await userStorage.getProfile('u1'))!;
    const { [waId]: _gone, ...rest } = profile.telegram!.agents!;
    await userStorage.updateProfile('u1', { telegram: { ...profile.telegram!, agents: rest } });
  };
  return { chat, org: org.orgId, orgStorage, userStorage, notes, media, model, message, ended, stopTurn, fromUser, rows, scope, done, deps, resolve, changed, sendFromAgent, history, answerFrom, stopFromAgent, resetFromAgent, removeFromAgent, modelFromAgent, platformRow, neverStarted };
}

describe('Workspace Agent stop, steer and files (note #423): an agent chat\'s contract', () => {
  it('stops the running turn from the conversation: the turn is ended on the machine, what it did stays, and the transcript says so', async () => {
    const x = await setup([]);
    x.model.mockImplementationOnce(async (...args: unknown[]) => {
      await x.chat.receipt('u1', x.org, 'Created note: Half done');
      return untilAborted(...args);
    });
    await x.chat.send('u1', x.org, 'request-1', 'Write three notes');
    await vi.waitFor(() => expect(x.model).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => expect((await x.chat.read('u1', x.org)).messages).toHaveLength(2));
    expect(await x.chat.stop('u1', x.org)).toEqual({ stopped: true });
    const settled = await x.done();
    expect(settled.messages.map(m => [m.role, m.text])).toEqual([
      ['owner', 'Write three notes'], ['action', 'Created note: Half done'], ['action', RECAP_TURN_STOPPED],
    ]);
    expect(x.model).toHaveBeenCalledTimes(1);
    // The turn had already ended: the honest answer, not an error.
    expect(await x.chat.stop('u1', x.org)).toEqual({ stopped: false });
    // The next message is an ordinary new request.
    x.model.mockResolvedValueOnce({ text: 'Two more written.' });
    await x.chat.send('u1', x.org, 'request-2', 'Finish the other two');
    expect((await x.done()).messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Two more written.' });
  });
  it('steers a running turn with the next message: no refusal, the turn is interrupted, and one replacement turn answers both messages', async () => {
    const x = await setup([]);
    x.model.mockImplementationOnce(untilAborted);
    x.model.mockImplementationOnce(async () => ({ text: 'Archived 12, kept 13.' }));
    await x.chat.send('u1', x.org, 'request-1', 'Archive note 12');
    await vi.waitFor(() => expect(x.model).toHaveBeenCalledTimes(1));
    const steered = await x.chat.send('u1', x.org, 'request-2', 'And keep note 13');
    expect(steered.steered).toBe(true);
    expect(steered.working).toBe(true);
    expect(steered.phase).toBe('Changing direction…');
    const settled = await x.done();
    expect(x.model).toHaveBeenCalledTimes(2);
    const first = x.model.mock.calls[0]![5] as TurnOptions;
    expect(first.signal!.aborted).toBe(true);
    const prompt = x.model.mock.calls[1]![2] as string;
    expect(prompt).toContain(STEERING_RESUME_NOTICE);
    expect(prompt).toContain('"text":"Archive note 12"');
    expect(prompt).toContain('"text":"And keep note 13"');
    expect(prompt).toContain('Answer every owner message after your last reply');
    expect(settled.messages.map(m => [m.role, m.text])).toEqual([
      ['owner', 'Archive note 12'], ['owner', 'And keep note 13'], ['assistant', 'Archived 12, kept 13.'],
    ]);
    // A message after the reply is an ordinary request again, with no notice.
    x.model.mockResolvedValueOnce({ text: 'Yes.' });
    await x.chat.send('u1', x.org, 'request-3', 'Sure?');
    await x.done();
    expect(x.model.mock.calls[2]![2] as string).not.toContain(STEERING_RESUME_NOTICE);
  });
  it('answers a message that lands as the turn is finishing with a replacement turn, instead of leaving it unanswered', async () => {
    const x = await setup([]);
    // The model has already answered; its signal is aborted too late to
    // matter, and the reply is landing when the next message arrives.
    x.model.mockImplementationOnce(async () => {
      void x.chat.send('u1', x.org, 'request-2', 'Also note 13');
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { text: 'Archived 12.' };
    });
    x.model.mockImplementationOnce(async () => ({ text: 'And 13.' }));
    await x.chat.send('u1', x.org, 'request-1', 'Archive note 12');
    const settled = await x.done();
    expect(x.model).toHaveBeenCalledTimes(2);
    expect(settled.messages.map(m => [m.role, m.text])).toEqual([
      ['owner', 'Archive note 12'], ['owner', 'Also note 13'], ['assistant', 'And 13.'],
    ]);
  });
  it('carries files with a message: stored for the screen, staged for the turn, named in the prompt, served by a signed URL', async () => {
    const x = await setup([]);
    x.model.mockImplementationOnce(async () => ({ text: 'Put the photo on note 3.' }));
    const answer = await x.chat.send('u1', x.org, 'request-1', 'Attach this to note 3', [
      { fileName: 'photo.png', contentType: 'image/png', data: PNG },
      { fileName: 'brief.pdf', contentType: 'application/pdf', data: Buffer.from([1, 2, 3]) },
    ]);
    const row = answer.messages[0]!;
    expect(row).toMatchObject({ role: 'owner', text: 'Attach this to note 3' });
    expect(row.files).toHaveLength(2);
    expect(row.files![0]).toMatchObject({ fileName: 'photo.png', contentType: 'image/png', sizeBytes: PNG.byteLength, width: 2, height: 3 });
    // Where the bytes live never reaches the screen.
    expect(JSON.stringify(answer)).not.toContain('storagePath');
    expect(x.media.objects.size).toBe(2);
    await x.done();
    const [, , prompt, , , options] = x.model.mock.calls[0]! as [string, string, string, unknown, unknown, TurnOptions];
    expect(prompt).toContain('"files":["photo.png","brief.pdf"]');
    expect(options.attachments!.map(a => a.fileName)).toEqual(['photo.png', 'brief.pdf']);
    expect(options.attachments![0]!.storagePath).toContain('workspace-agent');
    // Filed under this workplace, so its own store takes them — not the
    // store of whichever workplace the person joined first (note #650).
    expect(options.attachments![0]!.storagePath.startsWith(`users/${x.org}/agent-chats/workspace-agent-u1/`)).toBe(true);
    expect(options.attachments![0]).toMatchObject({ use: 'sandbox_input', source: 'user_input', renderAs: 'image' });
    // Served the way an agent chat's files are: a preview asks for an inline picture, an open for a download.
    const preview = await x.chat.fileAccess('u1', x.org, row.files![0]!.id, true);
    expect(preview).toMatchObject({ fileName: 'photo.png', width: 2, height: 3 });
    expect(preview!.url).toContain('https://signed.example/');
    expect(await x.chat.fileAccess('u1', x.org, 'nope')).toBeNull();
    expect(await x.chat.fileAccess('u2', x.org, row.files![0]!.id)).toBeNull();
    // A second turn answers for no files: the first turn already had them.
    x.model.mockResolvedValueOnce({ text: 'Done.' });
    await x.chat.send('u1', x.org, 'request-2', 'Thanks');
    await x.done();
    expect((x.model.mock.calls[1]![5] as TurnOptions).attachments).toEqual([]);
  });
  it('reads a Markdown file on its rows as words, the way an agent\'s chat does (note #677)', async () => {
    const x = await setup([]);
    x.model.mockImplementationOnce(async () => ({ text: 'Read it.' }));
    const answer = await x.chat.send('u1', x.org, 'request-md', 'The plan', [
      { fileName: 'plan.md', contentType: 'text/markdown', data: Buffer.from('# Plan\n\nShip it.') },
      { fileName: 'photo.png', contentType: 'image/png', data: PNG },
    ]);
    await x.done();
    const [md, photo] = answer.messages[0]!.files!;
    expect(await x.chat.fileText('u1', x.org, md!.id)).toEqual({ kind: 'markdown', fileName: 'plan.md', content: '# Plan\n\nShip it.' });
    expect(await x.chat.fileText('u1', x.org, photo!.id)).toEqual({ kind: 'unsupported', fileName: 'photo.png' });
    expect(await x.chat.fileText('u1', x.org, 'nope')).toBeNull();
    expect(await x.chat.fileText('u2', x.org, md!.id)).toBeNull();
  });
  it('stores files returned by the agent on its assistant row', async () => {
    const x = await setup([]);
    x.model.mockResolvedValueOnce({
      text: 'Here is the report.',
      files: [{ fileName: 'report.txt', contentType: 'text/plain', data: Buffer.from('done') }],
    });
    await x.chat.send('u1', x.org, 'request-files-out', 'Make a report');
    const settled = await x.done();
    const reply = settled.messages.at(-1)!;
    expect(reply).toMatchObject({ role: 'assistant', text: 'Here is the report.' });
    expect(reply.files).toHaveLength(1);
    expect(reply.files![0]).toMatchObject({ fileName: 'report.txt', contentType: 'text/plain', sizeBytes: 4 });
    expect([...x.media.objects.values()].some((data) => data.toString() === 'done')).toBe(true);
  });
  it('refuses too many bytes, a bad name, and files when storage is missing — and a file alone is a message', async () => {
    const x = await setup([]);
    const file = (n: number) => ({ fileName: `f${n}.txt`, contentType: 'text/plain', data: Buffer.from('x') });
    // Note #672: no count cap, a byte cap — four 24 MB files are 96 MB together.
    const big = Buffer.alloc(24 * 1024 * 1024, 1);
    await expect(x.chat.send('u1', x.org, 'request-1', '', [1, 2, 3, 4].map((n) => ({ fileName: `v${n}.mp4`, data: big }))))
      .rejects.toMatchObject({ status: 400 });
    await expect(x.chat.send('u1', x.org, 'request-1', '', [{ fileName: '../etc/passwd', data: Buffer.from('x') }])).rejects.toMatchObject({ status: 400 });
    await expect(x.chat.send('u1', x.org, 'request-1', '', [])).rejects.toMatchObject({ status: 400 });
    // The person's words are held to the chat box's 10,000 (note #704), not an agent message's 4,000.
    await expect(x.chat.send('u1', x.org, 'request-1', 'x'.repeat(10_001))).rejects.toMatchObject({ status: 400, message: 'Write a message of at most 10,000 characters.' });
    x.model.mockResolvedValueOnce({ text: 'Got it.' });
    const only = await x.chat.send('u1', x.org, 'request-2', '', [file(1)]);
    expect(only.messages[0]).toMatchObject({ role: 'owner', text: '' });
    expect(only.messages[0]!.files).toHaveLength(1);
    await x.done();
    const bare = new WorkspaceRecapChat({ ...x.deps, mediaStorage: undefined } as RouteDeps, x.resolve);
    await expect(bare.send('u1', x.org, 'request-3', 'hi', [file(1)])).rejects.toMatchObject({ status: 503 });
  });
});

describe('Workspace Agent stops an agent (note #462): the owner\'s Stop, done for them', () => {
  it('stops a working own agent: the same stop with the Workspace Agent and its reason named on it, the wait for that agent closed, and a receipt here', async () => {
    const x = await setup([]);
    // Outside a request of the person nothing is stopped, as nothing is sent.
    x.scope.agents[0]!.working = true;
    expect(await x.stopFromAgent('Theo')).toMatchObject({ ok: false, code: 'unavailable' });
    expect(x.stopTurn).not.toHaveBeenCalled();
    x.scope.agents[0]!.working = false;
    x.message.mockImplementation(async () => {
      x.scope.agents[0]!.working = true;
      return { ok: true as const, recipient: { id: 'a1', name: 'Theo', cli: 'codex' } };
    });
    x.model.mockImplementation(async () => {
      await x.sendFromAgent('theo');
      const result = await x.stopFromAgent('theo', '  the note text changed  ');
      expect(result).toEqual({ ok: true, name: 'Theo', idle: true });
      return { text: 'Stopped Theo; sending the new text.' };
    });
    await x.chat.send('u1', x.org, 'request-1', 'Stop Theo, the note changed');
    const settled = await x.done();
    expect(x.stopTurn).toHaveBeenCalledWith({ userId: 'u1', agentId: 'a1', stoppedBy: 'workspace-agent', reason: 'the note text changed', awaitIdleMs: STOP_UNWIND_WAIT_MS });
    expect(settled.waiting).toEqual([]);
    expect(settled.messages.map(m => [m.role, m.text])).toEqual([
      ['owner', 'Stop Theo, the note changed'],
      ['action', 'Sent to Theo: What is the status?'],
      ['action', 'Stopped Theo: the note text changed. Its reply is no longer awaited.'],
      ['assistant', 'Stopped Theo; sending the new text.'],
    ]);
    expect(x.changed).toHaveBeenCalledWith(x.org);
    // The closed wait stays closed: no "finished without a reply" arrives for it later.
    x.scope.agents[0]!.working = false;
    (x.scope.agents[0]!.record as { lastTurnEndedAt?: string }).lastTurnEndedAt = new Date(Date.now() + 1000).toISOString();
    expect((await x.chat.read('u1', x.org)).messages).toHaveLength(4);
  });
  it('refuses an idle agent, itself, a teammate\'s agent, an unknown name and an overlong reason; a turn that had already ended is "nothing to stop", one still unwinding says so', async () => {
    const x = await setup([]);
    x.model.mockImplementation(async () => {
      expect(await x.stopFromAgent('Theo')).toMatchObject({ ok: false, code: 'idle' });
      expect(await x.stopFromAgent('Workspace Agent')).toMatchObject({ ok: false, code: 'self' });
      expect(await x.stopFromAgent('Other')).toMatchObject({ ok: false, code: 'not_own' });
      expect(await x.stopFromAgent('a2')).toMatchObject({ ok: false, code: 'not_own' });
      expect(await x.stopFromAgent('Nobody')).toMatchObject({ ok: false, code: 'not_found' });
      x.scope.agents[0]!.working = true;
      expect(await x.stopFromAgent('Theo', 'x'.repeat(501))).toMatchObject({ ok: false, code: 'unavailable' });
      expect(x.stopTurn).not.toHaveBeenCalled();
      x.stopTurn.mockResolvedValueOnce({ ok: true as const, stopped: false, name: 'Theo', idle: true });
      expect(await x.stopFromAgent('Theo')).toMatchObject({ ok: false, code: 'idle' });
      x.stopTurn.mockResolvedValueOnce({ ok: true as const, stopped: true, name: 'Theo', idle: false });
      expect(await x.stopFromAgent('a1')).toEqual({ ok: true, name: 'Theo', idle: false });
      return { text: 'Done.' };
    });
    await x.chat.send('u1', x.org, 'request-1', 'Stop things');
    const settled = await x.done();
    expect(settled.messages.filter(m => m.role === 'action').map(m => m.text)).toEqual(['Stopped Theo.']);
    expect(recapRowViews(settled.messages)).toContainEqual({ form: 'did', parts: ['Stopped ', { agent: 'Theo' }] });
    expect(x.stopTurn).toHaveBeenCalledTimes(2);
  });
});

describe('Workspace Agent reply', () => {
  it('shows prose as written and drops a legacy JSON wrapper', () => {
    expect(cleanRecapReply('Theo is idle; Ada is working.')).toBe('Theo is idle; Ada is working.');
    expect(cleanRecapReply('```json\n{"reply":"Both agents are idle."}\n```')).toBe('Both agents are idle.');
    expect(cleanRecapReply('{"reply":"Saved."}')).toBe('Saved.');
    expect(cleanRecapReply('{"tool":"archive_notes"}')).toBe('{"tool":"archive_notes"}');
    expect(cleanRecapReply('  ')).toBe('');
  });
});

describe('Workspace Agent reads an agent\'s recent visible steps (note #466)', () => {
  it('reads the latest four text rows by name or id, oldest first, whether idle or working', async () => {
    const x = await setup([]);
    x.rows.push(
      { seq: 1, role: 'owner', text: 'Old context outside the window.', at: '2026-09-10T09:00:00.000Z' },
      { seq: 2, role: 'agent', text: 'I started the migration.', at: '2026-09-10T09:01:00.000Z' },
      { seq: 3, role: 'platform', text: 'Turn stopped by the user.', at: '2026-09-10T09:02:00.000Z' },
      { seq: 4, role: 'owner', text: 'Continue, but keep the old rows.', at: '2026-09-10T09:03:00.000Z' },
      { seq: 5, role: 'agent', text: 'The migration is running.', at: '2026-09-10T09:04:00.000Z' },
    );
    x.scope.agents[0]!.working = true;

    const byName = await x.history('theo');
    expect(byName).toEqual({
      ok: true,
      agent: { id: 'a1', name: 'Theo' },
      steps: [
        { role: 'agent', author: 'Theo', text: 'I started the migration.', at: '2026-09-10T09:01:00.000Z' },
        { role: 'platform', author: 'Platform', text: 'Turn stopped by the user.', at: '2026-09-10T09:02:00.000Z' },
        { role: 'owner', author: 'Owner', text: 'Continue, but keep the old rows.', at: '2026-09-10T09:03:00.000Z' },
        { role: 'agent', author: 'Theo', text: 'The migration is running.', at: '2026-09-10T09:04:00.000Z' },
      ],
    });
    expect(await x.history('a1', 1)).toMatchObject({ ok: true, steps: [{ role: 'agent', author: 'Theo', text: 'The migration is running.' }] });
  });

  it('returns only visible text and distinguishes another owner\'s agent from a missing one', async () => {
    const x = await setup([]);
    x.rows.push({ seq: 1, role: 'owner', text: '', at: '2026-09-10T09:00:00.000Z', files: [{ id: 'f1', fileName: 'machine-secret.txt', contentType: 'text/plain', sizeBytes: 12 }] } as never);
    x.rows.push({ seq: 2, role: 'agent', text: 'Only these visible words.', at: '2026-09-10T09:01:00.000Z' });
    const visible = await x.history('Theo');
    expect(visible).toMatchObject({ ok: true, steps: [{ text: 'Only these visible words.' }] });
    expect(JSON.stringify(visible)).not.toContain('machine-secret.txt');
    await expect(x.history('Other')).resolves.toMatchObject({ ok: false, code: 'not_own', reason: expect.stringContaining("teammate's agent") });
    await expect(x.history('Nobody')).resolves.toMatchObject({ ok: false, code: 'not_found', reason: expect.stringContaining('No agent of yours') });
  });
});

describe('Workspace Agent conversation', () => {
  it('runs one acting turn per request, with the roster and its orders in the prompt, and keeps the transcript private', async () => {
    const x = await setup(['Your booking page is ready.']);
    x.scope.activity = [{
      id: 'pr:proposal-12', kind: 'proposal', title: 'Proposal #12: Ship booking page',
      text: 'Ready for the owner to review.', at: '2026-09-09T10:45:00.000Z',
      href: '/workspace/proposals/proposal-12', status: 'Awaiting your decision',
    }];
    await x.chat.send('u1', x.org, 'request-123', 'What changed?'); await x.done();
    await x.chat.send('u1', x.org, 'request-123', 'What changed?');
    expect(x.model).toHaveBeenCalledTimes(1);
    const [, , prompt, settings, , options] = x.model.mock.calls[0]! as [string, string, string, unknown, unknown, { act?: boolean; signal?: AbortSignal; attachments?: unknown[] }];
    expect(options).toMatchObject({ act: true, attachments: [] });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(settings).toEqual(x.scope.settings);
    expect(prompt.startsWith(WORKSPACE_AGENT_INSTRUCTIONS)).toBe(true);
    expect(prompt).toContain('agentbuilt agent message');
    expect(prompt).toContain('agentbuilt agent history');
    expect(prompt).toContain('works while the agent is idle or working and changes nothing');
    expect(prompt).toContain('Open: /workspace/...');
    expect(prompt).toContain('https://workspace/...');
    expect(prompt).toContain('"name":"Theo"');
    expect(prompt).toContain('"state":"idle"');
    // Briefings are fetched only when asked for, never injected into every
    // turn alongside the workplace facts.
    expect(prompt).toContain('agentbuilt briefing list');
    expect(prompt).not.toContain('"briefings":');
    expect(prompt).toContain('"latestWork"');
    expect(prompt).not.toContain('"recap":');
    // Each row carries the ring's own context reading (note #449), and the
    // orders say how to weigh it — lower thresholds than the ring's (note
    // #456), and only as a safety net: a finished, unrelated conversation
    // asks for a reset first whatever the figure.
    expect(prompt).toContain('"context":{"usedPercent":75,"tokens":150000,"window":200000,"at":"2026-09-09T10:30:00.000Z"}');
    expect(prompt).toContain('"name":"Other"');
    // Agent rows name no room (note #923): there is none to name.
    expect(prompt).not.toContain('"room"');
    expect(prompt).toContain('under 40% is room to work');
    expect(prompt).toContain('from 40% the agent is getting full');
    expect(prompt).toContain('at 60% or more it is nearly full');
    expect(prompt).not.toMatch(/67%|90%/);
    // It no longer asks the agent to reset itself (PR #1246): its wait for
    // the answer closes when the reset turn ends, and the fresh chat never
    // answers it. Since note #710 it asks for the reset with its own verb,
    // as the person's button does, and never inside the message with the work.
    expect(prompt).not.toContain('reset your chat first');
    expect(prompt).toContain('ask for it yourself with `agentbuilt agent reset` while it is idle');
    expect(prompt).toContain('Never write "reset your chat" inside the message that carries the work');
    // The orchestrator's verbs and its role (note #710).
    expect(prompt).toContain('one person\'s private orchestrator across their whole workplace');
    // Rooms are gone (note #843): no room verb to run, no --room to name,
    // and an agent is brought into the workplace.
    expect(prompt).toContain('agentbuilt room … — gone.');
    expect(prompt).not.toMatch(/room (create|rename|order|remove) "/);
    expect(prompt).not.toContain('--room "<room');
    expect(prompt).toContain('`--room` is accepted and ignored');
    expect(prompt).toContain('agentbuilt agent create [--cli claude|codex|opencode] [--model <model>] [--effort <effort>] — bring a new agent into the workplace');
    // Note #757: the flags only when the person asked, and the names read off
    // the picker's own catalog, so the text never offers what it would refuse.
    expect(prompt).toContain('Pass them ONLY when the person said which model or effort they want');
    expect(prompt).toContain('the defaults (Claude Code: opus at high; Codex: gpt-6.1-sol at high; OpenCode: glm-5.3 at high)');
    for (const entry of [...TELEGRAM_CLAUDE_MODEL_CATALOG, ...TELEGRAM_CODEX_MODEL_CATALOG]) expect(prompt).toContain(entry.value);
    expect(prompt).toContain('Claude Code offers fable, opus, sonnet (effort medium, high, xhigh, max)');
    expect(prompt).toContain('gpt-5.5 (effort medium, high, xhigh)');
    expect(prompt).toContain('agentbuilt agent remove "<name-or-id>" ["<why>"] — ASK the person');
    expect(prompt).toContain('Orchestrating. When the person hands you work that is bigger than one agent\'s turn, plan it before you hand it out');
    expect(prompt).toContain('whether its previous work is finished and whether what is left in its conversation still helps the new task — not the percentage');
    expect(prompt).toContain('The percentage is only a safety net');
    expect(prompt).not.toContain('ceiling');
    expect(prompt).toContain('dead weight even at 20%');
    expect(prompt).toContain('Do NOT ask for a reset when the conversation is working for the new task');
    expect(prompt).toContain('decide from latestWork alone');
    // CONTEXT lists no rooms (note #923): there are none.
    expect(prompt).not.toContain('"rooms"');
    expect(prompt).not.toContain('"roomActivity"');
    // Current workplace state is in the model prompt itself, not merely drawn
    // on Home: a proposal created since the prior turn is visible on this turn.
    expect(prompt).toContain('"activity":[{"kind":"proposal","title":"Proposal #12: Ship booking page"');
    expect(prompt).toContain('"status":"Awaiting your decision"');
    expect(prompt).not.toContain('"overview"');
    expect(prompt).not.toContain('"namespace"');
    expect((await x.chat.read('u2', x.org)).messages).toEqual([]);
    const restarted = new WorkspaceRecapChat(x.deps, x.resolve);
    expect((await restarted.read('u1', x.org)).messages.map(m => m.text)).toEqual(['What changed?', 'Your booking page is ready.']);
    await x.orgStorage.removeMember(x.org, 'u1');
    await expect(x.chat.read('u1', x.org)).rejects.toMatchObject({ status: 403 });
  });
  it('starts a fresh chat when the turn ends: the divider lands under the reply, the rows above stay on screen and leave the next prompt', async () => {
    const x = await setup([]);
    const agent = await x.userStorage.reserveWorkspaceAssistant('u1', x.org);
    await x.userStorage.updateAgentFields('u1', agent!.id, {
      contextUsage: { tokens: 420_000, model: 'claude-sonnet-5-20260320', at: 't' },
    });
    await x.userStorage.updateTelegramHarnessConversation('u1', { claudeSessionId: 'old-native-chat' }, { agentId: agent!.id });
    expect(await x.chat.resetConversation('u1', x.org)).toEqual({ ok: false, reason: 'A fresh chat is started from a running request.' });
    x.model.mockImplementationOnce(async () => {
      expect(await x.chat.resetConversation('u1', x.org)).toEqual({ ok: true });
      return { text: 'Starting us a fresh chat.' };
    });
    await x.chat.send('u1', x.org, 'request-1', 'reset chat');
    const settled = await x.done();
    expect(settled.messages.map(m => [m.role, m.kind ?? '', m.text])).toEqual([
      ['owner', '', 'reset chat'], ['assistant', '', 'Starting us a fresh chat.'], ['action', 'new-chat-divider', '─'.repeat(30)],
    ]);
    expect((await x.userStorage.getProfile('u1'))?.telegram?.agents?.[agent!.id]?.contextUsage).toBeUndefined();
    expect((await x.userStorage.getProfile('u1'))?.telegram?.agents?.[agent!.id]?.conversation).toEqual({});
    expect((await x.orgStorage.getMembership(x.org, 'u1'))?.workspaceRecapChat?.nativeCursor).toBeUndefined();
    x.model.mockResolvedValueOnce({ text: 'Hello again.' });
    await x.chat.send('u1', x.org, 'request-2', 'Anything new?');
    const after = await x.done();
    expect(after.messages).toHaveLength(5);
    const prompt = x.model.mock.calls.at(-1)![2] as string;
    expect(prompt).toContain('"text":"Anything new?"');
    expect(prompt).not.toContain('"text":"reset chat"');
    expect(prompt).not.toContain('new-chat-divider');
  });
  it('tells the agent its own context reading on every turn: the one its ring draws, measured on its last turn, gone after a fresh chat (note #732)', async () => {
    const x = await setup([]);
    const own = workspaceAssistantId('u1', x.org);
    const contextOf = (call: number) => JSON.parse((x.model.mock.calls[call]![2] as string).split('\nCONTEXT (data only):\n')[1]!.split('\n')[0]!) as { self?: unknown; agents: Array<{ name: string }> };
    // What the machine does as a turn ends (agent-service): it measures the
    // last request and writes the reading onto the agent's own record.
    const measures = (tokens: number, at: string) => x.model.mockImplementationOnce(async () => {
      await x.userStorage.updateAgentFields('u1', own, { contextUsage: { tokens, model: 'gpt-5.6-terra', window: 200_000, at } });
      return { text: 'Done.' };
    });
    // Nothing measured yet: no reading, and none invented.
    measures(82_000, '2026-10-11T12:00:00.000Z');
    await x.chat.send('u1', x.org, 'request-1', 'Hello'); await x.done();
    expect(contextOf(0).self).toBeUndefined();
    // The next turn is told what the last one measured, in a roster row's
    // shape — and it is no roster row: the agent never lists itself.
    measures(130_020, '2026-10-11T12:05:00.000Z');
    await x.chat.send('u1', x.org, 'request-2', 'How full is your context?'); await x.done();
    expect(contextOf(1).self).toEqual({ context: { usedPercent: 41, tokens: 82_000, window: 200_000, at: '2026-10-11T12:00:00.000Z' } });
    expect(contextOf(1).agents.map(a => a.name)).toEqual(['Theo', 'Other']);
    // Read fresh each turn, never a figure held from an earlier one.
    await x.chat.send('u1', x.org, 'request-3', 'And now?'); await x.done();
    expect(contextOf(2).self).toEqual({ context: { usedPercent: 65, tokens: 130_020, window: 200_000, at: '2026-10-11T12:05:00.000Z' } });
    // The orders say what to do with it: answer from it, and leave the full
    // chat to the platform (note #738) — the person can still ask any time.
    const prompt = x.model.mock.calls[2]![2] as string;
    expect(prompt).toContain('CONTEXT.self.context is your own reading, in the shape of a row\'s `context`');
    expect(prompt).toContain('When CONTEXT carries no self, nothing has been measured since your last fresh chat');
    expect(prompt).toContain('after any turn that ends at 75% or more, the platform asks you for a handoff and starts a fresh chat by itself');
    expect(prompt).toContain('Nothing you follow is lost by a fresh chat: agents\' answers still arrive here and start you');
    expect(prompt).toContain('Below that level, from 40%, suggest a fresh chat in one sentence');
    expect(prompt).toContain('never in an event turn');
    expect(prompt).toContain('you run `agentbuilt chat new` only when they do');
    // The rule that kept it from ever suggesting one on a busy day is gone.
    expect(prompt).not.toContain('Never while something you follow is open');
    expect(prompt).not.toMatch(/67%|90%/);
    // A fresh chat clears the reading with the conversation it measured, so
    // the next turn is told nothing rather than the old conversation's fill.
    x.model.mockImplementationOnce(async () => {
      expect(await x.chat.resetConversation('u1', x.org)).toEqual({ ok: true });
      return { text: 'Starting us a fresh chat.' };
    });
    await x.chat.send('u1', x.org, 'request-4', 'reset chat'); await x.done();
    await x.chat.send('u1', x.org, 'request-5', 'Hello again'); await x.done();
    expect(contextOf(4).self).toBeUndefined();
    // A model whose window this backend does not know: no percentage either.
    await x.userStorage.updateAgentFields('u1', own, { contextUsage: { tokens: 90_000, model: 'some/model-we-never-priced', at: 't' } });
    await x.chat.send('u1', x.org, 'request-6', 'And now?'); await x.done();
    expect(contextOf(5).self).toBeUndefined();
  });
  describe('its own chat starts fresh by itself when a turn ends full (note #738)', () => {
    const own = (x: Awaited<ReturnType<typeof setup>>) => workspaceAssistantId('u1', x.org);
    /** What the machine does as a turn ends (agent-service): the reading of the request it just made. */
    const measure = (x: Awaited<ReturnType<typeof setup>>, tokens: number) => x.userStorage.updateAgentFields('u1', own(x), { contextUsage: { tokens, model: 'gpt-5.6-terra', window: 200_000, at: new Date().toISOString() } });
    const HANDOFF = '- Theo is on note #733 (hide the room briefing): forward his PR when he answers.\n- Adam still owes a decision on PR #1340.';
    it('after a turn that ends at 75% or more: a handoff turn, then the divider and the handoff as the fresh chat\'s first row', async () => {
      const x = await setup([]);
      await x.userStorage.updateTelegramHarnessConversation('u1', { codexThreadId: 'old-thread' }, { agentId: own(x) });
      x.model.mockImplementationOnce(async () => {
        await x.sendFromAgent('theo', 'Hide the room briefing (note #733).');
        await measure(x, 160_000);
        return { text: 'Theo is on it.' };
      });
      x.model.mockImplementationOnce(async () => ({ text: HANDOFF }));
      await x.chat.send('u1', x.org, 'request-1', 'Hide the room briefing');
      const settled = await x.done();
      expect(x.model).toHaveBeenCalledTimes(2);
      // The second turn is the handoff, asked of the same conversation.
      const [, , prompt, , , options] = x.model.mock.calls[1]! as [string, string, string, unknown, unknown, { act?: boolean; attachments?: unknown[]; continuationPrompt?: string }];
      expect(prompt.endsWith(freshChatAsk(80))).toBe(true);
      expect(prompt).toContain('Your chat is 80% full — past 75%, where it starts fresh by itself.');
      expect(options).toMatchObject({ act: true, attachments: [] });
      expect(options.continuationPrompt!.endsWith(freshChatAsk(80))).toBe(true);
      // One line for the person, the handoff behind it, under a divider.
      expect(settled.messages.map(m => [m.role, m.kind ?? '', m.text])).toEqual([
        ['owner', '', 'Hide the room briefing'],
        ['action', '', 'Sent to Theo: Hide the room briefing (note #733).'],
        ['assistant', '', 'Theo is on it.'],
        ['action', 'new-chat-divider', '─'.repeat(30)],
        ['action', '', freshChatRowText(80, HANDOFF)],
      ]);
      expect(recapRowViews(settled.messages).at(-1)).toEqual({ form: 'did', parts: ['Started a fresh chat at 80% full'], body: HANDOFF, own: true });
      expect(settled.working).toBe(false);
      // The old native conversation and its reading go with it.
      const record = (await x.userStorage.getProfile('u1'))?.telegram?.agents?.[own(x)];
      expect(record?.contextUsage).toBeUndefined();
      expect(record?.conversation).toEqual({});
      const member = (await x.orgStorage.getMembership(x.org, 'u1'))!.workspaceRecapChat!;
      expect(member.nativeCursor).toBeUndefined();
      expect(member.freshChat).toBeUndefined();
      // The wait for Theo is the platform's, not the chat's: it survives.
      expect(settled.waiting).toEqual(['Theo']);
      // Theo's answer still reaches the fresh chat and starts it, which
      // starts from the handoff — not from the old conversation.
      x.model.mockImplementationOnce(async () => ({ text: 'Theo\'s PR is above for you.' }));
      expect(await x.answerFrom('a1', 'Done: PR #1347 hides the briefing.')).toMatchObject({ ok: true, reacting: true });
      const after = await x.done();
      expect(x.model).toHaveBeenCalledTimes(3);
      const fresh = x.model.mock.calls[2]![2] as string;
      expect(fresh).toContain(AGENT_REPLY_REACT_ASK);
      expect(fresh).toContain(JSON.stringify(freshChatRowText(80, HANDOFF)));
      expect(fresh).toContain('"text":"Done: PR #1347 hides the briefing."');
      expect(fresh).not.toContain('"text":"Hide the room briefing"');
      expect(after.waiting).toEqual([]);
      expect(after.messages.at(-1)!.text).toBe('Theo\'s PR is above for you.');
    });
    it('not below the level, and not on a reading the turn did not measure', async () => {
      const x = await setup([]);
      x.model.mockImplementationOnce(async () => { await measure(x, 148_000); return { text: 'Done.' }; });
      await x.chat.send('u1', x.org, 'request-1', 'Hello'); await x.done();
      expect(x.model).toHaveBeenCalledTimes(1);
      // A full reading from before the turn — a turn that failed is not
      // measured — is no reason: only what this turn measured is.
      await x.userStorage.updateAgentFields('u1', own(x), { contextUsage: { tokens: 190_000, model: 'gpt-5.6-terra', window: 200_000, at: new Date(Date.now() - 60_000).toISOString() } });
      await x.chat.send('u1', x.org, 'request-2', 'Again'); await x.done();
      expect(x.model).toHaveBeenCalledTimes(2);
      expect((await x.chat.read('u1', x.org)).messages.some(m => m.kind === 'new-chat-divider')).toBe(false);
    });
    it('the person writing during the handoff takes the turn: no fresh chat until a turn ends full again', async () => {
      const x = await setup([]);
      x.model.mockImplementationOnce(async () => { await measure(x, 170_000); return { text: 'Noted.' }; });
      x.model.mockImplementationOnce(untilAborted);
      await x.chat.send('u1', x.org, 'request-1', 'Note this');
      await vi.waitFor(() => expect(x.model).toHaveBeenCalledTimes(2));
      expect((await x.chat.read('u1', x.org)).phase).toBe('Starting a fresh chat…');
      x.model.mockImplementationOnce(async () => ({ text: 'Here is the answer.' }));
      await x.chat.send('u1', x.org, 'request-2', 'One more question');
      const settled = await x.done();
      expect(x.model).toHaveBeenCalledTimes(3);
      const replacement = x.model.mock.calls[2]![2] as string;
      expect(replacement).not.toContain(freshChatAsk(85));
      expect(replacement).toContain('"text":"One more question"');
      expect(settled.messages.some(m => m.kind === 'new-chat-divider')).toBe(false);
      expect(settled.messages.at(-1)!.text).toBe('Here is the answer.');
      expect((await x.orgStorage.getMembership(x.org, 'u1'))!.workspaceRecapChat!.freshChat).toBeUndefined();
    });
    it('an agent\'s answer that lands while the handoff is written is the fresh chat\'s, and its reaction runs there', async () => {
      const x = await setup([]);
      x.model.mockImplementationOnce(async () => {
        await x.sendFromAgent('theo', 'Status?');
        await measure(x, 156_000);
        return { text: 'Asked Theo.' };
      });
      x.model.mockImplementationOnce(async () => {
        await x.answerFrom('a1', 'All green.');
        return { text: HANDOFF };
      });
      x.model.mockImplementationOnce(async () => ({ text: 'Theo says all green.' }));
      await x.chat.send('u1', x.org, 'request-1', 'Ask Theo for a status');
      const settled = await x.done();
      expect(x.model).toHaveBeenCalledTimes(3);
      const rows = settled.messages.map(m => m.kind === 'new-chat-divider' ? '─' : m.text);
      expect(rows.slice(rows.indexOf('─'))).toEqual(['─', freshChatRowText(78, HANDOFF), 'All green.', 'Theo says all green.']);
      const reaction = x.model.mock.calls[2]![2] as string;
      expect(reaction).toContain('"text":"All green."');
      expect(reaction).toContain(JSON.stringify(freshChatRowText(78, HANDOFF)));
      expect(reaction).not.toContain('"text":"Ask Theo for a status"');
    });
    it('a handoff that could not be written changes nothing, and says nothing', async () => {
      const x = await setup([]);
      x.model.mockImplementationOnce(async () => { await measure(x, 180_000); return { text: 'Done.' }; });
      x.model.mockImplementationOnce(async () => ({ failure: 'unavailable' }) as never);
      await x.chat.send('u1', x.org, 'request-1', 'Hello');
      const settled = await x.done();
      expect(x.model).toHaveBeenCalledTimes(2);
      expect(settled.messages.map(m => m.text)).toEqual(['Hello', 'Done.']);
      expect((await x.userStorage.getProfile('u1'))?.telegram?.agents?.[own(x)]?.contextUsage?.tokens).toBe(180_000);
    });
    // Alex's review of PR #1352: a message landing between the reply and the
    // handoff turn found the request over, started a second run loop, and
    // the first loop's exit made the live turn look like a restart orphan.
    for (const [label, tokens] of [['full', 170_000], ['not full', 100_000]] as const) {
      it(`a message landing as the reply is recorded is one ordinary next turn, never a restart orphan (${label})`, async () => {
        const x = await setup([]);
        const read = x.userStorage.getProfile.bind(x.userStorage);
        let armed = false;
        vi.spyOn(x.userStorage, 'getProfile').mockImplementation(async (id: string) => {
          // The first read after the reply: the person writes right then.
          if (armed) { armed = false; void x.chat.send('u1', x.org, 'request-2', 'One more thing'); }
          return read(id);
        });
        // The turn that answers the person takes a while on the machine, and
        // the screen reads the conversation meanwhile. A turn already steered
        // before it reached the machine returns at once, as the real one does.
        let release!: () => void;
        const onMachine = new Promise<void>((resolve) => { release = resolve; });
        let answering = false;
        x.model.mockImplementation(async (...args: unknown[]) => {
          if ((args[5] as TurnOptions).signal!.aborted) return { failure: 'interrupted' } as never;
          answering = true; await onMachine;
          return { text: 'Second answer.' };
        });
        x.model.mockImplementationOnce(async () => { await measure(x, tokens); armed = true; return { text: 'First answer.' }; });
        await x.chat.send('u1', x.org, 'request-1', 'First thing');
        await vi.waitFor(() => expect(answering).toBe(true));
        const meanwhile = await x.chat.read('u1', x.org);
        expect(meanwhile.working).toBe(true);
        expect(x.ended).not.toHaveBeenCalled();
        release();
        await vi.waitFor(async () => expect((await x.chat.read('u1', x.org)).messages.at(-1)?.text).toBe('Second answer.'));
        const settled = await x.done();
        expect(x.ended).not.toHaveBeenCalled();
        expect(settled.messages.some(m => m.text.startsWith('The connection restarted'))).toBe(false);
        expect(settled.messages.map(m => [m.role, m.text])).toEqual([
          ['owner', 'First thing'], ['assistant', 'First answer.'], ['owner', 'One more thing'], ['assistant', 'Second answer.'],
        ]);
        // The person's words took the place of any handoff, and the turn
        // that answered them measured nothing, so no fresh chat yet.
        const answered = x.model.mock.calls.at(-1)![2] as string;
        expect(answered).toContain('"text":"One more thing"');
        expect(answered).not.toContain('where it starts fresh by itself');
        expect(x.model.mock.calls.filter(c => (c[2] as string).endsWith(freshChatAsk(85)) && !(c[5] as TurnOptions).signal!.aborted)).toHaveLength(0);
      });
    }
    it('the request stays running from the reply into the handoff turn: the plate never reads idle in between', async () => {
      const x = await setup([]);
      const seen: boolean[] = [];
      x.model.mockImplementationOnce(async () => { await measure(x, 160_000); return { text: 'Done.' }; });
      x.model.mockImplementationOnce(async () => {
        seen.push((await x.chat.read('u1', x.org)).working);
        return { text: HANDOFF };
      });
      const status = vi.spyOn(x.orgStorage, 'touchMember');
      await x.chat.send('u1', x.org, 'request-1', 'Hello');
      await x.done();
      expect(seen).toEqual([true]);
      // Every write between the reply and the divider kept the request running.
      const states = status.mock.calls.map(c => (c[2] as { workspaceRecapChat?: { running?: string; messages: Array<{ text: string; kind?: string }> } }).workspaceRecapChat).filter(Boolean);
      const reply = states.findIndex(st => st!.messages.some(m => m.text === 'Done.'));
      const divider = states.findIndex(st => st!.messages.some(m => m.kind === 'new-chat-divider'));
      expect(reply).toBeGreaterThanOrEqual(0);
      expect(states.slice(reply, divider).every(st => Boolean(st!.running))).toBe(true);
    });
    it('a chat new run in the handoff turn is that same reset: no second divider after the next turn', async () => {
      const x = await setup([]);
      x.model.mockImplementationOnce(async () => { await measure(x, 160_000); return { text: 'Done.' }; });
      x.model.mockImplementationOnce(async () => {
        expect(await x.chat.resetConversation('u1', x.org)).toEqual({ ok: true });
        return { text: HANDOFF };
      });
      x.model.mockImplementationOnce(async () => ({ text: 'Answer.' }));
      x.model.mockImplementationOnce(async () => ({ text: 'Another answer.' }));
      await x.chat.send('u1', x.org, 'request-1', 'Hello'); await x.done();
      await x.chat.send('u1', x.org, 'request-2', 'Next question'); await x.done();
      await x.chat.send('u1', x.org, 'request-3', 'And another'); await x.done();
      const settled = await x.chat.read('u1', x.org);
      expect(settled.messages.filter(m => m.kind === 'new-chat-divider')).toHaveLength(1);
      // The handoff is still in the window of every turn after it.
      expect(x.model.mock.calls[3]![2] as string).toContain(JSON.stringify(freshChatRowText(80, HANDOFF)));
    });
    it('a handoff turn a restart cut short is closed quietly, never replayed', async () => {
      const x = await setup([]);
      const state = { messages: [{ id: 'm1', role: 'assistant' as const, text: 'Done.', at: new Date().toISOString() }], receipts: [], pending: [], running: 'r1', phase: 'Starting a fresh chat…', freshChat: { percent: 82, through: 'm1' } };
      await x.orgStorage.touchMember(x.org, 'u1', { workspaceRecapChat: state });
      const restarted = new WorkspaceRecapChat(x.deps, x.resolve);
      const answer = await restarted.read('u1', x.org);
      expect(x.ended).toHaveBeenCalledWith('u1', x.org);
      expect(answer.working).toBe(false);
      expect(answer.messages.map(m => m.text)).toEqual(['Done.']);
      expect(x.model).not.toHaveBeenCalled();
    });
  });
  it('records the receipts the CLI routes leave while the turn runs, and none afterwards', async () => {
    const x = await setup([]);
    x.model.mockImplementation(async () => {
      await x.chat.receipt('u1', x.org, 'Proposed page: First', '/workspace/knowledge/first?org=o');
      return { text: 'Proposed [First](/workspace/knowledge/first?org=o).' };
    });
    await x.chat.send('u1', x.org, 'request-page', 'Write a page called First.');
    const answer = await x.done();
    expect(answer.messages.map(m => [m.role, m.text])).toEqual([
      ['owner', 'Write a page called First.'],
      ['action', 'Proposed page: First'],
      ['assistant', 'Proposed [First](/workspace/knowledge/first?org=o).'],
    ]);
    expect(answer.messages[1]?.href).toBe('/workspace/knowledge/first?org=o');
    expect(x.changed).toHaveBeenCalledWith(x.org);
    await x.chat.receipt('u1', x.org, 'Stray', undefined);
    expect((await x.chat.read('u1', x.org)).messages).toHaveLength(3);
  });
  it('no longer shows the note receipts stored before note #623, though the record keeps them', async () => {
    const x = await setup([]);
    x.model.mockImplementation(async () => {
      await x.chat.receipt('u1', x.org, 'Created note: First', '/workspace/notes/1?org=o');
      await x.chat.receipt('u1', x.org, 'Archived note: First', '/workspace/notes/1?org=o');
      return { text: 'Saved [First](/workspace/notes/1?org=o) and put it away.' };
    });
    await x.chat.send('u1', x.org, 'request-note', 'Save a note saying First, then archive it.');
    const answer = await x.done();
    expect(answer.messages.map(m => m.role)).toEqual(['owner', 'assistant']);
    const stored = (await x.orgStorage.getMembership(x.org, 'u1'))?.workspaceRecapChat?.messages ?? [];
    expect(stored.filter(m => m.role === 'action').map(m => m.text)).toEqual(['Created note: First', 'Archived note: First']);
  });
  it('puts a mail confirmation in this conversation while its agent turn is running', async () => {
    const x = await setup([]);
    x.model.mockImplementation(async () => {
      expect(await x.chat.requestMailApproval({
        userId: 'u1', orgId: x.org, approvalId: 'ma_1',
        text: 'Workspace Agent wants to send email. Nothing will be sent until you approve it here.',
      })).toBe(true);
      return { text: 'The email is waiting for your decision here.' };
    });
    await x.chat.send('u1', x.org, 'request-mail', 'Email Ada the update.');
    const answer = await x.done();
    expect(answer.messages.find((message) => message.mailApprovalId === 'ma_1')).toMatchObject({
      role: 'action',
      text: expect.stringContaining('Nothing will be sent'),
    });
    expect(await x.chat.requestMailApproval({
      userId: 'u1', orgId: x.org, approvalId: 'ma_late', text: 'late',
    })).toBe(false);
  });
  it('puts forwarded proposals on one action row of the running turn, as pointers only (note #724)', async () => {
    const x = await setup([]);
    x.model.mockImplementation(async () => {
      expect(await x.chat.forwardProposals({
        userId: 'u1', orgId: x.org, text: 'Forwarded PR #12 in site — Checkout',
        proposals: [{ kind: 'pr', id: 'pr_12' }, { kind: 'knowledge', id: 'kp_3', title: 'not stored' } as never],
      })).toEqual({ landed: true, added: [{ kind: 'pr', id: 'pr_12' }, { kind: 'knowledge', id: 'kp_3' }], alreadyShown: [] });
      return { text: 'Oscar\'s checkout change is ready for you.' };
    });
    await x.chat.send('u1', x.org, 'request-forward', 'Anything waiting on me?');
    const answer = await x.done();
    expect(answer.messages.map((m) => m.role)).toEqual(['owner', 'action', 'assistant']);
    expect(answer.messages[1]).toMatchObject({ role: 'action', text: 'Forwarded PR #12 in site — Checkout', proposals: [{ kind: 'pr', id: 'pr_12' }, { kind: 'knowledge', id: 'kp_3' }] });
    expect(JSON.stringify(answer.messages[1])).not.toContain('not stored');
    expect(await x.chat.forwardProposals({ userId: 'u1', orgId: x.org, text: 'late', proposals: [{ kind: 'pr', id: 'pr_12' }] })).toEqual({ landed: false, added: [], alreadyShown: [] });
  });
  /**
   * Note #752 (Adam, 2026-10-14): an agent's `pr ready` lands its card
   * in the owner's Chief of Staff chat at once — the same pointer row
   * `forward` writes, with no turn — and a proposal is never shown twice.
   */
  describe('a proposal made ready lands here by itself (note #752)', () => {
    const ref = { kind: 'pr' as const, id: 'pr_1378' };
    const text = 'Ada\'s PR #1378 in infinite-agents (Platform) — Room page — is ready for the person\'s decision; its card is in this conversation.';
    it('lands one card in the owner\'s conversation with no turn running, and a second ready of the same proposal adds none', async () => {
      const x = await setup([]);
      expect(await x.chat.proposalReady({ userId: 'u1', orgId: x.org, proposal: ref, text })).toBe('added');
      const answer = await x.chat.read('u1', x.org);
      expect(answer.working).toBe(false);
      expect(answer.messages).toHaveLength(1);
      expect(answer.messages[0]).toMatchObject({ role: 'action', text, proposals: [ref] });
      // Drawn as the card row, never as a grey receipt (note #725).
      expect(recapRowViews(answer.messages)).toEqual([{ form: 'row' }]);
      expect(x.changed).toHaveBeenCalledTimes(1);
      expect(x.model).not.toHaveBeenCalled();

      expect(await x.chat.proposalReady({ userId: 'u1', orgId: x.org, proposal: ref, text })).toBe('already');
      expect((await x.chat.read('u1', x.org)).messages).toHaveLength(1);
      expect(x.changed).toHaveBeenCalledTimes(1);
    });
    it('a later forward of the same proposal adds no second card, and says which were already there', async () => {
      const x = await setup([]);
      await x.chat.proposalReady({ userId: 'u1', orgId: x.org, proposal: ref, text });
      x.model.mockImplementation(async () => {
        expect(await x.chat.forwardProposals({
          userId: 'u1', orgId: x.org,
          proposals: [ref, { kind: 'knowledge', id: 'kp_3' }],
          text: (added) => `Forwarded ${added.map((entry) => entry.id).join('; ')}`,
        })).toEqual({ landed: true, added: [{ kind: 'knowledge', id: 'kp_3' }], alreadyShown: [ref] });
        // Everything already in front of the person: nothing is written.
        expect(await x.chat.forwardProposals({ userId: 'u1', orgId: x.org, proposals: [ref], text: 'Forwarded PR #1378' }))
          .toEqual({ landed: true, added: [], alreadyShown: [ref] });
        return { text: 'Ada\'s Room page change is ready for you, and the page update with it.' };
      });
      await x.chat.send('u1', x.org, 'request-forward', 'Anything waiting on me?');
      const answer = await x.done();
      expect(answer.messages.map((m) => [m.role, m.proposals ?? null])).toEqual([
        ['action', [ref]], ['owner', null], ['action', [{ kind: 'knowledge', id: 'kp_3' }]], ['assistant', null],
      ]);
      expect(answer.messages[2]!.text).toBe('Forwarded kp_3');
      // The next turn reads the card's row as part of the conversation.
      expect(x.model.mock.calls[0]![2] as string).toContain(text);
    });
    it('a teammate\'s proposal lands in the teammate\'s conversation, never in this person\'s; somebody outside the workplace has none', async () => {
      const x = await setup([]);
      expect(await x.chat.proposalReady({ userId: 'u2', orgId: x.org, proposal: ref, text })).toBe('added');
      expect((await x.chat.read('u1', x.org)).messages).toHaveLength(0);
      expect((await x.orgStorage.getMembership(x.org, 'u2'))?.workspaceRecapChat?.messages).toHaveLength(1);
      expect(await x.chat.proposalReady({ userId: 'u9', orgId: x.org, proposal: ref, text })).toBe('none');
      expect((await x.orgStorage.getMembership(x.org, 'u9'))).toBeFalsy();
    });
    it('a fresh chat is a new conversation: a proposal still undecided may be shown in it again', async () => {
      const x = await setup([]);
      await x.chat.proposalReady({ userId: 'u1', orgId: x.org, proposal: ref, text });
      const member = (await x.orgStorage.getMembership(x.org, 'u1'))!;
      const state = member.workspaceRecapChat!;
      state.messages.push({ id: 'divider', role: 'action', text: '---', at: new Date().toISOString(), kind: 'new-chat-divider' });
      await x.orgStorage.touchMember(x.org, 'u1', { workspaceRecapChat: state });
      expect(await x.chat.proposalReady({ userId: 'u1', orgId: x.org, proposal: ref, text })).toBe('added');
      expect((await x.chat.read('u1', x.org)).messages.filter((m) => m.proposals)).toHaveLength(2);
    });
  });
  it('reports the run that produced no words, keeping the actions it completed', async () => {
    const x = await setup([]);
    x.model.mockImplementation(async () => {
      await x.chat.receipt('u1', x.org, 'Archived note: Old reminder');
      return { failure: 'timeout' as const };
    });
    await x.chat.send('u1', x.org, 'request-slow', 'Archive the old reminder.');
    const answer = await x.done();
    expect(answer.messages.map(m => m.role)).toEqual(['owner', 'action', 'assistant']);
    expect(answer.messages.at(-1)?.text).toContain('took too long');
    expect(answer.messages.at(-1)?.text).toContain('recorded above');
    const shown = recapRowViews(answer.messages);
    expect(shown[0]).toEqual({ form: 'row', unfinished: { reason: 'Ran out of time — what was done is above', retry: 'continue' } });
    expect(shown.at(-1)).toEqual({ form: 'hidden' });
  });
  it('sends to an own idle agent; the agent\'s own answer lands as its message and ends the wait, with nothing read from its chat (note #457)', async () => {
    const x = await setup([]);
    x.message.mockImplementation(async () => {
      x.scope.agents[0]!.working = true;
      return { ok: true as const, recipient: { id: 'a1', name: 'Theo', cli: 'codex' } };
    });
    x.model.mockImplementationOnce(async () => {
      const result = await x.sendFromAgent('theo');
      expect(result.ok).toBe(true);
      return { text: 'I asked Theo.' };
    });
    await x.chat.send('u1', x.org, 'request-123', 'Ask Theo for an update'); await x.done();
    expect(x.message).toHaveBeenCalledWith({ userId: 'u1', senderAgentId: 'wa', recipient: 'a1', message: 'What is the status?' });
    expect((await x.chat.read('u1', x.org)).waiting).toEqual(['Theo']);
    // Theo's turn writes progress into his own chat; none of it comes here.
    x.rows.push({ seq: 2, role: 'agent', text: 'Let me look at the booking form first.', at: new Date().toISOString() });
    x.scope.agents[0]!.working = false;
    expect((await x.chat.read('u1', x.org)).messages.some(m => m.role === 'agent')).toBe(false);
    // His final answer, sent by him — outside any running request here. It
    // lands as his message and starts the reaction turn (note #539).
    x.model.mockImplementationOnce(async () => ({ text: 'Theo has the booking form ready.' }));
    expect(await x.answerFrom('a1', '  The booking form is ready.  ')).toEqual({ ok: true, name: 'Workspace Agent', reacting: true });
    await x.done();
    const restarted = new WorkspaceRecapChat(x.deps, x.resolve);
    const answer = await restarted.read('u1', x.org);
    expect(answer.messages.map(m => [m.role, m.text]).slice(-2)).toEqual([
      ['agent', 'The booking form is ready.'], ['assistant', 'Theo has the booking form ready.'],
    ]);
    expect(answer.messages.find(m => m.role === 'agent')).toMatchObject({ name: 'Theo' });
    expect(answer.messages.find(m => m.role === 'action')).toMatchObject({ text: 'Sent to Theo: What is the status?' });
    // Nothing about the other agent carries a door into its own conversation
    // (note #435): its answer is right here.
    expect(answer.messages.some(m => m.href)).toBe(false);
    expect(answer.waiting).toEqual([]);
    expect((restarted as unknown as { deps: { agentLifecycle: { agentChatMessages: ReturnType<typeof vi.fn> } } }).deps.agentLifecycle.agentChatMessages).not.toHaveBeenCalled();
    expect(x.changed).toHaveBeenCalledWith(x.org);
  });
  it('closes the wait when the agent\'s turn ended without an answer here, saying where the details are without a door to them', async () => {
    const x = await setup([]);
    x.message.mockImplementation(async () => {
      x.scope.agents[0]!.working = true;
      return { ok: true as const, recipient: { id: 'a1', name: 'Theo', cli: 'codex' } };
    });
    x.model.mockImplementationOnce(async () => { await x.sendFromAgent('theo'); return { text: 'I asked Theo.' }; });
    await x.chat.send('u1', x.org, 'request-123', 'Ask Theo for an update'); await x.done();
    x.scope.agents[0]!.working = false;
    (x.scope.agents[0]!.record as { lastTurnEndedAt?: string }).lastTurnEndedAt = new Date(Date.now() + 1000).toISOString();
    const answer = await x.chat.read('u1', x.org);
    const closing = answer.messages.filter(m => m.role === 'action').at(-1)!;
    expect(closing.text).toBe('Theo finished without sending a reply here. Its own conversation has the details.');
    expect(closing.href).toBeUndefined();
    expect(recapRowViews(answer.messages)[answer.messages.indexOf(closing)]).toMatchObject({ form: 'attention', door: { to: 'chat', agent: 'Theo' } });
    expect(answer.waiting).toEqual([]);
  });
  it('takes an answer only from the owner\'s own agents of this workplace, and never an empty one', async () => {
    const x = await setup([]);
    expect(await x.answerFrom('nobody', 'Hi')).toMatchObject({ ok: false });
    const profile = (await x.userStorage.getProfile('u1'))!;
    await x.userStorage.updateProfile('u1', { telegram: { ...profile.telegram!, agents: { ...profile.telegram!.agents, purposeful: { id: 'purposeful', name: 'Workspace Agent', cli: 'codex', orgId: x.org, purpose: 'workspace-recap', createdAt: 't' } as never } } });
    expect(await x.answerFrom('purposeful', 'Hi')).toMatchObject({ ok: false });
    expect(await x.answerFrom('a1', '   ')).toMatchObject({ ok: false, reason: 'The answer cannot be empty.' });
    // An answer with no wait open still reaches the person: the agent's later word.
    x.model.mockImplementationOnce(async () => ({ text: 'Noted: the calendar picker is in too.' }));
    expect(await x.answerFrom('a1', 'One more thing: the calendar picker landed too.')).toMatchObject({ ok: true, reacting: true });
    expect((await x.done()).messages.map(m => [m.role, m.text]).slice(-2)).toEqual([
      ['agent', 'One more thing: the calendar picker landed too.'], ['assistant', 'Noted: the calendar picker is in too.'],
    ]);
  });
  it('refuses busy, unknown and other members’ agents, a second pending send, and any send outside a request', async () => {
    const x = await setup([]);
    expect(await x.sendFromAgent('Theo')).toMatchObject({ ok: false, code: 'unavailable' });
    x.model.mockImplementation(async () => {
      expect(await x.sendFromAgent('Other')).toMatchObject({ ok: false, code: 'not_found' });
      expect(await x.sendFromAgent('a2')).toMatchObject({ ok: false, code: 'not_found' });
      expect(await x.sendFromAgent('Nobody')).toMatchObject({ ok: false, code: 'not_found' });
      x.scope.agents[0]!.working = true;
      expect(await x.sendFromAgent('Theo')).toMatchObject({ ok: false, code: 'busy' });
      x.scope.agents[0]!.working = false;
      expect(await x.sendFromAgent('Theo')).toMatchObject({ ok: true });
      expect(await x.sendFromAgent('Theo', 'Again?')).toMatchObject({ ok: false, code: 'busy' });
      return { text: 'One message went to Theo.' };
    });
    await x.chat.send('u1', x.org, 'request-123', 'Ask the agents'); await x.done();
    expect(x.message).toHaveBeenCalledTimes(1);
  });
  it('drops the pending entry when the send itself is refused', async () => {
    const x = await setup([]);
    x.message.mockResolvedValue({ ok: false, code: 'busy', reason: 'Theo is working.' } as never);
    x.model.mockImplementation(async () => {
      expect(await x.sendFromAgent('Theo')).toMatchObject({ ok: false, code: 'busy' });
      return { text: 'Theo is busy; nothing was sent.' };
    });
    await x.chat.send('u1', x.org, 'request-123', 'Ask Theo'); const answer = await x.done();
    expect(answer.waiting).toEqual([]);
    expect(answer.messages.filter(m => m.role === 'action')).toEqual([]);
  });
  it('describes its state for the Home plate', async () => {
    const x = await setup([]);
    expect(await x.chat.status('u1', x.org, false)).toEqual({ name: 'Workspace Agent', started: false, working: false, waiting: [] });
    let release!: () => void;
    x.model.mockImplementation(async (...args: unknown[]) => {
      await (args[4] as (phase: string) => Promise<void>)('Reading notes…');
      await new Promise<void>(resolve => { release = resolve; });
      return { text: 'Done.' };
    });
    await x.chat.send('u1', x.org, 'request-123', 'Hello');
    await vi.waitFor(async () => expect((await x.chat.status('u1', x.org, true)).phase).toBe('Reading notes…'));
    expect(await x.chat.status('u1', x.org, true)).toMatchObject({ started: true, working: true, phase: 'Reading notes…' });
    release();
    const settled = await x.done();
    expect(settled.working).toBe(false);
    expect(await x.chat.status('u1', x.org, true)).toMatchObject({ working: false, lastActiveAt: settled.messages[0]!.at });
  });
  it('carries what the turn is thinking while it runs, and its last reply whole afterwards (note #452)', async () => {
    const x = await setup([]);
    expect(await x.chat.status('u1', x.org, true)).not.toHaveProperty('lastReply');
    let release!: () => void;
    x.model.mockImplementation(async (...args: unknown[]) => {
      const options = args[5] as { onActivity: (activity: string) => Promise<void> };
      await options.onActivity('Bash: agentbuilt note list');
      await new Promise<void>(resolve => { release = resolve; });
      return { text: 'Archived **two** notes.' };
    });
    await x.chat.send('u1', x.org, 'request-1', 'Tidy the notes');
    await vi.waitFor(async () => expect((await x.chat.status('u1', x.org, true)).thinking).toBe('Bash: agentbuilt note list'));
    expect(await x.chat.read('u1', x.org)).toMatchObject({ working: true, thinking: 'Bash: agentbuilt note list' });
    release();
    const settled = await x.done();
    const status = await x.chat.status('u1', x.org, true);
    expect(status).not.toHaveProperty('thinking');
    expect(status.lastReply).toEqual({ text: 'Archived **two** notes.', at: settled.messages.at(-1)!.at });
    expect(settled).not.toHaveProperty('thinking');
    // A thought that lands after the turn was stopped is not this turn's.
    x.model.mockImplementation(untilAborted as never);
    await x.chat.send('u1', x.org, 'request-2', 'Again');
    const options = x.model.mock.calls.at(-1)![5] as { onActivity: (activity: string) => Promise<void> };
    await x.chat.stop('u1', x.org);
    await options.onActivity('Bash: agentbuilt note show 2');
    await x.done();
    expect(await x.chat.status('u1', x.org, true)).not.toHaveProperty('thinking');
  });
  it('closes an interrupted request it cannot name without replaying anything', async () => {
    const x = await setup([]);
    await x.orgStorage.touchMember(x.org, 'u1', { workspaceRecapChat: { messages: [], receipts: ['request-123'], pending: [], running: 'request-123' } });
    const first = (await x.chat.read('u1', x.org)).messages[0]!;
    expect(first.role).toBe('action');
    expect(first.text).toContain('restarted');
    expect((await x.chat.status('u1', x.org, true)).working).toBe(false);
    await x.chat.send('u1', x.org, 'request-123', 'Save the note'); expect(x.model).not.toHaveBeenCalled();
  });
  describe('a request a restart cut short (note #455)', () => {
    const interrupted = async (x: Awaited<ReturnType<typeof setup>>, at: string, actions: string[] = []) => {
      await x.orgStorage.touchMember(x.org, 'u1', { workspaceRecapChat: { messages: [
        { id: 'm1', role: 'owner', text: 'Hand note #454 to Rosa', at },
        ...actions.map((text, i) => ({ id: `a${i}`, role: 'action' as const, text, at })),
      ], receipts: ['request-123'], pending: [], running: 'request-123' } });
    };
    it('names the request, ends the orphaned turn on the machine, and picks a recent one up again with the actions already recorded', async () => {
      const x = await setup(['Sent to Rosa: note #454 is hers.']);
      x.ended.mockResolvedValueOnce('ended');
      await interrupted(x, new Date(Date.now() - 5 * 60_000).toISOString(), ['Read note #454']);
      const answer = await x.chat.read('u1', x.org);
      expect(x.ended).toHaveBeenCalledWith('u1', x.org);
      const notice = answer.messages.filter(m => m.role === 'action').at(-1)!;
      expect(notice.text).toBe('The connection restarted before your request "Hand note #454 to Rosa" finished. The 1 action recorded above already happened. Picking it up again now.');
      // The work carries on, so the person sees nothing of it (note #725).
      expect(recapRowViews(answer.messages)[answer.messages.indexOf(notice)]).toEqual({ form: 'hidden' });
      expect(answer.working).toBe(true);
      const settled = await x.done();
      expect(x.model).toHaveBeenCalledTimes(1);
      const prompt = x.model.mock.calls[0]![2] as string;
      expect(prompt).toContain(RESTART_RESUME_NOTICE);
      expect(prompt).toContain('Answer every owner message after your last reply');
      expect(settled.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Sent to Rosa: note #454 is hers.' });
      // Recovered once: the next read finds a finished request, not another restart.
      expect((await x.chat.read('u1', x.org)).messages.filter(m => m.text.includes('restarted'))).toHaveLength(1);
    });
    it('recovers at boot for every conversation left running, before anyone opens the screen', async () => {
      const x = await setup(['Done after the restart.']);
      await interrupted(x, new Date().toISOString());
      await x.chat.resumeInterrupted();
      const settled = await x.done();
      expect(x.model).toHaveBeenCalledTimes(1);
      expect(settled.messages.map(m => m.role)).toEqual(['owner', 'action', 'assistant']);
    });
    it('asks for the request again when it is too old to pick up safely, saying nothing was recorded for it', async () => {
      const x = await setup([]);
      await interrupted(x, new Date(Date.now() - 2 * 60 * 60_000).toISOString());
      const answer = await x.chat.read('u1', x.org);
      expect(answer.working).toBe(false);
      expect(answer.messages.at(-1)).toMatchObject({ role: 'action', text: 'The connection restarted before your request "Hand note #454 to Rosa" finished, and that was too long ago to pick up safely. Nothing had been recorded for it. Send it again if you still want it done.' });
      // Said under the request instead (note #725).
      const shown = recapRowViews(answer.messages);
      expect(shown.at(-1)).toEqual({ form: 'hidden' });
      expect(shown[answer.messages.findLastIndex(m => m.role === 'owner')]).toEqual({ form: 'row', unfinished: { reason: 'Not finished', retry: 'resend' } });
      expect(x.model).not.toHaveBeenCalled();
    });
    it('does not replay beside a turn its machine could not confirm ended', async () => {
      const x = await setup([]);
      x.ended.mockResolvedValueOnce('unreachable');
      await interrupted(x, new Date().toISOString());
      const answer = await x.chat.read('u1', x.org);
      expect(answer.working).toBe(false);
      expect(answer.messages.at(-1)?.text).toContain('its machine did not answer, so it was not picked up again');
      expect(recapRowViews(answer.messages)[answer.messages.findLastIndex(m => m.role === 'owner')]).toMatchObject({ unfinished: { reason: 'Not finished' } });
      expect(x.model).not.toHaveBeenCalled();
    });
    it('a message sent into the cut-short request steers the replacement turn instead of starting beside it', async () => {
      const x = await setup([]);
      x.model.mockImplementationOnce(untilAborted).mockResolvedValueOnce({ text: 'Both done.' });
      await interrupted(x, new Date().toISOString());
      const answer = await x.chat.send('u1', x.org, 'request-456', 'And tell her it is urgent');
      expect(answer.steered).toBe(true);
      const settled = await x.done();
      expect(x.model).toHaveBeenCalledTimes(2);
      expect(settled.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Both done.' });
    });
  });
  describe('the wait for an agent ends only when its turn is over (notes #455, #457)', () => {
    const asked = async (x: Awaited<ReturnType<typeof setup>>) => {
      x.model.mockImplementationOnce(async () => { await x.sendFromAgent('theo'); return { text: 'I asked Theo.' }; });
      await x.chat.send('u1', x.org, 'request-123', 'Ask Theo for an update'); await x.done();
    };
    it('keeps waiting while the agent merely looks idle — a restart forgets every turn — and reads nothing from its chat', async () => {
      const x = await setup([]);
      await asked(x);
      x.rows.push({ seq: 2, role: 'agent', text: 'Now the fix, in the Workspace Agent\'s conversation:', at: new Date().toISOString() });
      x.scope.agents[0]!.working = false;
      const answer = await x.chat.read('u1', x.org);
      expect(answer.messages.some(m => m.role === 'agent')).toBe(false);
      expect(answer.waiting).toEqual(['Theo']);
    });
    it('closes an idle, unstamped wait once it has been open long enough — an older backend, or a turn dropped at the restart — without saying it finished (note #734)', async () => {
      const x = await setup([]);
      await asked(x);
      const member = (await x.orgStorage.getMembership(x.org, 'u1'))!;
      const state = member.workspaceRecapChat!;
      state.pending[0]!.sentAt = new Date(Date.now() - 11 * 60_000).toISOString();
      await x.orgStorage.touchMember(x.org, 'u1', { workspaceRecapChat: state });
      x.scope.agents[0]!.working = false;
      const answer = await x.chat.read('u1', x.org);
      // No turn-end stamp: nothing says the turn FINISHED, so the row says
      // only what is known.
      expect(answer.messages.at(-1)?.text).toBe('Theo stopped working without sending a reply here; its turn may have been cut short. Its own conversation has the details.');
      expect(recapRowViews(answer.messages).at(-1)).toEqual({ form: 'attention', tone: 'warn', parts: [{ agent: 'Theo' }, ' stopped without answering — its turn may have been cut short'], door: { to: 'chat', agent: 'Theo' } });
      expect(answer.waiting).toEqual([]);
      // Still the one agent an event turn may ask to report, and the
      // no-reply event says the same honest thing.
      expect((await x.orgStorage.getMembership(x.org, 'u1'))!.workspaceRecapChat!.silent).toEqual([{ agentId: 'a1', name: 'Theo', at: expect.any(String), cut: true }]);
    });
    it('says "finished" only when the turn-end stamp says so, after the send (note #734)', async () => {
      const x = await setup([]);
      await asked(x);
      x.scope.agents[0]!.working = false;
      (x.scope.agents[0]!.record as { lastTurnEndedAt?: string }).lastTurnEndedAt = new Date(Date.now() + 1000).toISOString();
      const answer = await x.chat.read('u1', x.org);
      expect(answer.messages.at(-1)?.text).toBe('Theo finished without sending a reply here. Its own conversation has the details.');
      expect(recapRowViews(answer.messages).at(-1)).toMatchObject({ form: 'attention', parts: [{ agent: 'Theo' }, ' finished without answering'] });
      expect((await x.orgStorage.getMembership(x.org, 'u1'))!.workspaceRecapChat!.silent).toEqual([{ agentId: 'a1', name: 'Theo', at: expect.any(String) }]);
    });
    it('does not take a stamp from a turn that ended before the message was sent', async () => {
      const x = await setup([]);
      (x.scope.agents[0]!.record as { lastTurnEndedAt?: string }).lastTurnEndedAt = new Date(Date.now() - 60_000).toISOString();
      await asked(x);
      x.scope.agents[0]!.working = false;
      const answer = await x.chat.read('u1', x.org);
      expect(answer.messages.some(m => m.role === 'agent')).toBe(false);
      expect(answer.waiting).toEqual(['Theo']);
    });
  });
  describe('an agent\'s answer starts a turn, as a sibling\'s message starts an agent (note #539)', () => {
    it('reacts to an answer that arrives with nothing running: the turn reads it and leaves a reply where the person is', async () => {
      const x = await setup([]);
      x.model.mockImplementationOnce(async () => ({ text: 'Theo finished the booking form; nothing is left open.' }));
      expect(await x.answerFrom('a1', 'Done: the booking form is live.')).toEqual({ ok: true, name: 'Workspace Agent', reacting: true });
      // The plate says it is working before the turn lands, as it does for
      // the person's own message.
      expect((await x.chat.read('u1', x.org)).working).toBe(true);
      const settled = await x.done();
      expect(x.model).toHaveBeenCalledTimes(1);
      const prompt = x.model.mock.calls[0]![2] as string;
      expect(prompt).toContain(AGENT_REPLY_REACT_ASK);
      expect(prompt).not.toContain('Answer the newest owner message in the conversation.');
      // The agent's words are in the turn's material, named as the agent's.
      expect(prompt).toContain('"text":"Done: the booking form is live."');
      expect(prompt).toContain('"name":"Theo"');
      expect(settled.messages.map(m => [m.role, m.text])).toEqual([
        ['agent', 'Done: the booking form is live.'],
        ['assistant', 'Theo finished the booking form; nothing is left open.'],
      ]);
      expect(x.changed).toHaveBeenCalledWith(x.org);
    });
    it('tries once more when its machine would not wake for a reaction, and the retry reacts (note #763)', async () => {
      const x = await setup([], { wakeRetryDelayMs: 10 });
      x.model.mockResolvedValueOnce({ failure: 'unavailable', wakeFailed: true, detail: WAKE_FAILED } as never);
      x.model.mockResolvedValueOnce({ text: 'Theo is done; nothing is left open.' });
      expect(await x.answerFrom('a1', 'Done: the booking form is live.')).toMatchObject({ ok: true, reacting: true });
      const settled = await x.done();
      expect(x.model).toHaveBeenCalledTimes(2);
      // The retry is the same reaction, not a bare request.
      expect(x.model.mock.calls[1]![2] as string).toContain(AGENT_REPLY_REACT_ASK);
      expect(settled.messages.map(m => [m.role, m.text])).toEqual([
        ['agent', 'Done: the booking form is live.'],
        ['assistant', 'Theo is done; nothing is left open.'],
      ]);
    });
    it('retries the wake only once: a second refusal ends in the row, as before (note #763)', async () => {
      const x = await setup([], { wakeRetryDelayMs: 10 });
      x.model.mockResolvedValue({ failure: 'unavailable', wakeFailed: true, detail: WAKE_FAILED } as never);
      await x.answerFrom('a1', 'Done: PR #842 is ready.');
      const settled = await x.done();
      expect(x.model).toHaveBeenCalledTimes(2);
      expect(settled.messages.at(-1)).toMatchObject({ role: 'assistant', text: WAKE_FAILED });
    });
    it('does not retry the wake for the person\'s own message: they are told at once, as before (note #763)', async () => {
      const x = await setup([], { wakeRetryDelayMs: 10 });
      x.model.mockResolvedValue({ failure: 'unavailable', wakeFailed: true, detail: WAKE_FAILED } as never);
      await x.chat.send('u1', x.org, 'request-1', 'Plan the launch');
      const settled = await x.done();
      expect(x.model).toHaveBeenCalledTimes(1);
      expect(settled.messages.at(-1)).toMatchObject({ role: 'assistant', text: WAKE_FAILED });
    });
    it('does not retry a reaction whose failure was not the wake (note #763)', async () => {
      const x = await setup([], { wakeRetryDelayMs: 10 });
      x.model.mockResolvedValue({ failure: 'unavailable', detail: 'The platform could not run this turn.' } as never);
      await x.answerFrom('a1', 'Done: PR #842 is ready.');
      await x.done();
      expect(x.model).toHaveBeenCalledTimes(1);
    });
    it('never interrupts the turn already running: it finishes, then one replacement turn reacts to the answer', async () => {
      const x = await setup([]);
      x.model.mockImplementationOnce(async (...args: unknown[]) => {
        await x.sendFromAgent('theo');
        expect(await x.answerFrom('a1', 'Done: PR #842 is ready.')).toMatchObject({ reacting: true });
        // The answer is not a steer: this turn keeps its signal and its words.
        expect((args[5] as TurnOptions).signal!.aborted).toBe(false);
        return { text: 'I asked Theo.' };
      });
      x.model.mockImplementationOnce(async () => ({ text: 'Theo is done: PR #842 is ready for you.' }));
      await x.chat.send('u1', x.org, 'request-1', 'Ask Theo about the branch');
      const settled = await x.done();
      expect(x.model).toHaveBeenCalledTimes(2);
      const second = x.model.mock.calls[1]![2] as string;
      expect(second).toContain(AGENT_REPLY_REACT_ASK);
      expect(second).toContain('"text":"Done: PR #842 is ready."');
      expect(settled.messages.map(m => m.role)).toEqual(['owner', 'action', 'agent', 'assistant', 'assistant']);
      expect(settled.messages.at(-1)?.text).toBe('Theo is done: PR #842 is ready for you.');
      expect(settled.waiting).toEqual([]);
    });
    it('carries no reaction past a stop: the person ended the turn, and the row stays read-only until they write', async () => {
      const x = await setup([]);
      x.model.mockImplementationOnce(async (...args: unknown[]) => {
        await x.answerFrom('a1', 'Done: PR #842 is ready.');
        return untilAborted(...args);
      });
      await x.chat.send('u1', x.org, 'request-1', 'Ask Theo about the branch');
      await vi.waitFor(async () => expect((await x.chat.read('u1', x.org)).messages.some(m => m.role === 'agent')).toBe(true));
      expect(await x.chat.stop('u1', x.org)).toEqual({ stopped: true });
      const settled = await x.done();
      expect(x.model).toHaveBeenCalledTimes(1);
      expect(settled.messages.map(m => [m.role, m.text])).toEqual([
        ['owner', 'Ask Theo about the branch'],
        ['agent', 'Done: PR #842 is ready.'],
        ['action', RECAP_TURN_STOPPED],
      ]);
    });
    it('answers a steered replacement turn and the agent both, under the notice that explains the replacement', async () => {
      const x = await setup([]);
      x.model.mockImplementationOnce(async (...args: unknown[]) => {
        await x.answerFrom('a1', 'Done: PR #842 is ready.');
        return untilAborted(...args);
      });
      x.model.mockImplementationOnce(async () => ({ text: 'Theo is done, and note 12 is archived.' }));
      await x.chat.send('u1', x.org, 'request-1', 'Ask Theo about the branch');
      await vi.waitFor(async () => expect((await x.chat.read('u1', x.org)).messages.some(m => m.role === 'agent')).toBe(true));
      await x.chat.send('u1', x.org, 'request-2', 'And archive note 12');
      await x.done();
      const prompt = x.model.mock.calls[1]![2] as string;
      expect(prompt).toContain(STEERING_RESUME_NOTICE);
      expect(prompt).toContain(AGENT_REPLY_REACT_ASK);
      expect(x.model).toHaveBeenCalledTimes(2);
    });
    it('ends and picks up a reaction turn a restart cut short — it has no owner row, and must not fall through as no request at all', async () => {
      const x = await setup([]);
      x.model.mockImplementationOnce(untilAborted);
      await x.answerFrom('a1', 'Done: PR #842 is ready.');
      await vi.waitFor(() => expect(x.model).toHaveBeenCalledTimes(1));
      // A new process: the run registry is empty, the marker is in storage,
      // and the turn on the machine is still acting with nobody waiting.
      const restarted = new WorkspaceRecapChat(x.deps, x.resolve);
      x.model.mockImplementationOnce(async () => ({ text: 'Theo is done: PR #842 is ready for you.' }));
      const picked = await restarted.read('u1', x.org);
      expect(x.ended).toHaveBeenCalledWith('u1', x.org);
      const notice = picked.messages.filter(m => m.role === 'action').at(-1)!.text;
      expect(notice).toContain('before Theo\'s answer "Done: PR #842 is ready." could be answered here');
      expect(notice).toContain('Picking it up again now.');
      await vi.waitFor(async () => expect((await restarted.read('u1', x.org)).working).toBe(false));
      const prompt = x.model.mock.calls[1]![2] as string;
      expect(prompt).toContain(RESTART_RESUME_NOTICE);
      expect(prompt).toContain(AGENT_REPLY_REACT_ASK);
      expect((await restarted.read('u1', x.org)).messages.at(-1)).toMatchObject({
        role: 'assistant', text: 'Theo is done: PR #842 is ready for you.',
      });
    });
    it('says the answer is above rather than "send it again" when the machine did not answer: nobody sent a reaction to send again', async () => {
      const x = await setup([]);
      x.model.mockImplementationOnce(untilAborted);
      await x.answerFrom('a1', 'Done: PR #842 is ready.');
      await vi.waitFor(() => expect(x.model).toHaveBeenCalledTimes(1));
      x.ended.mockResolvedValueOnce('unreachable');
      const restarted = new WorkspaceRecapChat(x.deps, x.resolve);
      const answer = await restarted.read('u1', x.org);
      const notice = answer.messages.at(-1)!.text;
      expect(notice).toContain('its machine did not answer');
      expect(notice).toContain('The answer is above; ask me about it if it still matters.');
      expect(notice).not.toContain('Send it again');
      expect(recapRowViews(answer.messages).at(-1)).toEqual({ form: 'hidden' });
      expect(answer.working).toBe(false);
      expect(x.model).toHaveBeenCalledTimes(1);
    });
    it('keeps the reaction when an answer lands while the turn is reading the conversation, not only while it is running', async () => {
      const x = await setup([]);
      // The window between the turn's read of the conversation and the clear
      // of its flags: an answer arriving there once had its flag wiped by
      // that clear, and nothing carried the reaction the sender was promised.
      const load = (x.chat as unknown as { load: (u: string, o: string) => Promise<unknown> }).load.bind(x.chat);
      let raced = false;
      (x.chat as unknown as { load: (u: string, o: string) => Promise<unknown> }).load = async (u: string, o: string) => {
        const current = await load(u, o);
        if (!raced && x.model.mock.calls.length === 1) {
          raced = true;
          void x.answerFrom('a1', 'Done: PR #842 is ready.');
          await new Promise(resolve => setTimeout(resolve, 30));
        }
        return current;
      };
      x.model.mockImplementationOnce(untilAborted);
      x.model.mockImplementationOnce(async () => ({ text: 'Archived 12 — and Theo is done.' }));
      await x.chat.send('u1', x.org, 'request-1', 'Archive note 12');
      await vi.waitFor(() => expect(x.model).toHaveBeenCalledTimes(1));
      await x.chat.send('u1', x.org, 'request-2', 'And keep note 13');
      const settled = await x.done();
      expect(x.model).toHaveBeenCalledTimes(2);
      const prompt = x.model.mock.calls[1]![2] as string;
      expect(prompt).toContain(AGENT_REPLY_REACT_ASK);
      expect(prompt).toContain('"text":"Done: PR #842 is ready."');
      // One reaction, one reply: the agent's row is answered by the same
      // replacement turn the steer produced, not left for nobody.
      expect(settled.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Archived 12 — and Theo is done.' });
      expect(settled.messages.filter(m => m.role === 'agent')).toHaveLength(1);
      expect(settled.messages.filter(m => m.role === 'assistant')).toHaveLength(1);
    });
    it('drops a reaction rather than carrying it past a fresh chat, where its row would be out of the window', async () => {
      const x = await setup([]);
      x.model.mockImplementationOnce(async () => {
        expect(await x.chat.resetConversation('u1', x.org)).toEqual({ ok: true });
        await x.answerFrom('a1', 'Done: PR #842 is ready.');
        return { text: 'Starting us a fresh chat.' };
      });
      await x.chat.send('u1', x.org, 'request-1', 'reset chat');
      const settled = await x.done();
      expect(x.model).toHaveBeenCalledTimes(1);
      expect(settled.messages.map(m => [m.role, m.kind ?? ''])).toEqual([
        ['owner', ''], ['agent', ''], ['assistant', ''], ['action', 'new-chat-divider'],
      ]);
      expect((await x.orgStorage.getMembership(x.org, 'u1'))?.workspaceRecapChat?.agentReplied).toBeUndefined();
    });
    it('starts nothing when the person has never started their Workspace Agent: the row lands and no machine is provisioned', async () => {
      const x = await setup([]);
      await x.neverStarted();
      expect(await x.answerFrom('a1', 'Done: the booking form is live.')).toEqual({ ok: true, name: 'Workspace Agent', reacting: false });
      const answer = await x.chat.read('u1', x.org);
      expect(answer.working).toBe(false);
      expect(answer.messages.map(m => [m.role, m.text])).toEqual([['agent', 'Done: the booking form is live.']]);
      expect(x.model).not.toHaveBeenCalled();
    });
  });
});

describe('the orchestrator verbs (note #710)', () => {
  it('asks an idle own agent for a fresh chat through the owner\'s own door, and refuses a working one, an awaited one, itself, a teammate\'s and a stranger', async () => {
    const x = await setup([]);
    // Outside a request of the person nothing is sent.
    expect(await x.resetFromAgent('Theo')).toMatchObject({ ok: false, code: 'unavailable' });
    expect(x.fromUser).not.toHaveBeenCalled();
    x.model.mockImplementation(async () => {
      expect(await x.resetFromAgent('theo')).toEqual({ ok: true, name: 'Theo' });
      expect(x.fromUser).toHaveBeenCalledWith({ userId: 'u1', agentId: 'a1', message: 'reset chat' });
      expect(await x.resetFromAgent('Workspace Agent')).toMatchObject({ ok: false, code: 'self' });
      expect(await x.resetFromAgent('Other')).toMatchObject({ ok: false, code: 'not_own' });
      expect(await x.resetFromAgent('Nobody')).toMatchObject({ ok: false, code: 'not_found' });
      x.scope.agents[0]!.working = true;
      expect(await x.resetFromAgent('Theo')).toMatchObject({ ok: false, code: 'busy' });
      x.scope.agents[0]!.working = false;
      // The door itself may find it busy: the same refusal, nothing queued.
      x.fromUser.mockResolvedValueOnce({ ok: false, code: 'busy', reason: 'Theo is working.' } as never);
      expect(await x.resetFromAgent('Theo')).toMatchObject({ ok: false, code: 'busy' });
      // An answer still owed: the fresh chat would never send it.
      await x.sendFromAgent('Theo');
      expect(await x.resetFromAgent('Theo')).toMatchObject({ ok: false, code: 'awaited' });
      return { text: 'Theo starts fresh.' };
    });
    await x.chat.send('u1', x.org, 'request-1', 'Give Theo a fresh chat');
    const settled = await x.done();
    expect(x.fromUser).toHaveBeenCalledTimes(2);
    expect(settled.messages.filter(m => m.role === 'action').map(m => m.text)).toEqual(['Asked Theo for a fresh chat.', 'Sent to Theo: What is the status?']);
    expect(recapRowViews(settled.messages).filter(v => v.form === 'did')).toEqual([{ form: 'did', parts: ['Sent to ', { agent: 'Theo' }, ' · fresh chat first'], body: 'What is the status?' }]);
    expect(x.changed).toHaveBeenCalledWith(x.org);
  });
  it('asks the person to remove an own agent: the record is flagged with who, when and why, nothing is removed, and the refusals match', async () => {
    const x = await setup([]);
    expect(await x.removeFromAgent('Theo')).toMatchObject({ ok: false, code: 'unavailable' });
    x.model.mockImplementation(async () => {
      expect(await x.removeFromAgent('a1', '  its work is finished.  ')).toEqual({ ok: true, name: 'Theo' });
      expect(await x.removeFromAgent('Workspace Agent')).toMatchObject({ ok: false, code: 'self' });
      expect(await x.removeFromAgent('Other')).toMatchObject({ ok: false, code: 'not_own' });
      expect(await x.removeFromAgent('Nobody')).toMatchObject({ ok: false, code: 'not_found' });
      expect(await x.removeFromAgent('Theo', 'x'.repeat(501))).toMatchObject({ ok: false, code: 'unavailable' });
      return { text: 'Asked you to remove Theo.' };
    });
    await x.chat.send('u1', x.org, 'request-1', 'Remove Theo');
    const settled = await x.done();
    const record = (await x.userStorage.getProfile('u1'))!.telegram!.agents!.a1!;
    expect(record.removeAsk).toEqual({ byAgentId: workspaceAssistantId('u1', x.org), byUserId: 'u1', at: expect.any(String), reason: 'its work is finished.' });
    expect(settled.messages.filter(m => m.role === 'action').map(m => m.text)).toEqual(['Asked the person to remove Theo: its work is finished.']);
    expect(recapRowViews(settled.messages)).toContainEqual({ form: 'remove-agent', agent: 'Theo', reason: 'its work is finished' });
  });
});

describe('agentbuilt agent model (note #776): the picker on an agent\'s screen, used for the person', () => {
  const record = async (x: Awaited<ReturnType<typeof setup>>) => (await x.userStorage.getProfile('u1'))!.telegram!.agents!.a1!;
  it('changes an idle own agent\'s model by the picker\'s rule, leaves a row in its chat naming the Workspace Agent, marks its next turn, and says what it runs on now', async () => {
    const x = await setup([]);
    // Outside a request of the person nothing is changed.
    expect(await x.modelFromAgent('Theo', { model: 'gpt-6-luna' })).toMatchObject({ ok: false, code: 'unavailable' });
    x.model.mockImplementation(async () => {
      // Case-blind, as on create; a model alone keeps the effort the new model offers.
      expect(await x.modelFromAgent('theo', { model: ' GPT-6-Luna ' })).toEqual({
        ok: true, name: 'Theo', cli: 'codex', model: 'gpt-6-luna', effort: 'high',
        was: { model: 'gpt-6.1-sol', effort: 'high' }, changed: true, working: false,
      });
      return { text: 'Theo now runs on GPT-6 Luna.' };
    });
    await x.chat.send('u1', x.org, 'request-1', 'Put Theo on luna');
    const settled = await x.done();
    expect(await record(x)).toMatchObject({ model: 'gpt-6-luna', runtimeChange: { by: 'workspace-agent', at: expect.any(String) } });
    expect((await record(x)).effort).toBeUndefined();
    expect(x.platformRow).toHaveBeenCalledWith('u1', 'a1', 'Model changed by Workspace Agent: gpt-6-luna at high effort, from the next turn.');
    expect(settled.messages.filter(m => m.role === 'action').map(m => m.text)).toEqual(['Set Theo to gpt-6-luna at high effort.']);
    expect(recapRowViews(settled.messages).filter(v => v.form === 'did')).toEqual([{ form: 'did', parts: ['Set ', { agent: 'Theo' }, ' to gpt-6-luna at high effort'] }]);
    expect(x.changed).toHaveBeenCalledWith(x.org);
  });
  it('puts a Codex agent on GPT-6.1 Terra at any rung of its ladder, ultra included (note #930)', async () => {
    const x = await setup([]);
    x.model.mockImplementation(async () => {
      expect(await x.modelFromAgent('Theo', { model: 'GPT-6.1-Terra', effort: 'ultra' })).toEqual({
        ok: true, name: 'Theo', cli: 'codex', model: 'gpt-6.1-terra', effort: 'ultra',
        was: { model: 'gpt-6.1-sol', effort: 'high' }, changed: true, working: false,
      });
      return { text: 'Theo now runs on GPT-6.1 Terra.' };
    });
    await x.chat.send('u1', x.org, 'request-1', 'Put Theo on terra at ultra');
    await x.done();
    expect(await record(x)).toMatchObject({ model: 'gpt-6.1-terra', effort: 'ultra' });
    expect(x.platformRow).toHaveBeenCalledWith('u1', 'a1', 'Model and effort changed by Workspace Agent: gpt-6.1-terra at ultra effort, from the next turn.');
  });
  it('refuses a model or an effort the agent\'s harness or model does not offer, with the list it does offer, and changes nothing', async () => {
    const x = await setup([]);
    x.model.mockImplementation(async () => {
      const codexModels = TELEGRAM_CODEX_MODEL_CATALOG.map(entry => entry.value).join(', ');
      const opus = await x.modelFromAgent('Theo', { model: 'opus' });
      expect(opus).toMatchObject({ ok: false, code: 'refused' });
      expect(opus.ok ? '' : opus.reason).toBe(`Nothing was changed: "opus" is not a model Theo can use — it is a Codex agent. Choose one of: ${codexModels}. It is a Claude Code model, and an agent's harness is chosen when it is created and never changes.`);
      const haiku = await x.modelFromAgent('Theo', { model: 'haiku' });
      expect(haiku.ok ? '' : haiku.reason).toBe(`Nothing was changed: "haiku" is not a model Theo can use — it is a Codex agent. Choose one of: ${codexModels}.`);
      // An effort alone is judged against the model it runs on now; with a model, against that one.
      const solLevels = TELEGRAM_CODEX_MODEL_CATALOG.find(entry => entry.value === 'gpt-6.1-sol')!.efforts.map(level => level.value).join(', ');
      const low = await x.modelFromAgent('Theo', { effort: 'low' });
      expect(low.ok ? '' : low.reason).toBe(`Nothing was changed: "low" is not an effort gpt-6.1-sol offers. Choose one of: ${solLevels}.`);
      const ultra = await x.modelFromAgent('Theo', { model: 'gpt-5.5', effort: 'ultra' });
      expect(ultra.ok ? '' : ultra.reason).toBe('Nothing was changed: "ultra" is not an effort gpt-5.5 offers. Choose one of: medium, high, xhigh.');
      return { text: 'Theo cannot run on that.' };
    });
    await x.chat.send('u1', x.org, 'request-1', 'Put Theo on opus');
    const settled = await x.done();
    expect((await record(x)).model).toBeUndefined();
    expect((await record(x)).runtimeChange).toBeUndefined();
    expect(x.platformRow).not.toHaveBeenCalled();
    expect(settled.messages.filter(m => m.role === 'action')).toEqual([]);
  });
  it('changes a working agent too: the answer says a turn is finishing on the old pair, and the new one is written for its next turn', async () => {
    const x = await setup([]);
    x.scope.agents[0]!.working = true;
    x.model.mockImplementation(async () => {
      expect(await x.modelFromAgent('a1', { model: 'gpt-5.5', effort: 'XHIGH' })).toEqual({
        ok: true, name: 'Theo', cli: 'codex', model: 'gpt-5.5', effort: 'xhigh',
        was: { model: 'gpt-6.1-sol', effort: 'high' }, changed: true, working: true,
      });
      return { text: 'Theo moves to GPT-5.5 after this turn.' };
    });
    await x.chat.send('u1', x.org, 'request-1', 'Theo should use gpt-5.5 at extra high');
    await x.done();
    expect(await record(x)).toMatchObject({ model: 'gpt-5.5', effort: 'xhigh' });
    expect(x.platformRow).toHaveBeenCalledWith('u1', 'a1', 'Model and effort changed by Workspace Agent: gpt-5.5 at xhigh effort, from the next turn.');
  });
  it('acts only on the person\'s own agents: a teammate\'s, itself and a stranger are refused, and the pair it already runs on changes nothing', async () => {
    const x = await setup([]);
    x.model.mockImplementation(async () => {
      expect(await x.modelFromAgent('Other', { effort: 'medium' })).toMatchObject({ ok: false, code: 'not_own', reason: expect.stringContaining('a teammate\'s agent') });
      expect(await x.modelFromAgent('Workspace Agent', { effort: 'medium' })).toMatchObject({ ok: false, code: 'self' });
      expect(await x.modelFromAgent('Nobody', { effort: 'medium' })).toMatchObject({ ok: false, code: 'not_found' });
      expect(await x.modelFromAgent('Theo', { model: 'gpt-6.1-sol', effort: 'high' })).toMatchObject({ ok: true, changed: false, model: 'gpt-6.1-sol', effort: 'high' });
      return { text: 'Nothing to change.' };
    });
    await x.chat.send('u1', x.org, 'request-1', 'Make Other think less');
    const settled = await x.done();
    expect((await x.userStorage.getProfile('u1'))!.telegram!.agents!.a1!.runtimeChange).toBeUndefined();
    expect(x.platformRow).not.toHaveBeenCalled();
    expect(settled.messages.filter(m => m.role === 'action')).toEqual([]);
  });
  it('is never one of the standing permissions: an event turn is refused it', () => {
    expect(eventTurnPermissionFor('POST', '/agents/model')).toBeNull();
  });
});

describe('Event turns and standing permissions (note #716): the Chief of Staff on its own', () => {
  const red: WorkspaceAgentEvent = { kind: 'checks-red', key: 'checks-red:pr1:abc', text: 'Checks failed on proposal #4 "Booking page" by Theo: ci/checks.', at: '2026-10-11T08:00:00.000Z', href: '/workspace/prs/pr1' };
  const waiting: WorkspaceAgentEvent = { kind: 'proposal-waiting', key: 'proposal-waiting:pr2:2026-10-11', text: 'Proposal #5 "Pricing copy" by Theo has waited 2 days for your decision.', at: '2026-10-09T08:00:00.000Z' };
  const permit = async (x: Awaited<ReturnType<typeof setup>>, permissions: Partial<typeof DEFAULT_WORKSPACE_AGENT_PROACTIVE.permissions>) => {
    await x.orgStorage.touchMember(x.org, 'u1', { workspaceAgentProactive: { ...DEFAULT_WORKSPACE_AGENT_PROACTIVE, events: true, permissions: { ...DEFAULT_WORKSPACE_AGENT_PROACTIVE.permissions, ...permissions } } });
  };
  const events = (x: Awaited<ReturnType<typeof setup>>, list: WorkspaceAgentEvent[]) => x.chat.receiveEvents({ userId: 'u1', orgId: x.org, events: list });

  it('reads the quiet word however the model dressed it, and only that', () => {
    expect(quietLine(`${EVENT_QUIET}: #4 is already being fixed by Theo.`)).toBe('#4 is already being fixed by Theo.');
    expect(quietLine(`**${EVENT_QUIET}** — nothing needs them`)).toBe('nothing needs them');
    expect(quietLine(EVENT_QUIET)).toBe('');
    expect(quietLine('Checks failed on #4. Quiet hours are over.')).toBeNull();
    expect(eventTurnPermissionFor('POST', '/agents/reset')).toBe('reset-finished-agent');
    expect(eventTurnPermissionFor('POST', '/notes/12/hand')).toBe('hand-unclaimed-note');
    expect(eventTurnPermissionFor('POST', '/agents/messages')).toBe('ask-silent-agent');
    expect(eventTurnPermissionFor('POST', '/notes/12/archive')).toBe('archive-finished-note');
    expect(eventTurnPermissionFor('POST', '/notes')).toBeNull();
    expect(eventTurnPermissionFor('POST', '/mail/send')).toBeNull();
    expect(eventTurnPermissionFor('POST', '/forward')).toBe('always');
  });

  it('starts ONE event turn for what it noticed, under the event ask that names the person\'s permissions; a quiet answer leaves nothing on screen', async () => {
    const x = await setup([`${EVENT_QUIET}: #4 is Theo's and he is on it; #5 waits on Adam, who saw it this morning.`]);
    await permit(x, { 'reset-finished-agent': true });
    expect(await events(x, [red, waiting])).toBe(true);
    const settled = await x.done();
    expect(x.model).toHaveBeenCalledTimes(1);
    const prompt = x.model.mock.calls[0]![2] as string;
    expect(prompt).toContain('This is an EVENT TURN. The person has not written');
    expect(prompt).toContain('reset a finished agent’s chat (when its work is merged or live, nothing is open and no reply is awaited)');
    expect(prompt).not.toContain('hand an unclaimed note');
    expect(prompt).toContain('"turn":"event"');
    expect(prompt).toContain('Checks failed on proposal #4');
    expect(prompt).toContain('has waited 2 days for your decision');
    // Nothing drawn: the events and the quiet line stay in the record, off the screen.
    expect(settled.messages).toEqual([]);
    expect((await x.chat.status('u1', x.org, true)).lastReply).toBeUndefined();
    expect(await x.chat.eventHistory('u1', x.org)).toEqual([{
      at: expect.any(String), noticed: [red.text, waiting.text], outcome: 'quiet',
      summary: '#4 is Theo\'s and he is on it; #5 waits on Adam, who saw it this morning.', actions: 0,
    }]);
    // The next ordinary request reads them, so the agent knows what it already noticed.
    await x.chat.send('u1', x.org, 'request-1', 'Anything new?');
    await x.done();
    const next = (x.model.mock.calls[1]![5] as { continuationPrompt?: string }).continuationPrompt ?? (x.model.mock.calls[1]![2] as string);
    expect(next).toContain('Answer the newest owner message');
    expect(next).not.toContain('This is an EVENT TURN');
  });

  it('tells the person when it must: the reply is drawn under the events it noticed, and the window lists it as told', async () => {
    const x = await setup(['Checks failed on #4 and Theo has gone idle. Shall I ask him to look?']);
    await permit(x, {});
    await events(x, [red]);
    const settled = await x.done();
    expect(settled.messages.map(m => [m.role, m.text])).toEqual([
      ['action', red.text],
      ['assistant', 'Checks failed on #4 and Theo has gone idle. Shall I ask him to look?'],
    ]);
    expect(settled.messages[0]).toMatchObject({ kind: 'event', href: '/workspace/prs/pr1' });
    expect((x.model.mock.calls[0]![2] as string)).toContain('The person has given you no standing permissions, so change nothing.');
    expect((await x.chat.eventHistory('u1', x.org))[0]).toMatchObject({ outcome: 'told', actions: 0 });
  });

  it('fences the event turn: only a standing permission the person switched on passes, and nothing is fenced outside it', async () => {
    const x = await setup([]);
    await permit(x, { 'reset-finished-agent': false, 'archive-finished-note': true });
    const seen: Array<string | null> = [];
    x.model.mockImplementationOnce(async () => {
      seen.push(await x.chat.eventTurnRefusal('u1', x.org, 'POST', '/notes'));
      seen.push(await x.chat.eventTurnRefusal('u1', x.org, 'POST', '/agents/reset'));
      seen.push(await x.chat.eventTurnRefusal('u1', x.org, 'POST', '/notes/7/archive'));
      seen.push(await x.chat.eventTurnRefusal('u1', x.org, 'PUT', '/task'));
      expect(await x.chat.isEventTurn('u1', x.org)).toBe(true);
      return { text: `${EVENT_QUIET}: nothing.` };
    });
    await events(x, [waiting]);
    await x.done();
    expect(seen[0]).toMatch(/^This is an event turn — the person did not write — so this waits for them/);
    expect(seen[1]).toContain('"Reset a finished agent’s chat" is switched off');
    expect(seen.slice(2)).toEqual([null, null]);
    // After it, and in a turn the person asked for, nothing is fenced.
    expect(await x.chat.eventTurnRefusal('u1', x.org, 'POST', '/notes')).toBeNull();
    x.model.mockImplementationOnce(async () => {
      seen.push(await x.chat.eventTurnRefusal('u1', x.org, 'POST', '/notes'));
      return { text: 'Written.' };
    });
    await x.chat.send('u1', x.org, 'request-1', 'Write a note');
    await x.done();
    expect(seen.at(-1)).toBeNull();
  });

  it('acting on its own leaves the events on screen above receipts that say so, even when the answer is quiet', async () => {
    const x = await setup([]);
    await permit(x, { 'reset-finished-agent': true });
    x.model.mockImplementationOnce(async () => {
      expect(await x.resetFromAgent('Theo')).toEqual({ ok: true, name: 'Theo' });
      return { text: `${EVENT_QUIET}: Theo's work is merged; asked him for a fresh chat.` };
    });
    await events(x, [{ kind: 'report-unanswered', key: 'report-unanswered:a1:9', text: 'Theo reported "Merged and live." 2 days ago, and you have not answered in its chat.', at: 't' }]);
    const settled = await x.done();
    expect(settled.messages.map(m => [m.role, m.text])).toEqual([
      ['action', 'Theo reported "Merged and live." 2 days ago, and you have not answered in its chat.'],
      ['action', 'On its own: asked Theo for a fresh chat.'],
    ]);
    expect((await x.chat.eventHistory('u1', x.org))[0]).toMatchObject({ outcome: 'quiet', actions: 1 });
  });

  it('in an event turn it may message only an agent that finished without answering it', async () => {
    const x = await setup([]);
    await permit(x, { 'ask-silent-agent': true });
    const member = (await x.orgStorage.getMembership(x.org, 'u1'))!;
    await x.orgStorage.touchMember(x.org, 'u1', { workspaceRecapChat: { messages: [], receipts: [], pending: [], ...member.workspaceRecapChat, silent: [{ agentId: 'a1', name: 'Theo', at: new Date().toISOString() }] } });
    x.model.mockImplementationOnce(async () => {
      expect(await x.sendFromAgent('Theo', 'Did the deploy finish?')).toMatchObject({ ok: true });
      return { text: `${EVENT_QUIET}: asked Theo.` };
    });
    await events(x, [{ kind: 'no-reply', key: 'no-reply:a1:t', text: 'Theo finished without sending back the answer the Chief of Staff was waiting for.', at: 't' }]);
    const settled = await x.done();
    expect(settled.messages.map(m => m.text)).toContain('On its own: sent to Theo: Did the deploy finish?');
    expect(recapRowViews(settled.messages)).toContainEqual({ form: 'did', parts: ['Sent to ', { agent: 'Theo' }], body: 'Did the deploy finish?', own: true });
    // Asked once: Theo is no longer a door, and a second event turn may not message him.
    x.model.mockImplementationOnce(async () => {
      expect(await x.sendFromAgent('Theo', 'Again?')).toMatchObject({ ok: false, code: 'unavailable', reason: expect.stringContaining('you may message only an agent that finished without answering you') });
      return { text: `${EVENT_QUIET}: nothing.` };
    });
    await events(x, [waiting]);
    await x.done();
    expect(x.message).toHaveBeenCalledTimes(1);
  });

  it('the person writing during an event turn takes it over: the replacement turn is theirs, unfenced, and the events stay on screen', async () => {
    const x = await setup([]);
    await permit(x, {});
    const seen: Array<string | null> = [];
    x.model.mockImplementationOnce(untilAborted);
    x.model.mockImplementationOnce(async () => { seen.push(await x.chat.eventTurnRefusal('u1', x.org, 'POST', '/notes')); return { text: 'Theo is fixing #4; the build broke on a flaky test.' }; });
    await events(x, [red]);
    await vi.waitFor(() => expect(x.model).toHaveBeenCalledTimes(1));
    expect((await x.chat.send('u1', x.org, 'request-1', 'What is going on with #4?')).steered).toBe(true);
    const settled = await x.done();
    expect(seen).toEqual([null]);
    expect(x.model.mock.calls[1]![2] as string).not.toContain('This is an EVENT TURN');
    expect(settled.messages.map(m => [m.role, m.text])).toEqual([
      ['action', red.text],
      ['owner', 'What is going on with #4?'],
      ['assistant', 'Theo is fixing #4; the build broke on a flaky test.'],
    ]);
  });

  it('an ask made on its own motion that goes unanswered is not asked again by itself — no loop on a silent agent', async () => {
    const x = await setup([]);
    await permit(x, { 'ask-silent-agent': true });
    const member = (await x.orgStorage.getMembership(x.org, 'u1'))!;
    await x.orgStorage.touchMember(x.org, 'u1', { workspaceRecapChat: { messages: [], receipts: [], pending: [], ...member.workspaceRecapChat, silent: [{ agentId: 'a1', name: 'Theo', at: new Date().toISOString() }] } });
    x.model.mockImplementationOnce(async () => {
      expect(await x.sendFromAgent('Theo', 'Did the deploy finish?')).toMatchObject({ ok: true });
      return { text: `${EVENT_QUIET}: asked Theo.` };
    });
    await events(x, [{ kind: 'no-reply', key: 'no-reply:a1:d', text: 'Theo finished without sending back the answer the Chief of Staff was waiting for.', at: 't' }]);
    await x.done();
    expect((await x.orgStorage.getMembership(x.org, 'u1'))!.workspaceRecapChat!.pending).toEqual([expect.objectContaining({ agentId: 'a1', fromEvent: true })]);
    // Theo finishes without answering THAT ask: the wait closes, and Theo is not made a door again.
    (x.scope.agents[0]!.record as { lastTurnEndedAt?: string }).lastTurnEndedAt = new Date(Date.now() + 1000).toISOString();
    const settled = await x.chat.read('u1', x.org);
    expect(settled.messages.at(-1)!.text).toBe('Theo finished without sending a reply here. Its own conversation has the details.');
    expect((await x.orgStorage.getMembership(x.org, 'u1'))!.workspaceRecapChat!.silent).toEqual([]);
  });

  it('the answer to an ask made on its own motion is reacted to behind the same fence; one the person asked for is not', async () => {
    const x = await setup([]);
    await permit(x, { 'ask-silent-agent': true });
    const member = (await x.orgStorage.getMembership(x.org, 'u1'))!;
    await x.orgStorage.touchMember(x.org, 'u1', { workspaceRecapChat: { messages: [], receipts: [], pending: [], ...member.workspaceRecapChat, silent: [{ agentId: 'a1', name: 'Theo', at: new Date().toISOString() }] } });
    x.model.mockImplementationOnce(async () => {
      await x.sendFromAgent('Theo', 'Did the deploy finish?');
      return { text: `${EVENT_QUIET}: asked Theo.` };
    });
    await events(x, [{ kind: 'no-reply', key: 'no-reply:a1:d', text: 'Theo finished without sending back the answer the Chief of Staff was waiting for.', at: 't' }]);
    await x.done();
    const fenced: Array<string | null> = [];
    x.model.mockImplementationOnce(async () => {
      fenced.push(await x.chat.eventTurnRefusal('u1', x.org, 'POST', '/notes'));
      return { text: `${EVENT_QUIET}: Theo says the deploy finished.` };
    });
    expect(await x.answerFrom('a1', 'Yes — deployed at 09:10.')).toMatchObject({ ok: true, reacting: true });
    const settled = await x.done();
    const prompt = x.model.mock.calls[1]![2] as string;
    expect(prompt).toContain(AGENT_REPLY_REACT_ASK);
    expect(prompt).toContain('this is still an event turn');
    expect(fenced[0]).toMatch(/^This is an event turn/);
    // The event above the receipt stays (the turn acted); the reaction itself was quiet.
    expect(settled.messages.map(m => m.text)).toEqual([
      'Theo finished without sending back the answer the Chief of Staff was waiting for.',
      'On its own: sent to Theo: Did the deploy finish?',
      'Yes — deployed at 09:10.',
    ]);
    // An answer to the person's own request reacts unfenced, as before.
    x.model.mockImplementationOnce(async () => { await x.sendFromAgent('Theo', 'Ship the copy fix'); return { text: 'Asked Theo.' }; });
    await x.chat.send('u1', x.org, 'request-1', 'Ask Theo to ship the copy fix');
    await x.done();
    x.model.mockImplementationOnce(async () => { fenced.push(await x.chat.eventTurnRefusal('u1', x.org, 'POST', '/notes')); return { text: 'Theo shipped it.' }; });
    await x.answerFrom('a1', 'Shipped.');
    await x.done();
    expect(fenced[1]).toBeNull();
  });

  it('a reply that settles events is their outcome even when the person took the turn over, and a stop is no action', async () => {
    const x = await setup([]);
    await permit(x, {});
    x.model.mockImplementationOnce(untilAborted);
    x.model.mockImplementationOnce(async () => ({ text: 'Theo is fixing #4.' }));
    await events(x, [red]);
    await vi.waitFor(() => expect(x.model).toHaveBeenCalledTimes(1));
    await x.chat.send('u1', x.org, 'request-1', 'What is going on with #4?');
    await x.done();
    expect((await x.chat.eventHistory('u1', x.org))[0]).toMatchObject({ outcome: 'told', summary: 'Theo is fixing #4.', actions: 0 });
    x.model.mockImplementationOnce(untilAborted);
    await events(x, [waiting]);
    await vi.waitFor(() => expect(x.model).toHaveBeenCalledTimes(3));
    expect(await x.chat.stop('u1', x.org)).toEqual({ stopped: true });
    await x.done();
    expect((await x.chat.eventHistory('u1', x.org))[0]).toMatchObject({ noticed: [waiting.text], actions: 0 });
  });

  it('events a restart caught before their turn began simply start it, with no restart notice', async () => {
    const x = await setup([`${EVENT_QUIET}: nothing new.`]);
    await permit(x, {});
    await x.orgStorage.touchMember(x.org, 'u1', { workspaceRecapChat: {
      messages: [{ id: 'e1', role: 'action', kind: 'event', text: red.text, at: new Date().toISOString() }],
      receipts: [], pending: [], running: 'lost', eventing: true, phase: 'Thinking…',
    } });
    await x.chat.read('u1', x.org);
    const settled = await x.done();
    expect(x.model).toHaveBeenCalledTimes(1);
    expect(x.model.mock.calls[0]![2] as string).toContain('This is an EVENT TURN');
    expect(settled.messages).toEqual([]);
  });

  it('events that land while a person\'s request runs carry one event turn after it, never interrupting it', async () => {
    const x = await setup([]);
    await permit(x, {});
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    x.model.mockImplementationOnce(async () => { await held; return { text: 'Here is the plan.' }; });
    x.model.mockImplementationOnce(async () => ({ text: `${EVENT_QUIET}: the red check is the one Theo is fixing.` }));
    await x.chat.send('u1', x.org, 'request-1', 'Plan the launch');
    await vi.waitFor(() => expect(x.model).toHaveBeenCalledTimes(1));
    expect(await events(x, [red])).toBe(true);
    finish();
    const settled = await x.done();
    expect(x.model).toHaveBeenCalledTimes(2);
    expect((x.model.mock.calls[0]![5] as TurnOptions).signal!.aborted).toBe(false);
    const second = x.model.mock.calls[1]![2] as string;
    expect(second).toContain('This is an EVENT TURN');
    expect(settled.messages.map(m => [m.role, m.text])).toEqual([
      ['owner', 'Plan the launch'],
      ['assistant', 'Here is the plan.'],
    ]);
  });

  it('an event turn whose machine would not wake is tried once more, and the retry runs as the same event turn (note #763)', async () => {
    const x = await setup([], { wakeRetryDelayMs: 10 });
    await permit(x, {});
    x.model.mockResolvedValueOnce({ failure: 'unavailable', wakeFailed: true, detail: WAKE_FAILED } as never);
    x.model.mockResolvedValueOnce({ text: `${EVENT_QUIET}: Theo is already on the red check.` });
    expect(await events(x, [red])).toBe(true);
    const settled = await x.done();
    expect(x.model).toHaveBeenCalledTimes(2);
    expect(x.model.mock.calls[1]![2] as string).toContain('This is an EVENT TURN');
    expect(settled.messages).toEqual([]);
    expect((await x.chat.eventHistory('u1', x.org))[0]).not.toMatchObject({ outcome: 'failed' });
  });

  it('starts nothing for a Workspace Agent the person never started, and an event turn that could not run is listed, never drawn', async () => {
    const x = await setup([]);
    await permit(x, {});
    x.model.mockResolvedValueOnce({ failure: 'unavailable', detail: 'Your Workspace Agent\'s computer would not wake up, so it could not answer. Send your message again in a minute.' } as never);
    await events(x, [red]);
    const settled = await x.done();
    expect(settled.messages).toEqual([]);
    expect((await x.chat.eventHistory('u1', x.org))[0]).toMatchObject({ outcome: 'failed' });
    await x.neverStarted();
    expect(await events(x, [waiting])).toBe(false);
    expect(x.model).toHaveBeenCalledTimes(1);
  });

  it('a restart during an event turn closes it quietly: ended on the machine, never replayed or announced', async () => {
    const x = await setup([]);
    await x.orgStorage.touchMember(x.org, 'u1', { workspaceRecapChat: {
      messages: [{ id: 'e1', role: 'action', kind: 'event', text: red.text, at: new Date().toISOString() }],
      receipts: [], pending: [], running: 'lost', eventTurn: true, phase: 'Thinking…',
    } });
    const settled = await x.chat.read('u1', x.org);
    expect(x.ended).toHaveBeenCalledWith('u1', x.org);
    expect(x.model).not.toHaveBeenCalled();
    expect(settled.working).toBe(false);
    expect(settled.messages).toEqual([]);
    expect((await x.chat.eventHistory('u1', x.org))[0]).toMatchObject({ outcome: 'failed', summary: 'Could not run: the platform restarted during this event turn.' });
  });
});

describe('the first run (note #726): the Chief of Staff runs the first ten minutes', () => {
  const words = () => import('../../shared/first-run.js');
  /** The founder of a new workplace, before any plan: the chat the router wires, with the plan's presence under test control. */
  const firstRun = async (replies: string[] = []) => {
    const x = await setup(replies);
    let seated = false;
    let name: string | undefined = 'Samira';
    const greeting = vi.fn(async (_u: string, _o: string) => (await words()).firstRunGreeting(name));
    const chat = new WorkspaceRecapChat(x.deps, x.resolve, x.changed, { seated: async () => seated, greeting });
    const done = async () => { await vi.waitFor(async () => expect((await chat.read('u1', x.org)).working).toBe(false)); return chat.read('u1', x.org); };
    return { ...x, chat, done, greeting, seat: () => { seated = true; }, noName: () => { name = undefined; } };
  };

  it('opens on the fixed greeting, written once, by the person\'s first name', async () => {
    const x = await firstRun();
    const first = await x.chat.read('u1', x.org);
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]).toMatchObject({ role: 'assistant', kind: 'greeting', text: 'Hi Samira, I\'m your Chief of Staff. Tell me what you\'re working on, and I\'ll put a team of agents on it.' });
    expect(first.awaitingSeat).toBeUndefined();
    // Once: a second read neither repeats it nor asks again.
    const again = await x.chat.read('u1', x.org);
    expect(again.messages).toHaveLength(1);
    expect(x.greeting).toHaveBeenCalledTimes(1);
    expect(x.model).not.toHaveBeenCalled();
  });
  it('greets without a name when the account has none, and not at all where no greeting is owed', async () => {
    const x = await firstRun();
    x.noName();
    expect((await x.chat.read('u1', x.org)).messages[0]!.text).toBe('Hi, I\'m your Chief of Staff. Tell me what you\'re working on, and I\'ll put a team of agents on it.');
    const y = await setup([]);
    const plain = new WorkspaceRecapChat(y.deps, y.resolve, y.changed, { seated: async () => false, greeting: async () => null });
    expect((await plain.read('u1', y.org)).messages).toEqual([]);
  });
  it('keeps the first message and answers with the sign-in ask instead of a turn while no plan is in; a second message is kept too', async () => {
    const x = await firstRun();
    await x.chat.read('u1', x.org);
    const asked = await x.chat.send('u1', x.org, 'first-msg', 'A meal-planning app for busy parents. I need a waitlist page first.');
    expect(asked.working).toBe(false);
    expect(asked.awaitingSeat).toBe(true);
    expect(asked.messages.map(m => [m.role, m.kind ?? '', m.text])).toEqual([
      ['assistant', 'greeting', expect.stringContaining('Hi Samira')],
      ['owner', '', 'A meal-planning app for busy parents. I need a waitlist page first.'],
      ['assistant', 'signin-ask', 'Got it. Your agents and I run on your own Claude or ChatGPT plan. Sign it in below, and I\'ll start.'],
    ]);
    expect(x.model).not.toHaveBeenCalled();
    const more = await x.chat.send('u1', x.org, 'second-msg', 'Also a logo.');
    expect(more.awaitingSeat).toBe(true);
    expect(more.messages.slice(-2).map(m => [m.role, m.kind ?? '', m.text])).toEqual([
      ['owner', '', 'Also a logo.'],
      ['assistant', 'signin-ask', 'I\'ve kept that too. Sign in your plan above, and I\'ll start on all of it.'],
    ]);
    expect(x.model).not.toHaveBeenCalled();
    // Idempotent, as every send is.
    expect((await x.chat.send('u1', x.org, 'second-msg', 'Also a logo.')).messages).toHaveLength(5);
  });
  it('the plan landing writes its receipt and starts the first turn by itself, asked for the first-run shape, over everything the person wrote', async () => {
    const x = await firstRun(['Here\'s the plan for **Meal planner**:\n- **Juno** builds the waitlist page and puts it live.\nThey\'re starting now. I\'ll tell you when the page is up.']);
    await x.chat.read('u1', x.org);
    await x.chat.send('u1', x.org, 'first-msg', 'A meal-planning app for busy parents.');
    await x.chat.send('u1', x.org, 'second-msg', 'Also a logo.');
    x.seat();
    await x.chat.seatSignedIn('u1', x.org, 'claude');
    const started = await x.chat.read('u1', x.org);
    expect(started.working).toBe(true);
    expect(started.awaitingSeat).toBeUndefined();
    expect(started.messages.filter(m => m.role === 'action').map(m => m.text)).toEqual(['Your Claude plan is signed in.']);
    const settled = await x.done();
    expect(x.model).toHaveBeenCalledTimes(1);
    const prompt = x.model.mock.calls[0]![2] as string;
    const { FIRST_RUN_ASK } = await import('../../services/workspace-recap-chat.js');
    expect(prompt).toContain(FIRST_RUN_ASK);
    expect(prompt).toContain('Answer every owner message in the conversation, as one piece of work.');
    // No room to open since note #843: the team is brought into the workplace.
    expect(FIRST_RUN_ASK).not.toMatch(/room/i);
    expect(FIRST_RUN_ASK).toContain('with `agentbuilt agent create`, on the plan they signed in');
    expect(prompt).not.toContain(AGENT_REPLY_REACT_ASK);
    // The platform's lines travel as the agent's own earlier words.
    expect(prompt).toContain('Sign it in below');
    expect(settled.messages.at(-1)).toMatchObject({ role: 'assistant', text: expect.stringContaining('Meal planner') });
    // Over: the next message is an ordinary turn.
    x.model.mockResolvedValueOnce({ text: 'On it.' });
    await x.chat.send('u1', x.org, 'third-msg', 'Thanks');
    await x.done();
    expect(x.model.mock.calls[1]![2] as string).not.toContain(FIRST_RUN_ASK);
    expect(x.model.mock.calls[1]![2] as string).toContain('Answer the newest owner message in the conversation.');
  });
  it('a plan landing in a conversation that was not waiting writes nothing; one that was gets the receipt, naming ChatGPT as such', async () => {
    const x = await firstRun();
    await x.chat.read('u1', x.org);
    await x.chat.seatSignedIn('u1', x.org, 'codex');
    const answer = await x.chat.read('u1', x.org);
    expect(answer.working).toBe(false);
    expect(answer.messages.map(m => m.role)).toEqual(['assistant']);
    expect(x.model).not.toHaveBeenCalled();
    // Waiting, then: the receipt names the plan that landed.
    await x.chat.send('u1', x.org, 'msg-0001', 'hello');
    expect((await x.chat.read('u1', x.org)).awaitingSeat).toBe(true);
    x.seat();
    x.model.mockResolvedValueOnce({ text: 'Hello! What are you working on?' });
    await x.chat.seatSignedIn('u1', x.org, 'codex');
    const settled = await x.done();
    expect(settled.messages.filter(m => m.role === 'action').map(m => m.text)).toEqual(['Your ChatGPT plan is signed in.']);
    expect(settled.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Hello! What are you working on?' });
  });
  it('a plan signed in elsewhere while the ask stands: the next message is an ordinary turn over everything written', async () => {
    const x = await firstRun(['Done.']);
    await x.chat.read('u1', x.org);
    await x.chat.send('u1', x.org, 'msg-0001', 'Build me a site');
    x.seat();
    const next = await x.chat.send('u1', x.org, 'msg-0002', 'Please');
    expect(next.working).toBe(true);
    expect(next.awaitingSeat).toBeUndefined();
    await x.done();
    expect(x.model).toHaveBeenCalledTimes(1);
    expect(x.model.mock.calls[0]![2] as string).not.toContain('first conversation in a brand-new workplace');
  });
  it('a person who joined an existing workplace (note #820) opens on the welcome, and their plan landing starts an ordinary turn, never the first run', async () => {
    const x = await setup(['Welcome aboard. Ben is on the pricing page.']);
    let seated = false;
    const welcome = vi.fn(async () => 'Hi Dana, welcome to Acme. I\'m your Chief of Staff here. Here\'s what\'s already going on.');
    const chat = new WorkspaceRecapChat(x.deps, x.resolve, x.changed, { seated: async () => seated, greeting: async () => null, welcome });
    const first = await chat.read('u1', x.org);
    expect(first.messages.map(m => [m.role, m.kind])).toEqual([['assistant', 'welcome']]);
    expect((await chat.read('u1', x.org)).messages).toHaveLength(1);
    expect(welcome).toHaveBeenCalledTimes(1);
    // No plan yet: the same sign-in ask as the founder's.
    const asked = await chat.send('u1', x.org, 'msg-0001', 'What is Ben doing?');
    expect(asked.awaitingSeat).toBe(true);
    expect(asked.messages.at(-1)).toMatchObject({ kind: 'signin-ask' });
    seated = true;
    await chat.seatSignedIn('u1', x.org, 'claude');
    await vi.waitFor(async () => expect((await chat.read('u1', x.org)).working).toBe(false));
    const prompt = x.model.mock.calls[0]![2] as string;
    expect(prompt).not.toContain('first conversation in a brand-new workplace');
    expect(prompt).toContain('welcome to Acme');
    expect(prompt).toContain('What is Ben doing?');
    expect((await chat.read('u1', x.org)).messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Welcome aboard. Ben is on the pricing page.' });
  });
  it('the founder\'s greeting wins over the welcome; neither is owed, nothing is written', async () => {
    const x = await setup([]);
    const welcome = vi.fn(async () => 'welcome');
    const founder = new WorkspaceRecapChat(x.deps, x.resolve, x.changed, { seated: async () => false, greeting: async () => 'Hi Samira', welcome });
    expect((await founder.read('u1', x.org)).messages.map(m => m.kind)).toEqual(['greeting']);
    expect(welcome).not.toHaveBeenCalled();
    const y = await setup([]);
    const nobody = new WorkspaceRecapChat(y.deps, y.resolve, y.changed, { seated: async () => false, greeting: async () => null, welcome: async () => null });
    expect((await nobody.read('u1', y.org)).messages).toEqual([]);
  });
  it('a restart during the first turn picks it up again as the first run: the platform\'s lines are not the reply it owed', async () => {
    const x = await firstRun(['Here\'s the plan for **Site**:']);
    x.ended.mockResolvedValueOnce('ended');
    const at = new Date(Date.now() - 60_000).toISOString();
    await x.orgStorage.touchMember(x.org, 'u1', { workspaceRecapChat: { messages: [
      { id: 'g', role: 'assistant', kind: 'greeting', text: 'Hi Samira, I\'m your Chief of Staff.', at },
      { id: 'm1', role: 'owner', text: 'Build me a site', at },
      { id: 'ask', role: 'assistant', kind: 'signin-ask', text: 'Got it. Sign it in below.', at },
      { id: 'r', role: 'action', text: 'Your Claude plan is signed in.', at },
      { id: 'o', role: 'action', text: 'Brought in Ada.', at },
    ], receipts: ['m1'], pending: [], running: 'kick', firstRun: true, greeted: true } });
    x.seat();
    const answer = await x.chat.read('u1', x.org);
    expect(x.ended).toHaveBeenCalledWith('u1', x.org);
    expect(answer.messages.filter(m => m.role === 'action').at(-1)!.text).toBe('The connection restarted before your request "Build me a site" finished. The 2 actions recorded above already happened. Picking it up again now.');
    const settled = await x.done();
    const prompt = x.model.mock.calls[0]![2] as string;
    const { FIRST_RUN_ASK } = await import('../../services/workspace-recap-chat.js');
    expect(prompt).toContain(RESTART_RESUME_NOTICE);
    expect(prompt).toContain(FIRST_RUN_ASK);
    expect(settled.messages.at(-1)).toMatchObject({ role: 'assistant', text: expect.stringContaining('Site') });
    // The first run is over with the reply: the flag is gone from the record.
    expect((await x.orgStorage.getMembership(x.org, 'u1'))!.workspaceRecapChat!.firstRun).toBeUndefined();
  });
});
