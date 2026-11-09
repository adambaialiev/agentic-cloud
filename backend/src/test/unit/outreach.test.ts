import { describe, expect, it, vi } from 'vitest';
import { MailboxService } from '../../services/mailbox-service.js';
import { SqliteMailboxStorage } from '../../services/sqlite/sqlite-mailbox-storage.js';
import { SqliteMailMessageStorage } from '../../services/sqlite/sqlite-mail-message-storage.js';
import { openSqliteDb } from '../../services/sqlite/sqlite-db.js';
import { MailOutboxService } from '../../services/mail-outbox.js';
import type { OutboundMail } from '../../services/mail-sender.js';
import { OutreachError, OutreachService } from '../../services/outreach.js';
import { InMemoryOutreachStore } from '../../services/outreach-storage.js';
import { SqliteOutreachStore } from '../../services/sqlite/sqlite-outreach-storage.js';
import {
  addressMatches, hostMatches, outreachLocalTime, outreachPlaceholders, outreachWordCount, parseOutreachSeed, type OutreachSeed,
} from '../../shared/outreach.js';
import { fixtureOutreachSeed } from '../../shared/outreach-fixtures.js';
import type { CopyPulse } from '../../shared/copy-pulse.js';

/**
 * Outreach (note #1089). What matters here is what does NOT happen: nothing
 * sends unless the owner presses, a follow-up is refused before its day, a
 * placeholder never leaves, a second address is never written to — and that
 * what does happen (a reply, an install) is recorded, not acted on.
 */

const seed = (): OutreachSeed => {
  const parsed = parseOutreachSeed(fixtureOutreachSeed());
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.seed;
};

describe('Outreach words and places', () => {
  it('counts words the way note #799 does: subject and signature in, a link\'s #anchor a word of its own', () => {
    expect(outreachWordCount('Your agents need a workplace', 'Hi Yash,\n\nStart here: agenticcloudcomputer.com/#your-agent\n\nAdam\nFounder, Agentic Cloud Computer')).toBe(5 + 2 + 4 + 1 + 4);
    // A dash on its own is not a word; a hyphenated word is one.
    expect(outreachWordCount('', 'one — two-three')).toBe(2);
    // The end of note #799's day-4 text: a URL is one word.
    expect(outreachWordCount('', 'When you want your own: hand your agent agenticcloudcomputer.com/own-cloud.md. Every line of the code is open: agenticcloudcomputer.com/acc/agentic-cloud')).toBe(17);
  });

  it('finds the template\'s placeholders, and nothing in a finished letter', () => {
    expect(outreachPlaceholders('Hi {first name},\n\n{their line}. And {first name} again')).toEqual(['{first name}', '{their line}']);
    expect(outreachPlaceholders('Hi Yash,\n\nYour job post says so.')).toEqual([]);
  });

  it('tells the local time for the seven cities, and none where only a country or nothing is known', () => {
    const at = new Date('2026-11-09T13:00:00Z'); // a Monday
    expect(outreachLocalTime('San Francisco', at)).toBe('Mon 05:00');
    expect(outreachLocalTime('Seattle', at)).toBe('Mon 05:00');
    expect(outreachLocalTime('Chicago', at)).toBe('Mon 07:00');
    expect(outreachLocalTime('New York', at)).toBe('Mon 08:00');
    expect(outreachLocalTime('Washington DC', at)).toBe('Mon 08:00');
    expect(outreachLocalTime('Helsinki', at)).toBe('Mon 15:00');
    expect(outreachLocalTime('Austin', at)).toBe('Mon 07:00');
    for (const unknown of ['US', 'US remote', '', null, 'Richmond']) expect(outreachLocalTime(unknown, at)).toBeNull();
  });

  it('matches a reply by the address, or by the company\'s own domain — never by a shared mail service', () => {
    expect(addressMatches('mara@northwind.test', 'MARA@northwind.test')).toBe(true);
    expect(addressMatches('mara@northwind.test', 'cto@northwind.test')).toBe(true);
    expect(addressMatches('mara@northwind.test', 'mara@elsewhere.test')).toBe(false);
    expect(addressMatches('someone@gmail.com', 'other@gmail.com')).toBe(false);
    expect(addressMatches('someone@gmail.com', 'someone@gmail.com')).toBe(true);
    expect(hostMatches('mara@northwind.test', 'agents.northwind.test')).toBe(true);
    expect(hostMatches('mara@northwind.test', 'northwind.test.evil.test')).toBe(false);
  });

  it('reads the seed strictly', () => {
    expect(parseOutreachSeed({}).ok).toBe(false);
    const doubled = fixtureOutreachSeed();
    (doubled.targets as unknown[]).push((doubled.targets as unknown[])[0]);
    expect(parseOutreachSeed(doubled)).toEqual({ ok: false, error: 'Northwind Health appears twice.' });
    const parsed = seed();
    expect(parsed.targets).toHaveLength(14);
    expect(parsed.targets.filter((target) => target.firstBatchOrder !== null)).toHaveLength(10);
  });
});

