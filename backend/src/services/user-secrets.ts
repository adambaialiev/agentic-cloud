import type { SecretStorage } from './secret-storage.js';
import type { SecretAudience } from '../types/secret.js';

/**
 * User-owned environment secrets: the API keys and tokens a user's agent needs
 * to do real work (`GH_TOKEN`, `OPENAI_API_KEY`, a deploy key), stored on the
 * platform and exported into every CLI turn that agent runs.
 *
 * Why the platform holds them rather than the machine: an agent machine is not
 * durable. The idle reaper stops it, the free-tier recycler DESTROYS it (volume
 * and app with it) after three idle days, and an image roll resets everything
 * outside `/home/agent`. A key pasted into a shell once is gone with the first
 * recycle, and the user has to go find it again. Held here, it is re-exported
 * on the next turn of a rebuilt machine with no user action at all.
 *
 * These share {@link SecretStorage} with the platform's own credentials (the
 * Codex/Claude auth blobs, managed bot tokens), which are keyed by bare
 * names like `claude-oauth-token`. So every user secret is stored under a
 * reserved prefix, and the name is validated before it gets there: without
 * that, a user who names a secret `claude-oauth-token` would overwrite the
 * credential their own harness authenticates with.
 *
 * ## Scope
 *
 * A secret is either shared by every agent in its owning namespace, or private
 * to one. In the hosted product that namespace is the WORKPLACE (note #783 —
 * one set per workplace, like repositories; `ShelfMappedSecretStorage` maps an
 * old room's namespace to the workplace's own, note #843). The legacy personal
 * namespace remains for self-hosted and pre-workplace callers.
 * Two storage shapes carry that:
 *
 *   user-env:NAME             shared by all agents in the namespace
 *   user-env@<agentId>:NAME   only that agent's turns
 *
 * The shared form is unchanged from before scoping existed, so rows written
 * then keep working and keep meaning "all agents in this namespace" — no migration.
 *
 * A human's own write is always SHARED — the Workspace add form is the only way
 * they save one. The agent-scoped form comes from an agent writing its own
 * (`agentbuilt secret set --this-agent`). The retired per-agent Telegram-bot
 * path can still delete old scoped rows while a boot migration is in flight,
 * but it is compatibility code rather than the product's identity model.
 *
 * An agent-scoped secret SHADOWS a shared one of the same name for that agent
 * (see {@link UserSecretsService.getSecretEnv}) — the specific beats the
 * general, which is what "this agent uses a different key" has to mean.
 *
 * ## Audience (note #655)
 *
 * A shared secret also says WHOSE agents it reaches. A key on an agent's
 * machine is a key its owner can read — the owner drives that machine through
 * chat — so "members see names but never values" is only true of the keys a
 * member's agents are never handed. Each shared row therefore carries an
 * audience: `admins` (the default, and what a row from before audiences
 * means) reaches only agents owned by workplace admins; `everyone` reaches
 * every agent in the workplace. A personal namespace with no workplace has one
 * human, who is its admin, so everything reaches there.
 *
 * Until rooms left the product (note #843) a shared key could also be
 * limited to some rooms of the workplace (note #783); Adam had that limit go
 * with them on 30 Oct 2026. Members, admins-only and this-agent are what
 * scope a key.
 */
const USER_SECRET_KEY_PREFIX = 'user-env:';
const USER_SECRET_SCOPED_KEY_PREFIX = 'user-env@';

/** Every agent (the default), or one agent by id. */
export type UserSecretScope = { kind: 'shared' } | { kind: 'agent'; agentId: string };

export const SHARED_USER_SECRET_SCOPE: UserSecretScope = { kind: 'shared' };

/** Whose agents a shared secret reaches — see the module doc. */
export type UserSecretAudience = SecretAudience;

/** Admins' agents only, until an admin deliberately opens a key up. */
export const DEFAULT_USER_SECRET_AUDIENCE: UserSecretAudience = 'admins';

export function validateUserSecretAudience(
  raw: unknown,
): { ok: true; audience: UserSecretAudience } | { ok: false; reason: string } {
  if (raw === 'admins' || raw === 'everyone') return { ok: true, audience: raw };
  return { ok: false, reason: 'The audience is either "admins" (only admins\' agents receive it) or "everyone" (every agent in the workplace).' };
}

