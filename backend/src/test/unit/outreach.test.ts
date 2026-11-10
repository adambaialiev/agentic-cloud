import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RESEND_WEBHOOK_PATH, outreachMailEventRoutes, readResendEvent, verifySvixSignature } from '../../routes/outreach-mail-events.js';
import { MailboxService } from '../../services/mailbox-service.js';
import { SqliteMailboxStorage } from '../../services/sqlite/sqlite-mailbox-storage.js';
import { SqliteMailMessageStorage } from '../../services/sqlite/sqlite-mail-message-storage.js';
import { openSqliteDb } from '../../services/sqlite/sqlite-db.js';
import { MAIL_NEW_PER_HOUR, MailOutboxService } from '../../services/mail-outbox.js';
import type { OutboundMail } from '../../services/mail-sender.js';
import { OUTREACH_MAIL_ALLOWANCE, OutreachService, type OutreachMailEventInput } from '../../services/outreach.js';
import { InMemoryOutreachStore } from '../../services/outreach-storage.js';
import { SqliteOutreachStore } from '../../services/sqlite/sqlite-outreach-storage.js';
import {
  addressMatches, hostMatches, outreachLocalTime, outreachMailHtml, outreachPlaceholders, outreachWordCount, parseOutreachWrite, type OutreachTouch, type OutreachWrite,
} from '../../shared/outreach.js';
import { fixtureOutreachProfile, fixtureOutreachWrite } from '../../shared/outreach-fixtures.js';
import type { CopyPulse } from '../../shared/copy-pulse.js';

/**
 * Outreach (notes #1089, #1103). What matters here is what does NOT happen:
 * nothing sends unless the owner presses, a follow-up is refused before its
 * day, a placeholder never leaves, a second address is never written to, an
 * agent's write never moves a state or replaces the owner's own letter — and
 * that what does happen (a reply, an install, a write) is recorded.
 */

const ROWAN = { agentId: 'agent-rowan', name: 'Rowan' };
const ADA = { agentId: 'agent-ada', name: 'Ada' };

const batch = (): OutreachWrite => {
  const parsed = parseOutreachWrite(fixtureOutreachWrite());
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.write;
};
/** One company out of the batch, as an agent would write it alone. */
const company = (name: string) => structuredClone(batch().targets.find((target) => target.company === name)!);

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
    // Europe (note #1113), accents as people write them.
    expect(outreachLocalTime('Munich', at)).toBe('Mon 14:00');
    expect(outreachLocalTime('Zürich', at)).toBe('Mon 14:00');
    expect(outreachLocalTime('Kraków', at)).toBe('Mon 14:00');
    expect(outreachLocalTime('Porto', at)).toBe('Mon 13:00');
    expect(outreachLocalTime('Tallinn', at)).toBe('Mon 15:00');
    expect(outreachLocalTime('Kyiv', at)).toBe('Mon 15:00');
    expect(outreachLocalTime('Istanbul', at)).toBe('Mon 16:00');
    expect(outreachLocalTime('Reykjavik', at)).toBe('Mon 13:00');
    expect(outreachLocalTime('the hague', at)).toBe('Mon 14:00');
    expect(outreachLocalTime('Forlì', at)).toBe('Mon 14:00');
    expect(outreachLocalTime('Carpentras', at)).toBe('Mon 14:00');
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

  it('reads an agent\'s write strictly: a batch, or one company, and refuses anything else whole', () => {
    expect(parseOutreachWrite({}).ok).toBe(false);
    expect(parseOutreachWrite([]).ok).toBe(false);
    const doubled = fixtureOutreachWrite();
    (doubled.targets as unknown[]).push((doubled.targets as unknown[])[0]);
    expect(parseOutreachWrite(doubled)).toEqual({ ok: false, error: 'Northwind Health appears twice.' });
    const parsed = batch();
    expect(parsed.targets).toHaveLength(14);
    expect(parsed.targets.filter((target) => target.firstBatchOrder !== null)).toHaveLength(10);
    expect(parsed.words?.template?.subject).toBe('Your agents need a workplace');
    // One company on its own: no template, no follow-ups, nothing else touched.
    const one = parseOutreachWrite((fixtureOutreachWrite().targets as unknown[])[1]);
    expect(one).toMatchObject({ ok: true, write: { words: null } });
    expect(one.ok && one.write.targets.map((target) => target.company)).toEqual(['Fernhill Labs']);
    // Only follow-ups: fine.
    expect(parseOutreachWrite({ followUps: { day4: { text: 'Again.' } } })).toMatchObject({ ok: true, write: { targets: [], words: { followUps: { day4: { text: 'Again.' } } } } });
    expect(parseOutreachWrite({ company: 'X', fit: 'maybe' })).toEqual({ ok: false, error: 'X: fit is neither "fit" nor "not a fit".' });
    expect(parseOutreachWrite({ company: 'X', fit: 'fit', email: 'a@x.test, b@x.test' }).ok).toBe(false);
    expect(parseOutreachWrite({ company: 'X', fit: 'fit', profile: 'words' })).toEqual({ ok: false, error: 'X: profile is not an object.' });
  });

  it('keeps a profile whole, a field the site does not know included, and the quote a letter opens on', () => {
    const northwind = batch().targets[0]!;
    expect(northwind.profile).toEqual(fixtureOutreachProfile());
    expect(northwind.profile?.fundingRound).toBe('Seed, 2025 (a field the site does not lay out)');
    expect(northwind.firstEmail?.opensOn).toEqual({ quote: 'Our agents step on each other\'s branches every night.', who: 'Mara Quill, CEO', source: 'northwind-health.test/blog/agents', date: '2 Nov 2026' });
    expect(northwind.firstEmail?.painMatch).toBe('matches');
    // Plain JSON only, and of a size a profile has.
    const odd = parseOutreachWrite({ company: 'X', fit: 'fit', profile: { builds: 'x', nested: { a: [1, 'two', null, { deep: { deeper: { deepest: { gone: 'yes' } } } }] } } });
    expect(odd.ok && odd.write.targets[0]!.profile).toEqual({ builds: 'x', nested: { a: [1, 'two', null, { deep: {} }] } });
    expect(parseOutreachWrite({ company: 'X', fit: 'fit', profile: { problems: Array.from({ length: 60 }, () => ({ quote: 'q'.repeat(1000) })) } }).ok).toBe(false);
  });
});

