/**
 * Deleting a whole workplace (owner, 2026-09-22) — the flow a populated
 * workplace never had. Until now only an EMPTY workplace could go, from its
 * details page, and anything with people, agents or work in it was a runbook
 * an operator walked by hand (knowledge: deleting-a-client-org).
 *
 * The owner's decisions, each of which shapes a part below:
 *
 *  1. Any admin may ask, alone. Nobody else has to agree.
 *  2. Nothing in the workplace's OWN cloud account is destroyed. Its agent
 *     machines, site apps, storage and any host it runs stay there; the
 *     platform lets go of them. Removing them is the customer's call.
 *     A HOSTED workplace (note #664) has no account of its own: its
 *     machines and sites are in OURS, where nobody else could ever remove
 *     them, so they are destroyed with it.
 *  3. Not at once: the workplace LOCKS the moment an admin asks (its agents
 *     are put to sleep and refused new turns, and every member sees the
 *     deletion screen), and it is deleted for good three days later (the
 *     owner shortened it from a week, note #654). Until
 *     then any admin can keep it, and it comes back exactly as it was.
 *  4. Every member is emailed: when it is asked for, if it is kept, and when
 *     it is gone.
 *  5. Its site addresses are freed — the one thing the rest of the platform
 *     notices, because anyone may take those names afterwards.
 *
 * `schedule` and `cancel` are the two doors an admin taps; `sweep` runs on a
 * timer and purges every workplace whose three days are up. The purge is written to
 * be RE-RUN: each step reads what is still there and removes it, the rows a
 * failed step would need later are removed last, and the workplace's own row
 * goes at the very end — so a purge that stops half-way is simply finished
 * by the next sweep, and records the reason on the workplace meanwhile.
 *
 * The platform's own workplace (org #0, the one whose cloud account the
 * backend itself runs in) is refused outright, exactly as the operator's
 * teardown script refuses it.
 */

import type { RouteDeps } from '../routes/deps.js';
import type { OrgDocument } from '../types/org.js';
import { isHostedWorkplace } from './hosted-workplace.js';
import { workplaceNumberSeries } from './workplace-numbers.js';
import { listAgents, personDisplayName, type AgentRecord } from '../types/user.js';
import {
  sendWorkplaceDeletionNotice,
  workplaceDeletionNoticeWords,
  type WorkplaceDeletionNoticeDeps,
  type WorkplaceDeletionNoticeKind,
  type WorkplaceDeletionRecipient,
} from './workplace-deletion-notice.js';

/** How long a locked workplace waits before it is deleted for good. */
export const WORKPLACE_DELETION_GRACE_MS = 3 * 24 * 60 * 60_000;

/** How often the sweep looks for a workplace whose three days are up. */
export const WORKPLACE_DELETION_SWEEP_MS = 15 * 60_000;

/** How long after a workplace is kept before it can be asked for again. */
export const WORKPLACE_DELETION_ASK_AGAIN_MS = 60 * 60_000;

export type WorkplaceDeletionDeps = Pick<
  RouteDeps,
  | 'orgStorage'
  | 'userStorage'
  | 'agentLifecycle'
  | 'deploymentService'
  | 'deploymentStorage'
  | 'objectStorage'
  | 'gitRepoStorage'
  | 'gitPullRequestStorage'
  | 'gitCommitStatusStorage'
  | 'orgGitHost'
  | 'gitHostClient'
  | 'knowledgeProposalStorage'
  | 'knowledgePageCommentStorage'
  | 'quickNoteStorage'
  | 'secretStorage'
  | 'driveStorage'
  | 'directMessageStorage'
  | 'mediaStorage'
  | 'orgWireGuard'
  | 'mailboxes'
  | 'mailIngest'
  | 'workspaceWebAuth'
>;

export interface WorkplaceDeletionOptions {
  /** The platform's own Fly organization: a workplace running in it is org #0. */
  platformFlyOrgSlug?: string;
  /** How notices go out; absent → nobody is emailed (tests, dev). */
  notices?: Omit<WorkplaceDeletionNoticeDeps, 'now' | 'log'>;
  /** The Workspace's own address, for the notices' one link. */
  workspaceUrl?: string;
  graceMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
  /** Destroys a hosted workplace's messaging machine (OrgMsgHostService):
   *  the app it removed, or null when the workplace had none on our side. */
  releaseMessagesMachine?: (orgId: string) => Promise<string | null>;
}