/**
 * Who a turn is being run for, as far as secrets are concerned. The owner of
 * a workplace agent is an admin or a member; a personal namespace's owner is
 * its only human and counts as admin. Callers resolve this from the org
 * membership record, never from anything the agent or its machine says.
 */
export interface UserSecretViewer {
  ownerIsAdmin: boolean;
}

export function agentUserSecretScope(agentId: string): UserSecretScope {
  return { kind: 'agent', agentId };
}

function scopesEqual(left: UserSecretScope, right: UserSecretScope): boolean {
  return left.kind === 'agent' && right.kind === 'agent'
    ? left.agentId === right.agentId
    : left.kind === right.kind;
}

/**
 * Ceilings, so one workplace cannot bloat every turn's launch script. The
 * count is per workplace since note #783 (it was 32 per room before).
 */
export const MAX_USER_SECRETS = 96;
export const MAX_USER_SECRET_NAME_LENGTH = 64;
export const MAX_USER_SECRET_VALUE_BYTES = 8 * 1024;
export const MAX_USER_SECRET_DESCRIPTION_LENGTH = 200;

/**
 * Shell-safe environment variable names only. The name is interpolated into the
 * turn's launch script as `export NAME=...`, so anything outside this class
 * could inject shell rather than name a variable. Values are quoted separately
 * and need no such restriction.
 */
const USER_SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names the agent's own runtime depends on. Exporting a user value over any of
 * these would break the turn (`PATH`, `HOME`) or hijack it outright
 * (`LD_PRELOAD`, `NODE_OPTIONS`, the CLI credential envs), so they are refused
 * at write time rather than filtered at export time — the user finds out when
 * they set it, not when a turn mysteriously fails.
 */
const RESERVED_USER_SECRET_NAMES = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PWD',
  'OLDPWD',
  'IFS',
  'ENV',
  'BASH_ENV',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_BASE_URL',
  'CODEX_HOME',
]);

export interface UserSecretSummary {
  name: string;
  /** Never the value: enough to recognize which key this is, no more. */
  maskedValue: string;
  /**
   * Why this secret exists and what it is for. Written by whoever saved it —
   * agents are required to provide one (their CLI insists); rows from before
   * descriptions existed, and the user's own Workspace writes, may not.
   */
  description?: string;
  scope: UserSecretScope;
  /**
   * Whose agents a SHARED row reaches (resolved: an absent stored field is the
   * default). Omitted on agent-private rows, which reach exactly one agent.
   */
  audience?: UserSecretAudience;
  /**
   * When this secret was last written — created or rotated. Deliberately NOT a
   * "last used" time: every in-scope secret is exported into every turn, so a
   * use stamp would just be the time of the last turn, identical across all of
   * them, and would imply the CLI read a variable we cannot observe it reading.
   * "Last changed" is the question a user can actually act on ("is this the new
   * key or the one I rotated away from?").
   */
  updatedAt?: string;
  /** True when a shared secret of this name is hidden by an agent-scoped one. */
  shadowedByAgentScope?: boolean;
  /**
   * Which agents hold their own copy of this shared name — the same fact as
   * `shadowedByAgentScope`, but answerable when NO agent was asked about. The
   * concierge listing (the Workspace) has no single agent to be "here", and
   * "your shared GH_TOKEN does not reach Leo" is exactly the thing that view
   * exists to show. Empty is omitted, so a plain listing carries nothing new.
   */
  shadowedByAgentIds?: string[];
  /** How many characters the value has — a paste can be checked against it. */
  valueLength: number;
  /** The short mask on its own, for surfaces that print the length themselves. */
  maskedPreview: string;
  /**
   * What KIND of value this is, when the format announces itself. A PEM key
   * masks to "---…--", which identifies nothing; the format's name does.
   */
  valueKind?: string;
}

export type SetUserSecretResult =
  | { ok: true; created: boolean; name: string; scope: UserSecretScope }
  | { ok: false; reason: string };

export function isUserSecretStorageKey(key: string): boolean {
  return key.startsWith(USER_SECRET_KEY_PREFIX) || key.startsWith(USER_SECRET_SCOPED_KEY_PREFIX);
}