async function world(opts: { send?: (mail: OutboundMail) => Promise<unknown>; sqlite?: boolean; mailEvents?: boolean } = {}) {
  const db = openSqliteDb(':memory:');
  const mailboxes = new SqliteMailboxStorage(db);
  const messages = new SqliteMailMessageStorage(db);
  await new MailboxService(mailboxes).claim('user-adam', 'adam');
  const sent: OutboundMail[] = [];
  let clock = new Date('2026-11-09T13:00:00Z');
  const now = () => clock;
  const sender = { send: vi.fn(async (mail: OutboundMail) => { sent.push(mail); if (opts.send) await opts.send(mail); return { providerId: `re-${sent.length}` }; }) };
  const outbox = new MailOutboxService({ mailboxes, messages, sender }, now);
  const store = opts.sqlite ? new SqliteOutreachStore(db) : new InMemoryOutreachStore();
  const pulses: CopyPulse[] = [];
  const service = new OutreachService({
    store, outbox: () => outbox, mailboxes, now, pulses: async () => pulses, senderName: async () => 'Adam B', mailEventsConfigured: opts.mailEvents === true,
  });
  await service.write('user-adam', ROWAN, batch());
  return { service, outbox, messages, sent, sender, store, pulses, at: (iso: string) => { clock = new Date(iso); } };
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

  it('opens the Send box with the letter an agent wrote, word for word and signed, and the template where none was written', async () => {
    const { service } = await world();
    const draft = await firstOf(service, 'northwind-health');
    const written = batch().targets[0]!.firstEmail!;
    expect(draft).toMatchObject({ step: 'first', to: 'mara@northwind-health.test', subject: written.subject, text: written.body, from: 'written', by: 'Rowan', newer: null });
    const template = await firstOf(service, 'kestrel-systems');
    expect(template.from).toBe('template');
    expect(outreachPlaceholders(template.text)).toEqual(['{first name}', '{their line}']);
  });

  it('says why there is no Send where there is none: no address, or not a fit', async () => {
    const { service } = await world();
    const none = (await service.detail('user-adam', 'solace-studio'))!;
    expect(none.draft).toBeNull();
    expect(none.noSend).toMatch(/No address/);
    expect((await service.detail('user-adam', 'bigfirm-inc'))!.noSend).toMatch(/^Not a fit: too big/);
  });

  it('sends the first letter as the owner, the words as text with the same words as HTML beside them, and records it: Sent, on the timeline, in the mail Sent', async () => {
    const { service, sent, messages } = await world();
    const draft = await firstOf(service, 'northwind-health');
    const { touch, mailId } = await service.send('user-adam', 'northwind-health', { step: 'first', subject: draft.subject, text: draft.text });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: { address: 'adam@agenticcloudcomputer.com', name: 'Adam B' }, to: [{ address: 'mara@northwind-health.test' }], subject: draft.subject, text: `${draft.text}\n` });
    // Note #1112: an HTML copy of the same words, for the provider's open pixel; nothing of ours added.
    expect(sent[0]!.html).toBe(outreachMailHtml(`${draft.text}\n`));
    expect(sent[0]!.html).not.toMatch(/<img|<style|<script/);
    expect(touch).toMatchObject({ kind: 'sent', step: 'first', to: 'mara@northwind-health.test', text: draft.text, providerId: 're-1', measured: true });
    const stored = await messages.get('user-adam', mailId);
    expect(stored?.direction).toBe('sent');
    expect(stored?.providerId).toBe('re-1');
    const after = (await service.detail('user-adam', 'northwind-health'))!;
    expect(after.row.state).toBe('sent');
    expect(after.touches.map((one) => one.kind).sort()).toEqual(['sent', 'state', 'written']);
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
    expect(after.touches.filter((one) => one.kind !== 'written')).toEqual([]);
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
    expect(day4.text).toBe(batch().words!.followUps!.day4!.text);
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
    expect((await service.detail('user-adam', 'harbor-pine'))!.touches.filter((one) => one.kind !== 'written')).toEqual([]);
  });

  it('marks a company Installed when its own copy reports in, once per copy, and when an agent first writes it', async () => {
    const { service, pulses } = await world();
    const pulse = { copyId: 'c1', domain: 'agents.lakeview-data.test', contactName: 'Ines', contactEmail: 'ops@elsewhere.test' } as CopyPulse;
    await service.notePulse(pulse);
    await service.notePulse(pulse);
    const after = (await service.detail('user-adam', 'lakeview-data'))!;
    expect(after.row.state).toBe('installed');
    expect(after.touches.filter((one) => one.kind === 'installed')).toHaveLength(1);
    pulses.push({ copyId: 'c2', domain: 'cloud.example.test', contactName: 'Leo', contactEmail: 'leo@newcomer.test' } as CopyPulse);
    await service.write('user-adam', ROWAN, { targets: [{ ...company('Harbor & Pine'), company: 'Newcomer', email: 'leo@newcomer.test' }], words: null });
    expect((await service.detail('user-adam', 'newcomer'))!.row.state).toBe('installed');
  });

  it('a new write updates the agents\' words and keeps the owner\'s edits, states and touches; a company left out of it stays as it was', async () => {
    const { service } = await world();
    await service.edit('user-adam', 'quarry-software', { city: 'Boston' });
    await service.addNote('user-adam', 'quarry-software', 'Met Bea at a meetup.');
    const next = batch();
    next.targets = next.targets.filter((target) => target.company !== 'Gleam Tools');
    next.targets[0]!.firstEmail!.body = 'New words from Rowan.';
    next.targets[2]!.city = 'Denver';
    next.targets[4]!.firstEmail!.body = 'Other new words.';
    next.targets[7]!.city = 'Portland';
    const answer = await service.write('user-adam', ROWAN, next);
    expect(answer).toMatchObject({ added: [], refused: [], words: 'unchanged' });
    expect(answer.updated).toEqual([
      { company: 'Northwind Health', fields: ['firstEmail'] }, { company: 'Lakeview Data', fields: ['city'] },
      { company: 'Capitol Ledger', fields: ['firstEmail'] }, { company: 'Quarry Software', fields: ['city'] },
    ]);
    expect(answer.unchanged).toHaveLength(9);
    const quarry = (await service.detail('user-adam', 'quarry-software'))!;
    expect(quarry.row.city).toBe('Boston');
    expect(quarry.touches.some((one) => one.kind === 'note' && one.text === 'Met Bea at a meetup.')).toBe(true);
    expect((await firstOf(service, 'northwind-health')).text).toBe('New words from Rowan.');
    expect((await service.detail('user-adam', 'gleam-tools'))!.seed.company).toBe('Gleam Tools');
  });

  it('signs every write and keeps the words it replaced on the timeline; a write that changes nothing leaves no mark', async () => {
    const { service, at } = await world();
    const before = (await service.detail('user-adam', 'northwind-health'))!;
    expect(before.touches).toEqual([expect.objectContaining({ kind: 'written', by: ROWAN, added: true, previous: null, at: '2026-11-09T13:00:00.000Z' })]);
    expect(before.row).toMatchObject({ writtenBy: 'Rowan', writtenAt: '2026-11-09T13:00:00.000Z' });
    at('2026-11-09T14:00:00Z');
    const changed = company('Northwind Health');
    changed.firstEmail!.subject = 'Northwind: agents on each other\'s branches';
    changed.profile = { ...changed.profile, matchNote: 'Rechecked.' };
    expect(await service.write('user-adam', ADA, { targets: [changed], words: null })).toMatchObject({ updated: [{ company: 'Northwind Health', fields: ['firstEmail', 'profile'] }] });
    const after = (await service.detail('user-adam', 'northwind-health'))!;
    expect(after.row).toMatchObject({ writtenBy: 'Ada', writtenAt: '2026-11-09T14:00:00.000Z' });
    expect(after.touches[0]).toMatchObject({ kind: 'written', by: ADA, added: false, fields: ['firstEmail', 'profile'] });
    const previous = after.touches[0]!.kind === 'written' ? after.touches[0]!.previous : null;
    expect(previous?.firstEmail?.subject).toBe('Your agents need a workplace');
    expect(previous?.profile?.matchNote).toBe('The strongest of the made-up ten.');
    expect(after.seed.profile?.matchNote).toBe('Rechecked.');
    expect((await service.list('user-adam')).lastWrite).toEqual({ at: '2026-11-09T14:00:00.000Z', by: 'Ada' });
    // The same words again: nothing new on the timeline.
    expect(await service.write('user-adam', ADA, { targets: [changed], words: null })).toMatchObject({ unchanged: ['Northwind Health'], updated: [] });
    expect((await service.detail('user-adam', 'northwind-health'))!.touches).toHaveLength(2);
  });

  it('writes the template and follow-ups signed, keeping the ones they replaced', async () => {
    const { service, store } = await world();
    expect((await store.words('user-adam'))!.words.writtenBy).toEqual(ROWAN);
    expect(await service.write('user-adam', ADA, { targets: [], words: { source: null, generatedBy: null, generatedAt: null, followUps: { day4: { text: 'A shorter day 4.', wordCount: 4 } } } })).toMatchObject({ words: 'written' });
    const kept = (await store.words('user-adam'))!.words;
    expect(kept).toMatchObject({ writtenBy: ADA, followUps: { day4: { text: 'A shorter day 4.' }, day11: { text: batch().words!.followUps!.day11!.text } } });
    expect(kept.template?.subject).toBe('Your agents need a workplace');
    expect(kept.previous?.[0]).toMatchObject({ by: ROWAN, followUps: { day4: { text: batch().words!.followUps!.day4!.text } } });
  });

  it('never replaces the owner\'s own letter: an agent\'s newer one waits beside it until he picks', async () => {
    const { service, at } = await world();
    const agents = await firstOf(service, 'northwind-health');
    // He edits the letter on the site; it is his from now on.
    await service.letter('user-adam', 'northwind-health', { action: 'save', subject: agents.subject, text: `${agents.text}\nP.S. Mine.` });
    await service.letter('user-adam', 'northwind-health', { action: 'save', subject: agents.subject, text: `${agents.text}\nP.S. Mine, again.` });
    let draft = await firstOf(service, 'northwind-health');
    expect(draft).toMatchObject({ from: 'yours', text: `${agents.text}\nP.S. Mine, again.`, newer: null });
    let detail = (await service.detail('user-adam', 'northwind-health'))!;
    expect(detail.touches.filter((one) => one.kind === 'letter')).toEqual([expect.objectContaining({ action: 'saved', subject: agents.subject, body: agents.text })]);
    // Rowan writes a new letter: his stays in the box, Rowan's waits beside it.
    at('2026-11-09T15:00:00Z');
    const rewritten = company('Northwind Health');
    rewritten.firstEmail!.body = 'Rowan\'s second try.';
    await service.write('user-adam', ROWAN, { targets: [rewritten], words: null });
    draft = await firstOf(service, 'northwind-health');
    expect(draft).toMatchObject({ from: 'yours', text: `${agents.text}\nP.S. Mine, again.`, newer: { text: 'Rowan\'s second try.', by: 'Rowan', at: '2026-11-09T15:00:00.000Z' } });
    expect((await service.list('user-adam')).rows.find((row) => row.id === 'northwind-health')).toMatchObject({ yours: true, newerDraft: true });
    // He keeps his: Rowan's is set aside, on the timeline.
    await service.letter('user-adam', 'northwind-health', { action: 'keep' });
    draft = await firstOf(service, 'northwind-health');
    expect(draft).toMatchObject({ from: 'yours', newer: null });
    detail = (await service.detail('user-adam', 'northwind-health'))!;
    expect(detail.touches[0]).toMatchObject({ kind: 'letter', action: 'kept', body: 'Rowan\'s second try.', by: 'Rowan' });
    // A third try waits again; this time he takes it.
    rewritten.firstEmail!.body = 'Rowan\'s third try.';
    await service.write('user-adam', ROWAN, { targets: [rewritten], words: null });
    expect((await firstOf(service, 'northwind-health')).newer?.text).toBe('Rowan\'s third try.');
    await service.letter('user-adam', 'northwind-health', { action: 'take' });
    draft = await firstOf(service, 'northwind-health');
    expect(draft).toMatchObject({ from: 'written', text: 'Rowan\'s third try.', by: 'Rowan', newer: null });
    detail = (await service.detail('user-adam', 'northwind-health'))!;
    expect(detail.touches[0]).toMatchObject({ kind: 'letter', action: 'took', body: `${agents.text}\nP.S. Mine, again.` });
    // Where he never touched it, a new letter simply replaces the draft.
    const fernhill = company('Fernhill Labs');
    fernhill.firstEmail!.body = 'Fresh words.';
    await service.write('user-adam', ROWAN, { targets: [fernhill], words: null });
    expect(await firstOf(service, 'fernhill-labs')).toMatchObject({ from: 'written', text: 'Fresh words.', newer: null });
  });

  it('refuses a write that would change a letter, an address or a fit that has gone; the rest of the batch and the profile still go in', async () => {
    const { service } = await world();
    const draft = await firstOf(service, 'northwind-health');
    await service.send('user-adam', 'northwind-health', { step: 'first', subject: draft.subject, text: draft.text });
    const northwind = company('Northwind Health');
    northwind.firstEmail!.body = 'Too late.';
    const fernhill = company('Fernhill Labs');
    fernhill.city = 'Portland';
    const answer = await service.write('user-adam', ROWAN, { targets: [northwind, fernhill], words: null });
    expect(answer.refused).toEqual([{ company: 'Northwind Health', reason: 'Its first letter went on 2026-11-09: its first letter stays as it went. Write it again without changing that.' }]);
    expect(answer.updated).toEqual([{ company: 'Fernhill Labs', fields: ['city'] }]);
    const moved = company('Northwind Health');
    moved.email = 'cto@northwind-health.test';
    expect((await service.write('user-adam', ROWAN, { targets: [moved], words: null })).refused[0]!.reason).toMatch(/its address stays/);
    // New research on a company already written to is still welcome.
    const researched = company('Northwind Health');
    researched.profile = { ...researched.profile, gaps: [] };
    expect((await service.write('user-adam', ROWAN, { targets: [researched], words: null })).updated).toEqual([{ company: 'Northwind Health', fields: ['profile'] }]);
    const after = (await service.detail('user-adam', 'northwind-health'))!;
    expect(after.row.state).toBe('sent');
    expect(after.touches.find((one) => one.kind === 'sent')).toMatchObject({ text: draft.text });
    // And the owner's own letter is closed too: it went.
    await expect(service.letter('user-adam', 'northwind-health', { action: 'save', subject: 'x', text: 'y' })).rejects.toThrow('its words stay as they went');
  });

  it('a write never moves a state or the owner\'s own fields, and an agent reads back no reply, note or sent letter', async () => {
    const { service } = await world();
    await service.edit('user-adam', 'lakeview-data', { person: 'Ines O.' });
    const draft = await firstOf(service, 'harbor-pine');
    await service.send('user-adam', 'harbor-pine', { step: 'first', subject: draft.subject, text: 'The words that went.' });
    await service.noteArrival({ id: 'mm_reply', address: 'adam@agenticcloudcomputer.com', from: 'leo@harborpine.test', subject: 'Private reply subject', receivedAt: '2026-11-09T16:00:00Z' });
    await service.addNote('user-adam', 'harbor-pine', 'A private note of the owner.');
    const lakeview = company('Lakeview Data');
    lakeview.person = 'Ines Okafor, CTO and co-founder';
    await service.write('user-adam', ROWAN, { targets: [lakeview], words: null });
    const after = (await service.detail('user-adam', 'lakeview-data'))!;
    expect(after.row).toMatchObject({ state: 'not-contacted', person: 'Ines O.' });
    const shown = await service.agentShow('user-adam', 'Harbor & Pine');
    expect(shown).toMatchObject({ id: 'harbor-pine', state: 'replied', firstLetterGone: true, ownerEdited: false, writtenBy: 'Rowan' });
    expect(shown!.writes).toEqual([{ at: '2026-11-09T13:00:00.000Z', by: 'Rowan', added: true, fields: expect.any(Array) }]);
    const wire = JSON.stringify(shown);
    for (const secret of ['The words that went.', 'Private reply subject', 'A private note of the owner.', 'mm_reply']) expect(wire).not.toContain(secret);
    const list = await service.agentList('user-adam');
    expect(list.map((row) => row.firstBatchOrder).slice(0, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(list.find((row) => row.id === 'northwind-health')).toMatchObject({ letter: true, profile: true, state: 'not-contacted' });
    expect(await service.agentShow('user-adam', 'nobody')).toBeNull();
  });

  for (const sqlite of [false, true]) {
    it(`keeps the whole profile and the owner's letter through the store (${sqlite ? 'sqlite' : 'memory'})`, async () => {
      const { service } = await world({ sqlite });
      expect((await service.detail('user-adam', 'northwind-health'))!.seed.profile).toEqual(fixtureOutreachProfile());
      await service.letter('user-adam', 'northwind-health', { action: 'save', subject: 'Mine', text: 'My words.' });
      expect(await firstOf(service, 'northwind-health')).toMatchObject({ from: 'yours', subject: 'Mine', text: 'My words.' });
    });
  }

  it('sends the whole list in one sitting (note #1111): 50 first letters an hour and 60 a day, 50 follow-ups an hour; the inbox keeps its 10', async () => {
    const { service, outbox, sent, at } = await world();
    expect(OUTREACH_MAIL_ALLOWANCE).toEqual({ newPerHour: 50, newPerDay: 60, repliesPerHour: 50 });
    const many = Array.from({ length: 61 }, (_, n) => ({
      ...company('Fernhill Labs'), company: `Made Up ${n}`, email: `founder@made-up-${n}.test`, firstBatchOrder: null,
      firstEmail: { ...company('Fernhill Labs').firstEmail!, to: `founder@made-up-${n}.test`, body: `Hi,\n\nLetter ${n}.\n\nAdam` },
    }));
    await service.write('user-adam', ROWAN, { targets: many, words: null });
    const press = (n: number) => service.send('user-adam', `made-up-${n}`, { step: 'first', subject: 'Hello', text: `Hi,\n\nLetter ${n}.\n\nAdam` });
    for (let n = 0; n < 50; n += 1) await press(n);
    expect(sent).toHaveLength(50);
    await expect(press(50)).rejects.toThrow('You can start 50 new messages an hour. Try again shortly.');
    // The inbox's own door keeps its ceiling, and counts the letters Outreach sent.
    await expect(outbox.send({ userId: 'user-adam', to: 'someone@else.test', subject: 'Hi', text: 'Hello' }))
      .rejects.toThrow(`You can start ${MAIL_NEW_PER_HOUR} new messages an hour.`);
    // An hour on: ten more today, then the day's 60.
    at('2026-11-09T14:00:01Z');
    for (let n = 50; n < 60; n += 1) await press(n);
    await expect(press(60)).rejects.toThrow('You can start 60 new messages a day. Replies are not counted.');
    expect(sent).toHaveLength(60);
    // Day 4: the follow-ups of the whole list fall due together; more than the inbox's 20 replies an hour go.
    at('2026-11-13T14:00:02Z');
    for (let n = 0; n < 25; n += 1) {
      const draft = (await service.detail('user-adam', `made-up-${n}`))!.draft!;
      await service.send('user-adam', `made-up-${n}`, { step: 'day4', text: draft.text });
    }
    expect(sent).toHaveLength(85);
  });

  it('has no door that sets a state (note #1112); a Not now picked by hand before is history and moves nothing', async () => {
    const { service, store } = await world();
    expect((service as unknown as Record<string, unknown>).setState).toBeUndefined();
    const draft = await firstOf(service, 'northwind-health');
    await service.send('user-adam', 'northwind-health', { step: 'first', subject: draft.subject, text: draft.text });
    // A record from before: Adam had picked Not now on the screen.
    const record = (await store.target('user-adam', 'northwind-health'))!;
    await store.putTarget({ ...record, state: 'not-now', stateAt: '2026-11-09T13:30:00.000Z' });
    await store.addTouch('user-adam', { id: 'ot_old', targetId: 'northwind-health', at: '2026-11-09T13:30:00.000Z', kind: 'state', from: 'sent', to: 'not-now' });
    const after = (await service.detail('user-adam', 'northwind-health'))!;
    expect(after.row.state).toBe('sent');
    expect(after.touches.some((one) => one.kind === 'state' && one.to === 'not-now')).toBe(true);
    expect((await service.agentShow('user-adam', 'northwind-health'))!.state).toBe('sent');
  });
});

