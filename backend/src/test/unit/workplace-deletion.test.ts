import PostalMime from 'postal-mime';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryDeploymentStorage } from '../../services/deployment-storage.js';
import { InMemoryDriveStorage } from '../../services/drive-storage.js';
import { InMemoryGitPullRequestStorage } from '../../services/git-pr-storage.js';
import { InMemoryGitRepoStorage } from '../../services/git-repo-storage.js';
import { InMemoryKnowledgePageCommentStorage } from '../../services/knowledge-page-comments.js';
import { InMemoryKnowledgeProposalStorage } from '../../services/knowledge-storage.js';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { InMemoryQuickNoteStorage } from '../../services/quick-note-storage.js';
import { InMemorySecretStorage } from '../../services/secret-storage.js';
import { InMemoryUserStorage } from '../../services/user-storage.js';
import {
  noticeMessage,
  noticeMoment,
  workplaceDeletionNoticeWords,
} from '../../services/workplace-deletion-notice.js';
import { WORKPLACE_DELETION_GRACE_MS, WorkplaceDeletionService } from '../../services/workplace-deletion.js';

/**
 * Deleting a whole workplace (owner, 2026-09-22): any admin asks, the
 * workplace locks for three days, any admin may keep it, and then it goes — with
 * nothing destroyed in its own cloud account and its site names freed. Every
 * member is emailed at each step.
 */

const START = Date.parse('2026-09-22T10:00:00Z');