function toStorageKey(name: string, scope: UserSecretScope): string {
  return scope.kind === 'agent'
    ? `${USER_SECRET_SCOPED_KEY_PREFIX}${scope.agentId}:${name}`
    : `${USER_SECRET_KEY_PREFIX}${name}`;
}

/**
 * Split a storage key back into scope and name, or null when it is not a user
 * secret at all (a platform credential, or a malformed scoped key).
 */
export function parseUserSecretStorageKey(
  storageKey: string,
): { scope: UserSecretScope; name: string } | null {
  if (storageKey.startsWith(USER_SECRET_KEY_PREFIX)) {
    return {
      scope: SHARED_USER_SECRET_SCOPE,
      name: storageKey.slice(USER_SECRET_KEY_PREFIX.length),
    };
  }
  if (!storageKey.startsWith(USER_SECRET_SCOPED_KEY_PREFIX)) {
    return null;
  }

  const rest = storageKey.slice(USER_SECRET_SCOPED_KEY_PREFIX.length);
  // Agent ids are UUIDs, so they never contain ':' — the FIRST colon always
  // ends the id, and the name (which cannot contain ':' either) is the rest.
  const separatorIndex = rest.indexOf(':');
  if (separatorIndex <= 0) {
    return null;
  }
  return {
    scope: agentUserSecretScope(rest.slice(0, separatorIndex)),
    name: rest.slice(separatorIndex + 1),
  };
}

/**
 * Show the shape of a value without disclosing it. Anything short enough that a
 * prefix would give most of it away is masked whole — a 6-character value with
 * 4 shown is not redacted, it is spelled out.
 */
export function maskSecretValue(value: string): string {
  const length = [...value].length;
  // A PEM's first and last characters are dashes, so masking one produces
  // "---…--" — identical for every key ever issued, and useless for telling
  // two of them apart. Where the format names itself, that name IS the mask:
  // it discloses nothing and actually identifies something.
  const kind = secretValueKind(value);
  if (kind) {
    return `${kind} (${length} chars)`;
  }
  if (length <= 8) {
    return maskSecretPreview(value);
  }
  return `${maskSecretPreview(value)} (${length} chars)`;
}

/**
 * The same mask without the character count, for a surface that already shows
 * the length as its own field instead of folding it into the preview.
 */
export function maskSecretPreview(value: string): string {
  const length = [...value].length;
  if (length <= 8) {
    return '•'.repeat(Math.max(length, 1));
  }
  return `${value.slice(0, 3)}…${value.slice(-2)}`;
}

/**
 * Name the FORMAT of a value when it is self-evident, or undefined when it is
 * just an opaque string.
 *
 * This exists because masking is worst exactly where identification matters
 * most: every PEM key on earth masks to "---…--", so the preview that is
 * supposed to tell two keys apart tells you nothing. The format's name does.
 * Reads only the first line, and never returns any part of the value.
 */
export function secretValueKind(value: string): string | undefined {
  const firstLine = value.trimStart().split('\n', 1)[0]?.trim() ?? '';
  const pem = /^-----BEGIN (.+?)-----$/.exec(firstLine);
  if (pem) {
    const label = pem[1]!.toUpperCase();
    if (label === 'OPENSSH PRIVATE KEY') return 'OpenSSH private key';
    if (label === 'CERTIFICATE') return 'Certificate';
    if (label.endsWith('PRIVATE KEY')) return 'PEM private key';
    if (label.endsWith('PUBLIC KEY')) return 'PEM public key';
    return 'PEM block';
  }
  if (firstLine.startsWith('ssh-') || firstLine.startsWith('ecdsa-sha2-')) {
    return 'SSH public key';
  }
  if (value.trimStart().startsWith('{') && value.trimEnd().endsWith('}')) {
    return 'JSON file';
  }
  return undefined;
}

/**
 * Validate a user-supplied name. Returns the canonical name, or the reason it
 * was refused — phrased for a non-technical user, since this text is what the
 * Telegram flow shows them.
 */
