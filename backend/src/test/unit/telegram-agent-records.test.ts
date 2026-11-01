import { describe, expect, it } from 'vitest';
import {
  TELEGRAM_AGENT_NAME_POOL,
  ensureAgentForCli,
  getTelegramAgentByCli,
  pickTelegramAgentName,
  type TelegramLinkState,
} from '../../types/user.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';

describe('telegram agent records', () => {
  describe('ensureAgentForCli — implicit default-agent creation', () => {
    it('creates a default agent for a CLI when none exists', () => {
      const result = ensureAgentForCli(undefined, 'claude', () => 'id-1');
      expect(result.created).toBe(true);
      expect(result.agentId).toBe('id-1');
      expect(result.agents['id-1']).toEqual(expect.objectContaining({
        id: 'id-1',
        cli: 'claude',
        turnCount: 0,
      }));
      // Christened from the human-name pool — never "Main"/"Agent 2".
      expect(TELEGRAM_AGENT_NAME_POOL).toContain(result.agents['id-1'].name);
      expect(result.agents['id-1'].createdAt).toEqual(expect.any(String));
    });

    it('reuses the existing agent for a CLI instead of creating a second', () => {
      const telegram: TelegramLinkState = {
        agents: {
          existing: { id: 'existing', name: 'Codex', cli: 'codex', createdAt: '2026-01-01T00:00:00.000Z' },
        },
      };
      const result = ensureAgentForCli(telegram, 'codex', () => 'should-not-be-used');
      expect(result.created).toBe(false);
      expect(result.agentId).toBe('existing');
      expect(Object.keys(result.agents)).toEqual(['existing']);
    });

    it('does not reuse a same-CLI agent pinned to another workplace', () => {
      const telegram: TelegramLinkState = {
        agents: {
          existing: {
            id: 'existing', name: 'Codex', cli: 'codex', orgId: 'org-a',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        },
      };
      const result = ensureAgentForCli(telegram, 'codex', () => 'new-in-b', 'org-b');
      expect(result.created).toBe(true);
      expect(result.agentId).toBe('new-in-b');
      expect(result.agents['new-in-b']?.orgId).toBe('org-b');
      expect(result.agents.existing?.orgId).toBe('org-a');
    });

    it('does not mutate the source agents map', () => {
      const telegram: TelegramLinkState = { agents: {} };
      const result = ensureAgentForCli(telegram, 'claude', () => 'id-1');
      expect(result.agents).not.toBe(telegram.agents);
      expect(telegram.agents).toEqual({});
    });
  });

  describe('ensureAgentForCli — uncapped', () => {
    it('creates a new agent past the old 4-agent limit (agents are uncapped)', () => {
      const agents = Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [
          `a${index}`,
          { id: `a${index}`, name: `Agent ${index}`, cli: 'codex' as const, createdAt: '2026-01-01T00:00:00.000Z' },
        ]),
      );
      const telegram: TelegramLinkState = { agents };
      const result = ensureAgentForCli(telegram, 'claude', () => 'agent-11');
      expect(result.created).toBe(true);
      expect(Object.keys(result.agents)).toHaveLength(11);
    });

    it('still returns the existing agent when one exists for the CLI', () => {
      const telegram: TelegramLinkState = {
        agents: {
          a0: { id: 'a0', name: 'Codex', cli: 'codex', createdAt: '2026-01-01T00:00:00.000Z' },
          a1: { id: 'a1', name: 'Claude Code', cli: 'claude', createdAt: '2026-01-01T00:00:00.000Z' },
          a2: { id: 'a2', name: 'Codex 2', cli: 'codex', createdAt: '2026-01-01T00:00:00.000Z' },
        },
      };
      const result = ensureAgentForCli(telegram, 'claude', () => 'overflow');
      expect(result.created).toBe(false);
      expect(result.agentId).toBe('a1');
    });
  });

  describe('agent lookup by CLI', () => {
    const telegram: TelegramLinkState = {
      agents: {
        'agent-codex': { id: 'agent-codex', name: 'Codex', cli: 'codex', createdAt: '2026-01-01T00:00:00.000Z' },
        'agent-claude': { id: 'agent-claude', name: 'Claude Code', cli: 'claude', createdAt: '2026-01-01T00:00:00.000Z' },
      },
    };

    it('finds an agent by CLI', () => {
      expect(getTelegramAgentByCli(telegram, 'codex')?.id).toBe('agent-codex');
      expect(getTelegramAgentByCli(telegram, 'claude')?.id).toBe('agent-claude');
    });
  });

  describe('updateTelegramHarnessConversation targets an explicit agent', () => {
    it('writes and clears the addressed agent conversation pointer only', async () => {
      const userStorage = new InMemoryUserStorage();
      await userStorage.createProfile('user-1', {
        email: 'user@example.com',
        displayName: 'Test User',
        telegram: {
          agents: {
            'agent-codex': { id: 'agent-codex', name: 'Codex', cli: 'codex', createdAt: '2026-01-01T00:00:00.000Z' },
            'agent-claude': { id: 'agent-claude', name: 'Claude Code', cli: 'claude', createdAt: '2026-01-01T00:00:00.000Z' },
          },
        },
      });

      await userStorage.updateTelegramHarnessConversation('user-1', { claudeSessionId: 'sess-1' }, { agentId: 'agent-claude' });
      let telegram = (await userStorage.getProfile('user-1'))?.telegram;
      expect(telegram?.agents?.['agent-claude'].conversation?.claudeSessionId).toBe('sess-1');
      // The other agent is untouched.
      expect(telegram?.agents?.['agent-codex'].conversation).toBeUndefined();

      await userStorage.updateTelegramHarnessConversation('user-1', { claudeSessionId: null }, { agentId: 'agent-claude' });
      telegram = (await userStorage.getProfile('user-1'))?.telegram;
      expect(telegram?.agents?.['agent-claude'].conversation?.claudeSessionId).toBeUndefined();
    });

    it('no-ops when no agentId is passed', async () => {
      const userStorage = new InMemoryUserStorage();
      await userStorage.createProfile('user-1', {
        email: 'user@example.com',
        displayName: 'Test User',
        telegram: {
          agents: {
            'agent-claude': { id: 'agent-claude', name: 'Claude Code', cli: 'claude', createdAt: '2026-01-01T00:00:00.000Z' },
          },
        },
      });
      await userStorage.updateTelegramHarnessConversation('user-1', { claudeSessionId: 'sess-1' });
      const telegram = (await userStorage.getProfile('user-1'))?.telegram;
      expect(telegram?.agents?.['agent-claude'].conversation).toBeUndefined();
    });
  });
  describe('pickTelegramAgentName — human-name pool', () => {
    const agentsNamed = (...names: string[]): TelegramLinkState => ({
      agents: Object.fromEntries(names.map((name, index) => [
        `a${index}`,
        { id: `a${index}`, name, cli: 'codex' as const, createdAt: '2026-01-01T00:00:00.000Z' },
      ])),
    });

    it('ships a pool of 40 distinct human names', () => {
      expect(TELEGRAM_AGENT_NAME_POOL).toHaveLength(40);
      expect(new Set(TELEGRAM_AGENT_NAME_POOL.map((name) => name.toLowerCase())).size).toBe(40);
    });

    it('picks from the pool, deterministically via the injected random', () => {
      expect(pickTelegramAgentName(undefined, () => 0)).toBe(TELEGRAM_AGENT_NAME_POOL[0]);
      // random ~1 → last available name.
      expect(pickTelegramAgentName(undefined, () => 0.999)).toBe(
        TELEGRAM_AGENT_NAME_POOL[TELEGRAM_AGENT_NAME_POOL.length - 1],
      );
    });

    it('skips names already taken, case-insensitively', () => {
      const telegram = agentsNamed(TELEGRAM_AGENT_NAME_POOL[0].toUpperCase());
      expect(pickTelegramAgentName(telegram, () => 0)).toBe(TELEGRAM_AGENT_NAME_POOL[1]);
    });

    it('never collides with existing agents across many draws', () => {
      const telegram = agentsNamed(...TELEGRAM_AGENT_NAME_POOL.slice(0, 5));
      for (let i = 0; i < 50; i += 1) {
        const picked = pickTelegramAgentName(telegram);
        expect(TELEGRAM_AGENT_NAME_POOL.slice(5)).toContain(picked);
      }
    });

    it('falls back to a numbered pool name when the pool is exhausted', () => {
      const telegram = agentsNamed(...TELEGRAM_AGENT_NAME_POOL);
      expect(pickTelegramAgentName(telegram, () => 0)).toBe(`${TELEGRAM_AGENT_NAME_POOL[0]} 41`);
    });
  });
});
