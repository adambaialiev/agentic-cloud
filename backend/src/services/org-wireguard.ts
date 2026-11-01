import { createHash, generateKeyPairSync } from 'node:crypto';
import { FlyClient } from './fly-client.js';
import type { OrgStorage } from './org-storage.js';
import type { OrgSecretsService } from './org-secrets.js';
import type { OrgFlyService } from './org-fly.js';

/**
 * One WireGuard peer per client Fly org (byo-fly-design: "reaching machines
 * in a foreign network"). The backend's existing peer routes only OUR org's
 * 6PN network; a machine in a client's Fly org is unreachable without a peer
 * into that org. This service owns the whole lifecycle:
 *
 *   mint keypair → register peer with Fly (client org's own token) → persist
 *   (private key as an org secret, public half on the org doc) → render
 *   /etc/wireguard/<iface>.conf → bring the interface up and enable it across
 *   host reboots → converge on every later call.
 *
 * The host side runs through an injected `exec`, because the backend process
 * runs as root ON the control-plane host — the same trust that lets it SSH
 * into machines lets it manage local interfaces. Everything host-touching is
 * argv-array exec (no shell), and the conf file is written 0600 via install.
 *
 * Route-conflict guard: two interfaces routing the same fdaa /48 would fight
 * — org #0's network is already routed by the legacy peer, so ensuring org #0
 * here would break backend→fleet SSH. After registering (the network is only
 * knowable from the answer), a peer whose /48 is already routed elsewhere is
 * rolled back and reported, never brought up. Live rehearsal 2026-08-23:
 * register → conf → up → handshake with ams1.gateway.6pn.dev verified, from a
 * plain Linux host with wireguard-tools + iproute2 (BOTH must be installed —
 * this machine image lacked iproute2).
 */

export const ORG_WIREGUARD_PRIVATE_KEY_SECRET = 'WG_PRIVATE_KEY';

/** Linux IFNAMSIZ is 16 incl. NUL; `iaorg-` + 8 hex = 14. */
export function orgWireGuardInterfaceName(orgId: string): string {
  return `iaorg-${createHash('sha256').update(orgId).digest('hex').slice(0, 8)}`;
}

/** The org's whole 6PN network: first three hextets of any address in it. */
export function sixPnNetworkOf(peerIp: string): string {
  const parts = peerIp.split(':');
  if (parts.length < 3 || parts[0] !== 'fdaa') {
    throw new OrgWireGuardError(`"${peerIp}" is not a 6PN address`);
  }
  return `${parts[0]}:${parts[1]}:${parts[2]}::/48`;
}

/** WireGuard-shape keys from node crypto: raw 32 bytes, base64. */
export function mintWireGuardKeypair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const rawPriv = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return { privateKey: rawPriv.toString('base64'), publicKey: rawPub.toString('base64') };
}

export function renderWireGuardConfig(args: {
  privateKey: string;
  peerIp: string;
  gatewayPubkey: string;
  endpoint: string;
  network: string;
}): string {
  return [
    '[Interface]',
    `PrivateKey = ${args.privateKey}`,
    `Address = ${args.peerIp}/120`,
    '',
    '[Peer]',
    `PublicKey = ${args.gatewayPubkey}`,
    `Endpoint = ${args.endpoint}:51820`,
    `AllowedIPs = ${args.network}`,
    'PersistentKeepalive = 15',
    '',
  ].join('\n');
}

export class OrgWireGuardError extends Error {}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface OrgWireGuardDeps {
  orgStorage: Pick<OrgStorage, 'getOrg' | 'updateOrg'>;
  orgSecrets: Pick<OrgSecretsService, 'setOrgSecret' | 'getOrgSecret' | 'deleteOrgSecret'>;
  orgFly: Pick<OrgFlyService, 'resolveOrgFlyContext'>;
  /** Run one command on the control-plane host. Argv array — never a shell string. */
  exec: (argv: string[], opts?: { stdin?: string }) => Promise<ExecResult>;
  /** Injectable for tests; defaults to a real FlyClient on the org's token. */
  makeFlyClient?: (apiToken: string) => Pick<
    FlyClient,
    'resolveOrganizationId' | 'addWireGuardPeer' | 'removeWireGuardPeer'
  >;
  /** WireGuard gateway region for new peers (where the control plane lives). */
  region?: string;
  confDir?: string;
}

export type EnsureOrgWireGuardResult =
  | { status: 'up'; interfaceName: string; peerIp: string }
  | { status: 'route-conflict'; network: string; detail: string };

export class OrgWireGuardService {
  constructor(private readonly deps: OrgWireGuardDeps) {}