export function validateUserSecretName(rawName: string): { ok: true; name: string } | { ok: false; reason: string } {
  const name = rawName.trim();
  if (!name) {
    return { ok: false, reason: 'A secret needs a name, like GH_TOKEN.' };
  }
  if (name.length > MAX_USER_SECRET_NAME_LENGTH) {
    return { ok: false, reason: `That name is too long — keep it under ${MAX_USER_SECRET_NAME_LENGTH} characters.` };
  }
  if (!USER_SECRET_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      reason: 'Names can use letters, numbers and underscores, and cannot start with a number — for example GH_TOKEN.',
    };
  }
  if (RESERVED_USER_SECRET_NAMES.has(name.toUpperCase())) {
    return { ok: false, reason: `${name} is reserved by the system — pick another name.` };
  }
  return { ok: true, name };
}

/**
 * Validate a description. One line, bounded, and never empty when required —
 * a description is display text (chat lists, the Workspace), so newlines are
 * collapsed rather than refused: a pasted sentence should just work.
 */
export function validateUserSecretDescription(
  rawDescription: string,
): { ok: true; description: string } | { ok: false; reason: string } {
  const description = rawDescription.replace(/\s+/g, ' ').trim();
  if (!description) {
    return { ok: false, reason: 'A description needs some text — say what the secret is for.' };
  }
  if (description.length > MAX_USER_SECRET_DESCRIPTION_LENGTH) {
    return {
      ok: false,
      reason: `That description is too long — keep it under ${MAX_USER_SECRET_DESCRIPTION_LENGTH} characters.`,
    };
  }
  return { ok: true, description };
}

function validateUserSecretValue(rawValue: string): { ok: true; value: string } | { ok: false; reason: string } {
  // Only the trailing newline a copy-paste tends to carry is stripped. Leading
  // and interior whitespace can be significant (a PEM body, a padded token),
  // so the value is otherwise stored exactly as given.
  const value = rawValue.replace(/\r?\n$/, '');
  if (!value) {
    return { ok: false, reason: 'That secret has no value.' };
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_USER_SECRET_VALUE_BYTES) {
    return { ok: false, reason: `That value is too large — the limit is ${MAX_USER_SECRET_VALUE_BYTES / 1024} KB.` };
  }
  return { ok: true, value };
}

function toIsoString(value: { toDate?: () => Date } | undefined): string | undefined {
  try {
    return value?.toDate?.().toISOString();
  } catch {
    return undefined;
  }
}

/**
 * Per-turn convenience for the CLI harnesses: the user's secret environment,
 * or an empty one when there is no storage configured or the read fails.
 *
 * Deliberately swallows errors. A secrets lookup is a side quest to answering
 * the user's message — losing the turn over it would be a worse failure than
 * running without the extra environment, and the CLI's own error ("GH_TOKEN
 * not set") is a clearer signal than a dead turn.
 */
export async function resolveUserSecretEnv(
  secretStorage: SecretStorage | undefined,
  userId: string,
  agentId: string | undefined,
  viewer: UserSecretViewer,
): Promise<Record<string, string>> {
  if (!secretStorage) {
    return {};
  }
  try {
    return await new UserSecretsService(secretStorage).getSecretEnv(userId, agentId, viewer);
  } catch (error) {
    console.warn(`[user-secrets] Failed to load secrets for ${userId}:`, error);
    return {};
  }
}

export class UserSecretsService {
  constructor(private readonly secretStorage: SecretStorage) {}