export type WorkplaceDeletionRefusal = { ok: false; status: number; error: string };

/** What a workplace's owner reads on the lock screen, and the emails repeat. */
export type WorkplaceDeletionState = NonNullable<OrgDocument['deletion']>;

/** True for the platform's own workplace — never deleted through the product. */
export function isPlatformWorkplace(org: Pick<OrgDocument, 'fly'>, platformFlyOrgSlug: string | undefined): boolean {
  return Boolean(platformFlyOrgSlug && org.fly?.orgSlug && org.fly.orgSlug === platformFlyOrgSlug);
}

export class WorkplaceDeletionService {
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly graceMs: number;
  /** One purge per workplace at a time: a slow sweep never overlaps the next.
   *  Also what a Keep checks in the same tick as its write, so a purge and a
   *  Keep can never both proceed (one process holds both). */
  private readonly purging = new Set<string>();
  /** A Keep in flight, so two taps at once send one round of mail. */
  private readonly keeping = new Set<string>();

  constructor(private readonly deps: WorkplaceDeletionDeps, private readonly options: WorkplaceDeletionOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((line) => console.log(`[workplace-deletion] ${line}`));
    this.graceMs = options.graceMs ?? WORKPLACE_DELETION_GRACE_MS;
  }

  isPlatformWorkplace(org: Pick<OrgDocument, 'fly'>): boolean {
    return isPlatformWorkplace(org, this.options.platformFlyOrgSlug);
  }

  /** The half of {@link refusalFor} that reads nothing but the record — what
   *  the details page asks on every open. */
  standingRefusalFor(org: OrgDocument): string | null {
    if (this.isPlatformWorkplace(org)) {
      return 'This is the platform’s own workplace: the Workspace itself runs in its cloud account, so it cannot be deleted.';
    }
    // Org #0's layout, and any workplace old enough to share it: its work is
    // kept in its founder's own space, which is theirs, not the workplace's.
    if (org.git?.namespaceId && org.git.namespaceId === org.createdByUserId) {
      return 'This workplace keeps its work in its founder’s own space, so only the platform’s operator can delete it.';
    }
    return null;
  }

  /**
   * Why this workplace cannot be deleted through the product at all, or null.
   * Asked when an admin asks, and again when the purge begins.
   */
  async refusalFor(org: OrgDocument): Promise<string | null> {
    const standing = this.standingRefusalFor(org);
    if (standing) return standing;
    // A site of ANOTHER workplace that runs in this one's cloud account would
    // be stranded: the purge removes the only token that reaches it.
    const hosted = (await this.deps.deploymentStorage?.listAll() ?? []).find((site) => (
      site.flyOrgId === org.orgId && site.orgId !== org.orgId && site.status !== 'destroyed'
    ));
    if (hosted) {
      return `The site ${hosted.name} belongs to another workplace but runs in this one’s cloud account. It has to move before this workplace can be deleted.`;
    }
    return null;
  }

  /** When a deletion asked for now would land — the confirmation screen's date. */
  purgeAtFrom(requestedAt: Date): string {
    return new Date(requestedAt.getTime() + this.graceMs).toISOString();
  }

  /**
   * An admin asks. Locks the workplace, puts every agent in it to sleep and
   * emails every member. Asking twice answers the first request unchanged —
   * a second tap must not push the date out or send a second round of mail.
   */
  async schedule(args: { orgId: string; userId: string }): Promise<{ ok: true; deletion: WorkplaceDeletionState } | WorkplaceDeletionRefusal> {
    const storage = this.deps.orgStorage;
    if (!storage) return { ok: false, status: 503, error: 'The workplace layer is not available on this backend yet.' };
    const org = await storage.getOrg(args.orgId);
    if (!org) return { ok: false, status: 404, error: 'This workplace no longer exists.' };
    const membership = await storage.getMembership(args.orgId, args.userId);
    if (membership?.role !== 'admin') return { ok: false, status: 403, error: 'Only an admin can delete this workplace.' };
    const refusal = await this.refusalFor(org);
    if (refusal) return { ok: false, status: 403, error: refusal };
    if (org.deletion) return { ok: true, deletion: org.deletion };
    const again = org.deletionKeptAt ? Date.parse(org.deletionKeptAt) + WORKPLACE_DELETION_ASK_AGAIN_MS : 0;
    if (again > this.now().getTime()) {
      return { ok: false, status: 429, error: 'It was kept less than an hour ago. Ask again in a little while.' };
    }

    const requestedAt = this.now();
    const profile = await this.deps.userStorage?.getProfile(args.userId).catch(() => null);
    const deletion: WorkplaceDeletionState = {
      requestedAt: requestedAt.toISOString(),
      requestedByUserId: args.userId,
      requestedByName: personDisplayName(profile),
      purgeAt: this.purgeAtFrom(requestedAt),
    };
    // The lock first: from this write on, no turn can start in the
    // workplace, so putting the agents to sleep below cannot race a new one.
    if (!await storage.updateOrg(org.orgId, { deletion })) {
      return { ok: false, status: 404, error: 'This workplace no longer exists.' };
    }
    this.log(`${org.orgId} (${org.name}) locked by ${args.userId}; deleted for good at ${deletion.purgeAt}`);
    // Side by side: the admin is waiting on this tap, and neither half can
    // undo the lock that is already written.
    await Promise.allSettled([
      this.suspendAgents(org.orgId),
      this.notify('scheduled', { ...org, deletion }, deletion.requestedByName),
    ]);
    return { ok: true, deletion };
  }

