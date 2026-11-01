import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Timestamp } from '../../types/timestamp.js';
import { openSqliteDb, serializeDoc, deserializeDoc, type SqliteDb } from '../../services/sqlite/sqlite-db.js';
import { SqliteUserStorage } from '../../services/sqlite/sqlite-user-storage.js';
import { SqliteSessionStorage } from '../../services/sqlite/sqlite-session-storage.js';
import { SqliteSecretStorage } from '../../services/sqlite/sqlite-secret-storage.js';
import { SqlitePendingTurnStorage } from '../../services/sqlite/sqlite-pending-turn-storage.js';
import { SqliteStoppedUserMessageStorage } from '../../services/sqlite/sqlite-stopped-user-message-storage.js';
import { SqlitePlatformCredentialPool } from '../../services/sqlite/sqlite-platform-credential-pool.js';
import { SqliteConfigDocSource } from '../../services/sqlite/sqlite-config-docs.js';
import { SqliteFlyIdleReaperAlertStore } from '../../services/sqlite/sqlite-fly-idle-reaper-alerts.js';
import { SqliteAgentActivityStore } from '../../services/sqlite/sqlite-agent-activity-store.js';
import { SqliteAgentWorkLedger } from '../../services/sqlite/sqlite-agent-work-ledger.js';
import { SqliteDeploymentStorage } from '../../services/sqlite/sqlite-deployment-storage.js';
import { SqliteQuickNoteStorage } from '../../services/sqlite/sqlite-quick-note-storage.js';
import { SqliteGitPullRequestStorage } from '../../services/sqlite/sqlite-git-pr-storage.js';
import { SqliteKnowledgeProposalStorage } from '../../services/sqlite/sqlite-knowledge-storage.js';
import { SqliteKnowledgePageCommentStorage } from '../../services/sqlite/sqlite-knowledge-page-comments.js';
import type { MarginComment } from '../../types/comment.js';
import { AgentConfigService } from '../../services/agent-config-service.js';
import { HarnessCliVersionService } from '../../services/harness-cli-versions.js';
import { DEFAULT_MODEL } from '../../config/models.js';