  /**
   * Names, masked previews and scopes, for display. Never returns plaintext.
   *
   * With no `agentId` this is the whole cupboard — every shared secret plus
   * every agent's private ones, which is what the concierge chat shows. With an
   * `agentId` it is narrowed to what THAT agent can actually see: its own
   * secrets plus the shared ones, with a shared entry marked
   * `shadowedByAgentScope` when the agent overrides it. Answering "why is this
   * agent using a different key?" is the whole point of showing that flag
   * rather than silently dropping the shared row.
   */
  async listSecrets(userId: string, agentId?: string): Promise<UserSecretSummary[]> {
    const stored = await this.secretStorage.getUserSecrets(userId);
    const parsed = stored
      .map((secret) => {
        const key = parseUserSecretStorageKey(secret.key);
        return key ? { ...key, secret } : null;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .filter((entry) => (
        agentId === undefined
        || entry.scope.kind === 'shared'
        || entry.scope.agentId === agentId
      ));

    const agentScopedNames = new Set(
      parsed.filter((entry) => entry.scope.kind === 'agent').map((entry) => entry.name),
    );
    // name → every agent holding its own copy of that name. Built from the same
    // `parsed` rows, so when a caller DID name an agent this only ever contains
    // that agent and the answer is the same either way.
    const shadowedBy = new Map<string, string[]>();
    for (const entry of parsed) {
      if (entry.scope.kind !== 'agent') continue;
      const holders = shadowedBy.get(entry.name) ?? [];
      holders.push(entry.scope.agentId);
      shadowedBy.set(entry.name, holders);
    }

    return parsed
      .map((entry) => {
        const kind = secretValueKind(entry.secret.value);
        return {
          name: entry.name,
          maskedValue: maskSecretValue(entry.secret.value),
          maskedPreview: maskSecretPreview(entry.secret.value),
          valueLength: [...entry.secret.value].length,
          ...(kind ? { valueKind: kind } : {}),
          ...(entry.secret.description ? { description: entry.secret.description } : {}),
          scope: entry.scope,
          ...(entry.scope.kind === 'shared'
            ? { audience: entry.secret.audience ?? DEFAULT_USER_SECRET_AUDIENCE }
            : {}),
          updatedAt: toIsoString(entry.secret.updatedAt),
          ...(entry.scope.kind === 'shared' && agentId !== undefined && agentScopedNames.has(entry.name)
            ? { shadowedByAgentScope: true }
            : {}),
          ...(entry.scope.kind === 'shared' && shadowedBy.has(entry.name)
            ? { shadowedByAgentIds: shadowedBy.get(entry.name) }
            : {}),
        };
      })
      .sort((left, right) => (
        left.name.localeCompare(right.name)
        || left.scope.kind.localeCompare(right.scope.kind)
      ));
  }

  /**
   * The environment to export for one turn: plaintext, and the only method here
   * that returns it. Callers must feed these values to `redactHarnessSecrets`
   * before any transcript or log derived from the turn leaves the backend.
   *
   * `viewer` says whose turn this is. A member's agent receives only the
   * shared secrets whose audience is `everyone`; an admin's receives them
   * all. Absent (the concierge and legacy personal callers) means admin —
   * the personal namespace has no members to keep anything from.
   */
  async getSecretEnv(
    userId: string,
    agentId?: string,
    viewer: UserSecretViewer = { ownerIsAdmin: true },
  ): Promise<Record<string, string>> {
    const stored = await this.secretStorage.getUserSecrets(userId);
    const shared: Record<string, string> = {};
    const scoped: Record<string, string> = {};

    for (const secret of stored) {
      const key = parseUserSecretStorageKey(secret.key);
      if (!key || typeof secret.value !== 'string') {
        continue;
      }
      // Re-validate on the way out. A row written by an older or buggier path
      // must not become shell injection in the launch script.
      if (!validateUserSecretName(key.name).ok) {
        continue;
      }
      if (key.scope.kind === 'shared') {
        // The audience line (note #655): a key a member's agent is handed is
        // a key that member can read, so an admins-only key stays off their
        // machine entirely rather than being hidden from the listing.
        if (!viewer.ownerIsAdmin && (secret.audience ?? DEFAULT_USER_SECRET_AUDIENCE) !== 'everyone') {
          continue;
        }
        shared[key.name] = secret.value;
      } else if (agentId !== undefined && key.scope.agentId === agentId) {
        scoped[key.name] = secret.value;
      }
      // Another agent's scoped secret: deliberately dropped. This is the line
      // that makes scoping mean anything — without it, "private to one agent"
      // would still be exported into every other agent's turn.
    }

    // Scoped last: the agent's own key shadows the shared one of that name.
    return { ...shared, ...scoped };
  }

  /**
   * The plaintext of ONE secret in ONE scope, for the owner to read back —
   * the Mini App's copy button, and nothing else so far. Returns null when
   * there is no such secret in that scope, so a shared key is never handed
   * back in place of an agent's private one of the same name.
   *
   * This and {@link getSecretEnv} are the only methods that return plaintext.
   * Callers must treat the result as the secret it is: never log it, never put
   * it in an error message, never let it reach a transcript.
   */
  async getSecretValue(
    userId: string,
    rawName: string,
    scope: UserSecretScope = SHARED_USER_SECRET_SCOPE,
  ): Promise<string | null> {
    const nameResult = validateUserSecretName(rawName);
    if (!nameResult.ok) {
      return null;
    }
    const existing = await this.secretStorage.getSecretByKey(userId, toStorageKey(nameResult.name, scope));
    return typeof existing?.value === 'string' ? existing.value : null;
  }

  /**
   * Create or overwrite one secret in one scope. Overwrite is intentional:
   * rotating a key is the common case.
   *
   * Scopes are independent — setting `GH_TOKEN` for one agent does not touch
   * the shared `GH_TOKEN`, it shadows it for that agent only.
   *
   * `rawDescription` says what the secret is for. Optional HERE because rows
   * predating descriptions still rotate, and the Workspace add form does not
   * ask — nobody writes prose while pasting a token. The "every secret has
   * one" rule is enforced where agents write (their CLI refuses a create
   * without it).
   * On a rotate, an omitted description keeps the existing one: rotating a
   * key does not change what it is for.
   *
   * `audience` (shared scope only) says whose agents the key reaches. Omitted
   * on create it is the default, admins' agents only; omitted on a rotate it
   * keeps what the row had — a new value does not widen who gets it.
   */
  async setSecret(
    userId: string,
    rawName: string,
    rawValue: string,
    scope: UserSecretScope = SHARED_USER_SECRET_SCOPE,
    rawDescription?: string,
    audience?: UserSecretAudience,
  ): Promise<SetUserSecretResult> {
    const nameResult = validateUserSecretName(rawName);
    if (!nameResult.ok) {
      return { ok: false, reason: nameResult.reason };
    }
    const valueResult = validateUserSecretValue(rawValue);
    if (!valueResult.ok) {
      return { ok: false, reason: valueResult.reason };
    }
    let description: string | undefined;
    if (rawDescription !== undefined) {
      const descriptionResult = validateUserSecretDescription(rawDescription);
      if (!descriptionResult.ok) {
        return { ok: false, reason: descriptionResult.reason };
      }
      description = descriptionResult.description;
    }

    const storageKey = toStorageKey(nameResult.name, scope);
    const existing = await this.secretStorage.getSecretByKey(userId, storageKey);
    if (existing) {
      await this.secretStorage.updateSecret(userId, existing.secretId, {
        value: valueResult.value,
        ...(description !== undefined ? { description } : {}),
        ...(scope.kind === 'shared' && audience !== undefined ? { audience } : {}),
      });
      return { ok: true, created: false, name: nameResult.name, scope };
    }

    // Counted only on create, so rotating a key still works at the ceiling.
    // Counted across ALL scopes: the ceiling exists to bound what one user can
    // store, and per-scope counting would let it be multiplied by agent count.
    const current = await this.listSecrets(userId);
    if (current.length >= MAX_USER_SECRETS) {
      return {
        ok: false,
        reason: `You already have ${MAX_USER_SECRETS} secrets saved — delete one before adding another.`,
      };
    }

    await this.secretStorage.createSecret(userId, {
      key: storageKey,
      value: valueResult.value,
      ...(description !== undefined ? { description } : {}),
      ...(scope.kind === 'shared' ? { audience: audience ?? DEFAULT_USER_SECRET_AUDIENCE } : {}),
    });
    return { ok: true, created: true, name: nameResult.name, scope };
  }

  /**
   * Change whose agents a SHARED secret reaches, leaving value, description
   * and the last-changed time alone. Shared only: a private key reaches one
   * agent by construction. Takes effect at each agent's next turn — a turn
   * already running was handed its environment when it started.
   */
  async setSecretAudience(
    userId: string,
    rawName: string,
    rawAudience: unknown,
  ): Promise<{ ok: true; name: string; audience: UserSecretAudience } | { ok: false; reason: string; notFound?: boolean }> {
    const nameResult = validateUserSecretName(rawName);
    if (!nameResult.ok) {
      return { ok: false, reason: nameResult.reason };
    }
    const audienceResult = validateUserSecretAudience(rawAudience);
    if (!audienceResult.ok) {
      return { ok: false, reason: audienceResult.reason };
    }
    const existing = await this.secretStorage.getSecretByKey(userId, toStorageKey(nameResult.name, SHARED_USER_SECRET_SCOPE));
    if (!existing) {
      return { ok: false, notFound: true, reason: `There is no shared secret named ${nameResult.name}.` };
    }
    await this.secretStorage.updateSecret(userId, existing.secretId, { audience: audienceResult.audience });
    return { ok: true, name: nameResult.name, audience: audienceResult.audience };
  }

  /**
   * Replace one secret's description without touching its value — for filling
   * in a row that predates descriptions, or correcting a stale one after the
   * key's purpose shifted. Scope-specific like delete: describing an agent's
   * private key must never silently annotate the shared one instead.
   */
  async describeSecret(
    userId: string,
    rawName: string,
    rawDescription: string,
    scope: UserSecretScope = SHARED_USER_SECRET_SCOPE,
  ): Promise<{ ok: true; name: string; scope: UserSecretScope } | { ok: false; reason: string; notFound?: boolean }> {
    const nameResult = validateUserSecretName(rawName);
    if (!nameResult.ok) {
      return { ok: false, reason: nameResult.reason };
    }
    const descriptionResult = validateUserSecretDescription(rawDescription);
    if (!descriptionResult.ok) {
      return { ok: false, reason: descriptionResult.reason };
    }
    const existing = await this.secretStorage.getSecretByKey(userId, toStorageKey(nameResult.name, scope));
    if (!existing) {
      return { ok: false, notFound: true, reason: `There is no secret named ${nameResult.name} in that scope.` };
    }
    await this.secretStorage.updateSecret(userId, existing.secretId, {
      description: descriptionResult.description,
    });
    return { ok: true, name: nameResult.name, scope };
  }

  /**
   * Delete one secret from one scope. Returns false when there was no such
   * secret IN THAT SCOPE, so the caller can say so — deleting an agent's
   * private key must never silently remove the shared one instead.
   */
  async deleteSecret(
    userId: string,
    rawName: string,
    scope: UserSecretScope = SHARED_USER_SECRET_SCOPE,
  ): Promise<boolean> {
    const nameResult = validateUserSecretName(rawName);
    if (!nameResult.ok) {
      return false;
    }
    const existing = await this.secretStorage.getSecretByKey(userId, toStorageKey(nameResult.name, scope));
    if (!existing) {
      return false;
    }
    await this.secretStorage.deleteSecret(userId, existing.secretId);
    return true;
  }

  /**
   * Drop everything scoped to one agent. Called when that agent is deleted —
   * its machine and bot are gone, so its private keys are unreachable and would
   * otherwise sit in storage forever, counting against the user's ceiling.
   * Shared secrets are untouched: the user's other agents still need them.
   */
  async deleteAgentSecrets(userId: string, agentId: string): Promise<number> {
    const stored = await this.secretStorage.getUserSecrets(userId);
    let removed = 0;
    for (const secret of stored) {
      const key = parseUserSecretStorageKey(secret.key);
      if (key?.scope.kind === 'agent' && key.scope.agentId === agentId) {
        await this.secretStorage.deleteSecret(userId, secret.secretId);
        removed += 1;
      }
    }
    return removed;
  }
}

/** Audience wording for replies and listings: who a shared key reaches. */
export function describeUserSecretAudience(audience: UserSecretAudience): string {
  return audience === 'everyone' ? 'every agent in the workplace' : 'admins\' agents only';
}

/** What a request to limit a key to some rooms is told. */
export const SECRET_ROOMS_GONE = 'Rooms are gone (note #843): every key belongs to the whole workplace. Limit who gets a key with its audience (admins only, or every member) or by making it one agent\'s own.';

/** Scope-aware wording for chat replies, so "saved" always says where. */
export function describeUserSecretScope(scope: UserSecretScope, agentName?: string): string {
  if (scope.kind === 'shared') {
    return 'all agents in this workplace';
  }
  return agentName ? `${agentName} only` : 'this agent only';
}
