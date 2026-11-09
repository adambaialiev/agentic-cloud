import { randomBytes } from 'node:crypto';
import {
  OUTREACH_CODE_ALPHABET, OUTREACH_CODE_LENGTH, OUTREACH_LINK_ORIGIN, OUTREACH_REVIEW_AFTER, OUTREACH_WORDS_HISTORY, addressMatches,
  outreachGlance, outreachKnown, outreachStateFrom, type OutreachMailEvent, type OutreachMailFacts, type OutreachPastState,
  fillOutreachLinks, isOutreachCode, outreachLinkTarget, outreachLinks, outreachReader, type OutreachLink, type OutreachLinkCodes, hostMatches, outreachDraft, outreachNewerDraft, outreachNext,
  outreachPlaceholders, outreachTargetId, outreachZone, sortOutreachRows, targetCity, targetEmail, targetPerson,
  type OutreachAgentRow, type OutreachAgentTarget, type OutreachEdits, type OutreachListAnswer, type OutreachRow, type OutreachSeedTarget,
  type OutreachState, type OutreachStep, type OutreachTargetAnswer, type OutreachTargetRecord, type OutreachTouch, type OutreachWords,
  type OutreachWrite, type OutreachWriteAnswer, type OutreachWriter,
} from '../shared/outreach.js';
import type { CopyPulse } from '../shared/copy-pulse.js';
import type { MailArrival } from '../types/mail-arrival.js';
import type { MailAllowance, MailOutboxService } from './mail-outbox.js';
import type { MailboxStorage } from './mailbox-storage.js';
import type { OutreachStore } from './outreach-storage.js';

/**
 * Outreach (notes #1089, #1103), the service behind the owner's site.
 *
 * Its tables are the one place the words live. The owner's agents write a
 * company — facts, profile, first letter — and the shared template and
 * follow-ups with `write()` (`agentbuilt outreach set`); each write is signed
 * and the record it replaced stays on the company's timeline. A write never
 * changes a state, a touch, the owner's own fields or his own letter, and it
 * cannot reach a letter that has gone. The site reads `list()` and
 * `detail()` live.
 *
 * A company's state is never picked (note #1112; Adam, 9 Nov 2026: "I should
 * not be able to change state manually"). It is read off the timeline by
 * `outreachStateFrom`, and only these RECORD what already happened — none of
 * them sends anything:
 *   - a letter he sends from the screen (Sent);
 *   - the mail provider's signed word on one of his letters: delivered,
 *     delayed, bounced, marked as spam, pictures loaded (`noteMailEvent`);
 *   - a letter that arrives at his address from the company's address or
 *     domain (Replied);
 *   - a private copy's daily report whose contact or domain is the
 *     company's (Installed).
 * Not now and Trying it, which he picked by hand before, stay on the
 * timeline as history and move nothing.
 *
 * Sending goes through the person's own outbox (MailOutboxService), so a
 * letter from here is an ordinary letter of his: it is in Sent, it spends the
 * same allowance as one written in the inbox, and it carries nothing else.
 */
/**
 * Outreach's own ceilings (note #1111). Adam, 9 Nov 2026, sending the list:
 * "You can start 10 new messages an hour … Can we increase the limit?". The
 * mail screens' 10 an hour / 30 a day guard a free address on our domain
 * against strangers; Outreach is a narrower door — only the platform
 * operator, only on his own press, one letter per company — so it gets 50 an
 * hour (the whole list in one sitting), 60 a day (well under the provider's
 * free-plan ceiling of 100 a day for the whole account, sign-ins included),
 * and 50 follow-ups an hour (day 4 and day 11 fall due for the whole list on
 * the same day). Everything he sent still counts towards them.
 */
export const OUTREACH_MAIL_ALLOWANCE: MailAllowance = { newPerHour: 50, newPerDay: 60, repliesPerHour: 50 };

export class OutreachError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'OutreachError';
  }
}

export interface OutreachServiceDeps {
  store: OutreachStore;
  /** The person's outbox, read when needed: it is replaced when sending is set up after boot. */
  outbox: () => MailOutboxService | undefined;
  mailboxes?: Pick<MailboxStorage, 'getByAddress'>;
  /** The copies' pulses we already hold, to match at import. */
  pulses?: () => Promise<CopyPulse[]>;
  senderName?: (userId: string) => Promise<string>;
  /** Whether the backend holds the provider's webhook signing secret, so its delivery facts can arrive (note #1112). */
  mailEventsConfigured?: boolean;
  now?: () => Date;
}

