import type { SecretStorage } from './secret-storage.js';
import type { GitNamespace } from './org-git.js';
import { UserSecretsService, validateUserSecretName } from './user-secrets.js';

/**
 * Saved secrets handed to a running service (note #661).
 *
 * A Telegram bot, a webhook, anything that calls a paid API needs its key
 * while it runs, and before this the only way to give it one was to write
 * the value into the deployed files — which agents rightly refused. Now a
 * deploy names the secrets (`--secret NAME`) and the backend sets their
 * values as the site machine's env, so the value never passes through the
 * agent or lands in a file.
 *
 * THE RULE: a site is handed only keys its deploying agent is itself handed —
 * the same projection a turn gets (the workplace's shared keys, filtered by
 * the owner's role, plus its
 * own private ones). Sites belong to the workplace and
 * any agent may redeploy one, so the values are re-read from the CURRENT
 * deployer on every deploy: an agent that is not handed a key can never put
 * code in front of it.
 */

/** Env the app-runtime image or the supervisor already sets; a secret must not shadow it. */
const PLATFORM_SITE_ENV = new Set(['PORT', 'PUBLIC_PORT', 'AUTHORIZED_KEYS', 'BACKEND_PEER_IP', 'DATA_DIR']);

export const MAX_SITE_SECRETS = 20;

/** Who is deploying — the fields of an agent credential or a site record that decide its keys. */
export interface SiteSecretDeployer {
  userId: string;
  orgId: string | null;
  agentId: string;
}

export interface SiteSecretDeps {
  secretStorage?: SecretStorage;
  resolveNamespace?: (userId: string, orgId?: string | null) => Promise<GitNamespace>;
}

/**
 * The names from a `x-agentbuilt-secrets` header, validated. Comma or space
 * separated; an empty header is a real answer (no secrets), distinct from no
 * header at all (keep what the site has).
 */
export function parseSiteSecretNames(raw: string): { ok: true; names: string[] } | { ok: false; error: string } {
  const names = [...new Set(raw.split(/[\s,]+/).map((name) => name.trim()).filter(Boolean))];
  if (names.length > MAX_SITE_SECRETS) {
    return { ok: false, error: `A site can run with at most ${MAX_SITE_SECRETS} secrets.` };
  }
  for (const name of names) {
    const valid = validateUserSecretName(name);
    if (!valid.ok) return { ok: false, error: `--secret ${name}: ${valid.reason}` };
    if (PLATFORM_SITE_ENV.has(name.toUpperCase())) {
      return { ok: false, error: `--secret ${name}: the platform sets ${name} on every site — save the secret under another name.` };
    }
  }
  return { ok: true, names };
}

/**
 * The values of `names` as the deployer's own turn would see them, and the
 * names it is NOT handed. Storage errors throw: a deploy must fail loudly
 * rather than bring a service up quietly missing its key.
 */
export async function resolveSiteSecrets(
  deps: SiteSecretDeps,
  deployer: SiteSecretDeployer,
  names: readonly string[],
): Promise<{ env: Record<string, string>; missing: string[] }> {
  if (names.length === 0) return { env: {}, missing: [] };
  if (!deps.secretStorage) return { env: {}, missing: [...names] };
  const namespace = deps.resolveNamespace
    ? await deps.resolveNamespace(deployer.userId, deployer.orgId)
    : { namespaceId: deployer.userId, orgId: null, role: null };
  // The note #655 audience line, read the way a turn reads it: off the
  // owner's membership, never off anything the agent says.
  const ownerIsAdmin = !namespace.orgId || namespace.role === 'admin';
  const handed = await new UserSecretsService(deps.secretStorage)
    .getSecretEnv(namespace.namespaceId, deployer.agentId, { ownerIsAdmin });
  const env: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(handed, name)) env[name] = handed[name]!;
    else missing.push(name);
  }
  return { env, missing };
}

/** Every secret value out of a message before it reaches an agent. */
export function redactSiteSecrets(message: string, env: Record<string, string>): string {
  let out = message;
  for (const value of Object.values(env)) {
    if (value.length >= 4) out = out.split(value).join('[redacted]');
  }
  return out;
}