async function build(options: { platformSlug?: string; stampNamespace?: boolean; hosted?: boolean } = {}) {
  let clock = START;
  const orgStorage = new InMemoryOrgStorage();
  const userStorage = new InMemoryUserStorage();
  const quickNoteStorage = new InMemoryQuickNoteStorage();
  const gitRepoStorage = new InMemoryGitRepoStorage();
  const gitPullRequestStorage = new InMemoryGitPullRequestStorage();
  const knowledgeProposalStorage = new InMemoryKnowledgeProposalStorage();
  const knowledgePageCommentStorage = new InMemoryKnowledgePageCommentStorage();
  const secretStorage = new InMemorySecretStorage();
  const driveStorage = new InMemoryDriveStorage();
  const deploymentStorage = new InMemoryDeploymentStorage();

  for (const [userId, firstName, lastName] of [['u1', 'Saddam', 'Baialiev'], ['u2', 'Mira', 'Chen']] as const) {
    await userStorage.createProfile(userId, {});
    await userStorage.updatePersonFields(userId, { firstName, lastName });
  }
  const org = await orgStorage.createOrg({ name: 'Nomad Trading', createdByUserId: 'u1' });
  if (options.stampNamespace !== false) await orgStorage.updateOrg(org.orgId, { git: { namespaceId: org.orgId } });
  if (!options.hosted) {
    await orgStorage.updateOrg(org.orgId, {
      fly: { orgSlug: options.platformSlug ?? 'nomad-fly', tokenSecretName: 'FLY_ORG_TOKEN' },
    });
  }
  await orgStorage.addMember({ orgId: org.orgId, userId: 'u1', role: 'admin' });
  await orgStorage.addMember({ orgId: org.orgId, userId: 'u2', role: 'member' });
  // One of its old rooms' namespaces, recorded on the workplace when its rooms
  // were merged and dropped (note #843): records made there before the merge
  // are still this workplace's, so the purge walks it too.
  const former = 'room-sales';
  await orgStorage.updateOrg(org.orgId, { roomsMerged: { mergedAt: '2026-09-01T00:00:00Z', namespaces: [former] } });

  // Somewhere else entirely, which nothing here may touch.
  const other = await orgStorage.createOrg({ name: 'Side Hustle', createdByUserId: 'u2' });
  await orgStorage.updateOrg(other.orgId, { git: { namespaceId: other.orgId } });
  await orgStorage.addMember({ orgId: other.orgId, userId: 'u2', role: 'admin' });

  const agent = (id: string, orgId: string, extra: Record<string, unknown> = {}) => ({
    id, name: id, cli: 'claude', orgId, serverId: `fly:app-${id}:m-${id}`, connectedAt: '2026-09-01T00:00:00Z', ...extra,
  });
  await userStorage.updateProfile('u1', {
    telegram: {
      chatId: '1', linkedAt: 't', notificationsEnabled: true,
      agents: {
        ada: agent('ada', org.orgId),
        wa1: agent('wa1', org.orgId, { purpose: 'workspace-recap' }),
        plan: { id: 'plan', name: 'Plan', cli: 'claude', orgId: org.orgId, planned: true },
      },
    } as never,
  });
  await userStorage.updateProfile('u2', {
    telegram: {
      chatId: '2', linkedAt: 't', notificationsEnabled: true,
      agents: {
        leo: agent('leo', org.orgId),
        elsewhere: agent('elsewhere', other.orgId),
      },
    } as never,
  });

  const note = (namespace: string, html: string) => quickNoteStorage.create({
    userId: namespace, html, createdByAgentId: 'user', updatedByAgentId: 'user',
  } as never);
  await note(org.orgId, '<p>Launch plan</p>');
  await note(former, '<p>Sales list</p>');
  await note(other.orgId, '<p>Side notes</p>');
  await note('u1', '<p>My own</p>');
  await secretStorage.createSecret(org.orgId, { key: 'STRIPE', value: 'sk' });
  await secretStorage.createSecret(former, { key: 'CRM', value: 'x' });
  await secretStorage.createSecret(`org:${org.orgId}`, { key: 'org-env:FLY_ORG_TOKEN', value: 'fly' });
  await secretStorage.createSecret(`org:${other.orgId}`, { key: 'org-env:FLY_ORG_TOKEN', value: 'fly2' });
  const repo = await gitRepoStorage.create({ userId: org.orgId, name: 'site', orgId: org.orgId } as never);
  await gitRepoStorage.create({ userId: other.orgId, name: 'side', orgId: other.orgId } as never);
  await gitPullRequestStorage.create({ userId: org.orgId, repoId: repo.id, repoName: 'site', status: 'open' } as never);
  await knowledgeProposalStorage.create({ userId: org.orgId, status: 'open' } as never);
  await driveStorage.change(org.orgId, (entries) => { entries.set('d1', { id: 'd1', name: 'Plan.pdf' } as never); });
  const shop = await deploymentStorage.create({ userId: 'u1', orgId: org.orgId, name: 'shop', status: 'live', flyApp: 'iapp-shop' } as never);
  await deploymentStorage.create({ userId: 'u2', orgId: other.orgId, name: 'side', status: 'live', flyApp: 'iapp-side' } as never);

  const suspendAgent = vi.fn(async () => 'stopped' as const);
  const forgetAgent = vi.fn(async (userId: string, agentId: string) => {
    await userStorage.removeTelegramAgent(userId, agentId);
    return { ok: true as const, name: agentId, machine: 'left' as const, remaining: 0 };
  });
  const deleteAgent = vi.fn(async () => ({ ok: true as const, name: 'x', machine: 'destroyed' as const, remaining: 0 }));
  const released: string[] = [];
  const deploymentService = {
    release: vi.fn(async (id: string) => { released.push(id); await deploymentStorage.delete(id); }),
    destroy: vi.fn(),
  };
  const gitHostClient = {
    deleteRepo: vi.fn(async () => ({ deleted: true, trashedAs: 'site.x.git' })),
    deleteKnowledge: vi.fn(async () => undefined),
  };
  const clearedPrefixes: string[] = [];
  const mediaStorage = { deleteObjectsWithPrefix: vi.fn(async ({ prefix }: { prefix: string }) => { clearedPrefixes.push(prefix); }) };
  const inbox: Array<{ to: string; raw: Buffer }> = [];
  const outside: Array<{ email: string; subject: string; paragraphs: readonly string[] }> = [];
  const releaseMessagesMachine = vi.fn(async (orgId: string) => `iamsg-${orgId.replace(/-/g, '').slice(0, 12)}`);
  const service = new WorkplaceDeletionService({
    orgStorage, userStorage, quickNoteStorage, gitRepoStorage, gitPullRequestStorage,
    knowledgeProposalStorage, knowledgePageCommentStorage, secretStorage, driveStorage, deploymentStorage,
    deploymentService: deploymentService as never,
    gitHostClient: gitHostClient as never,
    mediaStorage: mediaStorage as never,
    agentLifecycle: { deleteAgent, suspendAgent, forgetAgent } as never,
    mailboxes: { forUser: async (userId: string) => ({ address: `${userId}@agenticcloudcomputer.com` }) } as never,
    workspaceWebAuth: {
      storage: { getEmailIdentityByUserId: async (userId: string) => (userId === 'u2' ? { userId } : null) },
      passwordResetAddress: () => 'mira@outside.test',
    } as never,
  }, {
    platformFlyOrgSlug: 'platform-fly',
    workspaceUrl: 'https://acc.test/workspace',
    notices: {
      from: 'Agentic Cloud Computer <workspace@updates.acc.test>',
      deliverToInbox: async ({ to, raw }) => { inbox.push({ to, raw }); },
      sendOutside: async (message) => { outside.push(message); },
    },
    now: () => new Date(clock),
    log: () => undefined,
    releaseMessagesMachine,
  });
  return {
    releaseMessagesMachine,
    service, orgStorage, userStorage, quickNoteStorage, gitRepoStorage, gitPullRequestStorage,
    knowledgeProposalStorage, secretStorage, driveStorage, deploymentStorage,
    org, other, former, repo, shop,
    suspendAgent, forgetAgent, deleteAgent, deploymentService, gitHostClient, released, inbox, outside, clearedPrefixes,
    advance: (ms: number) => { clock += ms; },
  };
}