  /**
   * An admin keeps it. The lock lifts and the workplace is exactly as it was:
   * its agents wake on the next message, the way they do after any sleep.
   */
  async cancel(args: { orgId: string; userId: string }): Promise<{ ok: true } | WorkplaceDeletionRefusal> {
    const storage = this.deps.orgStorage;
    if (!storage) return { ok: false, status: 503, error: 'The workplace layer is not available on this backend yet.' };
    const org = await storage.getOrg(args.orgId);
    if (!org) return { ok: false, status: 404, error: 'This workplace no longer exists.' };
    const membership = await storage.getMembership(args.orgId, args.userId);
    if (membership?.role !== 'admin') return { ok: false, status: 403, error: 'Only an admin can keep this workplace.' };
    if (!org.deletion) return { ok: true };
    const now = this.now().toISOString();
    // Once the three days are up the purge may already be taking it apart, and a
    // half-deleted workplace must never be handed back as "as it was".
    // Checked in the same tick as the write below: no purge can begin between.
    if (org.deletion.purge || org.deletion.purgeAt <= now || this.purging.has(org.orgId)) {
      return { ok: false, status: 409, error: 'The deletion has already started and cannot be stopped now.' };
    }
    if (this.keeping.has(org.orgId)) return { ok: true };
    this.keeping.add(org.orgId);
    try {
      await storage.updateOrg(org.orgId, { deletion: undefined, deletionKeptAt: now });
      const profile = await this.deps.userStorage?.getProfile(args.userId).catch(() => null);
      this.log(`${org.orgId} (${org.name}) kept by ${args.userId}`);
      await this.notify('cancelled', org, personDisplayName(profile));
    } finally {
      this.keeping.delete(org.orgId);
    }
    return { ok: true };
  }