/** One event from the mail provider's webhook, already verified and read (routes/outreach-mail-events.ts). */
export interface OutreachMailEventInput {
  /** The webhook's own id for this delivery: the same event retried carries the same one. */
  eventId: string;
  event: OutreachMailEvent;
  /** The provider's id for the letter, as it answered the send. */
  providerId: string;
  at: string;
  to: string[];
  subject: string;
  detail?: string | null;
  permanent?: boolean;
}

/** A touch as its maker gives it: the store adds which company, its id and its time. */
type TouchBody = OutreachTouch extends infer T ? T extends OutreachTouch ? Omit<T, 'id' | 'at' | 'targetId'> : never : never;

const MAX_NOTE = 4000;
const MAX_FIELD = 300;
const MAX_LETTER = 20_000;

/** Which of a company's fields a write changes, by name. */
function changedFields(before: OutreachSeedTarget, after: OutreachSeedTarget): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)] as Array<keyof OutreachSeedTarget>);
  return [...keys].filter((key) => JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null));
}

let sequence = 0;
/** The same reader opening the same link again within this long is one visit (a mail system often fetches twice). */
const VISIT_REPEAT_MS = 60_000;
/** Pictures loaded again within this long is the same load (Apple Mail and proxies fetch more than once). */
const OPEN_REPEAT_MS = 60 * 60_000;
/** A letter sent before its provider id was kept is matched by recipient and subject within this long of its send. */
const UNTRACED_MATCH_MS = 10 * 60_000;

const touchId = (at: Date) => `ot_${at.getTime().toString(36).padStart(9, '0')}${(sequence++ % 1296).toString(36).padStart(2, '0')}${randomBytes(4).toString('hex')}`;

export class OutreachService {
  private readonly now: () => Date;
  /** One letter at a time per company: a double press is refused, not sent twice. */
  private readonly sending = new Set<string>();
  /** When the last signed provider event arrived, ours or not: proof the webhook is wired. */
  private lastMailEventAt: string | null = null;