describe('What we know about each letter (note #1112)', () => {
  const resend = (n: number) => `re-${n}`;
  const event = (over: Partial<OutreachMailEventInput>): OutreachMailEventInput => ({
    eventId: `msg_${Math.random().toString(36).slice(2)}`, event: 'delivered', providerId: resend(1), at: '2026-11-09T13:00:05.000Z',
    to: ['mara@northwind-health.test'], subject: 'Your agents need a workplace', ...over,
  });
  const sendFirst = async (service: OutreachService, id = 'northwind-health') => {
    const draft = await firstOf(service, id);
    return service.send('user-adam', id, { step: 'first', subject: draft.subject, text: draft.text });
  };

  it('writes delivered and pictures loaded on the letter, each once, with their times; Nothing yet is null, never a bad sign', async () => {
    const { service } = await world();
    await sendFirst(service);
    const before = (await service.detail('user-adam', 'northwind-health'))!;
    expect(before.known.letters).toEqual([expect.objectContaining({
      step: 'first', measured: true, traced: true, delivered: null, opened: null, bounced: null, spam: null, delayed: null,
    })]);
    expect(before.known).toMatchObject({ followed: null, replied: null, installed: null, checked: 0 });
    const delivered = event({ event: 'delivered' });
    expect(await service.noteMailEvent(delivered)).toEqual({ recorded: true, company: 'Northwind Health' });
    // The provider retries: the same event is one touch, and so is a second "delivered".
    expect((await service.noteMailEvent(delivered)).recorded).toBe(false);
    expect((await service.noteMailEvent(event({ event: 'delivered', at: '2026-11-09T13:00:09.000Z' }))).recorded).toBe(false);
    await service.noteMailEvent(event({ event: 'opened', at: '2026-11-09T13:20:00.000Z' }));
    // Loaded again within the hour (Apple Mail, a proxy): the same load.
    expect((await service.noteMailEvent(event({ event: 'opened', at: '2026-11-09T13:50:00.000Z' }))).recorded).toBe(false);
    await service.noteMailEvent(event({ event: 'opened', at: '2026-11-09T16:00:00.000Z' }));
    const after = (await service.detail('user-adam', 'northwind-health'))!;
    expect(after.known.letters[0]).toMatchObject({
      delivered: '2026-11-09T13:00:05.000Z', opened: { first: '2026-11-09T13:20:00.000Z', last: '2026-11-09T16:00:00.000Z', times: 2 },
    });
    expect(after.row.state).toBe('sent');
    expect(after.row.glance).toMatchObject({ delivered: '2026-11-09T13:00:05.000Z', opened: '2026-11-09T13:20:00.000Z', followed: null });
    expect(after.touches.filter((one) => one.kind === 'mail')).toHaveLength(3);
    const list = await service.list('user-adam');
    expect(list.rows.find((row) => row.id === 'northwind-health')!.glance.opened).toBe('2026-11-09T13:20:00.000Z');
  });

  it('a permanent bounce ends it: Bounced, no follow-up, the reason shown; a passing one is only a fact', async () => {
    const { service, at } = await world();
    await sendFirst(service);
    await service.noteMailEvent(event({ event: 'bounced', permanent: false, detail: 'Transient, MailboxFull' }));
    expect((await service.detail('user-adam', 'northwind-health'))!.row.state).toBe('sent');
    await service.noteMailEvent(event({ event: 'bounced', detail: 'Permanent, General: no such user' }));
    at('2026-11-13T13:00:01Z');
    const after = (await service.detail('user-adam', 'northwind-health'))!;
    expect(after.row.state).toBe('bounced');
    expect(after.row.next).toBeNull();
    expect(after.draft).toBeNull();
    expect(after.noSend).toBe('The letter did not arrive (Permanent, General: no such user). Nothing more goes to this address.');
    expect(after.touches[0]).toMatchObject({ kind: 'state', from: 'sent', to: 'bounced' });
    await expect(service.send('user-adam', 'northwind-health', { step: 'day4', text: 'Again' })).rejects.toThrow('Nothing is due');
  });

  it('marked as spam ends it too; a reply after it still says Replied; an install says Installed', async () => {
    const { service, pulses } = await world();
    void pulses;
    await sendFirst(service);
    await service.noteMailEvent(event({ event: 'spam' }));
    expect((await service.detail('user-adam', 'northwind-health'))!).toMatchObject({ row: { state: 'spam' }, draft: null, noSend: 'They marked a letter as spam. Nothing more goes to them.' });
    await service.noteArrival({ id: 'mm_r', address: 'adam@agenticcloudcomputer.com', from: 'mara@northwind-health.test', subject: 'Re: x', receivedAt: '2026-11-09T15:00:00Z' });
    const replied = (await service.detail('user-adam', 'northwind-health'))!;
    expect(replied.row.state).toBe('replied');
    expect(replied.known.replied).toBe('2026-11-09T15:00:00.000Z');
    await service.notePulse({ copyId: 'c9', domain: 'northwind-health.test', contactName: 'Mara', contactEmail: 'mara@northwind-health.test' } as CopyPulse);
    expect((await service.detail('user-adam', 'northwind-health'))!.row.state).toBe('installed');
  });

  it('finds a letter sent before ids were kept by its address and subject near its send time, and drops everything else', async () => {
    const { service, store } = await world();
    await sendFirst(service);
    const touches = await store.touches('user-adam', 'northwind-health');
    const sent = touches.find((one) => one.kind === 'sent')!;
    // As the ten letters of 9 Nov were stored: no provider id, no HTML.
    const { providerId: _drop, measured: _m, ...old } = sent as Extract<OutreachTouch, { kind: 'sent' }>;
    const db = store as unknown as { touchesBy?: Map<string, OutreachTouch[]> };
    db.touchesBy!.set('user-adam', db.touchesBy!.get('user-adam')!.map((one) => (one.id === sent.id ? old as OutreachTouch : one)));
    expect((await service.detail('user-adam', 'northwind-health'))!.known.letters[0]).toMatchObject({ measured: false, traced: false });
    // Somebody else's letter, a sign-in link, the right address at another time: dropped.
    expect((await service.noteMailEvent(event({ providerId: 're-unknown', to: ['someone@else.test'] }))).recorded).toBe(false);
    expect((await service.noteMailEvent(event({ providerId: 're-unknown', at: '2026-11-09T15:00:00.000Z', event: 'spam' }))).recorded).toBe(false);
    expect((await service.noteMailEvent(event({ providerId: 're-unknown', subject: 'Something else', event: 'spam' }))).recorded).toBe(false);
    expect(await service.noteMailEvent(event({ providerId: 're-unknown', to: ['Mara@Northwind-Health.test'], event: 'spam' }))).toEqual({ recorded: true, company: 'Northwind Health' });
    expect((await service.detail('user-adam', 'northwind-health'))!.row.state).toBe('spam');
  });

  it('counts a link followed by a browser or an agent, and a mail system\'s check apart', async () => {
    const { service } = await world();
    const links = (await service.detail('user-adam', 'northwind-health'))!.links;
    const code = (url: string) => url.split('/').at(-1)!;
    await service.visit(code(links.home), { userAgent: 'Mozilla/5.0 (compatible; Proofpoint URL Defense)' });
    await service.visit(code(links.agents), { userAgent: 'Claude-User/1.0' });
    const known = (await service.detail('user-adam', 'northwind-health'))!.known;
    expect(known.checked).toBe(1);
    expect(known.followed).toMatchObject({ times: 1, latest: { link: 'agents', reader: 'agent', client: 'Claude' } });
  });

  it('says whether the provider\'s facts reach us: off without the secret, waiting until the first signed event, on after', async () => {
    const off = await world();
    expect((await off.service.list('user-adam')).mailFacts).toEqual({ status: 'off', lastEventAt: null });
    const on = await world({ mailEvents: true });
    expect((await on.service.list('user-adam')).mailFacts).toEqual({ status: 'waiting', lastEventAt: null });
    on.service.mailHeard();
    expect((await on.service.list('user-adam')).mailFacts).toEqual({ status: 'on', lastEventAt: '2026-11-09T13:00:00.000Z' });
  });

  it('writes the HTML copy from the same words: paragraphs, line breaks, links as links, the quote as a quote, everything escaped', () => {
    expect(outreachMailHtml('Hi Mara,\n\nOne <b>line</b> & two\nhttps://agenticcloudcomputer.com/go/abc234.\n\nAdam\n\nOn Mon, Adam wrote:\n> First.\n> https://x.test/a?b=1&c=2\n'))
      .toBe('<p>Hi Mara,</p>\n<p>One &lt;b&gt;line&lt;/b&gt; &amp; two<br>\n<a href="https://agenticcloudcomputer.com/go/abc234">https://agenticcloudcomputer.com/go/abc234</a>.</p>\n'
        + '<p>Adam</p>\n<p>On Mon, Adam wrote:</p>\n<blockquote><p>First.<br>\n<a href="https://x.test/a?b=1&amp;c=2">https://x.test/a?b=1&amp;c=2</a></p></blockquote>');
  });
});

