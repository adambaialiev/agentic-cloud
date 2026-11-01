import { describe, expect, it } from 'vitest';
import {
  agentbuiltTokenMatches,
  hashAgentbuiltToken,
  mintAgentbuiltToken,
  parseAgentbuiltToken,
} from '../../services/agentbuilt-token.js';

describe('agentbuilt tokens', () => {
  it('round-trips the ids and verifies against the stored hash', () => {
    const { token, tokenHash } = mintAgentbuiltToken('user-1', 'agent-a');
    expect(parseAgentbuiltToken(token)).toEqual({ userId: 'user-1', agentId: 'agent-a' });
    expect(agentbuiltTokenMatches(token, tokenHash)).toBe(true);
  });

  it('the claim inside the token is worthless without the matching hash', () => {
    const alice = mintAgentbuiltToken('user-1', 'agent-a');
    // An attacker who KNOWS the ids can forge a parseable token — but it
    // hashes differently, so verification is what actually gates access.
    const forged = mintAgentbuiltToken('user-1', 'agent-a');
    expect(parseAgentbuiltToken(forged.token)).toEqual({ userId: 'user-1', agentId: 'agent-a' });
    expect(agentbuiltTokenMatches(forged.token, alice.tokenHash)).toBe(false);
  });

  it('rejects malformed and tampered tokens', () => {
    expect(parseAgentbuiltToken('')).toBeNull();
    expect(parseAgentbuiltToken('not-a-token')).toBeNull();
    expect(parseAgentbuiltToken('agb1.%%%')).toBeNull();
    const { token, tokenHash } = mintAgentbuiltToken('user-1', 'agent-a');
    expect(agentbuiltTokenMatches(`${token}x`, tokenHash)).toBe(false);
    expect(agentbuiltTokenMatches(token, undefined)).toBe(false);
    expect(agentbuiltTokenMatches(token, hashAgentbuiltToken('other'))).toBe(false);
  });

  // Regression: the secret is base64url, whose alphabet includes '_' — with
  // '_' as separator ~40% of minted tokens failed their own parse.
  it('every minted token parses, whatever the random secret contains', () => {
    for (let i = 0; i < 200; i += 1) {
      const { token } = mintAgentbuiltToken('user-1', 'agent-a');
      expect(parseAgentbuiltToken(token)).toEqual({ userId: 'user-1', agentId: 'agent-a' });
    }
  });

  it('minting twice rotates: two tokens never share a hash', () => {
    const first = mintAgentbuiltToken('user-1', 'agent-a');
    const second = mintAgentbuiltToken('user-1', 'agent-a');
    expect(first.token).not.toBe(second.token);
    expect(first.tokenHash).not.toBe(second.tokenHash);
  });
});