describe('WorkplaceDeletionService', () => {
  it('an admin’s ask locks the workplace for three days, puts every agent in it to sleep and emails every member', async () => {
    const h = await build();
    const asked = await h.service.schedule({ orgId: h.org.orgId, userId: 'u1' });
    expect(asked.ok).toBe(true);
    const locked = await h.orgStorage.getOrg(h.org.orgId);
    expect(locked?.deletion).toMatchObject({
      requestedAt: new Date(START).toISOString(),
      requestedByUserId: 'u1',
      requestedByName: 'Saddam Baialiev',
      purgeAt: new Date(START + WORKPLACE_DELETION_GRACE_MS).toISOString(),
    });
    // Every member's agents, the Workspace Agent included — never the one in
    // another workplace, and never a planned name with no machine.
    expect(h.suspendAgent.mock.calls.map((call) => (call as unknown[])[1]).sort()).toEqual(['ada', 'leo', 'wa1']);
    // Both members, at their address here; the one with an outside address there too.
    expect(h.inbox.map((mail) => mail.to).sort()).toEqual(['u1@agenticcloudcomputer.com', 'u2@agenticcloudcomputer.com']);
    expect(h.outside.map((mail) => mail.email)).toEqual(['mira@outside.test']);
    expect(h.outside[0]!.subject).toBe('Nomad Trading will be deleted on 25 September');
    expect(h.outside[0]!.paragraphs.join(' ')).toContain('Saddam Baialiev asked to delete the workplace Nomad Trading.');
    expect(h.outside[0]!.paragraphs.join(' ')).toContain('Nothing in the workplace’s own Fly account (nomad-fly) is destroyed');

    // A second tap answers the first request: same date, no second round.
    h.advance(60_000);
    const again = await h.service.schedule({ orgId: h.org.orgId, userId: 'u1' });
    expect(again.ok && again.deletion.purgeAt).toBe(locked!.deletion!.purgeAt);
    expect(h.inbox).toHaveLength(2);
    expect(h.suspendAgent).toHaveBeenCalledTimes(3);
  });

  it('refuses a member, and never locks the platform’s own workplace', async () => {
    const h = await build();
    expect(await h.service.schedule({ orgId: h.org.orgId, userId: 'u2' })).toMatchObject({ ok: false, status: 403 });
    expect((await h.orgStorage.getOrg(h.org.orgId))?.deletion).toBeUndefined();

    const platform = await build({ platformSlug: 'platform-fly' });
    const refused = await platform.service.schedule({ orgId: platform.org.orgId, userId: 'u1' });
    expect(refused).toMatchObject({ ok: false, status: 403 });
    expect((await platform.orgStorage.getOrg(platform.org.orgId))?.deletion).toBeUndefined();
    expect(platform.inbox).toHaveLength(0);
  });

  it('any admin keeps it: the lock lifts, everyone is told, and the three days passing do nothing', async () => {
    const h = await build();
    await h.service.schedule({ orgId: h.org.orgId, userId: 'u1' });
    expect(await h.service.cancel({ orgId: h.org.orgId, userId: 'u2' })).toMatchObject({ ok: false, status: 403 });
    await h.orgStorage.setMemberRole(h.org.orgId, 'u2', 'admin');
    expect(await h.service.cancel({ orgId: h.org.orgId, userId: 'u2' })).toEqual({ ok: true });
    expect((await h.orgStorage.getOrg(h.org.orgId))?.deletion).toBeUndefined();
    const kept = h.outside.at(-1)!;
    expect(kept.subject).toBe('Nomad Trading will not be deleted');
    expect(kept.paragraphs[0]).toBe('Mira Chen kept the workplace Nomad Trading, so it will not be deleted after all.');

    h.advance(WORKPLACE_DELETION_GRACE_MS + 60_000);
    expect(await h.service.sweep()).toEqual({ purged: [], failed: [] });
    expect(await h.orgStorage.getOrg(h.org.orgId)).not.toBeNull();
  });

  it('once the three days are up the workplace goes: records, names and keys — its cloud account untouched', async () => {
    const h = await build();
    await h.service.schedule({ orgId: h.org.orgId, userId: 'u1' });
    // Not yet: a day early is still a workplace someone can keep.
    h.advance(WORKPLACE_DELETION_GRACE_MS - 24 * 3600_000);
    expect((await h.service.sweep()).purged).toEqual([]);
    h.advance(24 * 3600_000);
    expect(await h.service.sweep()).toEqual({ purged: [h.org.orgId], failed: [] });

    expect(await h.orgStorage.getOrg(h.org.orgId)).toBeNull();
    expect(await h.orgStorage.getMembership(h.org.orgId, 'u1')).toBeNull();
    // Agents are FORGOTTEN, never deleted: deleting destroys the machine,
    // and the machines are the customer's.
    expect(h.deleteAgent).not.toHaveBeenCalled();
    expect(h.forgetAgent.mock.calls.map((call) => call[1]).sort()).toEqual(['ada', 'leo', 'wa1']);
    expect(Object.keys((await h.userStorage.getProfile('u1'))?.telegram?.agents ?? {})).toEqual([]);
    expect(Object.keys((await h.userStorage.getProfile('u2'))?.telegram?.agents ?? {})).toEqual(['elsewhere']);
    // Sites are released (names freed, apps left), never destroyed.
    expect(h.released).toEqual([h.shop.id]);
    expect(h.deploymentService.destroy).not.toHaveBeenCalled();
    expect(await h.deploymentStorage.getByName('shop')).toBeNull();
    expect(await h.deploymentStorage.getByName('side')).not.toBeNull();
    // Code on the platform's host goes to its trash; the rows go.
    expect(h.gitHostClient.deleteRepo).toHaveBeenCalledWith(h.org.orgId, 'site');
    expect(await h.gitRepoStorage.get(h.repo.id)).toBeNull();
    expect(await h.gitPullRequestStorage.listByRepo(h.repo.id)).toEqual([]);
    expect(h.gitHostClient.deleteKnowledge).toHaveBeenCalledWith(h.org.orgId);
    expect(await h.knowledgeProposalStorage.listByUser(h.org.orgId)).toEqual([]);
    expect(await h.quickNoteStorage.listByUser(h.org.orgId)).toEqual([]);
    expect(await h.quickNoteStorage.listByUser(h.former)).toEqual([]);
    expect(await h.secretStorage.getUserSecrets(h.org.orgId)).toEqual([]);
    expect(await h.secretStorage.getUserSecrets(h.former)).toEqual([]);
    expect(await h.secretStorage.getUserSecrets(`org:${h.org.orgId}`)).toEqual([]);
    expect((await h.driveStorage.read(h.org.orgId)).size).toBe(0);
    // Their files on the platform's store, by owner prefix — never a person's.
    expect([...h.clearedPrefixes].sort()).toEqual([`users/${h.org.orgId}/`, `users/${h.former}/`].sort());
    // Nothing of anybody else's: the other workplace, its notes and keys,
    // and a person's own namespace.
    expect(await h.orgStorage.getOrg(h.other.orgId)).not.toBeNull();
    expect(await h.quickNoteStorage.listByUser(h.other.orgId)).toHaveLength(1);
    expect(await h.quickNoteStorage.listByUser('u1')).toHaveLength(1);
    expect(await h.secretStorage.getUserSecrets(`org:${h.other.orgId}`)).toHaveLength(1);
    expect(await h.gitRepoStorage.listByUser(h.other.orgId)).toHaveLength(1);

    const gone = h.outside.at(-1)!;
    expect(gone.subject).toBe('Nomad Trading has been deleted');
    expect(gone.paragraphs[0]).toContain('as Saddam Baialiev asked on 22 September');
    expect(h.inbox.filter((mail) => mail.to === 'u2@agenticcloudcomputer.com')).toHaveLength(2);
  });

  it('a HOSTED workplace takes its machines and sites with it — they are on our account (note #664)', async () => {
    const h = await build({ hosted: true });
    // Its messaging machine was built on our account too (29 Oct 2026).
    await h.orgStorage.updateOrg(h.org.orgId, { messages: { host: { app: 'iamsg-x', machineId: 'm', privateIp: 'fdaa::2', volumeId: 'v' } } });
    await h.service.schedule({ orgId: h.org.orgId, userId: 'u1' });
    h.advance(WORKPLACE_DELETION_GRACE_MS);
    expect(await h.service.sweep()).toEqual({ purged: [h.org.orgId], failed: [] });
    // Every agent of the workplace is forgotten WITH its machine; nobody
    // else could ever remove one from our account.
    expect(h.forgetAgent.mock.calls.map((call) => [call[1], call[2]]).sort()).toEqual([
      ['ada', { destroyMachine: true }],
      ['leo', { destroyMachine: true }],
      ['wa1', { destroyMachine: true }],
    ]);
    // Its site is destroyed, then its name released; another workplace's
    // site is not touched.
    expect(h.deploymentService.destroy).toHaveBeenCalledWith(h.shop.id);
    expect(h.deploymentService.destroy).toHaveBeenCalledTimes(1);
    expect(h.released).toEqual([h.shop.id]);
    expect(await h.deploymentStorage.getByName('side')).not.toBeNull();
    // And its conversations' machine goes with it.
    expect(h.releaseMessagesMachine).toHaveBeenCalledWith(h.org.orgId);
    // Nobody is told something stays behind in a cloud account of theirs.
    expect(h.outside.flatMap((mail) => mail.paragraphs).join(' ')).not.toMatch(/Fly account/);
  });

  it('leaves a messaging machine in a workplace\'s own cloud there, like its other machines', async () => {
    const h = await build();
    await h.orgStorage.updateOrg(h.org.orgId, { messages: { host: { app: 'iamsg-x', machineId: 'm', privateIp: 'fdaa::2', volumeId: 'v' } } });
    await h.service.schedule({ orgId: h.org.orgId, userId: 'u1' });
    h.advance(WORKPLACE_DELETION_GRACE_MS);
    expect((await h.service.sweep()).purged).toEqual([h.org.orgId]);
    expect(h.releaseMessagesMachine).not.toHaveBeenCalled();
  });

  it('leaves the files of a workplace with its own storage bucket in that bucket', async () => {
    const h = await build();
    await h.orgStorage.updateOrg(h.org.orgId, { media: { addOnName: 'iamedia-x', bucket: 'iamedia-x', endpoint: 'https://x.test' } });
    await h.service.schedule({ orgId: h.org.orgId, userId: 'u1' });
    h.advance(WORKPLACE_DELETION_GRACE_MS);
    expect((await h.service.sweep()).purged).toEqual([h.org.orgId]);
    expect(h.clearedPrefixes).toEqual([]);
  });

  it('never deletes a namespace that is a person’s own, even when an older workplace resolves to it', async () => {
    const h = await build({ stampNamespace: false });
    // An old room of an unstamped workplace could adopt its founder's space,
    // and the merge recorded it among the workplace's old namespaces.
    await h.orgStorage.updateOrg(h.org.orgId, { roomsMerged: { mergedAt: '2026-09-01T00:00:00Z', namespaces: [h.former, 'u1'] } });
    await h.service.schedule({ orgId: h.org.orgId, userId: 'u1' });
    h.advance(WORKPLACE_DELETION_GRACE_MS);
    expect((await h.service.sweep()).purged).toEqual([h.org.orgId]);
    // The shelf of an unstamped workplace is its founder's id: left alone.
    expect(await h.quickNoteStorage.listByUser('u1')).toHaveLength(1);
    expect(h.gitHostClient.deleteKnowledge).not.toHaveBeenCalledWith('u1');
  });

  it('a profile read that fails stops the purge instead of treating a namespace as nobody’s', async () => {
    const h = await build();
    await h.service.schedule({ orgId: h.org.orgId, userId: 'u1' });
    h.advance(WORKPLACE_DELETION_GRACE_MS);
    // "Is this namespace a person?" cannot be answered for one old room's namespace.
    const getProfile = h.userStorage.getProfile.bind(h.userStorage);
    const spy = vi.spyOn(h.userStorage, 'getProfile').mockImplementation(async (userId: string) => {
      if (userId === h.former) throw new Error('database is locked');
      return getProfile(userId);
    });
    const first = await h.service.sweep();
    expect(first.failed[0]?.error).toBe('database is locked');
    // Nothing was touched and nothing was stamped: the purge had not begun.
    expect((await h.orgStorage.getOrg(h.org.orgId))?.deletion?.purge).toBeUndefined();
    expect(await h.quickNoteStorage.listByUser(h.former)).toHaveLength(1);
    expect(h.forgetAgent).not.toHaveBeenCalled();
    spy.mockRestore();
    expect((await h.service.sweep()).purged).toEqual([h.org.orgId]);
    expect(await h.quickNoteStorage.listByUser(h.former)).toEqual([]);
    expect(await h.quickNoteStorage.listByUser('u1')).toHaveLength(1);
  });

  it('never touches a namespace another workplace names as its own', async () => {
    const h = await build();
    // A repository of this workplace whose bytes sit at the OTHER workplace's base.
    await h.gitRepoStorage.create({ userId: h.other.orgId, name: 'borrowed', orgId: h.org.orgId } as never);
    // And one at a namespace of the other workplace's old rooms (note #843):
    // that is still the other workplace's, merged rooms or not.
    await h.orgStorage.updateOrg(h.other.orgId, { roomsMerged: { mergedAt: '2026-09-01T00:00:00Z', namespaces: ['room-side'] } });
    await h.gitRepoStorage.create({ userId: 'room-side', name: 'lent', orgId: h.org.orgId } as never);
    await h.quickNoteStorage.create({
      userId: 'room-side', html: '<p>Side room notes</p>', createdByAgentId: 'user', updatedByAgentId: 'user',
    } as never);
    await h.service.schedule({ orgId: h.org.orgId, userId: 'u1' });
    h.advance(WORKPLACE_DELETION_GRACE_MS);
    expect((await h.service.sweep()).purged).toEqual([h.org.orgId]);
    expect(await h.quickNoteStorage.listByUser(h.other.orgId)).toHaveLength(1);
    expect(await h.gitRepoStorage.getByName(h.other.orgId, 'side')).not.toBeNull();
    expect(h.gitHostClient.deleteKnowledge).not.toHaveBeenCalledWith(h.other.orgId);
    expect(await h.quickNoteStorage.listByUser('room-side')).toHaveLength(1);
    expect(h.gitHostClient.deleteKnowledge).not.toHaveBeenCalledWith('room-side');
  });

  it('cannot be kept once the three days are up, nor once the purge has begun', async () => {
    const h = await build();
    await h.service.schedule({ orgId: h.org.orgId, userId: 'u1' });
    h.advance(WORKPLACE_DELETION_GRACE_MS);
    expect(await h.service.cancel({ orgId: h.org.orgId, userId: 'u1' })).toMatchObject({ ok: false, status: 409 });
    // A purge that stopped half-way has stamped the record: still no keeping.
    h.forgetAgent.mockImplementationOnce(async () => ({ ok: false, reason: 'busy' }) as never);
    await h.service.sweep();
    expect((await h.orgStorage.getOrg(h.org.orgId))?.deletion?.purge?.namespaces).toContain(h.former);
    expect(await h.service.cancel({ orgId: h.org.orgId, userId: 'u1' })).toMatchObject({ ok: false, status: 409 });
  });

  it('a new ask waits out its own three days, even when an older list said the old one was due', async () => {
    const h = await build();
    await h.service.schedule({ orgId: h.org.orgId, userId: 'u1' });
    const stale = await h.orgStorage.getOrg(h.org.orgId);
    await h.service.cancel({ orgId: h.org.orgId, userId: 'u1' });
    h.advance(WORKPLACE_DELETION_GRACE_MS);
    // Asked again three days later; a sweep that read the OLD stamp arrives now.
    await h.orgStorage.updateOrg(h.org.orgId, { deletionKeptAt: undefined });
    await h.service.schedule({ orgId: h.org.orgId, userId: 'u1' });
    expect(stale?.deletion).toBeDefined();
    await h.service.purge(h.org.orgId);
    expect(await h.orgStorage.getOrg(h.org.orgId)).not.toBeNull();
  });

  it('re-stamps a lock made under the old week to three days and tells everyone, unless that date has already passed (note #654)', async () => {
    const h = await build();
    await h.service.schedule({ orgId: h.org.orgId, userId: 'u1' });
    const asked = (await h.orgStorage.getOrg(h.org.orgId))!.deletion!;
    const week = new Date(Date.parse(asked.requestedAt) + 7 * 24 * 3600_000).toISOString();
    await h.orgStorage.updateOrg(h.org.orgId, { deletion: { ...asked, purgeAt: week } });
    const mails = h.outside.length;

    h.advance(24 * 3600_000);
    expect(await h.service.sweep()).toEqual({ purged: [], failed: [] });
    const stamped = (await h.orgStorage.getOrg(h.org.orgId))!.deletion!;
    expect(stamped.purgeAt).toBe(new Date(START + WORKPLACE_DELETION_GRACE_MS).toISOString());
    expect(stamped.requestedAt).toBe(asked.requestedAt);
    // Every member hears the new date, once: the next sweep has nothing to re-stamp.
    expect(h.outside.length).toBe(mails + 1);
    expect(h.outside[h.outside.length - 1]!.subject).toBe('Nomad Trading will be deleted on 25 September');
    expect(await h.service.sweep()).toEqual({ purged: [], failed: [] });
    expect(h.outside.length).toBe(mails + 1);
    expect((await h.orgStorage.getOrg(h.org.orgId))!.deletion!.purgeAt).toBe(stamped.purgeAt);

    // The same old stamp found only after its three days would already be
    // up: the date the members were told stands, and nothing goes early.
    await h.orgStorage.updateOrg(h.org.orgId, { deletion: { ...asked, purgeAt: week } });
    h.advance(3 * 24 * 3600_000);
    expect(await h.service.sweep()).toEqual({ purged: [], failed: [] });
    expect((await h.orgStorage.getOrg(h.org.orgId))!.deletion!.purgeAt).toBe(week);
    expect(h.outside.length).toBe(mails + 1);
    expect(await h.orgStorage.getOrg(h.org.orgId)).toBeTruthy();
  });

  it('asking again right after a keep waits an hour, and two keeps at once mail once', async () => {
    const h = await build();
    await h.service.schedule({ orgId: h.org.orgId, userId: 'u1' });
    const before = h.outside.length;
    const [first, second] = await Promise.all([
      h.service.cancel({ orgId: h.org.orgId, userId: 'u1' }),
      h.service.cancel({ orgId: h.org.orgId, userId: 'u1' }),
    ]);
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(h.outside.length - before).toBe(1);
    expect(await h.service.schedule({ orgId: h.org.orgId, userId: 'u1' })).toMatchObject({ ok: false, status: 429 });
    h.advance(60 * 60_000);
    expect(await h.service.schedule({ orgId: h.org.orgId, userId: 'u1' })).toMatchObject({ ok: true });
  });

  it('refuses a workplace whose cloud runs another workplace’s site, and one laid out like the platform’s own', async () => {
    const h = await build();
    await h.deploymentStorage.create({ userId: 'u2', orgId: h.other.orgId, flyOrgId: h.org.orgId, name: 'guest', status: 'live', flyApp: 'iapp-guest' } as never);
    const refused = await h.service.schedule({ orgId: h.org.orgId, userId: 'u1' });
    expect(refused).toMatchObject({ ok: false, status: 403 });
    expect((refused as { error: string }).error).toContain('The site guest belongs to another workplace');

    const legacy = await build();
    await legacy.orgStorage.updateOrg(legacy.org.orgId, { git: { namespaceId: 'u1' } });
    expect(await legacy.service.schedule({ orgId: legacy.org.orgId, userId: 'u1' })).toMatchObject({ ok: false, status: 403 });
  });

  it('takes down a site that runs in another account before freeing its name', async () => {
    const h = await build();
    const moved = await h.deploymentStorage.create({ userId: 'u1', orgId: h.org.orgId, flyOrgId: 'platform-org', name: 'school', status: 'live', flyApp: 'iapp-school' } as never);
    await h.service.schedule({ orgId: h.org.orgId, userId: 'u1' });
    h.advance(WORKPLACE_DELETION_GRACE_MS);
    expect((await h.service.sweep()).purged).toEqual([h.org.orgId]);
    expect(h.deploymentService.destroy).toHaveBeenCalledWith(moved.id);
    expect(h.deploymentService.destroy).not.toHaveBeenCalledWith(h.shop.id);
    expect(h.released.sort()).toEqual([h.shop.id, moved.id].sort());
  });

  it('a purge that stops half-way says why on the workplace, and the next sweep finishes it', async () => {
    const h = await build();
    await h.service.schedule({ orgId: h.org.orgId, userId: 'u1' });
    h.advance(WORKPLACE_DELETION_GRACE_MS);
    h.forgetAgent.mockImplementationOnce(async () => ({ ok: false, reason: 'Leo could not be removed: busy' }) as never);
    const first = await h.service.sweep();
    expect(first.failed).toEqual([{ orgId: h.org.orgId, error: 'Leo could not be removed: busy' }]);
    expect((await h.orgStorage.getOrg(h.org.orgId))?.deletion?.lastAttempt?.error).toBe('Leo could not be removed: busy');
    expect(h.outside.at(-1)!.subject).not.toBe('Nomad Trading has been deleted');

    expect((await h.service.sweep()).purged).toEqual([h.org.orgId]);
    expect(await h.orgStorage.getOrg(h.org.orgId)).toBeNull();
  });
});