describe('The Resend webhook route (note #1112)', () => {
  const SECRET = `whsec_${Buffer.from('a test signing secret, 32 bytes!').toString('base64')}`;
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });
  const sign = (secret: string, id: string, ts: string, body: string) => {
    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    return `v1,${createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`;
  };
  async function serve(secret: string, service: OutreachService | null) {
    const app = express();
    app.use(RESEND_WEBHOOK_PATH, express.raw({ type: () => true, limit: '256kb' }));
    app.use(express.json());
    app.use(outreachMailEventRoutes({ outreach: () => service, secret: () => secret, now: () => new Date('2026-11-09T13:00:00Z') }));
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}${RESEND_WEBHOOK_PATH}`;
  }
  const payload = (type: string, emailId: string, extra: Record<string, unknown> = {}) => JSON.stringify({
    type, created_at: '2026-11-09T13:00:06.000Z',
    data: { email_id: emailId, created_at: '2026-11-09T13:00:01.000Z', from: 'Adam B <adam@agenticcloudcomputer.com>', to: ['mara@northwind-health.test'], subject: 'Your agents need a workplace', ...extra },
  });
  const post = (url: string, body: string, headers: Record<string, string>) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  const signed = (body: string, id = 'msg_1', ts = String(Date.parse('2026-11-09T13:00:00Z') / 1000), secret = SECRET) => ({ 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,bm90IGl0 ${sign(secret, id, ts, body)}` });

  it('verifies the signature over the exact bytes, refuses stale or forged posts, and records an Outreach letter\'s events once', async () => {
    const { service } = await world({ mailEvents: true });
    const draft = await firstOf(service, 'northwind-health');
    await service.send('user-adam', 'northwind-health', { step: 'first', subject: draft.subject, text: draft.text });
    const url = await serve(SECRET, service);
    const body = payload('email.bounced', 're-1', { bounce: { type: 'Permanent', subType: 'General', message: 'No such user.' } });
    expect((await post(url, body, {})).status).toBe(401);
    expect((await post(url, body, signed(body, 'msg_1', String(Date.parse('2026-11-09T12:50:00Z') / 1000)))).status).toBe(401);
    expect((await post(url, body, signed(body, 'msg_1', undefined, `whsec_${Buffer.from('another secret').toString('base64')}`))).status).toBe(401);
    expect((await post(url, `${body} `, signed(body))).status).toBe(401);
    const ok = await post(url, body, signed(body));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ recorded: true });
    expect(await (await post(url, body, signed(body))).json()).toEqual({ recorded: false });
    const after = (await service.detail('user-adam', 'northwind-health'))!;
    expect(after.row.state).toBe('bounced');
    expect(after.known.letters[0]!.bounced).toEqual({ at: '2026-11-09T13:00:06.000Z', detail: 'No such user.', permanent: true });
    // Somebody else's letter, and an event Outreach does not record (a click): 200, nothing kept.
    const other = payload('email.delivered', 're-somebody-else', { to: ['x@y.test'], subject: 'Hi' });
    expect(await (await post(url, other, signed(other, 'msg_2'))).json()).toEqual({ recorded: false });
    const click = payload('email.clicked', 're-1');
    expect(await (await post(url, click, signed(click, 'msg_3'))).json()).toEqual({ recorded: false });
    expect((await service.detail('user-adam', 'northwind-health'))!.touches.filter((one) => one.kind === 'mail')).toHaveLength(1);
    expect((await service.list('user-adam')).mailFacts.status).toBe('on');
  });

  it('answers 503 and records nothing without the secret, and 404 where there is no Outreach', async () => {
    const { service } = await world();
    const body = payload('email.delivered', 're-1');
    expect((await post(await serve('', service), body, signed(body))).status).toBe(503);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    expect((await post(await serve(SECRET, null), body, signed(body))).status).toBe(404);
  });

  it('reads Resend\'s events: the seven it records, a passing bounce, the address out of a display name', () => {
    expect(readResendEvent(JSON.parse(payload('email.opened', 're-1')), 'msg')).toMatchObject({ event: 'opened', providerId: 're-1', at: '2026-11-09T13:00:06.000Z', to: ['mara@northwind-health.test'] });
    expect(readResendEvent(JSON.parse(payload('email.complained', 're-1')), 'msg')!.event).toBe('spam');
    expect(readResendEvent(JSON.parse(payload('email.delivery_delayed', 're-1')), 'msg')!.event).toBe('delayed');
    expect(readResendEvent(JSON.parse(payload('email.bounced', 're-1', { bounce: { type: 'Transient', subType: 'MailboxFull' } })), 'msg')).toMatchObject({ permanent: false, detail: 'Transient, MailboxFull' });
    expect(readResendEvent(JSON.parse(payload('email.delivered', 're-1', { to: ['Mara Q <mara@northwind-health.test>'] })), 'msg')!.to).toEqual(['mara@northwind-health.test']);
    for (const type of ['email.clicked', 'email.sent', 'domain.updated']) expect(readResendEvent(JSON.parse(payload(type, 're-1')), 'msg')).toBeNull();
    expect(readResendEvent(JSON.parse(payload('email.delivered', '')), 'msg')).toBeNull();
    expect(verifySvixSignature(SECRET, { id: 'a', timestamp: '1', signature: 'v1,x' }, '{}', new Date(1000))).toBe(false);
  });
});