  private get confDir(): string {
    return this.deps.confDir ?? '/etc/wireguard';
  }

  private flyFor(apiToken: string) {
    return (this.deps.makeFlyClient ?? ((token: string) => new FlyClient(token)))(apiToken);
  }

  /**
   * Converge only when the interface is ABSENT. `ip link show` succeeding
   * means the tunnel exists and is carrying traffic, and a full ensure would
   * flap it (bringUp is down-then-up) under other machines' live SSH. The
   * missing-interface case is exactly the connect-time failure this heals:
   * peer registered, conf never installed, machines unreachable — the shape
   * the first real founder hit when the conf install lacked privileges.
   */
  async ensureUpIfMissing(orgId: string): Promise<EnsureOrgWireGuardResult> {
    const interfaceName = orgWireGuardInterfaceName(orgId);
    const show = await this.deps.exec(['ip', 'link', 'show', interfaceName]);
    if (show.code === 0) {
      const org = await this.deps.orgStorage.getOrg(orgId);
      // A standing interface IS the answer, and worth recording as one: it is
      // the cheapest true reading of this tunnel anybody takes.
      await this.recordCheck(orgId, 'up');
      return { status: 'up', interfaceName, peerIp: org?.fly?.wireguard?.peerIp ?? '' };
    }
    return this.ensureOrgWireGuard(orgId);
  }

  /**
   * Converge, and RECORD what happened (note #642).
   *
   * Every exit is an outcome the Workspace has to be able to state: up, the
   * network already routed some other way, or an attempt that threw. Before
   * this, only the first left a trace — the peer on the doc — so the other
   * two were indistinguishable from "nobody has tried yet", and the card
   * called all three of them "coming up".
   */
  async ensureOrgWireGuard(orgId: string): Promise<EnsureOrgWireGuardResult> {
    try {
      const result = await this.converge(orgId);
      if (result.status === 'up') await this.recordCheck(orgId, 'up');
      else await this.recordCheck(orgId, 'routed-elsewhere', result.detail, result.network);
      return result;
    } catch (error) {
      // Recorded and then rethrown: the caller's handling does not change,
      // and the failure stops being invisible. Its own write is best-effort
      // — an org that does not exist is why we are here in the first place.
      await this.recordCheck(orgId, 'failed', error instanceof Error ? error.message : String(error))
        .catch(() => undefined);
      throw error;
    }
  }

  /**
   * Keep the outcome on the workplace record, and only when it CHANGED.
   *
   * Agent provisioning converges on every machine it builds, so writing
   * unconditionally would put a doc write behind every one of them to
   * restate a fact that has not moved.
   */
  private async recordCheck(
    orgId: string,
    status: 'up' | 'routed-elsewhere' | 'failed',
    detail?: string,
    network?: string,
  ): Promise<void> {
    const org = await this.deps.orgStorage.getOrg(orgId);
    if (!org?.fly) return;
    const held = org.fly.peerCheck;
    if (held?.status === status && held.detail === detail && held.network === network) return;
    await this.deps.orgStorage.updateOrg(orgId, {
      fly: {
        ...org.fly,
        peerCheck: {
          status,
          at: new Date().toISOString(),
          ...(detail ? { detail } : {}),
          ...(network ? { network } : {}),
        },
      },
    });
  }

