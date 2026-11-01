import { describe, expect, it } from 'vitest';
import { InMemorySecretStorage } from '../../services/secret-storage.js';
import {
  MAX_USER_SECRETS,
  MAX_USER_SECRET_VALUE_BYTES,
  SHARED_USER_SECRET_SCOPE,
  UserSecretsService,
  agentUserSecretScope,
  describeUserSecretScope,
  isUserSecretStorageKey,
  maskSecretPreview,
  maskSecretValue,
  parseUserSecretStorageKey,
  resolveUserSecretEnv,
  secretValueKind,
  validateUserSecretDescription,
  validateUserSecretName,
} from '../../services/user-secrets.js';
import { buildTurnEnvExports } from '../../agent/harness-turn-output.js';

const USER = 'user_1';
const AGENT_A = '11111111-1111-4111-8111-111111111111';
const AGENT_B = '22222222-2222-4222-8222-222222222222';

function makeService(): { service: UserSecretsService; storage: InMemorySecretStorage } {
  const storage = new InMemorySecretStorage();
  return { service: new UserSecretsService(storage), storage };
}

describe('user secret names', () => {
  it('accepts ordinary environment variable names', () => {
    for (const name of ['GH_TOKEN', 'OPENAI_API_KEY', '_private', 'a1']) {
      expect(validateUserSecretName(name), name).toEqual({ ok: true, name });
    }
  });

  it('trims surrounding whitespace before validating', () => {
    expect(validateUserSecretName('  GH_TOKEN  ')).toEqual({ ok: true, name: 'GH_TOKEN' });
  });

  it('refuses names that would inject shell into the launch script', () => {
    // Each of these lands in `export <name>=...`, so anything but a bare
    // identifier is a command the user gets to run inside their own turn.
    for (const name of ['A;rm -rf /', 'A B', 'A$(id)', 'A`id`', 'A=B', 'A\nB', '../x', '']) {
      expect(validateUserSecretName(name).ok, JSON.stringify(name)).toBe(false);
    }
  });

  it('refuses names starting with a digit', () => {
    expect(validateUserSecretName('1PASSWORD').ok).toBe(false);
  });

  it('refuses names the agent runtime depends on, case-insensitively', () => {
    for (const name of ['PATH', 'path', 'HOME', 'LD_PRELOAD', 'NODE_OPTIONS', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      expect(validateUserSecretName(name).ok, name).toBe(false);
    }
  });
});

describe('maskSecretValue', () => {
  it('masks short values whole, since a prefix would spell them out', () => {
    expect(maskSecretValue('hunter2')).toBe('•'.repeat(7));
    expect(maskSecretValue('12345678')).toBe('•'.repeat(8));
  });

  it('shows only enough of a long value to tell keys apart', () => {
    const masked = maskSecretValue('ghp_abcdefghijklmnop');
    expect(masked).toBe('ghp…op (20 chars)');
    expect(masked).not.toContain('abcdefghijkl');
  });

  it('renders an empty value without an empty string', () => {
    expect(maskSecretValue('')).toBe('•');
  });
});

describe('secret values as they arrive from the Workspace paste box', () => {
  // The add form is now the only way a user saves a key, and a paste box is
  // exactly where a stray trailing newline comes from — so the value is stored
  // as given, minus that one newline.
  it('strips only the trailing newline a paste carries', async () => {
    // Interior and leading whitespace can be significant (a PEM body), so only
    // the one trailing newline goes.
    const { service } = makeService();
    await service.setSecret(USER, 'ONE_LINE', 'abc\n');
    await service.setSecret(USER, 'PADDED', '  abc  ');
    await service.setSecret(USER, 'MULTI_LINE', 'a\nb\n');

    expect(await service.getSecretValue(USER, 'ONE_LINE', SHARED_USER_SECRET_SCOPE)).toBe('abc');
    expect(await service.getSecretValue(USER, 'PADDED', SHARED_USER_SECRET_SCOPE)).toBe('  abc  ');
    expect(await service.getSecretValue(USER, 'MULTI_LINE', SHARED_USER_SECRET_SCOPE)).toBe('a\nb');
  });

  it('keeps a value that is nothing but a newline out of storage', async () => {
    const { service } = makeService();
    expect((await service.setSecret(USER, 'EMPTY', '\n')).ok).toBe(false);
  });
});

describe('validateUserSecretDescription', () => {
  it('collapses a pasted paragraph into one display line', () => {
    expect(validateUserSecretDescription('  GitHub token\nfor  pushing\tto repos  '))
      .toEqual({ ok: true, description: 'GitHub token for pushing to repos' });
  });

  it('refuses empty and whitespace-only text', () => {
    for (const raw of ['', '   ', '\n\t']) {
      expect(validateUserSecretDescription(raw).ok).toBe(false);
    }
  });

  it('refuses text past the ceiling', () => {
    expect(validateUserSecretDescription('x'.repeat(201)).ok).toBe(false);
    expect(validateUserSecretDescription('x'.repeat(200)).ok).toBe(true);
  });
});

describe('UserSecretsService descriptions', () => {
  it('stores a description on create and lists it back', async () => {
    const { service } = makeService();
    await service.setSecret(USER, 'GH_TOKEN', 'ghp_x', SHARED_USER_SECRET_SCOPE, 'GitHub token for pushing');

    const [listed] = await service.listSecrets(USER);
    expect(listed.description).toBe('GitHub token for pushing');
  });

  it('keeps the description when a key is rotated without one', async () => {
    const { service } = makeService();
    await service.setSecret(USER, 'GH_TOKEN', 'old', SHARED_USER_SECRET_SCOPE, 'GitHub token for pushing');
    await service.setSecret(USER, 'GH_TOKEN', 'new');

    const [listed] = await service.listSecrets(USER);
    expect(listed.description).toBe('GitHub token for pushing');
    expect(await service.getSecretEnv(USER)).toEqual({ GH_TOKEN: 'new' });
  });

  it('replaces the description when a rotate provides a new one', async () => {
    const { service } = makeService();
    await service.setSecret(USER, 'GH_TOKEN', 'old', SHARED_USER_SECRET_SCOPE, 'old purpose');
    await service.setSecret(USER, 'GH_TOKEN', 'new', SHARED_USER_SECRET_SCOPE, 'new purpose');

    const [listed] = await service.listSecrets(USER);
    expect(listed.description).toBe('new purpose');
  });

  it('refuses a set whose description fails validation, before writing anything', async () => {
    const { service } = makeService();
    const result = await service.setSecret(USER, 'GH_TOKEN', 'v', SHARED_USER_SECRET_SCOPE, 'x'.repeat(201));
    expect(result.ok).toBe(false);
    expect(await service.listSecrets(USER)).toHaveLength(0);
  });

  it('describeSecret annotates without touching the value or the last-changed time', async () => {
    const { service, storage } = makeService();
    await service.setSecret(USER, 'GH_TOKEN', 'ghp_x', SHARED_USER_SECRET_SCOPE, 'old purpose');
    const before = (await storage.getUserSecrets(USER))[0].updatedAt;

    expect(await service.describeSecret(USER, 'GH_TOKEN', 'corrected purpose')).toMatchObject({ ok: true });

    const [row] = await storage.getUserSecrets(USER);
    expect(row.description).toBe('corrected purpose');
    expect(row.value).toBe('ghp_x');
    // "Last changed" answers "is this the new key or the rotated one?" —
    // annotating a row rotates nothing.
    expect(row.updatedAt).toBe(before);
  });

  it('describeSecret is scope-specific and reports a miss as notFound', async () => {
    const { service } = makeService();
    await service.setSecret(USER, 'GH_TOKEN', 'shared', SHARED_USER_SECRET_SCOPE, 'shared purpose');

    const missed = await service.describeSecret(USER, 'GH_TOKEN', 'private note', agentUserSecretScope(AGENT_A));
    expect(missed).toMatchObject({ ok: false, notFound: true });
    // The shared row is untouched: describing a private copy that does not
    // exist must never silently annotate the shared one.
    const [listed] = await service.listSecrets(USER);
    expect(listed.description).toBe('shared purpose');
  });
});

describe('UserSecretsService', () => {
  it('round-trips a secret and exposes it as turn environment', async () => {
    const { service } = makeService();

    expect(await service.setSecret(USER, 'GH_TOKEN', 'ghp_secret')).toEqual({
      ok: true,
      created: true,
      name: 'GH_TOKEN',
      scope: SHARED_USER_SECRET_SCOPE,
    });
    expect(await service.getSecretEnv(USER)).toEqual({ GH_TOKEN: 'ghp_secret' });
  });

  it('never returns plaintext from the listing', async () => {
    const { service } = makeService();
    await service.setSecret(USER, 'GH_TOKEN', 'ghp_supersecretvalue');

    const listed = await service.listSecrets(USER);
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe('GH_TOKEN');
    expect(JSON.stringify(listed)).not.toContain('supersecret');
  });

  it('overwrites on repeat set, so rotating a key works', async () => {
    const { service } = makeService();
    await service.setSecret(USER, 'GH_TOKEN', 'old');

    expect(await service.setSecret(USER, 'GH_TOKEN', 'new')).toEqual({
      ok: true,
      created: false,
      name: 'GH_TOKEN',
      scope: SHARED_USER_SECRET_SCOPE,
    });
    expect(await service.getSecretEnv(USER)).toEqual({ GH_TOKEN: 'new' });
    expect(await service.listSecrets(USER)).toHaveLength(1);
  });

  it('keeps one user out of another user\'s secrets', async () => {
    const { service } = makeService();
    await service.setSecret(USER, 'GH_TOKEN', 'mine');

    expect(await service.getSecretEnv('user_2')).toEqual({});
    expect(await service.listSecrets('user_2')).toEqual([]);
  });

  it('cannot overwrite a platform credential by naming a secret after it', async () => {
    // The regression this whole prefix exists for: user secrets share storage
    // with the CLI credentials, so an unprefixed write would hand a user the
    // ability to replace the token their own harness authenticates with.
    const { service, storage } = makeService();
    await storage.createSecret(USER, { key: 'claude-oauth-token', value: 'platform-owned' });

    await service.setSecret(USER, 'claude_oauth_token', 'attacker');

    expect((await storage.getSecretByKey(USER, 'claude-oauth-token'))?.value).toBe('platform-owned');
  });

  it('ignores platform credentials when building the turn environment', async () => {
    const { service, storage } = makeService();
    await storage.createSecret(USER, { key: 'claude-oauth-token', value: 'platform-owned' });
    await storage.createSecret(USER, { key: 'codex-auth-json', value: '{}' });
    await service.setSecret(USER, 'GH_TOKEN', 'mine');

    expect(await service.getSecretEnv(USER)).toEqual({ GH_TOKEN: 'mine' });
  });

  it('drops a stored name that would not validate today', async () => {
    // Defense in depth: a row written by an older or buggier path must not
    // become shell injection in the launch script.
    const { service, storage } = makeService();
    await storage.createSecret(USER, { key: 'user-env:BAD;rm -rf /', value: 'x' });
    await service.setSecret(USER, 'GOOD', 'y');

    expect(await service.getSecretEnv(USER)).toEqual({ GOOD: 'y' });
  });

  it('caps how many secrets one user can create', async () => {
    const { service } = makeService();
    for (let index = 0; index < MAX_USER_SECRETS; index += 1) {
      expect((await service.setSecret(USER, `KEY_${index}`, 'v')).ok).toBe(true);
    }

    const overflow = await service.setSecret(USER, 'ONE_TOO_MANY', 'v');
    expect(overflow.ok).toBe(false);
  });

  it('still allows rotating an existing secret at the cap', async () => {
    const { service } = makeService();
    for (let index = 0; index < MAX_USER_SECRETS; index += 1) {
      await service.setSecret(USER, `KEY_${index}`, 'v');
    }

    expect((await service.setSecret(USER, 'KEY_0', 'rotated')).ok).toBe(true);
    expect((await service.getSecretEnv(USER)).KEY_0).toBe('rotated');
  });

  it('refuses a value past the size ceiling', async () => {
    const { service } = makeService();
    const tooBig = 'x'.repeat(MAX_USER_SECRET_VALUE_BYTES + 1);

    expect((await service.setSecret(USER, 'BIG', tooBig)).ok).toBe(false);
  });

  it('reports whether a delete matched anything', async () => {
    const { service } = makeService();
    await service.setSecret(USER, 'GH_TOKEN', 'v');

    expect(await service.deleteSecret(USER, 'GH_TOKEN')).toBe(true);
    expect(await service.deleteSecret(USER, 'GH_TOKEN')).toBe(false);
    expect(await service.deleteSecret(USER, 'never-existed')).toBe(false);
    expect(await service.getSecretEnv(USER)).toEqual({});
  });

  it('leaves platform credentials alone on delete', async () => {
    const { service, storage } = makeService();
    await storage.createSecret(USER, { key: 'claude-oauth-token', value: 'platform-owned' });

    expect(await service.deleteSecret(USER, 'claude_oauth_token')).toBe(false);
    expect((await storage.getSecretByKey(USER, 'claude-oauth-token'))?.value).toBe('platform-owned');
  });

  it('recognizes its own storage keys', () => {
    expect(isUserSecretStorageKey('user-env:GH_TOKEN')).toBe(true);
    expect(isUserSecretStorageKey('claude-oauth-token')).toBe(false);
  });
});

describe('resolveUserSecretEnv', () => {
  it('returns an empty environment when no storage is configured', async () => {
    expect(await resolveUserSecretEnv(undefined, USER, undefined, { ownerIsAdmin: true })).toEqual({});
  });

  it('degrades to an empty environment rather than failing the turn', async () => {
    const broken = {
      getUserSecrets: async () => {
        throw new Error('storage down');
      },
    } as never;

    expect(await resolveUserSecretEnv(broken, USER, undefined, { ownerIsAdmin: true })).toEqual({});
  });
});

describe('buildTurnEnvExports', () => {
  it('emits nothing when there is no environment', () => {
    expect(buildTurnEnvExports(undefined)).toEqual([]);
    expect(buildTurnEnvExports({})).toEqual([]);
  });

  it('single-quotes values so the shell cannot expand them', () => {
    expect(buildTurnEnvExports({ GH_TOKEN: 'ghp_abc' })).toEqual(["export GH_TOKEN='ghp_abc'"]);
  });

  it('neutralizes a value that would otherwise execute', () => {
    const [line] = buildTurnEnvExports({ EVIL: '$(rm -rf /)`id`' });
    expect(line).toBe("export EVIL='$(rm -rf /)`id`'");
  });

  it('closes and reopens quoting around an embedded single quote', () => {
    // The classic break-out: a bare ' would end the quoted string early.
    expect(buildTurnEnvExports({ K: "a'b" })).toEqual([`export K='a'"'"'b'`]);
  });

  it('skips a name that is not a bare identifier', () => {
    expect(buildTurnEnvExports({ 'BAD;id': 'x', GOOD: 'y' })).toEqual(["export GOOD='y'"]);
  });
});

describe('secret scope', () => {
  it('round-trips both storage shapes', () => {
    expect(parseUserSecretStorageKey('user-env:GH_TOKEN')).toEqual({
      scope: SHARED_USER_SECRET_SCOPE,
      name: 'GH_TOKEN',
    });
    expect(parseUserSecretStorageKey(`user-env@${AGENT_A}:GH_TOKEN`)).toEqual({
      scope: agentUserSecretScope(AGENT_A),
      name: 'GH_TOKEN',
    });
  });

  it('still recognizes pre-scoping rows as shared, so nothing needs migrating', () => {
    expect(isUserSecretStorageKey('user-env:GH_TOKEN')).toBe(true);
    expect(parseUserSecretStorageKey('user-env:GH_TOKEN')?.scope).toEqual(SHARED_USER_SECRET_SCOPE);
  });

  it('refuses platform credentials and malformed scoped keys', () => {
    expect(parseUserSecretStorageKey('claude-oauth-token')).toBeNull();
    expect(parseUserSecretStorageKey('user-env@no-colon-here')).toBeNull();
    expect(parseUserSecretStorageKey('user-env@:NAME')).toBeNull();
  });

  it('describes a scope in words for chat replies', () => {
    expect(describeUserSecretScope(SHARED_USER_SECRET_SCOPE)).toBe('all agents in this workplace');
    expect(describeUserSecretScope(agentUserSecretScope(AGENT_A), 'Nova')).toBe('Nova only');
    expect(describeUserSecretScope(agentUserSecretScope(AGENT_A))).toBe('this agent only');
  });
});

describe('getSecretValue', () => {
  it('reads one secret back per scope, and null when that scope has none', async () => {
    const { service } = makeService();
    await service.setSecret(USER, 'GH_TOKEN', 'shared-token');
    await service.setSecret(USER, 'GH_TOKEN', 'agent-a-token', agentUserSecretScope(AGENT_A));

    expect(await service.getSecretValue(USER, 'GH_TOKEN')).toBe('shared-token');
    expect(await service.getSecretValue(USER, 'GH_TOKEN', agentUserSecretScope(AGENT_A))).toBe('agent-a-token');
    // No fallback to the shared copy: an agent scope that has nothing has nothing.
    expect(await service.getSecretValue(USER, 'GH_TOKEN', agentUserSecretScope(AGENT_B))).toBeNull();
    expect(await service.getSecretValue(USER, 'NEVER_SET')).toBeNull();
  });

  it('never reads across users, and never accepts a name it would not have written', async () => {
    const { service } = makeService();
    await service.setSecret(USER, 'GH_TOKEN', 'shared-token');

    expect(await service.getSecretValue('user_2', 'GH_TOKEN')).toBeNull();
    expect(await service.getSecretValue(USER, 'bad name')).toBeNull();
    expect(await service.getSecretValue(USER, 'PATH')).toBeNull();
  });
});

describe('scoped secrets in a turn', () => {
  it('gives an agent the shared secrets plus its own', async () => {
    const { service } = makeService();
    await service.setSecret(USER, 'SHARED_KEY', 'shared-value');
    await service.setSecret(USER, 'PRIVATE_KEY', 'a-value', agentUserSecretScope(AGENT_A));

    expect(await service.getSecretEnv(USER, AGENT_A)).toEqual({
      SHARED_KEY: 'shared-value',
      PRIVATE_KEY: 'a-value',
    });
  });

  it("never exports one agent's private secret into another agent's turn", async () => {
    // This is the assertion that makes scoping mean anything.
    const { service } = makeService();
    await service.setSecret(USER, 'SHARED_KEY', 'shared-value');
    await service.setSecret(USER, 'A_ONLY', 'a-secret', agentUserSecretScope(AGENT_A));

    expect(await service.getSecretEnv(USER, AGENT_B)).toEqual({ SHARED_KEY: 'shared-value' });
  });

  it('lets an agent override a shared secret of the same name', async () => {
    const { service } = makeService();
    await service.setSecret(USER, 'GH_TOKEN', 'shared-token');
    await service.setSecret(USER, 'GH_TOKEN', 'agent-a-token', agentUserSecretScope(AGENT_A));

    expect((await service.getSecretEnv(USER, AGENT_A)).GH_TOKEN).toBe('agent-a-token');
    // The shared one is shadowed, not replaced — everyone else still gets it.
    expect((await service.getSecretEnv(USER, AGENT_B)).GH_TOKEN).toBe('shared-token');
    expect((await service.getSecretEnv(USER)).GH_TOKEN).toBe('shared-token');
  });

  it('exports only shared secrets when the turn has no agent', async () => {
    // The setup/concierge loop runs without a pinned agent; it must not inherit
    // some arbitrary agent's private keys.
    const { service } = makeService();
    await service.setSecret(USER, 'SHARED_KEY', 'shared-value');
    await service.setSecret(USER, 'A_ONLY', 'a-secret', agentUserSecretScope(AGENT_A));

    expect(await service.getSecretEnv(USER)).toEqual({ SHARED_KEY: 'shared-value' });
  });

  it('passes the agent through resolveUserSecretEnv', async () => {
    const { service, storage } = makeService();
    await service.setSecret(USER, 'A_ONLY', 'a-secret', agentUserSecretScope(AGENT_A));

    expect(await resolveUserSecretEnv(storage, USER, AGENT_A, { ownerIsAdmin: true })).toEqual({ A_ONLY: 'a-secret' });
    expect(await resolveUserSecretEnv(storage, USER, AGENT_B, { ownerIsAdmin: true })).toEqual({});
  });
});

describe('managing scoped secrets', () => {
  it('keeps scopes independent when writing', async () => {
    const { service } = makeService();
    await service.setSecret(USER, 'GH_TOKEN', 'shared');
    const scoped = await service.setSecret(USER, 'GH_TOKEN', 'private', agentUserSecretScope(AGENT_A));

    expect(scoped).toEqual({
      ok: true,
      created: true,
      name: 'GH_TOKEN',
      scope: agentUserSecretScope(AGENT_A),
    });
    expect(await service.listSecrets(USER)).toHaveLength(2);
  });

  it('deletes only the scope asked for', async () => {
    const { service } = makeService();
    await service.setSecret(USER, 'GH_TOKEN', 'shared');
    await service.setSecret(USER, 'GH_TOKEN', 'private', agentUserSecretScope(AGENT_A));

    expect(await service.deleteSecret(USER, 'GH_TOKEN', agentUserSecretScope(AGENT_A))).toBe(true);
    // The shared one must survive an agent-scoped delete.
    expect((await service.getSecretEnv(USER)).GH_TOKEN).toBe('shared');
  });

  it('reports a miss rather than falling back to the shared secret', async () => {
    const { service } = makeService();
    await service.setSecret(USER, 'GH_TOKEN', 'shared');

    expect(await service.deleteSecret(USER, 'GH_TOKEN', agentUserSecretScope(AGENT_A))).toBe(false);
    expect((await service.getSecretEnv(USER)).GH_TOKEN).toBe('shared');
  });

  it('counts the ceiling across all scopes', async () => {
    // Per-scope counting would let the cap be multiplied by agent count.
    const { service } = makeService();
    for (let index = 0; index < MAX_USER_SECRETS; index += 1) {
      await service.setSecret(USER, `KEY_${index}`, 'v', agentUserSecretScope(AGENT_A));
    }

    expect((await service.setSecret(USER, 'SHARED_ONE', 'v')).ok).toBe(false);
  });

  it('drops an agent\'s secrets when the agent is deleted, sparing shared ones', async () => {
    const { service } = makeService();
    await service.setSecret(USER, 'SHARED_KEY', 'shared');
    await service.setSecret(USER, 'A_ONE', 'x', agentUserSecretScope(AGENT_A));
    await service.setSecret(USER, 'A_TWO', 'y', agentUserSecretScope(AGENT_A));
    await service.setSecret(USER, 'B_ONE', 'z', agentUserSecretScope(AGENT_B));

    expect(await service.deleteAgentSecrets(USER, AGENT_A)).toBe(2);
    expect(await service.getSecretEnv(USER, AGENT_B)).toEqual({ SHARED_KEY: 'shared', B_ONE: 'z' });
    expect(await service.getSecretEnv(USER, AGENT_A)).toEqual({ SHARED_KEY: 'shared' });
  });

  it('leaves platform credentials alone when clearing an agent', async () => {
    const { service, storage } = makeService();
    await storage.createSecret(USER, { key: 'claude-oauth-token', value: 'platform-owned' });
    await service.setSecret(USER, 'A_ONE', 'x', agentUserSecretScope(AGENT_A));

    expect(await service.deleteAgentSecrets(USER, AGENT_A)).toBe(1);
    expect((await storage.getSecretByKey(USER, 'claude-oauth-token'))?.value).toBe('platform-owned');
  });
});

describe('listing with scope', () => {
  it('shows every scope in the concierge view', async () => {
    const { service } = makeService();
    await service.setSecret(USER, 'SHARED_KEY', 'shared');
    await service.setSecret(USER, 'A_ONLY', 'x', agentUserSecretScope(AGENT_A));

    const listed = await service.listSecrets(USER);
    expect(listed.map((s) => [s.name, s.scope])).toEqual([
      ['A_ONLY', agentUserSecretScope(AGENT_A)],
      ['SHARED_KEY', SHARED_USER_SECRET_SCOPE],
    ]);
  });

  it("narrows to what one agent can see, hiding another agent's", async () => {
    const { service } = makeService();
    await service.setSecret(USER, 'SHARED_KEY', 'shared');
    await service.setSecret(USER, 'A_ONLY', 'x', agentUserSecretScope(AGENT_A));
    await service.setSecret(USER, 'B_ONLY', 'y', agentUserSecretScope(AGENT_B));

    expect((await service.listSecrets(USER, AGENT_A)).map((s) => s.name)).toEqual(['A_ONLY', 'SHARED_KEY']);
  });

  it('flags a shared secret the agent overrides, rather than hiding it', async () => {
    const { service } = makeService();
    await service.setSecret(USER, 'GH_TOKEN', 'shared');
    await service.setSecret(USER, 'GH_TOKEN', 'private', agentUserSecretScope(AGENT_A));

    const listed = await service.listSecrets(USER, AGENT_A);
    const shared = listed.find((s) => s.scope.kind === 'shared');
    const scoped = listed.find((s) => s.scope.kind === 'agent');
    expect(shared?.shadowedByAgentScope).toBe(true);
    expect(scoped?.shadowedByAgentScope).toBeUndefined();
  });

  it('never leaks a value through the listing, in any scope', async () => {
    const { service } = makeService();
    await service.setSecret(USER, 'A_ONLY', 'supersecretvalue-aaa', agentUserSecretScope(AGENT_A));

    expect(JSON.stringify(await service.listSecrets(USER))).not.toContain('supersecret');
    expect(JSON.stringify(await service.listSecrets(USER, AGENT_A))).not.toContain('supersecret');
  });

  /**
   * The concierge listing — no agent named — is what the Workspace shows, and
   * it is precisely where "this shared key does not reach Leo" matters. The
   * per-agent flag cannot answer that question, because there is no "here".
   */
  it('names the agents overriding a shared secret even when no agent was asked about', async () => {
    const { service } = makeService();
    await service.setSecret(USER, 'GH_TOKEN', 'shared');
    await service.setSecret(USER, 'GH_TOKEN', 'a-private', agentUserSecretScope(AGENT_A));
    await service.setSecret(USER, 'GH_TOKEN', 'b-private', agentUserSecretScope(AGENT_B));
    await service.setSecret(USER, 'FLY_API_TOKEN', 'nobody-overrides-this');

    const listed = await service.listSecrets(USER);
    const shared = listed.find((s) => s.name === 'GH_TOKEN' && s.scope.kind === 'shared');
    expect(shared?.shadowedByAgentIds).toEqual([AGENT_A, AGENT_B]);
    // Unshadowed rows stay silent, and the per-agent flag is untouched here.
    expect(listed.find((s) => s.name === 'FLY_API_TOKEN')?.shadowedByAgentIds).toBeUndefined();
    expect(shared?.shadowedByAgentScope).toBeUndefined();
    // An agent-scoped row is never itself "shadowed" — it IS the override.
    expect(listed.find((s) => s.scope.kind === 'agent')?.shadowedByAgentIds).toBeUndefined();
  });

  it('names the format in the mask itself, so the CLI and chat stop printing "---…--"', async () => {
    const { service } = makeService();
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----';
    await service.setSecret(USER, 'HETZNER_SSH_PRIVATE_KEY', key);

    const [listed] = await service.listSecrets(USER);
    // Every PEM on earth masks to the same "---…--"; its format's name does not.
    expect(listed?.maskedValue).toBe(`OpenSSH private key (${[...key].length} chars)`);
    expect(listed?.maskedValue).not.toContain('b3BlbnNzaC1rZXktdjEAAAAA');
  });

  it('summarises a value by length and shape, without disclosing it', async () => {
    const { service } = makeService();
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----';
    await service.setSecret(USER, 'HETZNER_SSH_PRIVATE_KEY', key);
    await service.setSecret(USER, 'GH_TOKEN', 'ghp_averyordinarylookingtoken');

    const listed = await service.listSecrets(USER);
    const pem = listed.find((s) => s.name === 'HETZNER_SSH_PRIVATE_KEY');
    const token = listed.find((s) => s.name === 'GH_TOKEN');
    expect(pem?.valueKind).toBe('OpenSSH private key');
    expect(pem?.valueLength).toBe([...key].length);
    expect(token?.valueKind).toBeUndefined();
    expect(token?.valueLength).toBe(29);
    expect(token?.maskedPreview).toBe('ghp…en');
    // The preview is the mask without the count — the same characters, no more.
    expect(token?.maskedValue).toBe('ghp…en (29 chars)');
  });
});

describe('secret value shape', () => {
  it('names a format that announces itself, and stays quiet otherwise', () => {
    expect(secretValueKind('-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----'))
      .toBe('OpenSSH private key');
    expect(secretValueKind('-----BEGIN RSA PRIVATE KEY-----\nx')).toBe('PEM private key');
    expect(secretValueKind('-----BEGIN CERTIFICATE-----\nx')).toBe('Certificate');
    expect(secretValueKind('ssh-ed25519 AAAAC3Nz user@host')).toBe('SSH public key');
    expect(secretValueKind('{\n "type": "service_account"\n}')).toBe('JSON file');
    expect(secretValueKind('ghp_ordinary_token')).toBeUndefined();
    expect(secretValueKind('')).toBeUndefined();
  });

  it('reads only the first line, so the label can never carry key material', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nSECRETMATERIAL\n-----END OPENSSH PRIVATE KEY-----';
    expect(secretValueKind(key)).not.toContain('SECRETMATERIAL');
  });

  it('masks a short value whole, where a prefix would spell it out', () => {
    expect(maskSecretPreview('hunter2')).toBe('•••••••');
    expect(maskSecretPreview('')).toBe('•');
    expect(maskSecretPreview('abcdefghij')).toBe('abc…ij');
  });
});