let dir: string;
let dbPath: string;
let db: SqliteDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sqlite-storage-'));
  dbPath = join(dir, 'test.db');
  db = openSqliteDb(dbPath);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('sqlite-db serialization', () => {
  it('round-trips Timestamps, Dates and nested structures', () => {
    const ts = Timestamp.fromDate(new Date('2026-08-03T12:00:00.000Z'));
    const date = new Date('2026-08-01T00:00:00.000Z');
    const doc = {
      ts,
      date,
      nested: { list: [1, 'two', { ts }], keep: null },
      dropped: undefined,
    };
    const revived = deserializeDoc<typeof doc>(serializeDoc(doc));
    expect(revived.ts).toBeInstanceOf(Timestamp);
    expect(revived.ts.toDate().toISOString()).toBe('2026-08-03T12:00:00.000Z');
    expect(revived.date).toBeInstanceOf(Date);
    expect(revived.date.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect((revived.nested.list[2] as { ts: Timestamp }).ts.toDate().toISOString())
      .toBe('2026-08-03T12:00:00.000Z');
    expect(revived.nested.keep).toBeNull();
    expect('dropped' in revived).toBe(false);
  });
});

describe('SqliteUserStorage', () => {
  it('reserves exactly one Workspace assistant per workplace without replacing another agent', async () => {
    const storage = new SqliteUserStorage(db);
    await storage.createProfile('recap-u', { email: 'recap@example.com', telegram: { agents: { own: { id: 'own', name: 'Theo', cli: 'codex' } } } });
    const [first, second] = await Promise.all([storage.reserveWorkspaceAssistant('recap-u', 'org-a'), storage.reserveWorkspaceAssistant('recap-u', 'org-a')]);
    expect(first?.id).toBe(second?.id);
    expect((await storage.reserveWorkspaceAssistant('recap-u', 'org-b'))?.id).not.toBe(first?.id);
    await storage.createProfile('recap-other', { email: 'other@example.com' });
    expect((await storage.reserveWorkspaceAssistant('recap-other', 'org-a'))?.id).not.toBe(first?.id);
    const reopened = new SqliteUserStorage(db);
    expect((await reopened.getProfile('recap-u'))?.telegram?.agents?.own?.name).toBe('Theo');
    expect((await reopened.getProfile('recap-u'))?.telegram?.agents?.[first!.id]?.purpose).toBe('workspace-recap');
    // The briefing machine (note #437) is a second record with its own id
    // and name, beside the agent's, never in its place.
    const briefing = await storage.reserveWorkspaceAssistant('recap-u', 'org-a', 'workspace-briefing');
    expect(briefing).toMatchObject({ purpose: 'workspace-briefing', name: 'Workspace Recap', orgId: 'org-a' });
    expect(briefing?.id).not.toBe(first?.id);
    expect((await storage.reserveWorkspaceAssistant('recap-u', 'org-a', 'workspace-briefing'))?.id).toBe(briefing?.id);
    expect((await reopened.getProfile('recap-u'))?.telegram?.agents?.[first!.id]?.purpose).toBe('workspace-recap');
  });

  it('creates, reads and survives a reopen', async () => {
    const storage = new SqliteUserStorage(db);
    await storage.createProfile('user-1', {
      email: 'a@example.com',
      username: 'alice',
      telegram: { telegramUserId: 'tg-1' },
    });

    db.close();
    db = openSqliteDb(dbPath);
    const reopened = new SqliteUserStorage(db);
    const profile = await reopened.getProfile('user-1');
    expect(profile).toMatchObject({ userId: 'user-1', username: 'alice' });
    expect(profile?.createdAt).toBeInstanceOf(Date);
    await expect(reopened.findUserByTelegramUserId('tg-1')).resolves.toMatchObject({ userId: 'user-1' });
  });

  it('enforces username reservations across create, rename and delete', async () => {
    const storage = new SqliteUserStorage(db);
    await storage.createProfile('user-1', { email: '', username: 'alice' });
    await expect(storage.createProfile('user-2', { email: '', username: 'alice' }))
      .rejects.toThrow(/already in use/);

    await storage.updateProfile('user-1', { username: 'bob' });
    // Old name released, new name reserved.
    await expect(storage.createProfile('user-3', { email: '', username: 'alice' }))
      .resolves.toMatchObject({ username: 'alice' });
    await expect(storage.createProfile('user-4', { email: '', username: 'bob' }))
      .rejects.toThrow(/already in use/);

    await storage.deleteUserData('user-1');
    await expect(storage.getProfile('user-1')).resolves.toBeNull();
    await expect(storage.createProfile('user-5', { email: '', username: 'bob' }))
      .resolves.toMatchObject({ username: 'bob' });
  });

  it('applies field-scoped agent updates with null deletes', async () => {
    const storage = new SqliteUserStorage(db);
    await storage.createProfile('user-1', {
      email: '',
      telegram: {
        telegramUserId: 'tg-1',
        chatId: 'chat-1',
        agents: {
          agent1: { serverId: 'srv-1', connectedAt: '2026-08-01T00:00:00Z' },
        },
      } as never,
    });

    await expect(storage.updateAgentFields('user-1', 'agent1', {
      serverId: 'srv-2',
      connectedAt: null,
      exposedUrl: 'https://x.fly.dev',
    })).resolves.toBe(true);
    // Missing agent writes nothing.
    await expect(storage.updateAgentFields('user-1', 'missing', { serverId: 'x' }))
      .resolves.toBe(false);

    const agent = (await storage.getProfile('user-1'))?.telegram?.agents?.agent1 as Record<string, unknown>;
    expect(agent.serverId).toBe('srv-2');
    expect(agent.exposedUrl).toBe('https://x.fly.dev');
    expect('connectedAt' in agent).toBe(false);

    await expect(storage.removeTelegramAgent('user-1', 'agent1')).resolves.toBe(true);
    await expect(storage.removeTelegramAgent('user-1', 'agent1')).resolves.toBe(false);
  });

  it('increments an agent turn count atomically, including legacy records', async () => {
    const storage = new SqliteUserStorage(db);
    await storage.createProfile('user-1', {
      email: '',
      telegram: {
        telegramUserId: 'tg-1',
        agents: {
          legacy: { id: 'legacy', name: 'Kai', cli: 'claude', createdAt: 'x' },
          counted: { id: 'counted', name: 'Mia', cli: 'codex', createdAt: 'x', turnCount: 8 },
        },
      },
    });

    await expect(storage.incrementTelegramAgentTurnCount('user-1', 'legacy')).resolves.toBe(1);
    await expect(storage.incrementTelegramAgentTurnCount('user-1', 'legacy')).resolves.toBe(2);
    await expect(storage.incrementTelegramAgentTurnCount('user-1', 'counted')).resolves.toBe(9);
    await expect(storage.incrementTelegramAgentTurnCount('user-1', 'missing')).resolves.toBeNull();

    const agents = (await storage.getProfile('user-1'))?.telegram?.agents;
    expect(agents?.legacy?.turnCount).toBe(2);
    expect(agents?.counted?.turnCount).toBe(9);
  });

  it('updates harness conversation ids pinned to one agent', async () => {
    const storage = new SqliteUserStorage(db);
    await storage.createProfile('user-1', {
      email: '',
      telegram: {
        telegramUserId: 'tg-1',
        chatId: 'chat-1',
        agents: { agent1: { conversation: { claudeSessionId: 'old' } } },
      } as never,
    });

    await storage.updateTelegramHarnessConversation(
      'user-1',
      { claudeSessionId: 'new', codexThreadId: null },
      { agentId: 'agent1' },
    );
    const conversation = (await storage.getProfile('user-1'))?.telegram?.agents?.agent1?.conversation;
    expect(conversation).toEqual({ claudeSessionId: 'new' });

    // No agent id → no-op.
    await storage.updateTelegramHarnessConversation('user-1', { claudeSessionId: 'x' });
    expect((await storage.getProfile('user-1'))?.telegram?.agents?.agent1?.conversation)
      .toEqual({ claudeSessionId: 'new' });
  });
});

describe('SqliteSessionStorage', () => {
  it('creates sessions and round-trips message history with seq and title', async () => {
    const storage = new SqliteSessionStorage(db);
    await storage.createSession('session-1', 'user-1', { sandboxId: 'sb-1', model: 'test-model' });

    await storage.addToHistory('user-1', 'session-1', {
      role: 'user',
      content: 'Fix the flaky test in the payment flow that fails on Mondays only',
    } as never);
    await storage.addToHistory('user-1', 'session-1', {
      role: 'assistant',
      content: 'On it.',
    } as never);

    const session = await storage.getSession('user-1', 'session-1');
    expect(session).toMatchObject({
      sessionId: 'session-1',
      sandboxId: 'sb-1',
      model: 'test-model',
      messageCount: 2,
      history: [],
    });
    expect(session?.title).toBe('Fix the flaky test in the payment flow that fails on Mondays…');
    expect(session?.updatedAt).toBeInstanceOf(Timestamp);

    const history = await storage.getHistory('user-1', 'session-1');
    expect(history.map((message) => [message.seq, message.role])).toEqual([[0, 'user'], [1, 'assistant']]);
  });

  it('updateSession deletes fields passed as undefined', async () => {
    const storage = new SqliteSessionStorage(db);
    await storage.createSession('session-1', 'user-1', {});
    await storage.updateSession('user-1', 'session-1', { status: 'error', lastError: 'boom' } as never);
    expect((await storage.getSession('user-1', 'session-1'))?.lastError).toBe('boom');

    await storage.updateSession('user-1', 'session-1', { status: 'idle', lastError: undefined } as never);
    const session = await storage.getSession('user-1', 'session-1');
    expect(session?.status).toBe('idle');
    expect(session?.lastError).toBeUndefined();
  });

  it('clears history and transient fields, and persists across reopen', async () => {
    const storage = new SqliteSessionStorage(db);
    await storage.createSession('session-1', 'user-1', {});
    await storage.addToHistory('user-1', 'session-1', { role: 'user', content: 'hello there' } as never);
    await storage.updateSession('user-1', 'session-1', { lastError: 'x', pendingClarification: true } as never);

    await storage.clearSessionHistory('user-1', 'session-1');

    db.close();
    db = openSqliteDb(dbPath);
    const reopened = new SqliteSessionStorage(db);
    const session = await reopened.getSession('user-1', 'session-1');
    expect(session).toMatchObject({ messageCount: 0, status: 'idle', pendingClarification: false });
    expect(session?.lastError).toBeUndefined();
    // Title survives a clear (same as the other backends).
    expect(session?.title).toBe('hello there');
    await expect(reopened.getHistory('user-1', 'session-1')).resolves.toEqual([]);
  });

  it('returns null/[] for missing sessions', async () => {
    const storage = new SqliteSessionStorage(db);
    await expect(storage.getSession('user-1', 'nope')).resolves.toBeNull();
    await expect(storage.getHistory('user-1', 'nope')).resolves.toEqual([]);
    // Updates on missing sessions are silent no-ops, like the other backends.
    await expect(storage.updateSession('user-1', 'nope', { status: 'idle' } as never)).resolves.toBeUndefined();
    await expect(storage.addToHistory('user-1', 'nope', { role: 'user', content: 'x' } as never)).resolves.toBeUndefined();
  });
});

describe('SqliteSecretStorage', () => {
  it('does CRUD and key lookup, newest first', async () => {
    const storage = new SqliteSecretStorage(db);
    const first = await storage.createSecret('user-1', { key: 'API_KEY', value: 'one' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await storage.createSecret('user-1', { key: 'OTHER', value: 'two' });
    await storage.createSecret('user-2', { key: 'API_KEY', value: 'not-mine' });

    const secrets = await storage.getUserSecrets('user-1');
    expect(secrets.map((secret) => secret.secretId)).toEqual([second.secretId, first.secretId]);

    await expect(storage.getSecretByKey('user-1', 'API_KEY')).resolves.toMatchObject({ value: 'one' });
    await storage.updateSecret('user-1', first.secretId, { value: 'updated' });
    await expect(storage.getSecret('user-1', first.secretId)).resolves.toMatchObject({ value: 'updated' });

    await storage.deleteSecret('user-1', first.secretId);
    await expect(storage.getSecret('user-1', first.secretId)).resolves.toBeNull();
    await expect(storage.getSecret('user-2', second.secretId)).resolves.toBeNull();
  });
});

describe('SqlitePendingTurnStorage', () => {
  it('saves one checkpoint per run key and lists them after reopen', async () => {
    const storage = new SqlitePendingTurnStorage(db);
    await storage.save({
      runKey: 'session-1::agent:agent1',
      sessionId: 'session-1',
      userId: 'user-1',
      chatId: 'chat-1',
      payloads: [{ text: 'resume me' } as never],
      savedAt: '2026-08-03T00:00:00Z',
    });
    await storage.save({
      sessionId: 'session-1',
      userId: 'user-1',
      chatId: 'chat-1',
      payloads: [],
      savedAt: '2026-08-03T00:00:00Z',
    });

    db.close();
    db = openSqliteDb(dbPath);
    const reopened = new SqlitePendingTurnStorage(db);
    const all = await reopened.listAll();
    expect(all).toHaveLength(2);

    await reopened.delete('session-1::agent:agent1');
    await expect(reopened.listAll()).resolves.toHaveLength(1);
  });

  it('deletes only the checkpoint generation acknowledged by recovery', async () => {
    const storage = new SqlitePendingTurnStorage(db);
    const base = {
      sessionId: 'session-1', userId: 'user-1', chatId: 'chat-1',
      payloads: [{ content: 'old' }],
    };
    await storage.save({ ...base, savedAt: '2026-08-03T00:00:00Z' });

    await expect(storage.deleteIfSavedAt('session-1', 'wrong-generation')).resolves.toBe(false);
    await expect(storage.listAll()).resolves.toHaveLength(1);

    // A newer shutdown overwrites the same run while the old recovery is
    // acknowledging. Its CAS delete must not erase the newer checkpoint.
    await storage.save({
      ...base,
      payloads: [{ content: 'new shutdown snapshot' }],
      savedAt: '2026-08-03T01:00:00Z',
    });
    await expect(storage.deleteIfSavedAt('session-1', '2026-08-03T00:00:00Z')).resolves.toBe(false);
    await expect(storage.listAll()).resolves.toEqual([
      expect.objectContaining({
        savedAt: '2026-08-03T01:00:00Z',
        payloads: [{ content: 'new shutdown snapshot' }],
      }),
    ]);

    await expect(storage.deleteIfSavedAt('session-1', '2026-08-03T01:00:00Z')).resolves.toBe(true);
    await expect(storage.listAll()).resolves.toEqual([]);
  });

  it('uses the opaque checkpoint id when two generations share savedAt', async () => {
    const storage = new SqlitePendingTurnStorage(db);
    const savedAt = '2026-08-03T00:00:00.000Z';
    const base = {
      sessionId: 'same-ms', userId: 'user-1', chatId: 'chat-1', savedAt,
    };
    await storage.save({ ...base, checkpointId: 'generation-a', payloads: [{ content: 'old' }] });
    await storage.save({ ...base, checkpointId: 'generation-b', payloads: [{ content: 'new' }] });

    await expect(storage.deleteIfSavedAt('same-ms', savedAt, 'generation-a')).resolves.toBe(false);
    await expect(storage.listAll()).resolves.toEqual([
      expect.objectContaining({ checkpointId: 'generation-b', payloads: [{ content: 'new' }] }),
    ]);

    await expect(storage.deleteIfSavedAt('same-ms', savedAt, 'generation-b')).resolves.toBe(true);
  });

  it('does not let a legacy same-time acknowledgement erase a new-format generation', async () => {
    const storage = new SqlitePendingTurnStorage(db);
    const savedAt = '2026-08-03T00:00:00.000Z';
    const base = {
      sessionId: 'legacy-same-ms', userId: 'user-1', chatId: 'chat-1', savedAt,
    };
    await storage.save({ ...base, payloads: [{ content: 'legacy' }] });
    await storage.save({
      ...base,
      checkpointId: 'new-format-generation',
      payloads: [{ content: 'new shutdown' }],
    });

    await expect(storage.deleteIfSavedAt('legacy-same-ms', savedAt)).resolves.toBe(false);
    await expect(storage.listAll()).resolves.toEqual([
      expect.objectContaining({ checkpointId: 'new-format-generation' }),
    ]);
  });
});

describe('SqliteStoppedUserMessageStorage', () => {
  it('survives reopen and consumes only the admitted generation', async () => {
    const storage = new SqliteStoppedUserMessageStorage(db);
    const base = {
      runKey: 'session-1::agent:agent-1',
      sessionId: 'session-1',
      userId: 'user-1',
      agentId: 'agent-1',
      savedAt: '2026-09-05T12:00:00.000Z',
    };
    await storage.save({
      ...base,
      generation: 'stop-a',
      payloads: [{ content: 'first', preserveAfterUserStop: true }],
    });

    db.close();
    db = openSqliteDb(dbPath);
    const reopened = new SqliteStoppedUserMessageStorage(db);
    await expect(reopened.listAll()).resolves.toEqual([
      expect.objectContaining({
        generation: 'stop-a',
        payloads: [{ content: 'first', preserveAfterUserStop: true }],
      }),
    ]);

    await expect(reopened.deleteIfGeneration(base.runKey, 'older-stop')).resolves.toBe(false);
    await reopened.save({
      ...base,
      generation: 'stop-b',
      payloads: [{ content: 'second', preserveAfterUserStop: true }],
    });
    await expect(reopened.deleteIfGeneration(base.runKey, 'stop-a')).resolves.toBe(false);
    await expect(reopened.deleteIfGeneration(base.runKey, 'stop-b')).resolves.toBe(true);
    await expect(reopened.listAll()).resolves.toEqual([]);
  });
});

describe('SqlitePlatformCredentialPool', () => {
  it('leases the healthiest credential and tracks counts', async () => {
    const pool = new SqlitePlatformCredentialPool(db);
    const credential = await pool.addCredential({ provider: 'claude', token: 'tok-1', label: 'one' });

    const lease = await pool.leaseCredential('claude');
    expect(lease).toEqual({ credentialId: credential.credentialId, token: 'tok-1' });

    const [stored] = await pool.listCredentials('claude');
    expect(stored).toMatchObject({ inFlightCount: 1, totalLeases: 1 });

    await pool.releaseCredential(credential.credentialId, { kind: 'ok' });
    expect((await pool.listCredentials('claude'))[0]).toMatchObject({ inFlightCount: 0, authFailureStreak: 0 });
  });

  it('cools down on rate limit and dies after repeated auth failures', async () => {
    const pool = new SqlitePlatformCredentialPool(db);
    const credential = await pool.addCredential({ provider: 'claude', token: 'tok-1', label: 'one' });

    await pool.leaseCredential('claude');
    await pool.releaseCredential(credential.credentialId, { kind: 'rate_limited', retryAfterSeconds: 3600 });
    let [stored] = await pool.listCredentials('claude');
    expect(stored.status).toBe('cooldown');
    // Cooling down with a future cooldownUntil → not leasable.
    await expect(pool.leaseCredential('claude')).resolves.toBeNull();

    // Force the cooldown into the past: an expired cooldown is leasable again.
    stored = { ...stored, cooldownUntil: '2020-01-01T00:00:00.000Z' };
    db.prepare('UPDATE platform_credentials SET doc = ? WHERE credential_id = ?')
      .run(serializeDoc(stored), stored.credentialId);
    await expect(pool.leaseCredential('claude')).resolves.not.toBeNull();
    expect((await pool.listCredentials('claude'))[0].status).toBe('active');

    await pool.releaseCredential(credential.credentialId, { kind: 'auth_failed', detail: 'nope' });
    await pool.leaseCredential('claude');
    await pool.releaseCredential(credential.credentialId, { kind: 'auth_failed', detail: 'nope again' });
    expect((await pool.listCredentials('claude'))[0].status).toBe('dead');
    await expect(pool.leaseCredential('claude')).resolves.toBeNull();
  });

  it('pins to the preferred credential when it is leasable', async () => {
    const pool = new SqlitePlatformCredentialPool(db);
    await pool.addCredential({ provider: 'codex', token: 'tok-1', label: 'one' });
    const pinned = await pool.addCredential({ provider: 'codex', token: 'tok-2', label: 'two' });

    const lease = await pool.leaseCredential('codex', { preferredCredentialId: pinned.credentialId });
    expect(lease?.credentialId).toBe(pinned.credentialId);
  });
});

describe('SqliteConfigDocSource', () => {
  it('serves AgentConfigService and HarnessCliVersionService reads', async () => {
    const source = new SqliteConfigDocSource(db);
    source.setConfigDoc('config/agent', { telegramModel: 'openai/gpt-5.4' });
    source.setConfigDoc('config/harnessCliVersions', { claude: '2.1.220', codex: 'not a version' });

    const agentConfig = new AgentConfigService(source);
    await expect(agentConfig.getTelegramModel()).resolves.toBe('openai/gpt-5.4');
    await expect(agentConfig.getTelegramSidecarModel()).resolves.toBe(DEFAULT_MODEL);

    const cliVersions = new HarnessCliVersionService(source);
    await expect(cliVersions.getPinnedVersions()).resolves.toEqual({ claude: '2.1.220' });
  });

  it('reads a just-written pin past the cache, which the image build depends on', async () => {
    const source = new SqliteConfigDocSource(db);
    source.setConfigDoc('config/harnessCliVersions', { codex: '0.153.4' });
    const cliVersions = new HarnessCliVersionService(source);

    // A reader warms the cache, then the pin is bumped — the sequence a bump
    // and its image rebuild produce seconds apart.
    await expect(cliVersions.getPinnedVersions()).resolves.toEqual({ codex: '0.153.4' });
    source.setConfigDoc('config/harnessCliVersions', { codex: '0.154.0' });

    // The cached read is what baked the wrong CLI into a shipped image on
    // 2026-09-11: stale, and indistinguishable from a correct answer.
    await expect(cliVersions.getPinnedVersions()).resolves.toEqual({ codex: '0.153.4' });
    await expect(cliVersions.getPinnedVersionsUncached()).resolves.toEqual({ codex: '0.154.0' });
    // ...and it leaves the fresh answer behind for the cheap readers.
    await expect(cliVersions.getPinnedVersions()).resolves.toEqual({ codex: '0.154.0' });
  });

  it('merges on setConfigDoc like set(..., { merge: true })', () => {
    const source = new SqliteConfigDocSource(db);
    source.setConfigDoc('config/agent', { telegramModel: 'a', telegramSidecarModel: 'b' });
    source.setConfigDoc('config/agent', { telegramModel: 'c' });
    const row = db.prepare("SELECT doc FROM config_docs WHERE doc_id = 'config/agent'").get() as { doc: string };
    expect(deserializeDoc<Record<string, unknown>>(row.doc)).toEqual({
      telegramModel: 'c',
      telegramSidecarModel: 'b',
    });
  });
});

describe('SqliteFlyIdleReaperAlertStore', () => {
  it('keeps the daily notification stamp across a backend restart', () => {
    const appKey = 'infinite-agents/ia-unclaimed';
    new SqliteFlyIdleReaperAlertStore(db).put({
      appKey,
      lastAlertAt: '2026-09-02T12:00:00.000Z',
    });

    db.close();
    db = openSqliteDb(dbPath);

    expect(new SqliteFlyIdleReaperAlertStore(db).get(appKey)).toEqual({
      appKey,
      lastAlertAt: '2026-09-02T12:00:00.000Z',
    });
  });
});

describe('SqliteAgentActivityStore', () => {
  it('keeps the per-agent activity stamp across a backend restart', () => {
    // The stamp is what the idle reaper's recently-active gate reads. Lost on
    // restart, every deploy put a user's machine to sleep between two of
    // their messages; kept, the first sweep after boot answers correctly.
    const store = new SqliteAgentActivityStore(db);
    store.put('user-1', 'agent-1', 1_700_000_000_000);
    store.put('user-1', 'agent-1', 1_700_000_060_000);
    store.put('user-1', 'agent-2', 1_700_000_000_000);

    db.close();
    db = openSqliteDb(dbPath);

    const reopened = new SqliteAgentActivityStore(db);
    expect(reopened.get('user-1', 'agent-1')).toBe(1_700_000_060_000);
    expect(reopened.get('user-1', 'agent-2')).toBe(1_700_000_000_000);
    expect(reopened.get('user-1', 'agent-3')).toBeUndefined();

    reopened.delete('user-1', 'agent-1');
    expect(reopened.get('user-1', 'agent-1')).toBeUndefined();
    expect(reopened.get('user-1', 'agent-2')).toBe(1_700_000_000_000);
  });
});

describe('SqliteAgentWorkLedger', () => {
  it('adds working time in place, keeps it across a restart and after the agent is gone', () => {
    // Note #644: the ledger sits beside the agent record so deleting the
    // agent (which hard-deletes the record) leaves its hours on the owner's
    // and the workplace's totals, under the name it last had.
    const ledger = new SqliteAgentWorkLedger(db);
    ledger.credit({ userId: 'user-1', agentId: 'agent-1', orgId: 'org-1', agentName: 'Ruby', month: '2026-09', ms: 60_000 });
    ledger.credit({ userId: 'user-1', agentId: 'agent-1', orgId: 'org-1', agentName: 'Ruby', month: '2026-09', ms: 30_000 });
    ledger.credit({ userId: 'user-1', agentId: 'agent-1', orgId: 'org-1', agentName: 'Ruby Two', month: '2026-10', ms: 10_000 });
    ledger.credit({ userId: 'user-1', agentId: 'agent-2', orgId: null, agentName: 'Legacy', month: '2026-10', ms: 5_000 });
    ledger.credit({ userId: 'user-2', agentId: 'agent-3', orgId: 'org-1', agentName: 'Max', month: '2026-10', ms: 7_000 });
    ledger.credit({ userId: 'user-2', agentId: 'agent-4', orgId: 'org-2', agentName: 'Elsewhere', month: '2026-10', ms: 1_000 });
    // Nothing to add is nothing written.
    ledger.credit({ userId: 'user-1', agentId: 'agent-9', orgId: 'org-1', agentName: 'Zero', month: '2026-10', ms: 0 });

    db.close();
    db = openSqliteDb(dbPath);
    const reopened = new SqliteAgentWorkLedger(db);
    expect(reopened.agentTotal('user-1', 'agent-1')).toBe(100_000);
    expect(reopened.agentTotal('user-1', 'agent-9')).toBe(0);
    expect(reopened.userTotals('user-1')).toEqual([
      { agentId: 'agent-1', orgId: 'org-1', agentName: 'Ruby Two', ms: 100_000 },
      { agentId: 'agent-2', orgId: null, agentName: 'Legacy', ms: 5_000 },
    ]);
    expect(reopened.orgTotal('org-1')).toBe(107_000);
    expect(reopened.orgTotal('org-9')).toBe(0);
  });

  it('keeps the same time per day beside the month, summed per owner', () => {
    const ledger = new SqliteAgentWorkLedger(db);
    ledger.credit({ userId: 'user-1', agentId: 'agent-1', orgId: 'org-1', agentName: 'Ruby', month: '2026-10', day: '2026-10-09', ms: 60_000 });
    ledger.credit({ userId: 'user-1', agentId: 'agent-1', orgId: 'org-1', agentName: 'Ruby', month: '2026-10', day: '2026-10-10', ms: 30_000 });
    ledger.credit({ userId: 'user-1', agentId: 'agent-2', orgId: 'org-1', agentName: 'Max', month: '2026-10', day: '2026-10-10', ms: 15_000 });
    ledger.credit({ userId: 'user-2', agentId: 'agent-3', orgId: 'org-1', agentName: 'Leo', month: '2026-10', day: '2026-10-10', ms: 5_000 });
    // A credit with no day lands in its month alone.
    ledger.credit({ userId: 'user-2', agentId: 'agent-3', orgId: 'org-1', agentName: 'Leo', month: '2026-10', ms: 1_000 });

    db.close();
    db = openSqliteDb(dbPath);
    const reopened = new SqliteAgentWorkLedger(db);
    const byDay = (since: string) => reopened.daysSince(since).sort((a, b) => a.userId.localeCompare(b.userId) || a.day.localeCompare(b.day));
    expect(byDay('2026-10-01')).toEqual([
      { userId: 'user-1', day: '2026-10-09', ms: 60_000 },
      { userId: 'user-1', day: '2026-10-10', ms: 45_000 },
      { userId: 'user-2', day: '2026-10-10', ms: 5_000 },
    ]);
    expect(byDay('2026-10-10')).toHaveLength(2);
    expect(reopened.agentTotal('user-2', 'agent-3')).toBe(6_000);
  });

  it('gives a workplace its people’s week one row per agent, only for the people asked (note #925)', () => {
    const ledger = new SqliteAgentWorkLedger(db);
    const credit = (userId: string, agentId: string, day: string, ms: number) => ledger.credit({
      userId, agentId, orgId: 'org-1', agentName: agentId, month: day.slice(0, 7), day, ms,
    });
    credit('user-1', 'agent-1', '2026-10-25', 60_000); // the Sunday before: not this week
    credit('user-1', 'agent-1', '2026-10-26', 30_000);
    credit('user-1', 'agent-1', '2026-10-27', 30_000);
    credit('user-1', 'agent-2', '2026-10-27', 15_000);
    credit('user-2', 'agent-3', '2026-10-27', 5_000);
    credit('user-3', 'agent-4', '2026-10-27', 9_000); // not asked about
    const rows = ledger.agentsSince(['user-1', 'user-2'], '2026-10-26')
      .sort((a, b) => a.agentId.localeCompare(b.agentId));
    expect(rows).toEqual([
      { userId: 'user-1', agentId: 'agent-1', ms: 60_000 },
      { userId: 'user-1', agentId: 'agent-2', ms: 15_000 },
      { userId: 'user-2', agentId: 'agent-3', ms: 5_000 },
    ]);
    expect(ledger.agentsSince([], '2026-10-26')).toEqual([]);
  });
});

describe('SqliteDeploymentStorage — names a rename left behind', () => {
  /**
   * The in-memory storage walks a Map; SQLite has to find a former name with a
   * JSON1 query, and that query is the fence stopping a released name being
   * handed to someone else. Untested, it would fail open: `getByName` returns
   * null, `create` sees a free name, and a link the owner already shared ends
   * up pointing at a stranger's site.
   */
  const storage = () => new SqliteDeploymentStorage(db);

  it('resolves a name the site was renamed away from, and keeps it taken', async () => {
    const s = storage();
    const doc = await s.create({ userId: 'u', agentId: 'a', name: 'eldiyar-math', preset: 'service', status: 'live' });
    await s.update(doc.id, { name: 'school', formerNames: ['eldiyar-math'] });

    const byNew = await s.getByName('school');
    expect(byNew?.id).toBe(doc.id);
    const byOld = await s.getByName('eldiyar-math');
    expect(byOld?.id).toBe(doc.id);
    expect(byOld?.name).toBe('school');

    await expect(s.create({ userId: 'other', agentId: 'z', name: 'eldiyar-math', preset: 'static', status: 'live' }))
      .rejects.toThrow(/already taken/);
  });

  it('does not confuse a former name with a free one, or two sites with each other', async () => {
    const s = storage();
    const moved = await s.create({ userId: 'u', agentId: 'a', name: 'first', preset: 'static', status: 'live' });
    await s.update(moved.id, { name: 'second', formerNames: ['first'] });
    const other = await s.create({ userId: 'u', agentId: 'a', name: 'unrelated', preset: 'static', status: 'live' });

    expect((await s.getByName('unrelated'))?.id).toBe(other.id);
    expect(await s.getByName('never-used')).toBeNull();
    // A record with no formerNames at all must not break the JSON1 lookup.
    expect((await s.getByName('second'))?.id).toBe(moved.id);
  });

  it('frees the former names of a destroyed site along with its current one', async () => {
    // A tombstone holds nothing: destroying a site returns every address it
    // ever answered on to the pool, which is the existing rule for its name.
    const s = storage();
    const doc = await s.create({ userId: 'u', agentId: 'a', name: 'gone-old', preset: 'static', status: 'live' });
    await s.update(doc.id, { name: 'gone-new', formerNames: ['gone-old'] });
    await s.update(doc.id, { status: 'destroyed' });

    expect((await s.getByName('gone-old'))?.status).toBe('destroyed');
    const reclaimed = await s.create({ userId: 'other', agentId: 'z', name: 'gone-old', preset: 'static', status: 'live' });
    expect(reclaimed.id).not.toBe(doc.id);
    // And the reclaimed name now resolves to the NEW owner, not the tombstone.
    expect((await s.getByName('gone-old'))?.id).toBe(reclaimed.id);
  });

  it('permanently removes exactly the site record named by a room deletion', async () => {
    const s = storage();
    const removed = await s.create({ userId: 'u', agentId: 'a', name: 'remove-me', preset: 'static', status: 'destroyed' });
    const kept = await s.create({ userId: 'u', agentId: 'a', name: 'keep-me', preset: 'static', status: 'live' });
    expect(await s.delete(removed.id)).toBe(true);
    expect(await s.delete(removed.id)).toBe(false);
    expect(await s.get(removed.id)).toBeNull();
    expect((await s.get(kept.id))?.name).toBe('keep-me');
  });
});

/**
 * Notes are the one numbered thing on the platform that can be DELETED, so
 * their counter is a row of its own rather than `MAX(number) + 1`. That is a
 * SQL decision, and this is where SQL decisions are checked.
 */
describe('SqliteQuickNoteStorage — a number is never handed out twice', () => {
  const storage = () => new SqliteQuickNoteStorage(db);
  const write = (s: SqliteQuickNoteStorage, userId: string, html: string) =>
    s.create({ userId, html, createdByAgentId: 'agent-a', updatedByAgentId: 'agent-a' });

  it('keeps counting up after the newest note is deleted', async () => {
    const s = storage();
    await write(s, 'u', 'One');
    const two = await write(s, 'u', 'Two');
    expect(two.number).toBe(2);
    await s.delete(two.id);
    // Not 2 again: the user read "#2" a minute ago, and it must not come back
    // meaning something else.
    expect((await write(s, 'u', 'Three')).number).toBe(3);
  });

  it('counts per user, and survives a reopen of the database', async () => {
    const s = storage();
    await write(s, 'u', 'Mine');
    expect((await write(s, 'other', 'Theirs')).number).toBe(1);

    db.close();
    db = openSqliteDb(dbPath);
    expect((await write(storage(), 'u', 'Next')).number).toBe(2);
  });

  it('starts above notes that predate the counter row', async () => {
    // Self-healing seed: notes written before this table existed (or a
    // counter row lost in a restore) must not collide with what is there.
    const s = storage();
    await write(s, 'u', 'One');
    await write(s, 'u', 'Two');
    db.prepare('DELETE FROM quick_note_numbers WHERE user_id = ?').run('u');
    expect((await write(s, 'u', 'Three')).number).toBe(3);
  });

  it('numbers a workplace as ONE series, above every room\'s own numbers (note #741)', async () => {
    // Two rooms that each counted from #1 — the state every workplace was in
    // before the series existed: Platform and Growth both hold a "#1".
    const s = storage();
    await write(s, 'platform', 'Platform one');
    await write(s, 'platform', 'Platform two');
    expect((await write(s, 'growth', 'Growth one')).number).toBe(1);
    const series = { series: 'org:acme', namespaces: ['platform', 'growth'] };
    const next = await s.create({ userId: 'growth', html: 'First workplace-numbered', createdByAgentId: 'a', updatedByAgentId: 'a' }, series);
    // Not #2 (Growth's next), the next number NO room holds.
    expect(next.number).toBe(3);
    const fourth = await s.create({ userId: 'platform', html: 'Second', createdByAgentId: 'a', updatedByAgentId: 'a' }, series);
    expect(fourth.number).toBe(4);
    // Deleting the newest never reissues its number, and the series survives
    // a reopen of the database exactly as a room's counter does.
    await s.delete(fourth.id);
    db.close();
    db = openSqliteDb(dbPath);
    expect((await storage().create({ userId: 'platform', html: 'Fifth', createdByAgentId: 'a', updatedByAgentId: 'a' }, series)).number).toBe(5);
    // A room's own counter has learnt of the workplace numbers it holds, so a
    // per-room allocation can never reissue one of them either.
    expect((await write(storage(), 'growth', 'Room-numbered')).number).toBe(4);

    // Finding: a legacy number answers with every room holding it; a
    // workplace number with the one note it names.
    const rooms = ['platform', 'growth'];
    expect((await storage().findByNumber(rooms, 1)).map((doc) => doc.userId).sort()).toEqual(['growth', 'platform']);
    expect((await storage().findByNumber(rooms, 3)).map((doc) => [doc.userId, doc.html])).toEqual([['growth', 'First workplace-numbered']]);
    expect(await storage().findByNumber(['platform'], 3)).toEqual([]);
  });

  it('keeps a workplace number across a move and still finds the note under its earlier address (note #741)', async () => {
    const s = storage();
    const series = { series: 'org:acme', namespaces: ['platform', 'growth'] };
    const legacy = await write(s, 'platform', 'Platform legacy one');
    await write(s, 'growth', 'Growth legacy one');
    const note = await s.create({ userId: 'platform', html: 'Move me', createdByAgentId: 'a', updatedByAgentId: 'a' }, series);
    expect(note.number).toBe(2);
    // Workplace numbers are unique, so the number travels with the note…
    const moved = (await s.move(note.id, 'growth', series))!;
    expect(moved).toMatchObject({ userId: 'growth', number: 2, previousLocations: [{ userId: 'platform', number: 2 }] });
    // …and a legacy collision in the destination takes the next WORKPLACE number.
    expect(legacy.number).toBe(1);
    const collided = (await s.move(legacy.id, 'growth', series))!;
    expect(collided.number).toBe(3);
    // The address it left is still a way to it.
    expect((await s.findByNumber(['platform'], 1)).map((doc) => doc.id)).toEqual([legacy.id]);
  });

  it('moves one document between room namespaces, renumbering only on collision', async () => {
    const s = storage();
    const note = await s.create({
      userId: 'main-room', html: '<p>Move me whole</p>',
      createdByAgentId: 'agent-a', updatedByAgentId: 'agent-a',
      comments: [{ id: 'c1', authorId: 'agent-a', text: 'Keep this', createdAt: '2026-08-29T09:00:00.000Z' }],
      attachments: [{
        id: 'a1', fileName: 'plan.pdf', contentType: 'application/pdf', sizeBytes: 12,
        storagePath: 'users/main-room/notes/n1/a1/plan.pdf', addedByAgentId: 'agent-a',
        addedAt: '2026-08-29T09:01:00.000Z',
      }],
    });
    await write(s, 'school-room', 'Already #1');

    const moved = (await s.move(note.id, 'school-room'))!;
    expect(moved).toMatchObject({
      id: note.id,
      userId: 'school-room',
      number: 2,
      html: '<p>Move me whole</p>',
      previousLocations: [{ userId: 'main-room', number: 1 }],
    });
    expect(moved.comments?.[0]?.text).toBe('Keep this');
    expect(moved.attachments?.[0]?.storagePath).toContain('users/main-room/');
    expect(await s.getByNumber('main-room', 1)).toBeNull();
    expect((await s.getByNumber('school-room', 2))?.id).toBe(note.id);
    // The destination counter observed the move; it cannot hand #2 out again.
    expect((await write(s, 'school-room', 'After the move')).number).toBe(3);
    // Nor did leaving make the source address reusable.
    expect((await write(s, 'main-room', 'After it left')).number).toBe(2);

    // Returning reclaims the note's earlier address when it is still free.
    const returned = (await s.move(note.id, 'main-room'))!;
    expect(returned.number).toBe(1);
    expect((await s.getByNumber('main-room', 1))?.id).toBe(note.id);
  });

  it('appends a comment to the note it names, and keeps the note itself as it was', async () => {
    const s = storage();
    const one = await write(s, 'u', '<p>Wifi is 4417</p>');
    const two = await write(s, 'u', '<p>Bins on Friday</p>');
    await s.addComment(one.id, { id: 'c1', authorId: 'agent-a', text: 'first', createdAt: '2026-08-17T09:00:00.000Z' });
    await s.addComment(one.id, { id: 'c2', authorId: 'user', text: 'second', createdAt: '2026-08-17T09:01:00.000Z' });

    const stored = (await s.get(one.id))!;
    // Oldest first: a thread reads down.
    expect(stored.comments?.map((c) => c.text)).toEqual(['first', 'second']);
    // The note's own words, and the field every surface prints as "updated …",
    // are untouched — a remark is about the note, not a change to it.
    expect(stored.html).toBe('<p>Wifi is 4417</p>');
    expect(stored.updatedAt).toBe(one.updatedAt);
    expect((await s.get(two.id))!.comments).toBeUndefined();
    expect(await s.addComment('no-such-note', { id: 'c3', authorId: 'user', text: 'x', createdAt: 'now' })).toBeNull();

    const editedAt = '2026-08-17T09:02:00.000Z';
    const edited = await s.editComment(one.id, 'c1', 'first, corrected', editedAt);
    expect(edited?.comments).toEqual([
      { id: 'c1', authorId: 'agent-a', text: 'first, corrected', createdAt: '2026-08-17T09:00:00.000Z', editedAt },
      { id: 'c2', authorId: 'user', text: 'second', createdAt: '2026-08-17T09:01:00.000Z' },
    ]);
    expect(await s.editComment(one.id, 'missing', 'x', editedAt)).toBeNull();
    expect(await s.editComment('no-such-note', 'c1', 'x', editedAt)).toBeNull();

    // Withdrawn whole: the remark leaves no tombstone, and the rest of the
    // thread keeps its order.
    const shorter = await s.deleteComment(one.id, 'c1');
    expect(shorter?.comments).toEqual([
      { id: 'c2', authorId: 'user', text: 'second', createdAt: '2026-08-17T09:01:00.000Z' },
    ]);
    expect(await s.deleteComment(one.id, 'c1')).toBeNull();
    expect(await s.deleteComment('no-such-note', 'c2')).toBeNull();
  });

  it('keeps a comment through an edit of the note it hangs off', async () => {
    const s = storage();
    const one = await write(s, 'u', '<p>Wifi is 4417</p>');
    await s.addComment(one.id, { id: 'c1', authorId: 'user', text: 'it changed', createdAt: '2026-08-17T09:00:00.000Z' });
    await s.update(one.id, { html: '<p>Wifi is 8891</p>', updatedByAgentId: 'agent-a' });

    // The remark that PROMPTED the edit must survive it: an agent answering a
    // comment by rewriting the note would otherwise delete what it answered.
    const stored = (await s.get(one.id))!;
    expect(stored.html).toBe('<p>Wifi is 8891</p>');
    expect(stored.comments?.map((c) => c.text)).toEqual(['it changed']);
  });

  it('claims, renews, expires and releases one note atomically', async () => {
    const s = storage();
    const note = await write(s, 'u', '<p>One owner</p>');
    const now = new Date('2026-08-28T20:00:00.000Z');
    const ben = { agentId: 'agent-a', userId: 'user-a', agentName: 'Ben' };
    const ada = { agentId: 'agent-b', userId: 'user-a', agentName: 'Ada' };

    const first = await s.claim(note.id, ben, now);
    expect(first).toMatchObject({ outcome: 'claimed', claim: { agentName: 'Ben' } });
    expect(await s.listActiveClaimsByUsers(['other'], new Date('2026-08-28T20:00:30.000Z'))).toEqual([]);
    expect(await s.listActiveClaimsByUsers(['u'], new Date('2026-08-28T20:00:30.000Z'))).toMatchObject([
      { id: note.id, userId: 'u', claim: { agentId: 'agent-a', agentName: 'Ben' } },
    ]);
    expect((await s.claim(note.id, ada, new Date('2026-08-28T20:01:00.000Z')))).toMatchObject({
      outcome: 'held', claim: { agentName: 'Ben' },
    });
    const renewed = await s.claim(note.id, ben, new Date('2026-08-28T20:02:00.000Z'));
    expect(renewed).toMatchObject({ outcome: 'renewed' });
    expect(renewed!.claim.expiresAt).not.toBe(first!.claim.expiresAt);

    expect(await s.releaseClaim(note.id, 'agent-b', new Date('2026-08-28T20:03:00.000Z')))
      .toMatchObject({ outcome: 'held' });
    expect(await s.releaseClaim(note.id, 'agent-a', new Date('2026-08-28T20:03:00.000Z')))
      .toMatchObject({ outcome: 'released' });
    expect((await s.get(note.id))!.claim).toBeUndefined();
    expect(await s.listActiveClaimsByUsers(['u'], new Date('2026-08-28T20:03:01.000Z'))).toEqual([]);

    await s.claim(note.id, ben, now);
    const afterExpiry = await s.claim(note.id, ada, new Date('2026-08-29T00:01:00.000Z'));
    expect(afterExpiry).toMatchObject({ outcome: 'claimed', claim: { agentName: 'Ada' } });
  });

  it('replaces a handoff with the claim that answers it (notes #234/#258)', async () => {
    const s = storage();
    const note = await write(s, 'u', '<p>Book the table</p>');
    const ben = { agentId: 'agent-a', userId: 'user-a', agentName: 'Ben' };
    await s.update(note.id, {
      handoff: {
        agentId: 'agent-a', agentName: 'Ben', userId: 'user-a',
        handedAt: '2026-08-28T20:00:00.000Z', expiresAt: '2026-08-28T22:00:00.000Z',
      },
    });
    expect((await s.get(note.id))!.handoff).toMatchObject({ agentName: 'Ben' });

    await s.claim(note.id, ben, new Date('2026-08-28T20:01:00.000Z'));
    expect((await s.get(note.id))!.handoff).toBeUndefined();

    // Which is what makes release honest: an agent that takes the note and
    // then says it is not doing this leaves it Unclaimed, not "handed to Ben"
    // for the rest of the window.
    await s.releaseClaim(note.id, 'agent-a', new Date('2026-08-28T20:02:00.000Z'));
    const after = (await s.get(note.id))!;
    expect(after.claim).toBeUndefined();
    expect(after.handoff).toBeUndefined();
  });

  it('preserves a lease across concurrent partial updates and never claims an archived note', async () => {
    const s = storage();
    const note = await write(s, 'u', '<p>Original request</p>');
    const ben = { agentId: 'agent-a', userId: 'user-a', agentName: 'Ben' };

    // This ordering reproduces the old await gap: update read the document,
    // claim landed, then update wrote its stale pre-claim copy over the lease.
    await Promise.all([
      s.update(note.id, { html: '<p>Current request</p>' }),
      s.claim(note.id, ben, new Date('2026-08-28T20:00:00.000Z')),
    ]);
    expect(await s.get(note.id)).toMatchObject({
      html: '<p>Current request</p>',
      claim: { agentId: 'agent-a' },
    });

    await s.update(note.id, { archivedAt: '2026-08-28T20:01:00.000Z' });
    await s.releaseClaim(note.id, 'agent-a', new Date('2026-08-28T20:02:00.000Z'));
    expect(await s.claim(note.id, ben, new Date('2026-08-28T20:03:00.000Z')))
      .toMatchObject({ outcome: 'archived', note: { archivedAt: expect.any(String) } });
    expect((await s.get(note.id))!.claim).toBeUndefined();
  });

  it('lists newest-changed first and deletes only what it names', async () => {
    const s = storage();
    const one = await write(s, 'u', 'One');
    await write(s, 'u', 'Two');
    await s.update(one.id, { html: '<p>One, revised</p>', updatedAt: new Date(Date.now() + 1000).toISOString() });

    expect((await s.listByUser('u')).map((d) => d.number)).toEqual([1, 2]);
    expect(await s.countByUser('u')).toBe(2);
    expect(await s.delete(one.id)).toBe(true);
    expect(await s.delete(one.id)).toBe(false);
    expect((await s.listByUser('u')).map((d) => d.number)).toEqual([2]);
  });

  /** The archive (Owner, note #23): a state on the note, so no column and no
   *  migration — which puts the whole of the split on these two lists. */
  it('keeps the archived notes out of the list, and in one of their own', async () => {
    const s = storage();
    const one = await write(s, 'u', 'One');
    const two = await write(s, 'u', 'Two');
    await s.update(two.id, { archivedAt: '2026-08-18T09:00:00.000Z', archivedByAgentId: 'agent-a' });

    expect((await s.listByUser('u')).map((d) => d.number)).toEqual([one.number]);
    expect((await s.listArchivedByUser('u')).map((d) => d.number)).toEqual([two.number]);
    // The ceiling counts the desk, not the drawer.
    expect(await s.countByUser('u')).toBe(1);
    expect(await s.countArchivedByUser('u')).toBe(1);
    // Still addressable by number — that is how it is read, restored, deleted.
    expect((await s.getByNumber('u', two.number))?.html).toBe('Two');
  });

  it('reads the archive by when it was put away, not when it was written', async () => {
    const s = storage();
    const one = await write(s, 'u', 'One');
    const two = await write(s, 'u', 'Two');
    // #1 written first but archived LAST, so it is the top of the archive:
    // what you just put away is what you are looking for.
    await s.update(two.id, { archivedAt: '2026-08-18T09:00:00.000Z' });
    await s.update(one.id, { archivedAt: '2026-08-18T10:00:00.000Z' });
    expect((await s.listArchivedByUser('u')).map((d) => d.number)).toEqual([one.number, two.number]);
  });

  it('does not hand an archived note’s number to the next note written', async () => {
    // The trap the live-only list opens: seed the counter off `listByUser`
    // and #2's number goes to #3 while #2 sits in the archive holding it.
    const s = storage();
    await write(s, 'u', 'One');
    const two = await write(s, 'u', 'Two');
    await s.update(two.id, { archivedAt: '2026-08-18T09:00:00.000Z' });
    db.prepare('DELETE FROM quick_note_numbers WHERE user_id = ?').run('u');
    expect((await write(s, 'u', 'Three')).number).toBe(3);
  });

  it('deletes one room namespace including its number counter, and leaves another alone', async () => {
    const s = storage();
    await write(s, 'room-a', 'One');
    await write(s, 'room-a', 'Two');
    const kept = await write(s, 'room-b', 'Other');
    expect(await s.deleteByUser('room-a')).toBe(2);
    expect(await s.listByUser('room-a')).toEqual([]);
    expect((await s.get(kept.id))?.html).toBe('Other');
    // The namespace itself is permanently gone. If a test reuses its id, it
    // starts clean rather than preserving invisible room state.
    expect((await write(s, 'room-a', 'Fresh room')).number).toBe(1);
  });
});

describe('SqliteGitPullRequestStorage — a workplace’s merged changes (note #925)', () => {
  it('lists every change merged in the asked namespaces, as the few fields a card needs', async () => {
    const storage = new SqliteGitPullRequestStorage(db);
    const make = (userId: string, title: string, status: string, extra: Record<string, unknown> = {}) => storage.create({
      repoId: 'repo-1', userId, title, body: 'a long body nobody reads here', sourceBranch: 'f', targetBranch: 'main',
      headSha: 'h', diffStat: { files: 1, insertions: 1, deletions: 0 }, commitSubjects: ['S'],
      createdByAgentId: 'agent-1', status, ...extra,
    } as never);
    const merged = await make('ns-1', 'Map with ETAs', 'merged', { createdByUserId: 'user-1', decidedAt: '2026-10-30T10:00:00.000Z' });
    await make('ns-1', 'Still open', 'open');
    await make('ns-1', 'Turned down', 'rejected', { decidedAt: '2026-10-30T11:00:00.000Z' });
    await make('ns-9', 'Another workplace', 'merged', { decidedAt: '2026-10-30T12:00:00.000Z' });
    // Decided in a room of the workplace, on a repository homed elsewhere.
    await make('ns-9', 'From a room', 'merged', { roomNamespaceId: 'ns-2', decidedAt: '2026-10-30T13:00:00.000Z' });

    const rows = await storage.listMergedIn(['ns-1', 'ns-2']);
    expect(rows.map((row) => row.title).sort()).toEqual(['From a room', 'Map with ETAs']);
    expect(rows.find((row) => row.id === merged.id)).toEqual({
      id: merged.id, repoId: 'repo-1', number: merged.number, title: 'Map with ETAs',
      createdByUserId: 'user-1', createdByAgentId: 'agent-1', decidedAt: '2026-10-30T10:00:00.000Z',
    });
    expect(rows.find((row) => row.title === 'From a room')).not.toHaveProperty('createdByUserId');
    expect(await storage.listMergedIn([])).toEqual([]);
  });
});

describe('SqliteGitPullRequestStorage — one implementation per note', () => {
  const proposal = (repoId: string, branch: string) => ({
    repoId,
    userId: 'room-1',
    title: 'Implement the request',
    sourceBranch: branch,
    targetBranch: 'main',
    headSha: branch.padEnd(40, 'a').slice(0, 40),
    diffStat: { files: 1, insertions: 2, deletions: 0 },
    commitSubjects: ['Implement the request'],
    quickNoteNumbers: [99],
    createdByAgentId: 'agent-a',
    status: 'open' as const,
  });

  it('refuses a second open or merged proposal across repositories, but allows a retry after rejection', async () => {
    const s = new SqliteGitPullRequestStorage(db);
    const first = await s.create(proposal('repo-1', 'first'));
    await expect(s.create(proposal('repo-2', 'second')))
      .rejects.toThrow(/note #99 already has open PR #1/);

    await s.update(first.id, { status: 'rejected' });
    const retry = await s.create(proposal('repo-2', 'second'));
    expect(retry.quickNoteNumbers).toEqual([99]);
    await s.update(retry.id, { status: 'merged', mergeCommitSha: 'c'.repeat(40) });

    await expect(s.create(proposal('repo-3', 'third')))
      .rejects.toThrow(/note #99 already has merged PR #1/);
  });

  it('prose naming a note is words, not a link — only the stored numbers conflict', async () => {
    // The guard once read “note #99” out of titles as a legacy bridge, which
    // made every mention a claim. Only what `--note` recorded fences now.
    const s = new SqliteGitPullRequestStorage(db);
    await s.create({ ...proposal('repo-1', 'legacy'), quickNoteNumbers: undefined, title: 'Ship it (note #99)' });
    await expect(s.create(proposal('repo-2', 'new'))).resolves.toBeDefined();
  });

  it('keeps numbering by repo after a room move re-keys the namespace', async () => {
    // A room move updates the repo record's userId but deliberately leaves
    // existing proposals under the namespace where they were made. Numbering
    // must follow the REPO, or the next create re-mints "PR #1" and dies on
    // the unique (repo_id, number) index — which the School room hit live on
    // 2026-08-29 as a pr-create that never answered.
    const s = new SqliteGitPullRequestStorage(db);
    const before = await s.create({ ...proposal('repo-1', 'lesson-one'), quickNoteNumbers: undefined, userId: 'old-room' });
    await s.update(before.id, { status: 'merged', mergeCommitSha: 'd'.repeat(40) });
    const after = await s.create({ ...proposal('repo-1', 'lesson-two'), quickNoteNumbers: undefined, userId: 'new-room' });
    expect(before.number).toBe(1);
    expect(after.number).toBe(2);
  });

  it('keys the duplicate guard to the note room, not the repository home (note #108)', async () => {
    const s = new SqliteGitPullRequestStorage(db);
    const first = await s.create({
      ...proposal('repo-1', 'school-one'),
      userId: 'repo-home',
      quickNoteNamespaceId: 'school-room',
    });
    const sameNumberElsewhere = await s.create({
      ...proposal('repo-2', 'sales-one'),
      userId: 'another-repo-home',
      quickNoteNamespaceId: 'sales-room',
    });
    expect(sameNumberElsewhere.number).toBe(1);

    await expect(s.create({
      ...proposal('repo-3', 'school-two'),
      userId: 'third-repo-home',
      quickNoteNamespaceId: 'school-room',
    })).rejects.toThrow(new RegExp(`note #99 already has open PR #${first.number}`));
  });

  it('lists and permanently removes proposals by their room, not the repository home', async () => {
    const s = new SqliteGitPullRequestStorage(db);
    const inRoom = await s.create({
      ...proposal('repo-1', 'room-a-change'), quickNoteNumbers: undefined,
      userId: 'repo-home', roomNamespaceId: 'room-a',
    });
    const elsewhere = await s.create({
      ...proposal('repo-1', 'room-b-change'), quickNoteNumbers: undefined,
      userId: 'repo-home', roomNamespaceId: 'room-b',
    });
    expect((await s.listByRoomNamespace('room-a')).map((doc) => doc.id)).toEqual([inRoom.id]);
    expect(await s.delete(inRoom.id)).toBe(true);
    expect(await s.delete(inRoom.id)).toBe(false);
    expect(await s.get(inRoom.id)).toBeNull();
    expect((await s.get(elsewhere.id))?.id).toBe(elsewhere.id);
  });
});

/**
 * The margin (Owner, note #66) in SQL. `addComment` is the one write two
 * hands race on — a person tapping Send and an agent mid-turn — so every
 * storage appends the whole thread inside one transaction, and none of them
 * may touch the document above the margin while doing it. Those are SQL
 * decisions, and this is where SQL decisions are checked.
 */
describe('margin comments round-trip through sqlite', () => {
  const remark = (id: string, text: string): MarginComment => ({
    id,
    authorId: 'agent-a',
    userId: 'user-1',
    text,
    // One clock for every remark: order comes from the append, never from
    // sorting timestamps, and identical stamps would expose any resort.
    createdAt: '2026-08-27T09:00:00.000Z',
  });

  it('appends to a change proposal and leaves the proposal itself as it was', async () => {
    const s = new SqliteGitPullRequestStorage(db);
    const created = await s.create({
      repoId: 'repo-1',
      userId: 'user-1',
      title: 'Fix the deploy',
      sourceBranch: 'fix-deploy',
      targetBranch: 'main',
      headSha: 'a'.repeat(40),
      diffStat: { files: 1, insertions: 2, deletions: 1 },
      commitSubjects: ['fix deploy'],
      createdByAgentId: 'agent-a',
      status: 'open',
    });

    await s.addComment(created.id, remark('c1', 'first'));
    const returned = await s.addComment(created.id, remark('c2', 'second'));
    // Oldest first: a thread reads down — in the return AND on the next get.
    expect(returned?.comments?.map((c) => c.text)).toEqual(['first', 'second']);
    const stored = (await s.get(created.id))!;
    expect(stored.comments?.map((c) => c.text)).toEqual(['first', 'second']);

    // Everything the user decides on is exactly as created: a remark is
    // about the proposal, not a change to it.
    const { comments: _comments, ...rest } = stored;
    expect(rest).toEqual(created);

    expect(await s.addComment('no-such-pr', remark('c3', 'x'))).toBeNull();

    const editedAt = '2026-08-27T09:03:00.000Z';
    const edited = await s.editComment(created.id, 'c1', 'first, corrected', editedAt);
    expect(edited?.comments).toEqual([
      { ...remark('c1', 'first, corrected'), editedAt },
      remark('c2', 'second'),
    ]);
    expect(await s.editComment(created.id, 'missing', 'x', editedAt)).toBeNull();

    expect((await s.deleteComment(created.id, 'c1'))?.comments).toEqual([remark('c2', 'second')]);
    expect(await s.deleteComment(created.id, 'c1')).toBeNull();
  });

  it('appends to a knowledge proposal and leaves the proposal itself as it was', async () => {
    const s = new SqliteKnowledgeProposalStorage(db);
    const created = await s.create({
      userId: 'user-1',
      title: 'Add the runbook',
      changes: [{ page: 'runbook', action: 'create', html: '<p>steps</p>', baseSha: null }],
      createdByAgentId: 'agent-a',
      status: 'open',
    });

    await s.addComment(created.id, remark('c1', 'first'));
    const returned = await s.addComment(created.id, remark('c2', 'second'));
    expect(returned?.comments?.map((c) => c.text)).toEqual(['first', 'second']);
    const stored = (await s.get(created.id))!;
    expect(stored.comments?.map((c) => c.text)).toEqual(['first', 'second']);

    const { comments: _comments, ...rest } = stored;
    expect(rest).toEqual(created);

    expect(await s.addComment('no-such-proposal', remark('c3', 'x'))).toBeNull();

    const editedAt = '2026-08-27T09:03:00.000Z';
    const edited = await s.editComment(created.id, 'c2', 'second, corrected', editedAt);
    expect(edited?.comments).toEqual([
      remark('c1', 'first'),
      { ...remark('c2', 'second, corrected'), editedAt },
    ]);
    expect(await s.editComment(created.id, 'missing', 'x', editedAt)).toBeNull();

    expect((await s.deleteComment(created.id, 'c2'))?.comments).toEqual([remark('c1', 'first')]);
    expect(await s.deleteComment(created.id, 'c2')).toBeNull();
  });

  it('numbers knowledge proposals as one workplace series, and finds one across rooms (note #741)', async () => {
    const s = new SqliteKnowledgeProposalStorage(db);
    const make = (userId: string, page: string, series?: { series: string; namespaces: string[] }) => s.create({
      userId, title: `Add ${page}`,
      changes: [{ page, action: 'create' as const, html: '<p>steps</p>', baseSha: null }],
      createdByAgentId: 'agent-a', status: 'open',
    }, series);
    // Growth #1 and Platform #1..#2, as before the series.
    await make('growth', 'g-one');
    await make('platform', 'p-one');
    await make('platform', 'p-two');
    const series = { series: 'org:acme', namespaces: ['platform', 'growth'] };
    expect((await make('growth', 'g-next', series)).number).toBe(3);
    expect((await make('platform', 'p-next', series)).number).toBe(4);
    db.close();
    db = openSqliteDb(dbPath);
    expect((await new SqliteKnowledgeProposalStorage(db).create({
      userId: 'growth', title: 'After reopen',
      changes: [{ page: 'g-later', action: 'create' as const, html: '<p>steps</p>', baseSha: null }],
      createdByAgentId: 'agent-a', status: 'open',
    }, series)).number).toBe(5);
    const reopened = new SqliteKnowledgeProposalStorage(db);
    expect((await reopened.findByNumber(['platform', 'growth'], 1)).map((doc) => doc.userId).sort()).toEqual(['growth', 'platform']);
    expect((await reopened.findByNumber(['platform', 'growth'], 3)).map((doc) => doc.title)).toEqual(['Add g-next']);
    // A room deleted with its proposals does not hand its numbers back.
    await reopened.deleteByUser('growth');
    expect((await reopened.create({
      userId: 'platform', title: 'After a room went',
      changes: [{ page: 'p-last', action: 'create' as const, html: '<p>steps</p>', baseSha: null }],
      createdByAgentId: 'agent-a', status: 'open',
    }, series)).number).toBe(6);
  });

  it('deletes one room namespace of knowledge proposals and no other', async () => {
    const s = new SqliteKnowledgeProposalStorage(db);
    const make = (userId: string, page: string) => s.create({
      userId, title: `Add ${page}`,
      changes: [{ page, action: 'create' as const, html: '<p>steps</p>', baseSha: null }],
      createdByAgentId: 'agent-a', status: 'open' as const,
    });
    const first = await make('room-a', 'one');
    await make('room-a', 'two');
    const kept = await make('room-b', 'three');
    expect(await s.deleteByUser('room-a')).toBe(2);
    expect(await s.get(first.id)).toBeNull();
    expect((await s.get(kept.id))?.userId).toBe('room-b');
  });

  it('keeps a page margin per (user, page) and drops it whole with the page', async () => {
    const s = new SqliteKnowledgePageCommentStorage(db);
    await s.add('user-1', 'runbook', remark('c1', 'first'));
    const thread = await s.add('user-1', 'runbook', remark('c2', 'second'));
    expect(thread.map((c) => c.text)).toEqual(['first', 'second']);
    expect((await s.list('user-1', 'runbook')).map((c) => c.text)).toEqual(['first', 'second']);

    // A page nobody has remarked on has an empty margin, not a missing one.
    expect(await s.list('user-1', 'quiet-page')).toEqual([]);

    const editedAt = '2026-08-27T09:03:00.000Z';
    const edited = await s.edit('user-1', 'runbook', 'c1', 'first, corrected', editedAt);
    expect(edited).toEqual([
      { ...remark('c1', 'first, corrected'), editedAt },
      remark('c2', 'second'),
    ]);
    expect(await s.edit('user-1', 'runbook', 'missing', 'x', editedAt)).toBeNull();

    expect(await s.remove('user-1', 'runbook', 'c1')).toEqual([remark('c2', 'second')]);
    expect(await s.list('user-1', 'runbook')).toEqual([remark('c2', 'second')]);
    expect(await s.remove('user-1', 'runbook', 'c1')).toBeNull();
    expect(await s.remove('user-1', 'quiet-page', 'c2')).toBeNull();

    // A thread dies with its page, so a page recreated under the same name
    // starts clean rather than wearing remarks about a document nobody can
    // read any more.
    await s.deletePage('user-1', 'runbook');
    expect(await s.list('user-1', 'runbook')).toEqual([]);
  });

  it('moves a page’s margin when the page is renamed, and replaces anything at the new name', async () => {
    const s = new SqliteKnowledgePageCommentStorage(db);
    await s.add('user-1', 'old-name', remark('c1', 'still true'));
    // A thread left at the destination by some earlier page: the remarks
    // arriving belong to the document that is actually there now.
    await s.add('user-1', 'new-name', remark('c2', 'about a page that is gone'));
    // Another person's margin on the same page name is untouched by ours.
    await s.add('user-2', 'old-name', remark('c3', 'someone else'));

    await s.renamePage('user-1', 'old-name', 'new-name');
    expect((await s.list('user-1', 'new-name')).map((c) => c.text)).toEqual(['still true']);
    expect(await s.list('user-1', 'old-name')).toEqual([]);
    expect((await s.list('user-2', 'old-name')).map((c) => c.text)).toEqual(['someone else']);

    // Renaming a page with no margin clears the destination rather than
    // leaving remarks about a different document under it.
    await s.renamePage('user-1', 'never-remarked', 'new-name');
    expect(await s.list('user-1', 'new-name')).toEqual([]);
  });

  it('deletes every page margin in one room namespace and leaves its neighbour', async () => {
    const s = new SqliteKnowledgePageCommentStorage(db);
    await s.add('room-a', 'one', remark('c1', 'first'));
    await s.add('room-a', 'two', remark('c2', 'second'));
    await s.add('room-b', 'one', remark('c3', 'kept'));
    expect(await s.deleteByUser('room-a')).toBe(2);
    expect(await s.list('room-a', 'one')).toEqual([]);
    expect((await s.list('room-b', 'one')).map((comment) => comment.text)).toEqual(['kept']);
  });
});