async function world(opts: { send?: (mail: OutboundMail) => Promise<unknown>; sqlite?: boolean } = {}) {
  const db = openSqliteDb(':memory:');
  const mailboxes = new SqliteMailboxStorage(db);
  const messages = new SqliteMailMessageStorage(db);
  await new MailboxService(mailboxes).claim('user-adam', 'adam');
  const sent: OutboundMail[] = [];
  let clock = new Date('2026-11-09T13:00:00Z');
  const now = () => clock;
  const sender = { send: vi.fn(async (mail: OutboundMail) => { sent.push(mail); if (opts.send) await opts.send(mail); return {}; }) };
  const outbox = new MailOutboxService({ mailboxes, messages, sender }, now);
  const store = opts.sqlite ? new SqliteOutreachStore(db) : new InMemoryOutreachStore();
  const pulses: CopyPulse[] = [];
  const service = new OutreachService({
    store, outbox: () => outbox, mailboxes, now, pulses: async () => pulses, senderName: async () => 'Adam B',
  });
  await service.import('user-adam', seed());
  return { service, messages, sent, sender, store, pulses, at: (iso: string) => { clock = new Date(iso); } };
}

const firstOf = async (service: OutreachService, id: string) => (await service.detail('user-adam', id))!.draft!;

describe('Outreach, the service', () => {
  for (const sqlite of [false, true]) {
    it(`lists the first batch in the note's order, the rest after, the dropped last (${sqlite ? 'sqlite' : 'memory'})`, async () => {
      const { service } = await world({ sqlite });
      const list = await service.list('user-adam');
      expect(list.rows.slice(0, 10).map((row) => row.firstBatchOrder)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(list.rows.at(-1)!.fit).toBe('not a fit');
      expect(list.rows.every((row) => row.state === 'not-contacted')).toBe(true);
      expect(list.firstSends).toBe(0);
      expect(list.reviewAfter).toBe(15);
    });
  }

  it('opens the Send box with the note\'s own letter, word for word, and the template where none was written', async () => {
    const { service } = await world();
    const draft = await firstOf(service, 'northwind-health');
    const written = seed().targets[0]!.firstEmail!;
    expect(draft).toMatchObject({ step: 'first', to: 'mara@northwind-health.test', subject: written.subject, text: written.body, from: 'written' });
    const template = await firstOf(service, 'kestrel-systems');
    expect(template.from).toBe('template');
    expect(outreachPlaceholders(template.text)).toEqual(['{first name}', '{their line}']);
  });

  it('says why there is no Send where there is none: no address, or not a fit', async () => {
    const { service } = await world();
    const none = (await service.detail('user-adam', 'solace-studio'))!;
    expect(none.draft).toBeNull();
    expect(none.noSend).toMatch(/no address/);
    expect((await service.detail('user-adam', 'bigfirm-inc'))!.noSend).toMatch(/^Not a fit: too big/);
  });

  it('sends the first letter as the owner, plain, and records it: Sent, on the timeline, in the mail Sent', async () => {
    const { service, sent, messages } = await world();
    const draft = await firstOf(service, 'northwind-health');
    const { touch, mailId } = await service.send('user-adam', 'northwind-health', { step: 'first', subject: draft.subject, text: draft.text });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: { address: 'adam@agenticcloudcomputer.com', name: 'Adam B' }, to: [{ address: 'mara@northwind-health.test' }], subject: draft.subject, text: `${draft.text}\n` });
    expect(sent[0]).not.toHaveProperty('html');
    expect(touch).toMatchObject({ kind: 'sent', step: 'first', to: 'mara@northwind-health.test', text: draft.text });
    const stored = await messages.get('user-adam', mailId);
    expect(stored?.direction).toBe('sent');
    const after = (await service.detail('user-adam', 'northwind-health'))!;
    expect(after.row.state).toBe('sent');
    expect(after.touches.map((one) => one.kind).sort()).toEqual(['sent', 'state']);
    expect(after.touches.some((one) => one.kind === 'sent')).toBe(true);
    expect(after.row.next).toMatchObject({ step: 'day4', due: false, dueAt: '2026-11-13T13:00:00.000Z' });
    expect((await service.list('user-adam')).firstSends).toBe(1);
  });

  it('refuses a letter with a placeholder left in it, and a second press while the first is on its way', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { service, sent } = await world({ send: () => gate });
    const template = await firstOf(service, 'kestrel-systems');
    await expect(service.send('user-adam', 'kestrel-systems', { step: 'first', subject: template.subject, text: template.text }))
      .rejects.toThrow('Fill in {first name} and {their line} first.');
    const draft = await firstOf(service, 'northwind-health');
    const first = service.send('user-adam', 'northwind-health', { step: 'first', subject: draft.subject, text: draft.text });
    await expect(service.send('user-adam', 'northwind-health', { step: 'first', subject: draft.subject, text: draft.text }))
      .rejects.toThrow('already on its way');
    release();
    await first;
    await expect(service.send('user-adam', 'northwind-health', { step: 'first', subject: draft.subject, text: draft.text }))
      .rejects.toThrow('The next letter here is the day-4 follow-up.');
    expect(sent).toHaveLength(1);
  });

  it('keeps nothing when the provider refuses: still Not contacted, nothing on the timeline', async () => {
    const { service } = await world({ send: async () => { throw new Error('provider down'); } });
    const draft = await firstOf(service, 'northwind-health');
    await expect(service.send('user-adam', 'northwind-health', { step: 'first', subject: draft.subject, text: draft.text })).rejects.toThrow();
    const after = (await service.detail('user-adam', 'northwind-health'))!;
    expect(after.row.state).toBe('not-contacted');
    expect(after.touches).toEqual([]);
  });

  it('sends the follow-ups only from their day, in the same thread, to the same person — then stops', async () => {
    const { service, sent, at } = await world();
    const draft = await firstOf(service, 'northwind-health');
    await service.send('user-adam', 'northwind-health', { step: 'first', subject: draft.subject, text: draft.text });
    at('2026-11-12T13:00:00Z');
    await expect(service.send('user-adam', 'northwind-health', { step: 'day4', text: 'Again' })).rejects.toThrow('due 2026-11-13. Nothing sends early.');
    at('2026-11-13T13:00:01Z');
    const day4 = await firstOf(service, 'northwind-health');
    expect(day4).toMatchObject({ step: 'day4', to: 'mara@northwind-health.test', subject: 'Re: Your agents need a workplace', from: 'follow-up' });
    expect(day4.text).toBe(seed().followUps.day4.text);
    await service.send('user-adam', 'northwind-health', { step: 'day4', text: day4.text });
    expect(sent[1]).toMatchObject({ to: [{ address: 'mara@northwind-health.test' }], subject: 'Re: Your agents need a workplace' });
    expect(sent[1]!.inReplyTo).toMatch(/@agenticcloudcomputer\.com$/);
    expect(sent[1]!.text.startsWith(day4.text)).toBe(true);
    expect(sent[1]!.text).toContain('Adam B wrote:');
    at('2026-11-20T13:00:01Z');
    const day11 = await firstOf(service, 'northwind-health');
    expect(day11.step).toBe('day11');
    await service.send('user-adam', 'northwind-health', { step: 'day11', text: day11.text });
    expect(sent[2]!.inReplyTo).not.toBe(sent[1]!.inReplyTo);
    expect(sent[2]!.references).toHaveLength(2);
    const done = (await service.detail('user-adam', 'northwind-health'))!;
    expect(done.draft).toBeNull();
    expect(done.noSend).toMatch(/then stop/);
  });

  it('keeps one address per company once a letter has gone', async () => {
    const { service } = await world();
    await service.edit('user-adam', 'northwind-health', { email: 'other@northwind-health.test' });
    expect((await service.detail('user-adam', 'northwind-health'))!.row.email).toBe('other@northwind-health.test');
    await service.edit('user-adam', 'northwind-health', { email: 'mara@northwind-health.test' });
    const draft = await firstOf(service, 'northwind-health');
    await service.send('user-adam', 'northwind-health', { step: 'first', subject: draft.subject, text: draft.text });
    await expect(service.edit('user-adam', 'northwind-health', { email: 'founders@northwind-health.test' })).rejects.toThrow(/One address per company/);
    // The person and the city stay the owner's to change.
    await service.edit('user-adam', 'northwind-health', { person: 'Mara Quill', city: 'Seattle' });
    const after = (await service.detail('user-adam', 'northwind-health'))!;
    expect(after.row).toMatchObject({ person: 'Mara Quill', city: 'Seattle' });
    expect(after.touches.filter((one) => one.kind === 'edit').map((one) => one.kind === 'edit' && one.field).sort()).toEqual(['city', 'email', 'email', 'person']);
  });

  it('puts a reply from the company on its timeline and moves it to Replied; a suspicious one moves nothing', async () => {
    const { service } = await world();
    const draft = await firstOf(service, 'northwind-health');
    await service.send('user-adam', 'northwind-health', { step: 'first', subject: draft.subject, text: draft.text });
    await service.noteArrival({ id: 'mm_fake', address: 'adam@agenticcloudcomputer.com', from: 'mara@northwind-health.test', subject: 'Re: hi', receivedAt: '2026-11-09T15:00:00Z' }, { suspicious: true });
    expect((await service.detail('user-adam', 'northwind-health'))!.row.state).toBe('sent');
    await service.noteArrival({ id: 'mm_reply', address: 'adam@agenticcloudcomputer.com', from: 'cto@northwind-health.test', subject: 'Re: Your agents need a workplace', receivedAt: '2026-11-09T16:00:00Z' });
    await service.noteArrival({ id: 'mm_reply', address: 'adam@agenticcloudcomputer.com', from: 'cto@northwind-health.test', subject: 'Re: Your agents need a workplace', receivedAt: '2026-11-09T16:00:00Z' });
    const after = (await service.detail('user-adam', 'northwind-health'))!;
    expect(after.row.state).toBe('replied');
    expect(after.touches.filter((one) => one.kind === 'reply')).toHaveLength(2);
    expect(after.touches[0]).toMatchObject({ kind: 'state', to: 'replied' });
    expect(after.draft).toBeNull();
    // A stranger, or another mailbox, moves nothing.
    await service.noteArrival({ id: 'mm_x', address: 'adam@agenticcloudcomputer.com', from: 'someone@elsewhere.test', subject: 'x', receivedAt: '2026-11-09T16:00:00Z' });
    await service.noteArrival({ id: 'mm_y', address: 'nobody@agenticcloudcomputer.com', from: 'leo@harborpine.test', subject: 'x', receivedAt: '2026-11-09T16:00:00Z' });
    expect((await service.detail('user-adam', 'harbor-pine'))!.touches).toEqual([]);
  });

  it('marks a company Installed when its own copy reports in, once per copy, and at import', async () => {
    const { service, pulses } = await world();
    const pulse = { copyId: 'c1', domain: 'agents.lakeview-data.test', contactName: 'Ines', contactEmail: 'ops@elsewhere.test' } as CopyPulse;
    await service.notePulse(pulse);
    await service.notePulse(pulse);
    const after = (await service.detail('user-adam', 'lakeview-data'))!;
    expect(after.row.state).toBe('installed');
    expect(after.touches.filter((one) => one.kind === 'installed')).toHaveLength(1);
    pulses.push({ copyId: 'c2', domain: 'cloud.example.test', contactName: 'Leo', contactEmail: 'leo@harborpine.test' } as CopyPulse);
    await service.import('user-adam', seed());
    expect((await service.detail('user-adam', 'harbor-pine'))!.row.state).toBe('installed');
  });

  it('a re-import updates the words and keeps the owner\'s edits, states and touches; a company gone from the file is kept', async () => {
    const { service } = await world();
    await service.edit('user-adam', 'quarry-software', { city: 'Boston' });
    await service.addNote('user-adam', 'quarry-software', 'Met Bea at a meetup.');
    await service.setState('user-adam', 'fernhill-labs', 'not-now');
    const next = seed();
    next.targets = next.targets.filter((target) => target.company !== 'Gleam Tools');
    next.targets[0]!.firstEmail!.body = 'New words from note #799.';
    expect(await service.import('user-adam', next)).toMatchObject({ added: 0, updated: 13, kept: 1 });
    const quarry = (await service.detail('user-adam', 'quarry-software'))!;
    expect(quarry.row.city).toBe('Boston');
    expect(quarry.touches.some((one) => one.kind === 'note' && one.text === 'Met Bea at a meetup.')).toBe(true);
    expect((await service.detail('user-adam', 'fernhill-labs'))!.row.state).toBe('not-now');
    expect((await firstOf(service, 'northwind-health')).text).toBe('New words from note #799.');
    expect((await service.detail('user-adam', 'gleam-tools'))!.row.inLatestImport).toBe(false);
  });

  it('lets the owner set Not now and Trying it, and refuses states that did not happen', async () => {
    const { service } = await world();
    await expect(service.setState('user-adam', 'northwind-health', 'sent')).rejects.toBeInstanceOf(OutreachError);
    await expect(service.setState('user-adam', 'bigfirm-inc', 'trying')).rejects.toThrow(/not a fit/);
    await service.setState('user-adam', 'northwind-health', 'not-now');
    const after = (await service.detail('user-adam', 'northwind-health'))!;
    expect(after.draft).toBeNull();
    expect(after.noSend).toMatch(/not now/);
  });
});