  /**
   * Converge the org's peer to "registered, configured, up, enabled at boot".
   * Idempotent: safe on every provision. Registers only when the org doc has
   * no peer yet (or its private key secret is gone — then the old peer is
   * replaced whole, because a peer whose private key is lost is dead weight).
   */
  private async converge(orgId: string): Promise<EnsureOrgWireGuardResult> {
    const org = await this.deps.orgStorage.getOrg(orgId);
    if (!org) {
      throw new OrgWireGuardError(`org ${orgId} does not exist`);
    }
    const context = await this.deps.orgFly.resolveOrgFlyContext(orgId);
    if (context.source !== 'org') {
      throw new OrgWireGuardError(
        `org ${orgId} has no Fly org of its own connected — a WireGuard peer would point at the platform's network`,
      );
    }

    let wireguard = org.fly?.wireguard;
    let privateKey = wireguard
      ? await this.deps.orgSecrets.getOrgSecret(orgId, ORG_WIREGUARD_PRIVATE_KEY_SECRET)
      : null;
    const interfaceName = orgWireGuardInterfaceName(orgId);

    // A network we already found routed some other way is re-checked as a
    // ROUTE, never re-learned by registering with Fly. Registering only to
    // roll straight back is what ran on every machine build for org #0, and
    // every roll-back is a chance to strand a peer (one did — see the type).
    // The route going away (the legacy peer retired) falls through to a real
    // registration, which is then exactly right.
    const remembered = org.fly?.peerCheck;
    if (!wireguard && remembered?.status === 'routed-elsewhere' && remembered.network) {
      const conflict = await this.findForeignRoute(remembered.network, interfaceName);
      if (conflict) return { status: 'route-conflict', network: remembered.network, detail: conflict };
    }

    if (!wireguard || !privateKey) {
      const fly = this.flyFor(context.apiToken);
      const organizationId = await fly.resolveOrganizationId(context.orgSlug);
      // A recorded peer whose key is gone cannot be revived — replace it whole.
      if (wireguard && !privateKey) {
        await fly.removeWireGuardPeer({ organizationId, name: wireguard.peerName }).catch(() => undefined);
      }
      const keys = mintWireGuardKeypair();
      const peerName = `ia-backend-${interfaceName.slice('iaorg-'.length)}`;
      const request = { organizationId, region: this.deps.region ?? 'ams', name: peerName, pubkey: keys.publicKey };
      let peer: Awaited<ReturnType<typeof fly.addWireGuardPeer>>;
      try {
        peer = await fly.addWireGuardPeer(request);
      } catch (first) {
        // Nothing usable is recorded for this workplace, so a peer already
        // holding OUR name — `ia-backend-` plus this org's own hash, minted
        // by nobody but this service — is an orphan of ours: a roll-back
        // that failed, or a doc entry that was lost. Every retry collided
        // with it forever and nothing said so; replace it once, and let a
        // second failure be the real one.
        console.warn(`[OrgWireGuard] adding ${peerName} failed, replacing a stale peer of that name and retrying once:`, first);
        await fly.removeWireGuardPeer({ organizationId, name: peerName }).catch(() => undefined);
        peer = await fly.addWireGuardPeer(request);
      }
      const network = sixPnNetworkOf(peer.peerIp);
      const conflict = await this.findForeignRoute(network, interfaceName);
      if (conflict) {
        // The host already routes this network some other way (org #0's
        // legacy peer is the known case). A second route would fight it, so
        // undo the registration and report — never bring the interface up.
        // A roll-back that fails is SAID, not swallowed: it leaves a peer of
        // ours in the client's Fly org, and the next registration heals it.
        await fly.removeWireGuardPeer({ organizationId, name: peerName }).catch((error) => {
          console.warn(`[OrgWireGuard] rolling back ${peerName} failed — a stale peer is left in ${context.orgSlug}:`, error);
        });
        return { status: 'route-conflict', network, detail: conflict };
      }
      // Secret before doc, mirroring connectOrgFly: a doc entry whose secret
      // is missing is detected (and replaced) on the next ensure.
      await this.deps.orgSecrets.setOrgSecret(
        orgId,
        ORG_WIREGUARD_PRIVATE_KEY_SECRET,
        keys.privateKey,
        `WireGuard private key for the backend's peer into Fly org ${context.orgSlug}`,
      );
      wireguard = { peerName, peerIp: peer.peerIp, endpoint: peer.endpoint, gatewayPubkey: peer.gatewayPubkey };
      await this.deps.orgStorage.updateOrg(orgId, {
        fly: { ...org.fly!, wireguard },
      });
      privateKey = keys.privateKey;
    } else {
      const network = sixPnNetworkOf(wireguard.peerIp);
      const conflict = await this.findForeignRoute(network, interfaceName);
      if (conflict) {
        return { status: 'route-conflict', network, detail: conflict };
      }
    }

    await this.bringUp({ interfaceName, privateKey, wireguard });
    return { status: 'up', interfaceName, peerIp: wireguard.peerIp };
  }