describe('Investors, a second audience (note #1115)', () => {
  const investor = (name: string, fit: string, extra: Record<string, unknown> = {}) => ({
    company: name, fit, city: 'London', person: 'Pat Partner, partner', email: `pat@${name.toLowerCase().replace(/[^a-z]+/g, '')}.test`,
    profile: { builds: 'Backs developer tools at pre-seed.', buildsSource: 'their site, 2026' }, ...extra,
  });
  const investorWrite = (over: Record<string, unknown> = {}) => {
    const parsed = parseOutreachWrite({
      audience: 'investor',
      targets: [investor('Made Up Ventures', 'thesis match'), investor('Example Angels', 'partly'), investor('Quiet Capital', 'no public thesis', { notAFitReason: 'no public thesis found' })],
      ...over,
    });
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.write;
  };

  it('reads the audience strictly: a file without one is a customer, an investor\'s fit is its own words', () => {
    expect(batch().targets.every((target) => !('audience' in target))).toBe(true);
    const write = investorWrite();
    expect(write.targets.map((t) => [t.audience, t.thesis, t.fit])).toEqual([
      ['investor', 'thesis match', 'fit'], ['investor', 'partly', 'fit'], ['investor', 'no public thesis', 'not a fit']]);
    expect(parseOutreachWrite({ company: 'One Angel', audience: 'investor', fit: 'fit' })).toEqual({ ok: false, error: 'One Angel: an investor\'s fit is "thesis match", "partly" or "no public thesis".' });
    expect(parseOutreachWrite({ company: 'Shop', fit: 'thesis match' }).ok).toBe(false);
    expect(parseOutreachWrite({ company: 'Shop', fit: 'fit', audience: 'press' }).ok).toBe(false);
    expect(parseOutreachWrite({ audience: 'press', targets: [{ company: 'X', fit: 'fit' }] }).ok).toBe(false);
    // One company in a batch may say it is a customer.
    const mixed = parseOutreachWrite({ audience: 'investor', targets: [{ company: 'Plain Shop', fit: 'fit', audience: 'customer' }] });
    expect(mixed.ok && mixed.write.targets[0]!.audience).toBeUndefined();
    const words = parseOutreachWrite({ audience: 'investor', template: { subject: 'Your thesis', body: 'Hi {first name},\n\n{their thesis}' } });
    expect(words.ok && words.write.words).toMatchObject({ audience: 'investor', template: { subject: 'Your thesis' } });
  });

  it('keeps investors apart: their own rows, the customers untouched, no letter until an agent writes one — never the customers\' template', async () => {
    const { service } = await world();
    const before = await service.list('user-adam');
    expect(await service.write('user-adam', ADA, investorWrite())).toMatchObject({ added: ['Made Up Ventures', 'Example Angels', 'Quiet Capital'], refused: [] });
    const after = await service.list('user-adam');
    expect(after.rows.filter((row) => row.audience === 'customer')).toEqual(before.rows.map((row) => ({ ...row, audience: 'customer', thesis: null })));
    expect(after.rows.filter((row) => row.audience === 'investor').map((row) => [row.company, row.thesis, row.fit])).toEqual([
      ['Example Angels', 'partly', 'fit'], ['Made Up Ventures', 'thesis match', 'fit'], ['Quiet Capital', 'no public thesis', 'not a fit']]);
    const made = (await service.detail('user-adam', 'made-up-ventures'))!;
    expect(made.draft).toBeNull();
    expect(made.noSend).toBe('No letter is written for this investor yet, and there is no investor template. An agent writes it here with agentbuilt outreach set.');
    expect((await service.detail('user-adam', 'quiet-capital'))!.noSend).toBe('No public thesis we match: no public thesis found. Kept so it is not added again.');
    // The customers' template still serves the customers.
    expect((await firstOf(service, 'kestrel-systems')).from).toBe('template');
    const shown = (await service.agentList('user-adam')).find((row) => row.id === 'made-up-ventures');
    expect(shown).toMatchObject({ audience: 'investor', thesis: 'thesis match' });
  });

  it('writes the investors\' own template and follow-ups beside the customers\', signed, and draws an investor\'s letters only from them', async () => {
    const { service, at } = await world();
    const customersBefore = (await service.list('user-adam')).lastWrite;
    at('2026-11-09T14:00:00Z');
    await service.write('user-adam', ADA, investorWrite({
      template: { subject: 'Your thesis, our workplace', body: 'Hi {first name},\n\n{their thesis}\n\n{home link}' },
      followUps: { day4: { text: 'Investor day 4.', wordCount: 3 }, day11: { text: 'Investor day 11.', wordCount: 3 } },
    }));
    const list = await service.list('user-adam');
    expect(list.lastWrite).toEqual({ at: '2026-11-09T14:00:00.000Z', by: 'Ada' });
    expect(customersBefore!.by).toBe('Rowan');
    const draft = await firstOf(service, 'made-up-ventures');
    expect(draft).toMatchObject({ from: 'template', by: 'Ada', subject: 'Your thesis, our workplace' });
    expect(outreachPlaceholders(draft.text)).toEqual(['{first name}', '{their thesis}']);
    expect(draft.text).toMatch(/agenticcloudcomputer\.com\/go\/[a-z2-9]{6}$/);
    await expect(service.send('user-adam', 'made-up-ventures', { step: 'first', subject: draft.subject, text: draft.text })).rejects.toThrow('Fill in {first name} and {their thesis} first.');
    // A finished investor letter goes, and its follow-up is the investors' day 4, the customers' stays theirs.
    await service.send('user-adam', 'made-up-ventures', { step: 'first', subject: draft.subject, text: 'Hi Pat,\n\nYour thesis.' });
    await service.send('user-adam', 'northwind-health', { step: 'first', subject: 'Hello', text: 'Hi Mara.' });
    at('2026-11-13T14:00:01Z');
    expect((await firstOf(service, 'made-up-ventures')).text).toBe('Investor day 4.');
    expect((await firstOf(service, 'northwind-health')).text).toBe(batch().words!.followUps!.day4!.text);
    // Note #799's review counts customers only.
    expect((await service.list('user-adam')).firstSends).toBe(1);
    // A second write of the investors' words keeps the one it replaced.
    await service.write('user-adam', ADA, { targets: [], words: { audience: 'investor', source: null, generatedBy: null, generatedAt: null, template: { subject: 'New', body: 'New {first name}' } } });
    await service.write('user-adam', ADA, { targets: [], words: { audience: 'investor', source: null, generatedBy: null, generatedAt: null, template: { subject: 'New', body: 'New {first name}' } } });
    const customerFirst = await firstOf(service, 'kestrel-systems');
    expect(customerFirst.subject).toBe(batch().words!.template!.subject);
  });

  it('never turns a customer into an investor or back: the same name is refused, the rest of the batch goes in', async () => {
    const { service } = await world();
    const answer = await service.write('user-adam', ADA, investorWrite({ targets: [investor('Northwind Health', 'thesis match'), investor('Made Up Ventures', 'thesis match')] }));
    expect(answer.added).toEqual(['Made Up Ventures']);
    expect(answer.refused).toEqual([{ company: 'Northwind Health', reason: 'Northwind Health is already a customer in Outreach. Give the investor a name of its own (for example the fund\'s full name).' }]);
    expect((await service.detail('user-adam', 'northwind-health'))!.row.audience).toBe('customer');
    const back = await service.write('user-adam', ADA, { targets: [{ ...company('Fernhill Labs'), company: 'Made Up Ventures' }], words: null });
    expect(back.refused[0]!.reason).toMatch(/already an investor/);
  });
});

