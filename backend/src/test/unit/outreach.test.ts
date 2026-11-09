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
  addressMatches, hostMatches, outreachLocalTime, outreachPlaceholders, outreachWordCount, parseOutreachWrite, type OutreachWrite,
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
  await service.write('user-adam', ROWAN, batch());
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
    await service.setState('user-adam', 'fernhill-labs', 'not-now');
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
    expect((await service.detail('user-adam', 'fernhill-labs'))!.row.state).toBe('not-now');
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
    await service.setState('user-adam', 'lakeview-data', 'trying');
    await service.edit('user-adam', 'lakeview-data', { person: 'Ines O.' });
    const draft = await firstOf(service, 'harbor-pine');
    await service.send('user-adam', 'harbor-pine', { step: 'first', subject: draft.subject, text: 'The words that went.' });
    await service.noteArrival({ id: 'mm_reply', address: 'adam@agenticcloudcomputer.com', from: 'leo@harborpine.test', subject: 'Private reply subject', receivedAt: '2026-11-09T16:00:00Z' });
    await service.addNote('user-adam', 'harbor-pine', 'A private note of the owner.');
    const lakeview = company('Lakeview Data');
    lakeview.person = 'Ines Okafor, CTO and co-founder';
    await service.write('user-adam', ROWAN, { targets: [lakeview], words: null });
    const after = (await service.detail('user-adam', 'lakeview-data'))!;
    expect(after.row).toMatchObject({ state: 'trying', person: 'Ines O.' });
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