describe('workplace deletion notices', () => {
  it('say the date in UTC, and name the cloud account that is left standing', () => {
    expect(noticeMoment('2026-09-29T10:05:00Z')).toBe('29 September 2026 at 10:05 UTC');
    const words = workplaceDeletionNoticeWords({
      kind: 'scheduled', workplace: 'Nomad Trading', actor: 'Saddam', requestedAt: '2026-09-22T10:05:00Z',
      purgeAt: '2026-09-29T10:05:00Z', workspaceUrl: 'https://acc.test/workspace/workplace?org=o1', cloudSlug: 'nomad-fly',
    });
    expect(words.subject).toBe('Nomad Trading will be deleted on 29 September');
    expect(words.paragraphs[1]).toContain('29 September 2026 at 10:05 UTC');
    expect(words.paragraphs.join(' ')).toContain('Any admin of the workplace can still keep it');
    expect(words.action).toEqual({ label: 'Open the Workspace', url: 'https://acc.test/workspace/workplace?org=o1' });
    expect(workplaceDeletionNoticeWords({
      kind: 'deleted', workplace: 'Nomad Trading', actor: 'Saddam', requestedAt: '2026-09-22T10:05:00Z', purgeAt: '2026-09-29T10:05:00Z',
    }).action).toBeUndefined();
  });

  it('write a message the inbox reads back exactly, a name that is not ASCII included', async () => {
    const words = workplaceDeletionNoticeWords({
      kind: 'cancelled', workplace: 'Café Ümlaut', actor: 'Aigerim', requestedAt: '2026-09-22T10:05:00Z', purgeAt: '2026-09-29T10:05:00Z',
    });
    const raw = noticeMessage({
      from: 'Agentic Cloud Computer <workspace@updates.acc.test>', to: 'mira@agenticcloudcomputer.com',
      words, date: new Date(START), messageId: 'workplace-cancelled-o1.u2@updates.acc.test',
    });
    const parsed = await PostalMime.parse(raw);
    expect(parsed.subject).toBe('Café Ümlaut will not be deleted');
    expect(parsed.from?.address).toBe('workspace@updates.acc.test');
    expect(parsed.messageId).toBe('<workplace-cancelled-o1.u2@updates.acc.test>');
    expect(parsed.text?.replace(/\r\n/g, '\n').trim()).toBe(words.paragraphs.join('\n\n'));
  });
});