describe('The graph of contacts: funds down to their portfolio companies (note #1124)', () => {
  const fund = (name: string, portfolio: unknown, extra: Record<string, unknown> = {}) => ({
    company: name, audience: 'investor', fit: 'thesis match', email: `pat@${name.toLowerCase().replace(/[^a-z]+/g, '')}.test`, city: 'London', portfolio, ...extra,
  });
  const read = (doc: unknown) => {
    const parsed = parseOutreachWrite(doc);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.write;
  };

  it('reads a portfolio strictly: a name each, a real website, investors only, no company twice', () => {
    const ok = read(fund('Made Up Ventures', [{ name: 'Northwind Health', website: 'https://www.northwind-health.test/', builds: 'Clinics run by agents.', source: 'madeup.test/portfolio', readOn: '2026-11-10' }, { name: 'Tiny Robot Co' }]));
    expect(ok.targets[0]!.portfolio).toEqual([
      { name: 'Northwind Health', website: 'https://www.northwind-health.test/', builds: 'Clinics run by agents.', source: 'madeup.test/portfolio', readOn: '2026-11-10' },
      { name: 'Tiny Robot Co', website: null, builds: null, source: null, readOn: null },
    ]);
    expect(read(fund('No List Yet', undefined)).targets[0]).not.toHaveProperty('portfolio');
    expect(parseOutreachWrite(fund('X Fund', [{ website: 'a.test' }]))).toEqual({ ok: false, error: 'X Fund: portfolio[0] has no name.' });
    expect(parseOutreachWrite(fund('X Fund', [{ name: 'A' }, { name: 'a' }]))).toEqual({ ok: false, error: 'X Fund: a is in its portfolio twice.' });
    expect(parseOutreachWrite(fund('X Fund', [{ name: 'A', website: 'not a site' }])).ok).toBe(false);
    expect(parseOutreachWrite(fund('X Fund', { name: 'A' })).ok).toBe(false);
    expect(parseOutreachWrite({ company: 'Shop', fit: 'fit', portfolio: [{ name: 'A' }] })).toEqual({ ok: false, error: 'Shop: only an investor has a portfolio; add "audience": "investor".' });
  });

  it('draws every fund, each company once however many funds back it, and links a company that is a customer here by website or name, with its state', async () => {
    const { service } = await world();
    await service.send('user-adam', 'northwind-health', { step: 'first', subject: 'Hello', text: 'Hi Mara.' });
    await service.write('user-adam', ADA, read({ audience: 'investor', targets: [
      fund('Made Up Ventures', [
        { name: 'Northwind Health Inc', website: 'https://northwind-health.test', builds: 'Clinics.', source: 'madeup.test/portfolio', readOn: '2026-11-10' },
        { name: 'Tiny Robot Co', website: 'tinyrobot.test' },
      ]),
      fund('Example Angels', [{ name: 'Tiny Robot', website: 'https://www.tinyrobot.test/about' }, { name: 'Fernhill Labs' }]),
      fund('Quiet Capital', undefined, { fit: 'no public thesis' }),
    ] }));
    const graph = await service.graph('user-adam');
    expect(graph.funds.map((one) => [one.name, one.written, one.thesis])).toEqual([
      ['Example Angels', true, 'thesis match'], ['Made Up Ventures', true, 'thesis match'], ['Quiet Capital', false, 'no public thesis']]);
    const ids = Object.fromEntries(graph.funds.map((one) => [one.name, one.id]));
    expect(graph.companies.map((one) => [one.key, one.name, one.record?.state ?? null, one.funds.length])).toEqual([
      ['p:tiny-robot', 'Tiny Robot', null, 2],
      ['fernhill-labs', 'Fernhill Labs', 'not-contacted', 1],
      ['northwind-health', 'Northwind Health', 'sent', 1],
    ]);
    expect(graph.companies[0]!.funds.sort()).toEqual([ids['Example Angels'], ids['Made Up Ventures']].sort());
    expect(graph.edges).toHaveLength(4);
    expect(graph.edges.find((edge) => edge.company === 'northwind-health')).toEqual({ fund: ids['Made Up Ventures'], company: 'northwind-health', builds: 'Clinics.', source: 'madeup.test/portfolio', readOn: '2026-11-10' });
    // Nothing about the match is stored: the link follows the store.
    expect(JSON.stringify((await service.agentShow('user-adam', 'Made Up Ventures'))!.written)).not.toContain('northwind-health"');
    expect((await service.agentList('user-adam')).find((row) => row.company === 'Made Up Ventures')).toMatchObject({ portfolio: 2 });
  });

  it('keeps the portfolio it replaced on the timeline, and takes a portfolio for an investor whose letter has gone', async () => {
    const { service } = await world();
    await service.write('user-adam', ADA, read(fund('Made Up Ventures', [{ name: 'Tiny Robot Co' }], { firstEmail: { subject: 'Hi', body: 'Hi Pat.' } })));
    await service.send('user-adam', 'made-up-ventures', { step: 'first', subject: 'Hi', text: 'Hi Pat.' });
    const answer = await service.write('user-adam', ADA, read(fund('Made Up Ventures', [{ name: 'Tiny Robot Co' }, { name: 'Second Co' }], { firstEmail: { subject: 'Hi', body: 'Hi Pat.' } })));
    expect(answer).toMatchObject({ updated: [{ company: 'Made Up Ventures', fields: ['portfolio'] }], refused: [] });
    const written = (await service.detail('user-adam', 'made-up-ventures'))!.touches.find((touch) => touch.kind === 'written' && !touch.added);
    expect(written && written.kind === 'written' && written.previous?.portfolio).toEqual([{ name: 'Tiny Robot Co', website: null, builds: null, source: null, readOn: null }]);
  });
});