// Note #655: a key on an agent's machine is a key its owner can read, so
// "members never see values" is only true of keys their agents are never
// handed. The audience line is applied where the value leaves storage.
describe('audience: whose agents a shared key reaches', () => {
  it('defaults a new shared key to admins\' agents only, and lists that', async () => {
    const { service } = makeService();
    await service.setSecret(USER, 'FLY_TOKEN', 'fly-value', SHARED_USER_SECRET_SCOPE, 'platform');
    const [row] = await service.listSecrets(USER);
    expect(row).toMatchObject({ name: 'FLY_TOKEN', scope: { kind: 'shared' }, audience: 'admins' });
  });

  it('a row from before audiences existed reads as admins-only', async () => {
    const { service, storage } = makeService();
    await storage.createSecret(USER, { key: 'user-env:OLD_KEY', value: 'old' });
    expect((await service.listSecrets(USER))[0]).toMatchObject({ audience: 'admins' });
    expect(await service.getSecretEnv(USER, AGENT_A, { ownerIsAdmin: false })).toEqual({});
    expect(await service.getSecretEnv(USER, AGENT_A, { ownerIsAdmin: true })).toEqual({ OLD_KEY: 'old' });
  });

  it('hands a member\'s agent only the keys opened to everyone — private ones still shadow', async () => {
    const { service, storage } = makeService();
    await service.setSecret(USER, 'ADMIN_KEY', 'a', SHARED_USER_SECRET_SCOPE, 'admins');
    await service.setSecret(USER, 'TEAM_KEY', 't', SHARED_USER_SECRET_SCOPE, 'team', 'everyone');
    await service.setSecret(USER, 'ADMIN_KEY', 'mine', agentUserSecretScope(AGENT_A), 'own copy');

    expect(await resolveUserSecretEnv(storage, USER, AGENT_A, { ownerIsAdmin: false }))
      .toEqual({ TEAM_KEY: 't', ADMIN_KEY: 'mine' });
    expect(await resolveUserSecretEnv(storage, USER, AGENT_B, { ownerIsAdmin: false }))
      .toEqual({ TEAM_KEY: 't' });
    expect(await resolveUserSecretEnv(storage, USER, AGENT_B, { ownerIsAdmin: true }))
      .toEqual({ ADMIN_KEY: 'a', TEAM_KEY: 't' });
    // The member's listing still SHOWS the row: out of reach, not hidden.
    expect((await service.listSecrets(USER, AGENT_B)).map((row) => row.name)).toContain('ADMIN_KEY');
  });

  it('setSecretAudience flips a shared row without touching value or last-changed, and is shared-only', async () => {
    const { service } = makeService();
    await service.setSecret(USER, 'KEY', 'v', SHARED_USER_SECRET_SCOPE, 'd');
    const before = (await service.listSecrets(USER))[0]!.updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await service.setSecretAudience(USER, 'KEY', 'everyone')).toEqual({ ok: true, name: 'KEY', audience: 'everyone' });
    const after = (await service.listSecrets(USER))[0]!;
    expect(after).toMatchObject({ audience: 'everyone', updatedAt: before });
    expect(await service.getSecretValue(USER, 'KEY')).toBe('v');
    expect(await service.getSecretEnv(USER, AGENT_A, { ownerIsAdmin: false })).toEqual({ KEY: 'v' });

    expect(await service.setSecretAudience(USER, 'KEY', 'friends')).toMatchObject({ ok: false });
    expect(await service.setSecretAudience(USER, 'MISSING', 'everyone')).toMatchObject({ ok: false, notFound: true });
    await service.setSecret(USER, 'PRIV', 'p', agentUserSecretScope(AGENT_A), 'd');
    expect(await service.setSecretAudience(USER, 'PRIV', 'everyone')).toMatchObject({ ok: false, notFound: true });
    expect((await service.listSecrets(USER)).find((row) => row.name === 'PRIV')).not.toHaveProperty('audience');
  });

  it('rotating a value keeps the audience — a new value never widens who gets it', async () => {
    const { service } = makeService();
    await service.setSecret(USER, 'KEY', 'v1', SHARED_USER_SECRET_SCOPE, 'd', 'everyone');
    await service.setSecret(USER, 'KEY', 'v2', SHARED_USER_SECRET_SCOPE);
    expect((await service.listSecrets(USER))[0]).toMatchObject({ audience: 'everyone' });
    await service.setSecret(USER, 'KEY', 'v3', SHARED_USER_SECRET_SCOPE, undefined, 'admins');
    expect((await service.listSecrets(USER))[0]).toMatchObject({ audience: 'admins' });
    expect(await service.getSecretEnv(USER, AGENT_A, { ownerIsAdmin: false })).toEqual({});
  });
});

// The ceiling counts one workplace's whole shelf: note #783 merged the
// rooms' shelves into it (32 per room before), and rooms are gone (note #843).
describe('the shared key ceiling', () => {
  it('counts the ceiling per workplace, wide enough for the merged shelves\' keys', () => {
    expect(MAX_USER_SECRETS).toBeGreaterThanOrEqual(64);
  });
});