  /** Tear everything down: interface, boot unit, conf, Fly peer, key, doc entry. */
  async removeOrgWireGuard(orgId: string): Promise<void> {
    const org = await this.deps.orgStorage.getOrg(orgId);
    if (!org) {
      throw new OrgWireGuardError(`org ${orgId} does not exist`);
    }
    const wireguard = org.fly?.wireguard;
    const interfaceName = orgWireGuardInterfaceName(orgId);
    // The interface is brought up by wg-quick directly (bringUp enables the
    // unit for reboots but never starts it), so the unit is inactive and a
    // `disable --now` stops nothing. Down it while the conf still exists —
    // wg-quick reads the conf to undo itself — and failing that, delete the
    // link outright. A surviving interface keeps the org network's /48 route,
    // and the NEXT org on that network reads the stale route as a conflict
    // and rolls its own tunnel back (found live, 2026-08-24).
    const show = await this.deps.exec(['ip', 'link', 'show', interfaceName]);
    if (show.code === 0) {
      const down = await this.deps.exec(['wg-quick', 'down', interfaceName]);
      if (down.code !== 0) {
        await this.deps.exec(['ip', 'link', 'delete', interfaceName]);
      }
    }
    await this.deps.exec(['systemctl', 'disable', `wg-quick@${interfaceName}`]).catch(() => undefined);
    await this.deps.exec(['rm', '-f', `${this.confDir}/${interfaceName}.conf`]);
    if (wireguard) {
      const context = await this.deps.orgFly.resolveOrgFlyContext(orgId);
      if (context.source === 'org') {
        const fly = this.flyFor(context.apiToken);
        const organizationId = await fly.resolveOrganizationId(context.orgSlug);
        await fly.removeWireGuardPeer({ organizationId, name: wireguard.peerName }).catch((error) => {
          console.warn(`[OrgWireGuard] could not remove Fly peer ${wireguard.peerName}`, error);
        });
      }
      await this.deps.orgStorage.updateOrg(orgId, { fly: { ...org.fly!, wireguard: undefined, peerCheck: undefined } });
    }
    await this.deps.orgSecrets.deleteOrgSecret(orgId, ORG_WIREGUARD_PRIVATE_KEY_SECRET);
  }

  /** A route for this network on any OTHER interface, or null when clear. */
  private async findForeignRoute(network: string, ourInterface: string): Promise<string | null> {
    const result = await this.deps.exec(['ip', '-6', 'route', 'show', network]);
    if (result.code !== 0) {
      throw new OrgWireGuardError(`ip -6 route show failed: ${result.stderr.trim()}`);
    }
    const line = result.stdout.trim();
    if (!line || line.includes(`dev ${ourInterface}`)) {
      return null;
    }
    return line;
  }

  private async bringUp(args: {
    interfaceName: string;
    privateKey: string;
    wireguard: { peerIp: string; endpoint: string; gatewayPubkey: string };
  }): Promise<void> {
    const { interfaceName, privateKey, wireguard } = args;
    const conf = renderWireGuardConfig({
      privateKey,
      peerIp: wireguard.peerIp,
      gatewayPubkey: wireguard.gatewayPubkey,
      endpoint: wireguard.endpoint,
      network: sixPnNetworkOf(wireguard.peerIp),
    });
    // Two steps: create the file 0600 FIRST, then fill it via dd's stdin —
    // the key is never in argv and never on disk with looser modes. (Not
    // `install /dev/stdin`: Node's exec pipes are socketpairs, and opening
    // /dev/stdin on a socket fails with ENXIO — the live rehearsal caught it.)
    const confPath = `${this.confDir}/${interfaceName}.conf`;
    const prepare = await this.deps.exec(['install', '-m', '600', '/dev/null', confPath]);
    if (prepare.code !== 0) {
      throw new OrgWireGuardError(`creating ${interfaceName}.conf failed: ${prepare.stderr.trim()}`);
    }
    // dd reads fd 0 directly (no reopen) and truncates at the end of what it
    // wrote, so a shorter rewrite leaves no tail of the previous config.
    const write = await this.deps.exec(['dd', `of=${confPath}`, 'status=none'], { stdin: conf });
    if (write.code !== 0) {
      throw new OrgWireGuardError(`writing ${interfaceName}.conf failed: ${write.stderr.trim()}`);
    }
    // Down-if-up before up: wg-quick has no "converge" verb, and a config
    // change under a live interface is otherwise silently ignored. A downed
    // moment costs an in-flight SSH packet a retry, nothing more.
    const show = await this.deps.exec(['ip', 'link', 'show', interfaceName]);
    if (show.code === 0) {
      const down = await this.deps.exec(['wg-quick', 'down', interfaceName]);
      if (down.code !== 0) {
        throw new OrgWireGuardError(`wg-quick down ${interfaceName} failed: ${down.stderr.trim()}`);
      }
    }
    const up = await this.deps.exec(['wg-quick', 'up', interfaceName]);
    if (up.code !== 0) {
      throw new OrgWireGuardError(`wg-quick up ${interfaceName} failed: ${up.stderr.trim()}`);
    }
    // Survive host reboots; --now is deliberately absent (it is already up).
    const enable = await this.deps.exec(['systemctl', 'enable', `wg-quick@${interfaceName}`]);
    if (enable.code !== 0) {
      console.warn(`[OrgWireGuard] systemctl enable wg-quick@${interfaceName} failed: ${enable.stderr.trim()}`);
    }
  }
}
