import { describe, expect, it } from 'vitest';
import { InMemoryOrgStorage } from '../../services/org-storage.js';
import { SqliteOrgStorage } from '../../services/sqlite/sqlite-org-storage.js';
import { SqliteMailboxStorage } from '../../services/sqlite/sqlite-mailbox-storage.js';
import { openSqliteDb } from '../../services/sqlite/sqlite-db.js';
import { MailboxService } from '../../services/mailbox-service.js';
import { OrgHandleService } from '../../services/org-handles.js';

const storages = [
  ['in memory', () => new InMemoryOrgStorage()],
  ['sqlite', () => new SqliteOrgStorage(openSqliteDb(':memory:'))],
] as const;

describe.each(storages)('workplace handles (%s)', (_label, make) => {
  it('claims a word once, never moves it, and frees it on delete', async () => {
    const orgStorage = make();
    const acme = await orgStorage.createOrg({ name: 'Acme Trading', createdByUserId: 'u1' });
    const other = await orgStorage.createOrg({ name: 'Other', createdByUserId: 'u2' });
    expect(await orgStorage.claimHandle(acme.orgId, 'acme')).toBe('claimed');
    expect(await orgStorage.claimHandle(acme.orgId, 'acme')).toBe('claimed');
    expect(await orgStorage.claimHandle(other.orgId, 'acme')).toBe('taken');
    expect(await orgStorage.claimHandle('nobody', 'free-word')).toBe('missing');
    expect((await orgStorage.getOrgByHandle('acme'))?.orgId).toBe(acme.orgId);
    // An address is for keeps: a second word for the same workplace is refused.
    expect(await orgStorage.claimHandle(acme.orgId, 'acme-trading')).toBe('taken');
    expect((await orgStorage.getOrg(acme.orgId))?.handle).toBe('acme');
    expect(await orgStorage.getOrgByHandle('acme-trading')).toBeNull();
    // updateOrg cannot write it either.
    await orgStorage.updateOrg(acme.orgId, { name: 'Renamed' });
    expect((await orgStorage.getOrg(acme.orgId))?.handle).toBe('acme');

    expect(await orgStorage.deleteOrg(acme.orgId)).toBe(true);
    expect(await orgStorage.getOrgByHandle('acme')).toBeNull();
    expect(await orgStorage.claimHandle(other.orgId, 'acme')).toBe('claimed');
  });

  it('derives a handle from the name and counts past the ones that are taken', async () => {
    const orgStorage = make();
    const service = new OrgHandleService({ orgStorage });
    const first = await orgStorage.createOrg({ name: 'Acme Trading', createdByUserId: 'u1' });
    const second = await orgStorage.createOrg({ name: 'ACME  Trading!', createdByUserId: 'u2' });
    const third = await orgStorage.createOrg({ name: 'Docs', createdByUserId: 'u3' });
    expect(await service.assignDerived(first)).toBe('acme-trading');
    expect(await service.assignDerived(second)).toBe('acme-trading-2');
    expect(await service.assignDerived(third)).toBe('docs-workplace');
    expect(await service.assignDerived({ orgId: 'nobody', name: 'Gone' })).toBeNull();
  });

  it('backfills every workplace without a handle, once', async () => {
    const orgStorage = make();
    const service = new OrgHandleService({ orgStorage });
    const a = await orgStorage.createOrg({ name: 'Northstar Studio', createdByUserId: 'u1' });
    const b = await orgStorage.createOrg({ name: 'Northstar Studio', createdByUserId: 'u2' });
    const c = await orgStorage.createOrg({ name: 'Chosen', createdByUserId: 'u3' });
    await orgStorage.claimHandle(c.orgId, 'picked');
    expect(await service.backfill()).toEqual({ assigned: 2, skipped: 0 });
    expect((await orgStorage.getOrg(a.orgId))?.handle).toBe('northstar-studio');
    expect((await orgStorage.getOrg(b.orgId))?.handle).toBe('northstar-studio-2');
    expect((await orgStorage.getOrg(c.orgId))?.handle).toBe('picked');
    expect(await service.backfill()).toEqual({ assigned: 0, skipped: 0 });
  });
});

describe('one namespace for people and workplaces', () => {
  it('walks a workplace past the word a person holds, and refuses a person the word a workplace holds', async () => {
    const db = openSqliteDb(':memory:');
    const orgStorage = new SqliteOrgStorage(db);
    const mailboxes = new MailboxService(new SqliteMailboxStorage(db), undefined, async (local) => (await orgStorage.getOrgByHandle(local)) !== null);
    const service = new OrgHandleService({ orgStorage, mailboxHolder: (address) => mailboxes.holderOf(address) });
    await mailboxes.claim('user-adam', 'adam');
    const org = await orgStorage.createOrg({ name: 'Adam', createdByUserId: 'user-adam' });
    expect(await service.assignDerived(org)).toBe('adam-2');

    const acme = await orgStorage.createOrg({ name: 'Acme', createdByUserId: 'user-adam' });
    expect(await service.assignDerived(acme)).toBe('acme');
    expect((await mailboxes.availability('acme')).available).toBe(false);
    await expect(mailboxes.claim('user-other', 'acme')).rejects.toMatchObject({ code: 'mailbox_taken' });
    expect((await mailboxes.availability('acme-2')).available).toBe(true);
  });
});
