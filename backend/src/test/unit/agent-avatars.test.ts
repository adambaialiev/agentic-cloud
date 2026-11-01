import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_AGENT_AVATAR_SLUG,
  WORKSPACE_AGENT_AVATAR_SLUGS,
  pickWorkspaceAgentAvatarSlug,
  readTelegramAgentAvatar,
  readWorkspaceAgentAvatar,
  telegramAgentAvatarSlug,
  workspaceAgentAvatarSlug,
} from '../../services/telegram-agent-avatars.js';
import { TELEGRAM_AGENT_NAME_POOL } from '../../types/user.js';

// Moved here from telegram-managed-bots.test.ts when the managed bots were
// deleted (2026-10-03): the avatars outlived them — the Workspace serves them.
describe('agent avatars', () => {
  it('reads the pre-generated file for a pool name', () => {
    const avatar = readTelegramAgentAvatar('Nina');

    expect(avatar).toBeInstanceOf(Buffer);
    // JPEG magic: every file in the set is a JPEG.
    expect(avatar?.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it('is case- and whitespace-insensitive, and reuses the base dog for numbered names', () => {
    // Past forty agents pickTelegramAgentName falls back to "Kai 41".
    expect(readTelegramAgentAvatar('  kai  ')).toEqual(readTelegramAgentAvatar('Kai 41'));
  });

  it('has a face for every name in the pool', () => {
    // The pool and the assets are one feature, and nothing else couples them:
    // a name shipped without its .jpg silently shows no face, which looks
    // like a bug in the avatars rather than a missing
    // file. Before the pool passed 20 this could not happen — the 21st agent
    // was "Kai 21" and reused Kai's dog — so growing the pool is exactly when
    // the guard starts earning its keep.
    const faceless = TELEGRAM_AGENT_NAME_POOL.filter((name) => !readTelegramAgentAvatar(name));

    expect(faceless).toEqual([]);
  });

  it('returns undefined rather than throwing for a name with no avatar', () => {
    expect(readTelegramAgentAvatar('Main')).toBeUndefined();
    expect(readTelegramAgentAvatar('')).toBeUndefined();
    // Never let a name reach the filesystem as a path.
    expect(readTelegramAgentAvatar('../../package')).toBeUndefined();
  });

  it('keeps the Workspace Agent its own reserved face that no room agent can wear (note #434)', () => {
    const avatar = readWorkspaceAgentAvatar();
    expect(avatar?.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(workspaceAgentAvatarSlug()).toBe(WORKSPACE_AGENT_AVATAR_SLUG);
    // The reservation IS the hyphen: the pool's slug rule admits letters only,
    // so neither the file's own name nor the agent's display name reaches it
    // through the room-agent path, and no pool name resolves to it.
    expect(readTelegramAgentAvatar(WORKSPACE_AGENT_AVATAR_SLUG)).toBeUndefined();
    expect(readTelegramAgentAvatar('Workspace Agent')).toBeUndefined();
    expect(TELEGRAM_AGENT_NAME_POOL.map(telegramAgentAvatarSlug)).not.toContain(WORKSPACE_AGENT_AVATAR_SLUG);
  });

  it('chooses a new workplace face only from shepherds, sheepdogs and big working dogs (note #582)', () => {
    expect(WORKSPACE_AGENT_AVATAR_SLUGS).toEqual([
      'alex', 'felix', 'oscar', 'otis', 'willow',
      'stella', 'gus', 'marcus', 'greta', WORKSPACE_AGENT_AVATAR_SLUG,
    ]);
    expect(pickWorkspaceAgentAvatarSlug(() => 0)).toBe('alex');
    expect(pickWorkspaceAgentAvatarSlug(() => WORKSPACE_AGENT_AVATAR_SLUGS.length - 1))
      .toBe(WORKSPACE_AGENT_AVATAR_SLUG);
    for (const slug of WORKSPACE_AGENT_AVATAR_SLUGS) {
      expect(workspaceAgentAvatarSlug(slug)).toBe(slug);
    }
    // A corrupt or pre-feature stored value never widens the approved set.
    expect(workspaceAgentAvatarSlug('ruby')).toBe(WORKSPACE_AGENT_AVATAR_SLUG);
    expect(workspaceAgentAvatarSlug()).toBe(WORKSPACE_AGENT_AVATAR_SLUG);
  });
});