  constructor(private readonly deps: OutreachServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private row(record: OutreachTargetRecord, touches: OutreachTouch[], now: Date): OutreachRow {
    const state = outreachStateFrom(touches);
    // When it came to be in that state: the newest state entry naming it, else when it was settled.
    const settled = touches.find((touch) => touch.kind === 'state' && touch.to === state)?.at ?? (record.state === state ? record.stateAt : null);
    return {
      id: record.id,
      company: record.seed.company,
      group: record.seed.group,
      fit: record.seed.fit,
      firstBatchOrder: record.seed.firstBatchOrder,
      city: targetCity(record),
      zone: outreachZone(targetCity(record)),
      person: targetPerson(record),
      email: targetEmail(record),
      verification: record.seed.verification,
      state,
      stateAt: state === 'not-contacted' ? null : settled,
      glance: outreachGlance(outreachKnown(touches)),
      lastTouchAt: touches[0]?.at ?? null,
      next: outreachNext(record, touches, now),
      written: Boolean(record.seed.firstEmail),
      writtenBy: record.written?.by.name ?? null,
      writtenAt: record.written?.at ?? null,
      yours: Boolean(record.ownLetter),
      newerDraft: Boolean(outreachNewerDraft(record)),
    };
  }

  async list(userId: string): Promise<OutreachListAnswer> {
    const now = this.now();
    const [kept, records, touches] = await Promise.all([this.deps.store.words(userId), this.deps.store.targets(userId), this.deps.store.touches(userId)]);
    const byTarget = new Map<string, OutreachTouch[]>();
    for (const touch of touches) byTarget.set(touch.targetId, [...(byTarget.get(touch.targetId) ?? []), touch]);
    const rows = records.map((record) => this.row(record, byTarget.get(record.id) ?? [], now));
    const writes = [
      ...records.flatMap((record) => (record.written ? [{ at: record.written.at, by: record.written.by.name }] : [])),
      ...(kept?.words.writtenBy ? [{ at: kept.importedAt, by: kept.words.writtenBy.name }] : []),
    ].sort((a, b) => b.at.localeCompare(a.at));
    return {
      lastWrite: writes[0] ?? null,
      mailFacts: this.mailFacts(touches),
      rows: sortOutreachRows(rows, new Map(records.map((record) => [record.id, record.seed.number]))),
      firstSends: touches.filter((touch) => touch.kind === 'sent' && touch.step === 'first').length,
      reviewAfter: OUTREACH_REVIEW_AFTER,
    };
  }

  async detail(userId: string, targetId: string): Promise<OutreachTargetAnswer | null> {
    const found = await this.deps.store.target(userId, targetId);
    if (!found) return null;
    const record = await this.withLinks(found);
    const [kept, touches] = await Promise.all([this.deps.store.words(userId), this.deps.store.touches(userId, targetId)]);
    const row = this.row(record, touches, this.now());
    const draft = outreachDraft(record, kept?.words ?? null, touches, row.next);
    return {
      row, seed: record.seed, edits: record.edits, touches, draft, noSend: draft ? null : this.noSend(record, row, touches), links: outreachLinks(record.links!),
      known: outreachKnown(touches), mailFacts: this.mailFacts(await this.deps.store.touches(userId)),
    };
  }

  /** Whether the provider's delivery facts reach us: off without the secret, waiting until the first signed event, on after. */
  private mailFacts(touches: OutreachTouch[]): OutreachMailFacts {
    if (!this.deps.mailEventsConfigured) return { status: 'off', lastEventAt: null };
    const recorded = touches.find((touch) => touch.kind === 'mail')?.at ?? null;
    const last = [recorded, this.lastMailEventAt].filter((at): at is string => Boolean(at)).sort().at(-1) ?? null;
    return { status: last ? 'on' : 'waiting', lastEventAt: last };
  }

  /**
   * The mail provider said something about a letter (note #1112): the route
   * has checked its signature and read it. It lands on the company's
   * timeline when the letter is one of his Outreach letters — found by the
   * provider's id kept at send time, or, for a letter sent before ids were
   * kept, by its recipient and subject within ten minutes of its send — and
   * the company's state is settled from the timeline again. The same event
   * twice is one touch; pictures loaded again within the hour are the same
   * load. Anything else (another person's mail, a sign-in link) is dropped.
   */
  /** A signed provider event arrived, whatever it was about: the webhook is wired. */
  mailHeard(): void {
    this.lastMailEventAt = this.now().toISOString();
  }

  async noteMailEvent(input: OutreachMailEventInput): Promise<{ recorded: boolean; company?: string }> {
    this.mailHeard();
    const records = await this.deps.store.allTargets();
    const users = [...new Set(records.map((record) => record.userId))];
    const to = new Set(input.to.map((address) => address.trim().toLowerCase()));
    for (const userId of users) {
      const touches = await this.deps.store.touches(userId);
      const sent = touches.filter((touch): touch is Extract<OutreachTouch, { kind: 'sent' }> => touch.kind === 'sent');
      const letter = sent.find((touch) => touch.providerId === input.providerId)
        ?? sent.find((touch) => !touch.providerId && to.has(touch.to.toLowerCase()) && touch.subject.trim() === input.subject.trim()
          && Math.abs(Date.parse(touch.at) - Date.parse(input.at)) <= UNTRACED_MATCH_MS);
      if (!letter) continue;
      const record = records.find((one) => one.userId === userId && one.id === letter.targetId);
      if (!record) return { recorded: false };
      const theirs = touches.filter((touch) => touch.targetId === record.id);
      const events = theirs.filter((touch): touch is Extract<OutreachTouch, { kind: 'mail' }> => touch.kind === 'mail' && touch.mailId === letter.mailId);
      const repeat = events.some((touch) => touch.eventId === input.eventId)
        || (input.event === 'opened'
          ? events.some((touch) => touch.event === 'opened' && Math.abs(Date.parse(input.at) - Date.parse(touch.at)) < OPEN_REPEAT_MS)
          // A passing bounce and then a final one are two facts; the same kind twice is one.
          : events.some((touch) => touch.event === input.event && (touch.event !== 'bounced' || (touch.permanent !== false) === (input.permanent !== false))));
      if (repeat) return { recorded: false, company: record.seed.company };
      await this.touch(userId, record.id, {
        kind: 'mail', event: input.event, mailId: letter.mailId, step: letter.step, eventId: input.eventId,
        ...(input.detail ? { detail: input.detail.slice(0, 300) } : {}),
        ...(input.event === 'bounced' && input.permanent === false ? { permanent: false } : {}),
        at: input.at,
      });
      await this.settle(userId, record, input.at);
      return { recorded: true, company: record.seed.company };
    }
    return { recorded: false };
  }

  /**
   * A company's two short codes (note #1106), given the first time it is
   * read or written and never changed after: a letter that has gone carries
   * them. Unique across every company in the store.
   */
  private async withLinks(record: OutreachTargetRecord): Promise<OutreachTargetRecord & { links: OutreachLinkCodes }> {
    if (record.links && isOutreachCode(record.links.home) && isOutreachCode(record.links.agents)) return record as OutreachTargetRecord & { links: OutreachLinkCodes };
    const taken = new Set((await this.deps.store.allTargets()).flatMap((other) => (other.links ? [other.links.home, other.links.agents] : [])));
    const fresh = () => {
      for (;;) {
        const bytes = randomBytes(OUTREACH_CODE_LENGTH);
        const code = [...bytes].map((byte) => OUTREACH_CODE_ALPHABET[byte % OUTREACH_CODE_ALPHABET.length]).join('');
        if (!taken.has(code)) { taken.add(code); return code; }
      }
    };
    const next = { ...record, links: { home: fresh(), agents: fresh() } };
    await this.deps.store.putTarget(next);
    return next;
  }

  /**
   * Somebody opened /go/<code> (note #1106). Whatever the code, the answer
   * is a redirect: a mistyped or unknown code still lands on the home page,
   * and records nothing. A known one lands on its page with the UTM data and
   * leaves a visit on the company's timeline: which link, and whether the
   * reader looked like a browser, an agent or a mail system checking it.
   * The same reader on the same link within a minute is one visit. Nothing
   * else about the reader is kept.
   */
  async visit(code: string, reader: { userAgent?: string | null; method?: string }): Promise<{ location: string; recorded: boolean }> {
    const home = `${OUTREACH_LINK_ORIGIN}/`;
    const wanted = String(code ?? '').toLowerCase();
    if (!isOutreachCode(wanted)) return { location: home, recorded: false };
    const record = (await this.deps.store.allTargets()).find((one) => one.links?.home === wanted || one.links?.agents === wanted);
    if (!record) return { location: home, recorded: false };
    const link: OutreachLink = record.links!.home === wanted ? 'home' : 'agents';
    const location = outreachLinkTarget(link, record.id);
    const who = outreachReader(reader.userAgent, reader.method);
    const now = this.now();
    const recent = (await this.deps.store.touches(record.userId, record.id)).find((touch) =>
      touch.kind === 'visit' && touch.link === link && touch.reader === who.reader && touch.client === who.client
      && now.getTime() - Date.parse(touch.at) < VISIT_REPEAT_MS);
    if (recent) return { location, recorded: false };
    await this.touch(record.userId, record.id, { kind: 'visit', link, reader: who.reader, client: who.client });
    return { location, recorded: true };
  }

  /** Why the profile has no Send, said plainly. */
  private noSend(record: OutreachTargetRecord, row: OutreachRow, touches: OutreachTouch[]): string {
    if (record.seed.fit !== 'fit') return `Not a fit${record.seed.notAFitReason ? `: ${record.seed.notAFitReason}` : ''}. Kept so it is not added again.`;
    if (!targetEmail(record)) return 'No address for this company yet. Add one below to write.';
    if (row.state === 'replied') return 'They replied. Answer from your inbox.';
    if (row.state === 'installed') return 'They installed it.';
    if (row.state === 'spam') return 'They marked a letter as spam. Nothing more goes to them.';
    if (row.state === 'bounced') {
      const bounce = outreachKnown(touches).letters.find((letter) => letter.bounced?.permanent)?.bounced;
      return `The letter did not arrive${bounce?.detail ? ` (${bounce.detail.replace(/[.\s]+$/, '')})` : ''}. Nothing more goes to this address.`;
    }
    if (row.state === 'sent' && !row.next) return 'The first letter and both follow-ups have gone. Note #799 says: then stop.';
    if (row.next?.step === 'first') return 'No letter is written for this company yet. An agent writes it here with agentbuilt outreach set.';
    if (row.next) return `The ${stepWords(row.next.step)} is not written yet. An agent writes it here with agentbuilt outreach set.`;
    return 'Nothing to send.';
  }

  /**
   * An agent writes (note #1103): companies, and the shared template and
   * follow-ups, straight into the store. A company is the same company across
   * writes (its id is its name). What changes is only what the agents own —
   * the facts, the profile, the first letter — and each change is signed and
   * keeps the record it replaced on the timeline. The owner's fields, his own
   * letter, the state and every touch stay as they are; where he has his own
   * letter, the new one waits beside it (`outreachNewerDraft`). Once a first
   * letter has gone, its words, its address and the company's fit are what
   * went: a write that would change them is refused for that company, and the
   * rest of the batch still goes in. Nothing is ever deleted.
   */
  async write(userId: string, by: OutreachWriter, write: OutreachWrite): Promise<OutreachWriteAnswer> {
    const at = this.now().toISOString();
    const answer: OutreachWriteAnswer = { added: [], updated: [], unchanged: [], refused: [], words: null };
    for (const target of write.targets) {
      const id = outreachTargetId(target.company);
      const before = await this.deps.store.target(userId, id);
      if (!before) {
        await this.withLinks({ id, userId, seed: target, edits: {}, state: 'not-contacted', stateAt: null, addedAt: at, written: { at, by }, ownLetter: null });
        await this.touch(userId, id, { kind: 'written', by, added: true, fields: Object.keys(target), previous: null, at });
        answer.added.push(target.company);
        continue;
      }
      const fields = changedFields(before.seed, target);
      if (!fields.length) { answer.unchanged.push(target.company); continue; }
      const touches = await this.deps.store.touches(userId, id);
      const gone = touches.find((touch): touch is Extract<OutreachTouch, { kind: 'sent' }> => touch.kind === 'sent' && touch.step === 'first');
      if (gone) {
        const fixed = [
          before.seed.firstEmail?.subject !== target.firstEmail?.subject || before.seed.firstEmail?.body !== target.firstEmail?.body ? 'its first letter' : null,
          (before.seed.email ?? '').toLowerCase() !== (target.email ?? '').toLowerCase() ? 'its address' : null,
          before.seed.fit !== target.fit ? 'whether it is a fit' : null,
        ].filter(Boolean);
        if (fixed.length) {
          answer.refused.push({ company: target.company, reason: `Its first letter went on ${gone.at.slice(0, 10)}: ${fixed.join(', ')} stays as it went. Write it again without changing that.` });
          continue;
        }
      }
      await this.deps.store.putTarget({ ...before, seed: target, written: { at, by } });
      await this.touch(userId, id, { kind: 'written', by, added: false, fields, previous: before.seed, at });
      answer.updated.push({ company: target.company, fields });
    }
    if (write.words) answer.words = await this.writeWords(userId, by, write.words, at);
    // A company that already runs its own copy is Installed from the start:
    // that records what happened, as a report arriving later would.
    if (answer.added.length && this.deps.pulses) {
      for (const pulse of await this.deps.pulses().catch(() => [] as CopyPulse[])) await this.notePulse(pulse, userId);
    }
    return answer;
  }

  private async writeWords(userId: string, by: OutreachWriter, write: NonNullable<OutreachWrite['words']>, at: string): Promise<'written' | 'unchanged'> {
    const kept = await this.deps.store.words(userId);
    const before = kept?.words ?? null;
    const template = write.template ?? before?.template ?? null;
    const followUps = {
      day4: write.followUps?.day4 ?? before?.followUps.day4 ?? null,
      day11: write.followUps?.day11 ?? before?.followUps.day11 ?? null,
    };
    if (before && JSON.stringify(template) === JSON.stringify(before.template) && JSON.stringify(followUps) === JSON.stringify(before.followUps)) return 'unchanged';
    const next: OutreachWords = {
      source: write.source ?? before?.source ?? 'written by the agents',
      generatedBy: write.generatedBy ?? before?.generatedBy ?? null,
      generatedAt: write.generatedAt ?? before?.generatedAt ?? null,
      template,
      followUps,
      writtenBy: by,
      previous: before
        ? [{ at: kept!.importedAt, by: before.writtenBy ?? null, template: before.template, followUps: before.followUps }, ...(before.previous ?? [])].slice(0, OUTREACH_WORDS_HISTORY)
        : [],
    };
    await this.deps.store.setWords(userId, at, next);
    return 'written';
  }

  /** What an agent reads back: no reply, no note, no sent letter — the words it may write and the state as a word. */
  private agentRow(record: OutreachTargetRecord, touches: OutreachTouch[]): OutreachAgentRow {
    return {
      id: record.id,
      company: record.seed.company,
      fit: record.seed.fit,
      firstBatchOrder: record.seed.firstBatchOrder,
      state: outreachStateFrom(touches),
      letter: Boolean(record.seed.firstEmail),
      profile: Boolean(record.seed.profile),
      firstLetterGone: touches.some((touch) => touch.kind === 'sent' && touch.step === 'first'),
      ownerEdited: Boolean(record.ownLetter),
      writtenBy: record.written?.by.name ?? null,
      writtenAt: record.written?.at ?? null,
      links: outreachLinks(record.links!),
    };
  }

  async agentList(userId: string): Promise<OutreachAgentRow[]> {
    const [found, touches] = await Promise.all([this.deps.store.targets(userId), this.deps.store.touches(userId)]);
    const records = [];
    for (const record of found) records.push(await this.withLinks(record));
    const rows = records.map((record) => this.agentRow(record, touches.filter((touch) => touch.targetId === record.id)));
    return sortOutreachRows(rows, new Map(records.map((record) => [record.id, record.seed.number])));
  }

  /** One company for an agent, by its id or its name. */
  async agentShow(userId: string, which: string): Promise<OutreachAgentTarget | null> {
    const found = await this.deps.store.target(userId, which) ?? await this.deps.store.target(userId, outreachTargetId(which));
    if (!found) return null;
    const record = await this.withLinks(found);
    const touches = await this.deps.store.touches(userId, record.id);
    return {
      ...this.agentRow(record, touches),
      written: record.seed,
      writes: touches.flatMap((touch) => (touch.kind === 'written' ? [{ at: touch.at, by: touch.by.name, added: touch.added, fields: touch.fields }] : [])),
    };
  }

  /**
   * The owner and his own first letter, from the site. `save` keeps what he
   * typed as his version (the site saves as he types); `take` sets his aside
   * for the agents' letter; `keep` keeps his over an agent's newer draft. Not
   * once the first letter has gone: then its words are what went.
   */
  async letter(userId: string, targetId: string, args: { action: unknown; subject?: unknown; text?: unknown }): Promise<OutreachTargetRecord> {
    const record = await this.mine(userId, targetId);
    if (record.seed.fit !== 'fit') throw new OutreachError(409, 'This company is not a fit; there is no letter to write.');
    const touches = await this.deps.store.touches(userId, targetId);
    if (touches.some((touch) => touch.kind === 'sent' && touch.step === 'first')) throw new OutreachError(409, 'The first letter has gone: its words stay as they went.');
    const agents = record.seed.firstEmail;
    const own = record.ownLetter ?? null;
    const by = record.written?.by.name ?? null;
    const action = String(args.action ?? '');
    let next: OutreachTargetRecord | null = null;
    if (action === 'save') {
      const subject = String(args.subject ?? '').trim().slice(0, 200);
      const body = String(args.text ?? '').replace(/\r\n/g, '\n').trim();
      if (!subject || !body) throw new OutreachError(400, 'Write a subject and a letter first.');
      if (body.length > MAX_LETTER) throw new OutreachError(400, `A letter is at most ${MAX_LETTER.toLocaleString('en-US')} characters.`);
      const basedOn = agents ? { subject: agents.subject, body: agents.body } : null;
      // The Send box shows the agents' words with this company's links filled in (note #1106).
      if (agents && subject === fillOutreachLinks(agents.subject, record.links).trim() && body === fillOutreachLinks(agents.body, record.links).trim()) {
        // Back to the agents' words, word for word: there is no version of his any more.
        if (!own) return record;
        next = { ...record, ownLetter: null };
        await this.deps.store.putTarget(next);
        await this.touch(userId, targetId, { kind: 'letter', action: 'took', subject: own.subject, body: own.body, by });
        return next;
      }
      next = { ...record, ownLetter: { subject, body, at: this.now().toISOString(), basedOn } };
      await this.deps.store.putTarget(next);
      // The timeline says once that he made it his, with the words he started from.
      if (!own) await this.touch(userId, targetId, { kind: 'letter', action: 'saved', subject: agents?.subject ?? subject, body: agents?.body ?? '', by });
      return next;
    }
    if (action === 'take') {
      if (!own) return record;
      next = { ...record, ownLetter: null };
      await this.deps.store.putTarget(next);
      await this.touch(userId, targetId, { kind: 'letter', action: 'took', subject: own.subject, body: own.body, by });
      return next;
    }
    if (action === 'keep') {
      const newer = outreachNewerDraft(record);
      if (!own || !newer) return record;
      next = { ...record, ownLetter: { ...own, basedOn: { subject: newer.subject, body: newer.body } } };
      await this.deps.store.putTarget(next);
      await this.touch(userId, targetId, { kind: 'letter', action: 'kept', subject: newer.subject, body: newer.body, by });
      return next;
    }
    throw new OutreachError(400, 'Say save, take or keep.');
  }

  private async mine(userId: string, targetId: string): Promise<OutreachTargetRecord> {
    const record = await this.deps.store.target(userId, targetId);
    if (!record) throw new OutreachError(404, 'No such company in Outreach.');
    return record;
  }

  private async touch(userId: string, targetId: string, touch: TouchBody & { at?: string }): Promise<OutreachTouch> {
    const at = touch.at ? new Date(touch.at) : this.now();
    const full = { ...touch, targetId, id: touchId(at), at: at.toISOString() } as OutreachTouch;
    await this.deps.store.addTouch(userId, full);
    return full;
  }

  /**
   * The owner's own fields: the person, the address, the city. One address
   * per company (note #799): once a letter has gone to one, the address is
   * fixed, because writing to a second would be the founder and the inbox at
   * once.
   */
  async edit(userId: string, targetId: string, patch: Record<string, unknown>): Promise<OutreachTargetRecord> {
    const record = await this.mine(userId, targetId);
    const touches = await this.deps.store.touches(userId, targetId);
    const edits: OutreachEdits = { ...record.edits };
    const changes: Array<{ field: keyof OutreachEdits; from: string | null; to: string | null }> = [];
    for (const field of ['person', 'email', 'city'] as const) {
      if (!(field in patch)) continue;
      const raw = patch[field];
      if (raw !== null && typeof raw !== 'string') throw new OutreachError(400, `${field} is words or nothing.`);
      const value = (raw ?? '').trim().slice(0, field === 'email' ? 254 : MAX_FIELD);
      const before = field === 'person' ? targetPerson(record) : field === 'email' ? targetEmail(record) : targetCity(record);
      const seeded = record.seed[field];
      if (field === 'email') {
        if (value && !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(value)) throw new OutreachError(400, 'Write one email address.');
        if (touches.some((touch) => touch.kind === 'sent') && value.toLowerCase() !== (before ?? '').toLowerCase()) {
          throw new OutreachError(409, `A letter already went to ${before}. One address per company: write again from that thread.`);
        }
      }
      // Back to the note's own value, or blank on purpose, or the owner's.
      if (value === (seeded ?? '')) delete edits[field];
      else edits[field] = value;
      const after = field in edits ? (edits[field] || null) : seeded;
      if ((after ?? '') !== (before ?? '')) changes.push({ field, from: before, to: after });
    }
    if (!changes.length) return record;
    const next = { ...record, edits };
    await this.deps.store.putTarget(next);
    for (const change of changes) await this.touch(userId, targetId, { kind: 'edit', ...change });
    return next;
  }

  /** A note of the owner's on the timeline. */
  async addNote(userId: string, targetId: string, text: unknown): Promise<OutreachTouch> {
    await this.mine(userId, targetId);
    const said = String(text ?? '').trim();
    if (!said) throw new OutreachError(400, 'Write something first.');
    if (said.length > MAX_NOTE) throw new OutreachError(400, `A note is at most ${MAX_NOTE.toLocaleString()} characters.`);
    return this.touch(userId, targetId, { kind: 'note', text: said });
  }

  /**
   * Settle the stored state from the timeline (`outreachStateFrom`) and, when
   * it changed, say so on the timeline. Only facts reach here: there is no
   * door that sets a state (note #1112).
   */
  private async settle(userId: string, record: OutreachTargetRecord, at?: string): Promise<OutreachTargetRecord> {
    const fresh = await this.deps.store.target(userId, record.id) ?? record;
    const state = outreachStateFrom(await this.deps.store.touches(userId, record.id));
    if (fresh.state === state) return fresh;
    const stamp = at ?? this.now().toISOString();
    const next = { ...fresh, state, stateAt: stamp };
    await this.deps.store.putTarget(next);
    await this.touch(userId, record.id, { kind: 'state', from: fresh.state as OutreachPastState, to: state, at: stamp });
    return next;
  }

  /**
   * Send the next letter, as the owner, from his address — only when he
   * presses. The step must be the one that is next and, for a follow-up,
   * due; the words are his to edit, but a template placeholder left in them
   * is refused, so no letter goes out with "{their line}" in it.
   */
  async send(userId: string, targetId: string, args: { step: unknown; subject?: unknown; text: unknown }): Promise<{ touch: OutreachTouch; mailId: string }> {
    const outbox = this.deps.outbox();
    if (!outbox) throw new OutreachError(503, 'Sending is not available on this backend yet.');
    const key = `${userId}\u0000${targetId}`;
    if (this.sending.has(key)) throw new OutreachError(409, 'A letter to this company is already on its way.');
    this.sending.add(key);
    try {
      const record = await this.mine(userId, targetId);
      const touches = await this.deps.store.touches(userId, targetId);
      const next = outreachNext(record, touches, this.now());
      const step = String(args.step ?? '') as OutreachStep;
      if (!next || next.step !== step) {
        throw new OutreachError(409, next ? `The next letter here is the ${stepWords(next.step)}.` : 'Nothing is due to this company.');
      }
      if (!next.due) throw new OutreachError(409, `The ${stepWords(step)} is due ${next.dueAt!.slice(0, 10)}. Nothing sends early.`);
      const text = String(args.text ?? '').trim();
      const subject = String(args.subject ?? '').trim();
      const left = outreachPlaceholders(`${subject}\n${text}`);
      if (left.length) throw new OutreachError(400, `Fill in ${left.join(' and ')} first.`);
      const senderName = (await this.deps.senderName?.(userId).catch(() => '')) || undefined;
      let mail;
      if (step === 'first') {
        if (!subject) throw new OutreachError(400, 'Write a subject.');
        mail = await outbox.send({ userId, to: targetEmail(record), subject, text, allowance: OUTREACH_MAIL_ALLOWANCE, withHtml: true, ...(senderName ? { senderName } : {}) });
      } else {
        // In the thread: under the latest letter of ours to them.
        const last = touches.find((touch): touch is Extract<OutreachTouch, { kind: 'sent' }> => touch.kind === 'sent');
        mail = await outbox.followUp({ userId, messageId: last!.mailId, text, allowance: OUTREACH_MAIL_ALLOWANCE, withHtml: true, ...(senderName ? { senderName } : {}) });
      }
      const touch = await this.touch(userId, targetId, {
        kind: 'sent', step, mailId: mail.id, to: mail.to?.[0]?.address ?? targetEmail(record) ?? '', subject: mail.subject, text: mail.wrote ?? text,
        ...(mail.providerId ? { providerId: mail.providerId } : {}), measured: true,
        at: mail.receivedAt,
      });
      await this.settle(userId, record, mail.receivedAt);
      return { touch, mailId: mail.id };
    } finally {
      this.sending.delete(key);
    }
  }

  /**
   * A letter arrived at somebody's address. If it is the Outreach owner's and
   * it came from a company's address or domain, it goes on that company's
   * timeline, and the company is Replied (unless it is already Installed).
   * A letter the checks marked as possibly forged is recorded as such and
   * moves nothing: a claim of their address is not their reply.
   */
  async noteArrival(arrival: MailArrival, opts: { suspicious?: boolean } = {}): Promise<void> {
    if (!this.deps.mailboxes || !arrival.from) return;
    const mailbox = await this.deps.mailboxes.getByAddress(arrival.address);
    if (!mailbox) return;
    const records = await this.deps.store.targets(mailbox.userId);
    for (const record of records) {
      if (record.seed.fit !== 'fit') continue;
      const email = targetEmail(record);
      if (!addressMatches(email, arrival.from) && !addressMatches(email, arrival.answerTo)) continue;
      const touches = await this.deps.store.touches(mailbox.userId, record.id);
      if (touches.some((touch) => touch.kind === 'reply' && touch.mailId === arrival.id)) continue;
      await this.touch(mailbox.userId, record.id, {
        kind: 'reply', mailId: arrival.id, from: arrival.from, subject: arrival.subject.slice(0, 200),
        ...(opts.suspicious ? { suspicious: true } : {}), at: arrival.receivedAt,
      });
      if (!opts.suspicious) await this.settle(mailbox.userId, record, arrival.receivedAt);
    }
  }

  /**
   * A private copy's report (note #1057) arrived, or was already held at
   * import. A company whose address or domain is the copy's contact or the
   * copy's own domain is Installed, once per copy.
   */
  async notePulse(pulse: CopyPulse, onlyUserId?: string): Promise<void> {
    const records = onlyUserId ? await this.deps.store.targets(onlyUserId) : await this.deps.store.allTargets();
    for (const record of records) {
      if (record.seed.fit !== 'fit') continue;
      const email = targetEmail(record);
      if (!addressMatches(email, pulse.contactEmail) && !hostMatches(email, pulse.domain)) continue;
      const touches = await this.deps.store.touches(record.userId, record.id);
      if (touches.some((touch) => touch.kind === 'installed' && touch.copyId === pulse.copyId)) continue;
      await this.touch(record.userId, record.id, { kind: 'installed', copyId: pulse.copyId, domain: pulse.domain, contact: pulse.contactEmail });
      await this.settle(record.userId, record);
    }
  }
}

export function stepWords(step: OutreachStep): string {
  return step === 'first' ? 'first letter' : step === 'day4' ? 'day-4 follow-up' : 'day-11 follow-up';
}
