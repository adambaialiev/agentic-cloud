import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryUserStorage } from '../../services/user-storage.js';

describe('InMemoryUserStorage', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates and reads back profiles', async () => {
    const userStorage = new InMemoryUserStorage();
    await userStorage.createProfile('user-1', {
      email: 'user@example.com',
      displayName: 'User One',
    });

    await expect(userStorage.getProfile('user-1')).resolves.toMatchObject({
      userId: 'user-1',
      email: 'user@example.com',
      displayName: 'User One',
    });
  });

  it('rejects creating a profile with a username already owned by another user', async () => {
    const userStorage = new InMemoryUserStorage();
    await userStorage.createProfile('user-1', {
      email: 'one@example.com',
      username: 'shared_name',
    });

    await expect(userStorage.createProfile('user-2', {
      email: 'two@example.com',
      username: 'shared_name',
    })).rejects.toThrow(/already in use/);
  });

  // The ops mini-app recognises the operator by the Telegram id on their own
  // account — the one Telegram lookup left.
  it('finds a user by their Telegram user id', async () => {
    const userStorage = new InMemoryUserStorage();
    await userStorage.createProfile('user-1', {
      email: 'user@example.com',
      telegram: { telegramUserId: 'tg-123' },
    });

    await expect(userStorage.findUserByTelegramUserId('tg-123')).resolves.toMatchObject({ userId: 'user-1' });
    await expect(userStorage.findUserByTelegramUserId('missing')).resolves.toBeNull();
  });

  it('deletes the stored profile and username index for a user', async () => {
    const userStorage = new InMemoryUserStorage();
    await userStorage.createProfile('user-1', {
      email: 'user@example.com',
      username: 'user_one',
    });

    await userStorage.deleteUserData('user-1');

    await expect(userStorage.getProfile('user-1')).resolves.toBeNull();
    // The username reservation is released: another user can claim it.
    await expect(userStorage.createProfile('user-2', {
      email: 'other@example.com',
      username: 'user_one',
    })).resolves.toMatchObject({ username: 'user_one' });
  });

  it('updates and clears the username lookup index', async () => {
    const userStorage = new InMemoryUserStorage();
    await userStorage.createProfile('user-1', {
      email: 'user@example.com',
      username: 'user_one',
    });

    await userStorage.updateProfile('user-1', { username: 'user_two' });
    // The old name is released; the new one is reserved.
    await expect(userStorage.createProfile('user-2', {
      email: 'other@example.com',
      username: 'user_one',
    })).resolves.toMatchObject({ username: 'user_one' });
    await expect(userStorage.createProfile('user-3', {
      email: 'third@example.com',
      username: 'user_two',
    })).rejects.toThrow(/already in use/);

    await userStorage.updateProfile('user-1', { username: undefined });
    // Clearing the username releases the reservation too.
    await expect(userStorage.createProfile('user-4', {
      email: 'fourth@example.com',
      username: 'user_two',
    })).resolves.toMatchObject({ username: 'user_two' });
    await expect(userStorage.getProfile('user-1')).resolves.toMatchObject({
      userId: 'user-1',
      username: undefined,
    });
  });

  describe('updateTelegramLinkFields', () => {
    it('writes bookkeeping fields without replacing the rest of the telegram map', async () => {
      const userStorage = new InMemoryUserStorage();
      await userStorage.createProfile('user-1', {
        email: '',
        telegram: {
          telegramUserId: 'tg-123', chatId: 'chat-456', username: 'alice',
          agents: {
            'agent-1': { id: 'agent-1', name: 'Emma', cli: 'claude', createdAt: 'x', botStatus: 'pending' },
          },
        },
      });

      await userStorage.updateTelegramLinkFields('user-1', {
        lastUserActivityAt: '2026-07-22T15:36:09.385Z',
        username: 'alice_new',
      });

      const telegram = (await userStorage.getProfile('user-1'))?.telegram;
      expect(telegram?.lastUserActivityAt).toBe('2026-07-22T15:36:09.385Z');
      expect(telegram?.username).toBe('alice_new');
      // The reserved pending agent survives the concurrent bookkeeping write.
      expect(telegram?.agents?.['agent-1']).toMatchObject({ id: 'agent-1', name: 'Emma', botStatus: 'pending' });
      expect(telegram?.chatId).toBe('chat-456');
    });

    it('deletes fields passed as null and merges onboarding stamps', async () => {
      const userStorage = new InMemoryUserStorage();
      await userStorage.createProfile('user-1', {
        email: '',
        telegram: {
          telegramUserId: 'tg-123', chatId: 'chat-456', username: 'alice', lastName: 'Smith',
          onboarding: { firstStartAt: '2026-07-22T15:35:53.281Z' },
        },
      });

      await userStorage.updateTelegramLinkFields('user-1', {
        lastName: null,
        onboarding: { firstStartAt: '2026-07-22T15:36:00.000Z' },
      });

      const telegram = (await userStorage.getProfile('user-1'))?.telegram;
      expect(telegram?.lastName).toBeUndefined();
      expect(telegram?.onboarding).toEqual({
        firstStartAt: '2026-07-22T15:35:53.281Z',
        firstStartAt: '2026-07-22T15:36:00.000Z',
      });
    });

    it('no-ops for users without a telegram link', async () => {
      const userStorage = new InMemoryUserStorage();
      await userStorage.createProfile('user-1', { email: 'user@example.com' });

      await userStorage.updateTelegramLinkFields('user-1', { lastUserActivityAt: 't' });

      const profile = await userStorage.getProfile('user-1');
      expect(profile?.telegram).toBeUndefined();
    });
  });

  describe('updateAgentFields', () => {
    const baseAgents = () => ({
      'agent-1': {
        id: 'agent-1', name: 'Kai', cli: 'claude' as const, createdAt: 'x',
        botStatus: 'pending' as const, serverId: 'fly_ia-1.aa11',
      },
      'agent-2': { id: 'agent-2', name: 'Mia', cli: 'codex' as const, createdAt: 'x', connectedAt: 't' },
    });

    it('writes lifecycle fields on one record without touching siblings or the rest of the map', async () => {
      const userStorage = new InMemoryUserStorage();
      await userStorage.createProfile('user-1', {
        email: '',
        telegram: { telegramUserId: 'tg-1', chatId: 'chat-1', lastActivityAt: 'seen', agents: baseAgents() },
      });

      const updated = await userStorage.updateAgentFields('user-1', 'agent-1', {
        oauthPendingAt: '2026-07-22T16:37:23.000Z',
      });

      expect(updated).toBe(true);
      const telegram = (await userStorage.getProfile('user-1'))?.telegram;
      expect(telegram?.agents?.['agent-1']).toMatchObject({
        oauthPendingAt: '2026-07-22T16:37:23.000Z',
        serverId: 'fly_ia-1.aa11',
        botStatus: 'pending',
      });
      expect(telegram?.agents?.['agent-2']).toMatchObject({ id: 'agent-2', connectedAt: 't' });
      expect(telegram?.lastActivityAt).toBe('seen');
    });

    it('null deletes a field (connect clears oauthPendingAt)', async () => {
      const userStorage = new InMemoryUserStorage();
      await userStorage.createProfile('user-1', {
        email: '',
        telegram: {
          telegramUserId: 'tg-1',
          agents: { 'agent-1': { ...baseAgents()['agent-1'], oauthPendingAt: 'pending' } },
        },
      });

      await userStorage.updateAgentFields('user-1', 'agent-1', {
        connectedAt: '2026-07-22T16:40:00.000Z',
        oauthPendingAt: null,
      });

      const record = (await userStorage.getProfile('user-1'))?.telegram?.agents?.['agent-1'];
      expect(record?.connectedAt).toBe('2026-07-22T16:40:00.000Z');
      expect(record?.oauthPendingAt).toBeUndefined();
    });

    it('returns false without writing when the record is missing (no resurrection)', async () => {
      const userStorage = new InMemoryUserStorage();
      await userStorage.createProfile('user-1', {
        email: '',
        telegram: { telegramUserId: 'tg-1', agents: {} },
      });

      const updated = await userStorage.updateAgentFields('user-1', 'agent-ghost', { serverId: 'fly_x.y' });

      expect(updated).toBe(false);
      expect((await userStorage.getProfile('user-1'))?.telegram?.agents).toEqual({});
    });
  });

  describe('removeTelegramAgent', () => {
    const baseAgents = () => ({
      'agent-1': { id: 'agent-1', name: 'Kai', cli: 'claude' as const, createdAt: 'x', serverId: 'fly_ia-1.aa11' },
      'agent-2': { id: 'agent-2', name: 'Mia', cli: 'codex' as const, createdAt: 'x', connectedAt: 't' },
    });

    it('deletes one record and leaves its siblings and the rest of the map alone', async () => {
      const userStorage = new InMemoryUserStorage();
      await userStorage.createProfile('user-1', {
        email: '',
        telegram: { telegramUserId: 'tg-1', chatId: 'chat-1', lastActivityAt: 'seen', agents: baseAgents() },
      });

      const removed = await userStorage.removeTelegramAgent('user-1', 'agent-1');

      expect(removed).toBe(true);
      const telegram = (await userStorage.getProfile('user-1'))?.telegram;
      expect(telegram?.agents?.['agent-1']).toBeUndefined();
      expect(telegram?.agents?.['agent-2']).toMatchObject({ id: 'agent-2', connectedAt: 't' });
      expect(telegram?.chatId).toBe('chat-1');
      expect(telegram?.lastActivityAt).toBe('seen');
    });

    it('returns false when the record is already gone (a double-tap is not an error)', async () => {
      const userStorage = new InMemoryUserStorage();
      await userStorage.createProfile('user-1', {
        email: '',
        telegram: { telegramUserId: 'tg-1', agents: {} },
      });

      expect(await userStorage.removeTelegramAgent('user-1', 'agent-ghost')).toBe(false);
    });
  });

  describe('incrementTelegramAgentTurnCount', () => {
    it('starts a legacy agent at one and increments only that record', async () => {
      const userStorage = new InMemoryUserStorage();
      await userStorage.createProfile('user-1', {
        email: '',
        telegram: {
          telegramUserId: 'tg-1',
          agents: {
            'agent-1': { id: 'agent-1', name: 'Kai', cli: 'claude', createdAt: 'x' },
            'agent-2': { id: 'agent-2', name: 'Mia', cli: 'codex', createdAt: 'x', turnCount: 7 },
          },
        },
      });

      await expect(userStorage.incrementTelegramAgentTurnCount('user-1', 'agent-1')).resolves.toBe(1);
      await expect(userStorage.incrementTelegramAgentTurnCount('user-1', 'agent-1')).resolves.toBe(2);
      await expect(userStorage.incrementTelegramAgentTurnCount('user-1', 'missing')).resolves.toBeNull();

      const agents = (await userStorage.getProfile('user-1'))?.telegram?.agents;
      expect(agents?.['agent-1']?.turnCount).toBe(2);
      expect(agents?.['agent-2']?.turnCount).toBe(7);
    });
  });

});