  /** Purge every workplace whose three days are up. Never throws. */
  async sweep(): Promise<{ purged: string[]; failed: Array<{ orgId: string; error: string }> }> {
    const purged: string[] = [];
    const failed: Array<{ orgId: string; error: string }> = [];
    const orgs = await this.deps.orgStorage?.listOrgs().catch(() => []) ?? [];
    const now = this.now().toISOString();
    for (const org of orgs) {
      if (!org.deletion) continue;
      // A workplace locked under a LONGER grace than the one that stands now
      // (a week, until the owner shortened it to three days on 2026-09-24,
      // note #654) still carried its old date: the lock screen and the
      // members' mail said the week. Re-stamp it to the grace as it now is
      // and tell every member the new date — but only while that date is
      // still ahead. Nobody is deleted earlier than they were told without a
      // notice that can still reach them first, so a shortened date already
      // in the past leaves the promised one standing.
      const requestedAt = Date.parse(org.deletion.requestedAt);
      const shortened = Number.isNaN(requestedAt) ? null : this.purgeAtFrom(new Date(requestedAt));
      if (shortened && !org.deletion.purge && shortened < org.deletion.purgeAt && shortened > now) {
        const promised = org.deletion.purgeAt;
        const deletion: WorkplaceDeletionState = { ...org.deletion, purgeAt: shortened };
        if (await this.deps.orgStorage?.updateOrg(org.orgId, { deletion }).catch(() => false)) {
          org.deletion = deletion;
          this.log(`${org.orgId} (${org.name}) re-stamped from ${promised} to ${shortened}: the grace is shorter now`);
          await this.notify('scheduled', org, deletion.requestedByName).catch((error) => {
            this.log(`${org.orgId} could not tell its members the new date: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      }
      if (org.deletion.purgeAt > now) continue;
      try {
        await this.purge(org.orgId);
        purged.push(org.orgId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ orgId: org.orgId, error: message });
        this.log(`${org.orgId} purge stopped, will retry: ${message}`);
        // Over the record as it is NOW: the purge may have stamped it.
        const fresh = await this.deps.orgStorage?.getOrg(org.orgId).catch(() => null);
        if (fresh?.deletion) {
          await this.deps.orgStorage?.updateOrg(org.orgId, {
            deletion: { ...fresh.deletion, lastAttempt: { at: now, error: message.slice(0, 500) } },
          }).catch(() => false);
        }
      }
    }
    return { purged, failed };
  }

  /**
   * The end of the three days. Throws when a step fails; everything already done
   * stays done, and the next sweep finishes the rest.
   */
  async purge(orgId: string): Promise<void> {
    if (this.purging.has(orgId)) return;
    this.purging.add(orgId);
    try {
      await this.purgeOnce(orgId);
    } finally {
      this.purging.delete(orgId);
    }
  }

  private async purgeOnce(orgId: string): Promise<void> {
    const storage = this.deps.orgStorage;
    if (!storage) throw new Error('The workplace layer is not available.');
    // Read AFTER `purging` holds this workplace, so a Keep either landed
    // before this read or is refused. Its own date, too: the list the sweep
    // walked may be older than a Keep and a new ask.
    const org = await storage.getOrg(orgId);
    const deletion = org?.deletion;
    if (!org || !deletion || deletion.purgeAt > this.now().toISOString()) return;
    const refusal = await this.refusalFor(org);
    if (refusal) throw new Error(refusal);
    const members = await storage.listMembers(orgId);
    // The first run stamps what a retry will need, and from this write on
    // the workplace can no longer be kept.
    let purge = deletion.purge;
    if (!purge) {
      purge = {
        startedAt: this.now().toISOString(),
        namespaces: await this.namespacesOf(org),
        memberIds: members.map((member) => member.userId),
      };
      await storage.updateOrg(orgId, { deletion: { ...deletion, purge } });
    }
    const namespaces = [...new Set([...purge.namespaces, ...await this.namespacesOf(org)])];
    const memberIds = [...new Set([...purge.memberIds, ...members.map((member) => member.userId)])];
    // The workplace's own storage bucket is in its own cloud account and is
    // left there (decision 2); only bytes on the PLATFORM's store are ours to
    // remove, and only while the org row still routes them.
    const mediaIsOurs = !org.media;
    // Likewise its own git host: its bytes are the customer's.
    const hostIsOurs = !org.git?.host;
    // And its machines and sites, when it has no cloud of its own (note #664).
    const machinesAreOurs = isHostedWorkplace(org);

    // 1. Agents — every member's, the Workspace Agents included. Their
    //    records, chats, keys and checkpoints go; their machines stay, asleep
    //    — unless they are on our account, and then they go too.
    //    A read that fails stops the purge rather than skipping somebody:
    //    an agent left behind would outlive its workplace.
    for (const userId of memberIds) {
      const profile = await this.deps.userStorage?.getProfile(userId);
      if (!profile) continue;
      const legacyOrgId = await this.oldestOrgOf(userId);
      for (const agent of listAgents(profile.telegram, true)) {
        if (!belongsTo(agent, orgId, legacyOrgId)) continue;
        if (agent.planned) {
          await this.deps.userStorage?.removeTelegramAgent(userId, agent.id);
          continue;
        }
        const forget = this.deps.agentLifecycle?.forgetAgent;
        if (!forget) throw new Error('Agent removal is unavailable right now.');
        const result = await forget(userId, agent.id, machinesAreOurs ? { destroyMachine: true } : undefined);
        if (!result.ok) throw new Error(result.reason);
      }
    }

    // 1b. The messaging machine (note #608), when it runs on our account: its
    //     volume IS the conversations, so it goes with the workplace. One in
    //     the workplace's own cloud is left there like its other machines.
    if (machinesAreOurs && org.messages?.host && this.options.releaseMessagesMachine) {
      const app = await this.options.releaseMessagesMachine(orgId);
      if (app) this.log(`messaging machine of ${orgId}: removed ${app}`);
    }

    // 2. Sites: every address handed back, every record gone (decision 5).
    //    An app in the workplace's own cloud account is left there (decision
    //    2). One that runs in ANOTHER account — a site moved in from
    //    elsewhere, or any site of a hosted workplace, which runs in ours —
    //    would otherwise run on, untracked, on somebody else's bill, so that
    //    one is taken down first.
    for (const site of await this.deps.deploymentStorage?.listByOrg(orgId) ?? []) {
      if (!this.deps.deploymentService) {
        await this.deps.deploymentStorage?.delete(site.id);
        continue;
      }
      const elsewhere = Boolean(site.flyOrgId && site.flyOrgId !== orgId);
      if ((elsewhere || machinesAreOurs) && site.status !== 'destroyed') {
        await this.deps.deploymentService.destroy(site.id);
      }
      await this.deps.deploymentService.release(site.id);
    }

    // 2b. Object-storage buckets (note #768): one in OUR account is emptied
    //     and removed; one in the workplace's own cloud is left there with
    //     its bytes (decision 2). Every record goes.
    if (this.deps.objectStorage) {
      const { destroyed, left } = await this.deps.objectStorage.releaseAll(orgId);
      if (destroyed.length || left.length) {
        this.log(`buckets of ${orgId}: removed ${destroyed.join(', ') || 'none'}; left in the workplace's own cloud: ${left.join(', ') || 'none'}`);
      }
    }

    // 3. Repositories, their proposals and their check runs. On the
    //    platform's own code host the bytes are moved to its trash, which the
    //    host empties on its own schedule; on the workplace's own host they
    //    stay with the customer.
    const host = hostIsOurs ? await this.gitHostFor(orgId) : null;
    const repoStorage = this.deps.gitRepoStorage;
    if (repoStorage) {
      const repos = [
        ...await repoStorage.listLiveIn(namespaces),
        ...await repoStorage.listTrashedIn(namespaces),
      ];
      for (const repo of repos) {
        if (host && !repo.deletedAt) await host.deleteRepo(repo.userId, repo.name);
        for (const proposal of await this.deps.gitPullRequestStorage?.listByRepo(repo.id) ?? []) {
          await this.deps.gitPullRequestStorage!.delete(proposal.id);
        }
        await this.deps.gitCommitStatusStorage?.deleteByRepo?.(repo.id);
        await repoStorage.delete?.(repo.id);
      }
    }

    // 4. Everything kept per namespace: proposals filed there, knowledge,
    //    notes and keys.
    for (const namespace of namespaces) {
      for (const proposal of await this.deps.gitPullRequestStorage?.listByRoomNamespace(namespace) ?? []) {
        await this.deps.gitPullRequestStorage!.delete(proposal.id);
      }
      if (host) await host.deleteKnowledge(namespace);
      await this.deps.knowledgeProposalStorage?.deleteByUser(namespace);
      await this.deps.knowledgePageCommentStorage?.deleteByUser(namespace);
      await this.deps.quickNoteStorage?.deleteByUser(namespace);
      for (const secret of await this.deps.secretStorage?.getUserSecrets(namespace) ?? []) {
        await this.deps.secretStorage!.deleteSecret(namespace, secret.secretId);
      }
    }
    // The workplace's own number series (note #741) goes with it.
    await this.deps.quickNoteStorage?.deleteSeries(workplaceNumberSeries(orgId, orgId));
    await this.deps.knowledgeProposalStorage?.deleteSeries(workplaceNumberSeries(orgId, orgId));

    // 5. Drive and the platform's side of private conversations. The
    //    conversations themselves live on the workplace's own messaging
    //    machine, in its cloud account, and stay there.
    if (this.deps.driveStorage && (await this.deps.driveStorage.read(orgId)).size) {
      await this.deps.driveStorage.change(orgId, (entries) => entries.clear());
    }
    await this.deps.directMessageStorage?.forgetWorkplace?.(orgId);

    // Every file those records carried — notes', proposals', pages', Drive's,
    // the workplace's picture — lives under the owner prefix of one of these
    // namespaces or of the workplace itself. On the platform's store they are
    // ours to remove, while the workplace's row still routes them there.
    if (mediaIsOurs) {
      for (const owner of new Set([orgId, ...namespaces])) await this.clearMedia(`users/${owner}/`);
    }

    // 6. Let go of the cloud account: our tunnel into it, then every key the
    //    platform held for it (the Fly token last of all, since removing the
    //    tunnel's far end needs it).
    if (org.fly?.wireguard && this.deps.orgWireGuard) {
      await this.deps.orgWireGuard.removeOrgWireGuard(orgId).catch((error) => {
        // The local side comes down first inside that call; only the far end
        // needs the token, and a revoked token is the customer's to clean up.
        this.log(`${orgId} tunnel removal incomplete: ${(error as Error).message}`);
      });
    }
    const orgSecretsOwner = `org:${orgId}`;
    for (const secret of await this.deps.secretStorage?.getUserSecrets(orgSecretsOwner) ?? []) {
      await this.deps.secretStorage!.deleteSecret(orgSecretsOwner, secret.secretId);
    }

    // 7. The workplace itself: memberships, then the row (which takes
    //    its invites, join requests and sign-in assignments with it). Private
    //    sign-ins are the members' own and are not touched.
    for (const member of await storage.listMembers(orgId)) await storage.removeMember(orgId, member.userId);
    if (!await storage.deleteOrg(orgId)) {
      throw new Error('The workplace changed while it was being deleted; the next sweep finishes it.');
    }
    this.log(`${orgId} (${org.name}) deleted for good`);

    // Everyone who was a member when the purge began — their memberships are
    // gone, but their addresses are their own.
    await this.send('deleted', org, deletion, deletion.requestedByName, await this.recipients(memberIds));
  }

  /** Every agent of every member put to sleep — the lock's other half. All at
   *  once: each may wait a few seconds for a running turn to wind down. */
  private async suspendAgents(orgId: string): Promise<void> {
    const suspend = this.deps.agentLifecycle?.suspendAgent;
    if (!suspend || !this.deps.orgStorage) return;
    const pending: Array<Promise<unknown>> = [];
    for (const member of await this.deps.orgStorage.listMembers(orgId)) {
      const profile = await this.deps.userStorage?.getProfile(member.userId).catch(() => null);
      if (!profile) continue;
      const legacyOrgId = await this.oldestOrgOf(member.userId).catch(() => null);
      for (const agent of listAgents(profile.telegram, true)) {
        if (!belongsTo(agent, orgId, legacyOrgId) || agent.planned) continue;
        pending.push(suspend(member.userId, agent.id).catch((error: unknown) => {
          this.log(`${orgId} could not put ${agent.id} to sleep: ${(error as Error).message}`);
        }));
      }
    }
    await Promise.all(pending);
  }

  /**
   * Every namespace whose contents are this workplace's: its base, its old
   * rooms' (note #843), and anywhere its repositories live. Never one that is anybody else's: a person's own id (an older
   * workplace can resolve to its founder's space), or anything another
   * workplace names as its base, its founder, or one of its old rooms. Every read
   * here THROWS rather than guessing — a failed read that answered "not a
   * person" would delete a person's work.
   */
  private async namespacesOf(org: OrgDocument): Promise<string[]> {
    const storage = this.deps.orgStorage!;
    const candidates = new Set<string>();
    if (org.git?.namespaceId) candidates.add(org.git.namespaceId);
    // Its old rooms' namespaces (note #843), where records made then still stand.
    for (const namespace of org.roomsMerged?.namespaces ?? []) candidates.add(namespace);
    for (const namespace of await this.deps.gitRepoStorage?.listNamespacesByOrg(org.orgId) ?? []) candidates.add(namespace);
    const foreign = new Set<string>();
    for (const other of await storage.listOrgs()) {
      if (other.orgId === org.orgId) continue;
      foreign.add(other.orgId);
      foreign.add(other.createdByUserId);
      if (other.git?.namespaceId) foreign.add(other.git.namespaceId);
      for (const namespace of other.roomsMerged?.namespaces ?? []) foreign.add(namespace);
    }
    const namespaces: string[] = [];
    for (const namespace of candidates) {
      if (!namespace || namespace === org.createdByUserId || foreign.has(namespace)) {
        if (namespace) this.log(`${org.orgId} leaves namespace ${namespace} alone: it is not only this workplace's`);
        continue;
      }
      const owner = await storage.getOrgByNamespace(namespace);
      if (owner && owner.orgId !== org.orgId) {
        this.log(`${org.orgId} leaves namespace ${namespace} alone: it is another workplace's`);
        continue;
      }
      if (await this.deps.userStorage?.getProfile(namespace)) {
        this.log(`${org.orgId} leaves namespace ${namespace} alone: it is a person's own`);
        continue;
      }
      namespaces.push(namespace);
    }
    return namespaces;
  }

  /** The membership an unstamped agent belongs to — the oldest, as everywhere.
   *  Throws on a failed read, like every read the purge decides by. */
  private async oldestOrgOf(userId: string): Promise<string | null> {
    const memberships = await this.deps.orgStorage?.listMembershipsByUser(userId) ?? [];
    return [...memberships]
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.orgId.localeCompare(b.orgId))[0]?.orgId ?? null;
  }

  private async gitHostFor(orgId: string) {
    if (this.deps.orgGitHost) return this.deps.orgGitHost.clientFor(orgId);
    return this.deps.gitHostClient ?? null;
  }

  private async clearMedia(prefix: string): Promise<void> {
    await this.deps.mediaStorage?.deleteObjectsWithPrefix?.({ prefix }).catch((error: unknown) => {
      this.log(`media cleanup of ${prefix} failed: ${(error as Error).message}`);
    });
  }

  private async recipients(userIds: readonly string[]): Promise<WorkplaceDeletionRecipient[]> {
    const recipients: WorkplaceDeletionRecipient[] = [];
    for (const userId of userIds) {
      const profile = await this.deps.userStorage?.getProfile(userId).catch(() => null);
      const mailbox = await this.deps.mailboxes?.forUser(userId).catch(() => null);
      const outside = await this.outsideAddressOf(userId);
      recipients.push({
        userId,
        name: personDisplayName(profile),
        ...(mailbox?.address ? { inbox: mailbox.address } : {}),
        ...(outside ? { outside } : {}),
      });
    }
    return recipients;
  }

  /** The outside address a password reset for this person would reach, if any. */
  private async outsideAddressOf(userId: string): Promise<string | null> {
    const auth = this.deps.workspaceWebAuth;
    if (!auth) return null;
    const identity = await auth.storage.getEmailIdentityByUserId(userId).catch(() => null);
    return identity ? auth.passwordResetAddress(identity) : null;
  }

  private async notify(kind: WorkplaceDeletionNoticeKind, org: OrgDocument, actor: string): Promise<void> {
    const deletion = org.deletion;
    const members = await this.deps.orgStorage?.listMembers(org.orgId).catch(() => []) ?? [];
    const recipients = await this.recipients(members.map((member) => member.userId));
    await this.send(kind, org, deletion, actor, recipients);
  }

  private async send(
    kind: WorkplaceDeletionNoticeKind,
    org: OrgDocument,
    deletion: WorkplaceDeletionState | undefined,
    actor: string,
    recipients: WorkplaceDeletionRecipient[],
  ): Promise<void> {
    const notices = this.options.notices;
    if (!notices || !recipients.length) return;
    const requestedAt = deletion?.requestedAt ?? this.now().toISOString();
    const workspaceUrl = this.options.workspaceUrl
      ? `${this.options.workspaceUrl.replace(/\/+$/, '')}/workplace?org=${encodeURIComponent(org.orgId)}`
      : undefined;
    const words = workplaceDeletionNoticeWords({
      kind,
      workplace: org.name,
      actor,
      requestedAt,
      purgeAt: deletion?.purgeAt ?? requestedAt,
      ...(workspaceUrl ? { workspaceUrl } : {}),
      ...(org.fly?.orgSlug ? { cloudSlug: org.fly.orgSlug } : {}),
    });
    // One key per decision: the same request retried mails nobody twice, and
    // a later ask of the same workplace is a new decision with its own key.
    const key = `workplace-${kind}-${org.orgId}-${Date.parse(requestedAt)}${kind === 'cancelled' ? `-${this.now().getTime()}` : ''}`;
    const reached = await sendWorkplaceDeletionNotice({ ...notices, now: this.now, log: this.log }, recipients, words, key);
    this.log(`${org.orgId} ${kind} notice reached ${reached} address${reached === 1 ? '' : 'es'} for ${recipients.length} member${recipients.length === 1 ? '' : 's'}`);
  }
}

/** Whether this agent stands in this workplace — unstamped ones by the oldest-membership rule. */
function belongsTo(agent: AgentRecord, orgId: string, legacyOrgId: string | null): boolean {
  return agent.orgId ? agent.orgId === orgId : legacyOrgId === orgId;
}
