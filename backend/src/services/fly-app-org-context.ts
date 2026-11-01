import { FlyClient } from './fly-client.js';
import { parseFlyServerRecordId, parseFlySandboxId } from './fly-sandbox-id.js';
import { listAgents } from '../types/user.js';
import type { UserStorage } from './user-storage.js';
import type { DeploymentStorage } from './deployment-storage.js';
import type { OrgStorage } from './org-storage.js';
import type { OrgFlyService } from './org-fly.js';

/**
 * App name → the Fly context of the ORG that owns it (byo-fly-design,
 * slice 4 part 2). Every Fly API call the sandbox client makes must use the
 * token of the org the app lives in; this answers "whose app is this" from
 * the same records the reaper's allowlist trusts: an agent's serverId app or
 * provisioning marker → owner → membership → org, or a deployment record's
 * Fly app → owner → org.
 *
 * The provisioning marker is what makes CREATION resolvable too: the record
 * names the app before anything by that name exists on Fly (onAppNamed is
 * awaited first), so the very first getApp/createApp already finds its org.
 *
 * A null answer means the app is unclaimed: no record exists from which to
 * attribute it, or its legacy owner has no organization. A claimed app whose
 * workplace has no cloud of its own is HOSTED (note #664) and resolves to the
 * platform's account; one whose connected cloud has lost its token still
 * throws rather than falling back to ours.
 *
 * The peer a machine pins its SSH to is the backend's address inside the
 * network the machine lands in: the workplace's own tunnel when it has one,
 * and the platform peer for anything in the platform's account — hosted
 * workplaces and org #0 alike. Before this, a platform-account machine got NO
 * pin (org #0 never has a tunnel of its own; its network is the host's), and
 * the image skips its whole firewall when it has neither a pin nor a readable
 * own address, which left sshd open to every machine in the network.
 *
 * Several workplaces can point at ONE Fly account (our internal test
 * workplaces all share `acme-trading`). The host carries one tunnel per
 * network, so only the first of them owns a peer; the converge for every
 * later one finds the network already routed and records `routed-elsewhere`
 * without a peer of its own. Their machines are reached through the
 * sibling's tunnel, from the sibling's address, so that is their pin too —
 * before this they got none (found 2026-09-25 by the pin watch).
 */

export interface FlyAppOrgContext {
  client: FlyClient;
  orgSlug: string;
  /** The backend's peer address inside this org's network, when it has one. */
  backendPeerIp?: string;
}

const APP_CACHE_TTL_MS = 5 * 60_000;

export interface FlyAppOrgContextResolverDeps {
  userStorage: Pick<UserStorage, 'getAllUsers'>;
  deploymentStorage: Pick<DeploymentStorage, 'listAll'>;
  orgStorage: Pick<OrgStorage, 'listMembershipsByUser' | 'getOrg' | 'listOrgs'>;
  orgFly: Pick<OrgFlyService, 'resolveHostingContext'>;
  /** The platform's Fly org slug (`FLY_ORG`), to know a machine is in it. */
  platformOrgSlug?: string;
  /** The backend's own address in the platform's network (`FLY_BACKEND_PEER_IP`). */
  platformBackendPeerIp?: string;
  /** Injectable for tests; defaults to a real FlyClient on the org's token. */
  makeFlyClient?: (apiToken: string) => FlyClient;
  now?: () => number;
}

export class FlyAppOrgContextResolver {
  private readonly appOrgCache = new Map<string, { orgId: string | null; expiresAt: number }>();

  /** One FlyClient per org, remade only when the token rotates. */
  private readonly clientCache = new Map<string, { apiToken: string; client: FlyClient }>();

  constructor(private readonly deps: FlyAppOrgContextResolverDeps) {}

  async resolve(appName: string): Promise<FlyAppOrgContext | null> {
    const orgId = await this.orgIdForApp(appName);
    if (!orgId) {
      return null;
    }
    const context = await this.deps.orgFly.resolveHostingContext(orgId);
    const org = await this.deps.orgStorage.getOrg(orgId);
    const inPlatformAccount = context.source === 'platform'
      || (Boolean(this.deps.platformOrgSlug) && context.orgSlug === this.deps.platformOrgSlug);
    const backendPeerIp = org?.fly?.wireguard?.peerIp
      || (inPlatformAccount ? this.deps.platformBackendPeerIp : await this.siblingPeerIp(orgId, context.orgSlug));
    return {
      client: this.clientFor(orgId, context.apiToken),
      orgSlug: context.orgSlug,
      ...(backendPeerIp ? { backendPeerIp } : {}),
    };
  }

  /** The peer of another workplace's tunnel into the same Fly account. */
  private async siblingPeerIp(orgId: string, orgSlug: string): Promise<string | undefined> {
    const orgs = await this.deps.orgStorage.listOrgs();
    return orgs.find((other) => other.orgId !== orgId
      && other.fly?.orgSlug === orgSlug
      && other.fly.wireguard?.peerIp)?.fly?.wireguard?.peerIp;
  }

  private clientFor(orgId: string, apiToken: string): FlyClient {
    const cached = this.clientCache.get(orgId);
    if (cached && cached.apiToken === apiToken) {
      return cached.client;
    }
    const client = (this.deps.makeFlyClient ?? ((token: string) => new FlyClient(token)))(apiToken);
    this.clientCache.set(orgId, { apiToken, client });
    return client;
  }

  private async orgIdForApp(appName: string): Promise<string | null> {
    const now = (this.deps.now ?? Date.now)();
    const cached = this.appOrgCache.get(appName);
    if (cached && cached.expiresAt > now) {
      return cached.orgId;
    }
    const owner = await this.ownerOfApp(appName);
    // New records carry immutable org ownership. The membership lookup is a
    // legacy bridge only: before multi-org, an owner could belong to exactly
    // one org, so their then-active membership is the only defensible home.
    const legacyMemberships = owner && !owner.orgId
      ? await this.deps.orgStorage.listMembershipsByUser(owner.userId)
      : [];
    const legacyOrgId = [...legacyMemberships]
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.orgId.localeCompare(b.orgId))[0]
      ?.orgId ?? null;
    const orgId = owner?.orgId ?? legacyOrgId;
    this.appOrgCache.set(appName, { orgId, expiresAt: now + APP_CACHE_TTL_MS });
    return orgId;
  }

  private async ownerOfApp(appName: string): Promise<{ userId: string; orgId?: string } | null> {
    const users = await this.deps.userStorage.getAllUsers();
    for (const user of users) {
      for (const agent of listAgents(user.telegram, true)) {
        if (agent.provisioningAppName?.trim() === appName) {
          return { userId: user.userId, ...(agent.orgId ? { orgId: agent.orgId } : {}) };
        }
        const sandboxId = parseFlyServerRecordId(agent.serverId);
        const target = sandboxId ? parseFlySandboxId(sandboxId) : null;
        if (target?.appName === appName) {
          return { userId: user.userId, ...(agent.orgId ? { orgId: agent.orgId } : {}) };
        }
      }
    }
    const deployments = await this.deps.deploymentStorage.listAll();
    const deployment = deployments.find((candidate) => candidate.flyApp === appName);
    if (!deployment) return null;
    // Where the app IS, which is only ever different from who owns it on a
    // site that was transferred between workplaces. Absent on every ordinary
    // record, so this reads exactly as it always did.
    const hostOrgId = deployment.flyOrgId ?? deployment.orgId;
    return { userId: deployment.userId, ...(hostOrgId ? { orgId: hostOrgId } : {}) };
  }
}
