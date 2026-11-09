import { randomBytes } from 'node:crypto';
import {
  OUTREACH_REVIEW_AFTER, OUTREACH_STATES, addressMatches, hostMatches, outreachDraft, outreachNext, outreachPlaceholders,
  outreachTargetId, sortOutreachRows, targetCity, targetEmail, targetPerson,
  type OutreachEdits, type OutreachImportAnswer, type OutreachListAnswer, type OutreachRow, type OutreachSeed,
  type OutreachState, type OutreachStep, type OutreachTargetAnswer, type OutreachTargetRecord, type OutreachTouch,
} from '../shared/outreach.js';
import type { CopyPulse } from '../shared/copy-pulse.js';
import type { MailArrival } from '../types/mail-arrival.js';
import type { MailOutboxService } from './mail-outbox.js';
import type { MailboxStorage } from './mailbox-storage.js';
import type { OutreachStore } from './outreach-storage.js';

/**
 * Outreach (note #1089), the service behind the owner's screen.
 *
 * Three things move a company along without the owner touching it, and each
 * only RECORDS what already happened — none of them sends anything:
 *   - a letter he sends from the screen moves it to Sent;
 *   - a letter that arrives at his address from the company's address or
 *     domain lands on its timeline and moves Sent (or Not contacted) to
 *     Replied;
 *   - a private copy's daily report whose contact or domain is the
 *     company's moves it to Installed.
 * Everything else — Not now, Trying it — is his hand.
 *
 * Sending goes through the person's own outbox (MailOutboxService), so a
 * letter from here is an ordinary letter of his: it is in Sent, it spends the
 * same allowance as one written in the inbox, and it carries nothing else.
 */
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
  now?: () => Date;
}

/** A touch as its maker gives it: the store adds which company, its id and its time. */
type TouchBody = OutreachTouch extends infer T ? T extends OutreachTouch ? Omit<T, 'id' | 'at' | 'targetId'> : never : never;

const MAX_NOTE = 4000;
const MAX_FIELD = 300;

let sequence = 0;
const touchId = (at: Date) => `ot_${at.getTime().toString(36).padStart(9, '0')}${(sequence++ % 1296).toString(36).padStart(2, '0')}${randomBytes(4).toString('hex')}`;

export class OutreachService {
  private readonly now: () => Date;
  /** One letter at a time per company: a double press is refused, not sent twice. */
  private readonly sending = new Set<string>();

  constructor(private readonly deps: OutreachServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private row(record: OutreachTargetRecord, touches: OutreachTouch[], now: Date): OutreachRow {
    return {
      id: record.id,
      company: record.seed.company,
      group: record.seed.group,
      fit: record.seed.fit,
      firstBatchOrder: record.seed.firstBatchOrder,
      city: targetCity(record),
      person: targetPerson(record),
      email: targetEmail(record),
      verification: record.seed.verification,
      state: record.state,
      stateAt: record.stateAt,
      lastTouchAt: touches[0]?.at ?? null,
      next: outreachNext(record, touches, now),
      written: Boolean(record.seed.firstEmail),
      inLatestImport: record.inLatestImport,
    };
  }

  async list(userId: string): Promise<OutreachListAnswer> {
    const now = this.now();
    const [kept, records, touches] = await Promise.all([this.deps.store.words(userId), this.deps.store.targets(userId), this.deps.store.touches(userId)]);
    const byTarget = new Map<string, OutreachTouch[]>();
    for (const touch of touches) byTarget.set(touch.targetId, [...(byTarget.get(touch.targetId) ?? []), touch]);
    const rows = records.map((record) => this.row(record, byTarget.get(record.id) ?? [], now));
    return {
      imported: kept ? { at: kept.importedAt, source: kept.words.source, generatedBy: kept.words.generatedBy, generatedAt: kept.words.generatedAt } : null,
      rows: sortOutreachRows(rows, new Map(records.map((record) => [record.id, record.seed.number]))),
      firstSends: touches.filter((touch) => touch.kind === 'sent' && touch.step === 'first').length,
      reviewAfter: OUTREACH_REVIEW_AFTER,
    };
  }

  async detail(userId: string, targetId: string): Promise<OutreachTargetAnswer | null> {
    const record = await this.deps.store.target(userId, targetId);
    if (!record) return null;
    const [kept, touches] = await Promise.all([this.deps.store.words(userId), this.deps.store.touches(userId, targetId)]);
    const row = this.row(record, touches, this.now());
    const draft = kept ? outreachDraft(record, kept.words, touches, row.next) : null;
    return { row, seed: record.seed, edits: record.edits, touches, draft, noSend: draft ? null : this.noSend(record, row) };
  }

  /** Why the profile has no Send, said plainly. */
  private noSend(record: OutreachTargetRecord, row: OutreachRow): string {
    if (record.seed.fit !== 'fit') return `Not a fit${record.seed.notAFitReason ? `: ${record.seed.notAFitReason}` : ''}. Kept so it is not added again.`;
    if (!targetEmail(record)) return 'Note #799 has no address for this company. Add one above to write.';
    if (record.state === 'not-now') return 'They said not now. That ends it.';
    if (record.state === 'replied') return 'They replied. Answer from your inbox.';
    if (record.state === 'trying') return 'They are trying it.';
    if (record.state === 'installed') return 'They installed it.';
    if (record.state === 'sent' && !row.next) return 'The first letter and both follow-ups have gone. Note #799 says: then stop.';
    return 'Nothing to send.';
  }

  /**
   * Bring the words and the companies in from the seed file. A company is the
   * same company across imports (its id is its name), so a re-import updates
   * what note #799 says — the facts and the ready letter — and leaves the
   * owner's edits, the state and every touch alone. A company the new file no
   * longer has is kept, marked, never deleted with its history.
   */
  async import(userId: string, seed: OutreachSeed): Promise<OutreachImportAnswer> {
    const at = this.now().toISOString();
    const existing = new Map((await this.deps.store.targets(userId)).map((record) => [record.id, record]));
    let added = 0;
    let updated = 0;
    const present = new Set<string>();
    for (const target of seed.targets) {
      const id = outreachTargetId(target.company);
      present.add(id);
      const before = existing.get(id);
      if (before) updated += 1;
      else added += 1;
      await this.deps.store.putTarget({
        id,
        userId,
        seed: target,
        edits: before?.edits ?? {},
        state: before?.state ?? 'not-contacted',
        stateAt: before?.stateAt ?? null,
        importedAt: at,
        inLatestImport: true,
      });
    }
    let kept = 0;
    for (const [id, record] of existing) {
      if (present.has(id)) continue;
      kept += 1;
      if (record.inLatestImport) await this.deps.store.putTarget({ ...record, inLatestImport: false });
    }
    const { targets: _targets, ...words } = seed;
    await this.deps.store.setWords(userId, at, words);
    // A company that already runs its own copy is Installed from the start.
    if (this.deps.pulses) {
      for (const pulse of await this.deps.pulses().catch(() => [] as CopyPulse[])) await this.notePulse(pulse, userId);
    }
    return { added, updated, kept, total: seed.targets.length + kept };
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

  /** The owner sets a state by hand: Not now and Trying it above all, and any correction. */
  async setState(userId: string, targetId: string, raw: unknown): Promise<OutreachTargetRecord> {
    const state = String(raw ?? '') as OutreachState;
    if (!OUTREACH_STATES.includes(state)) throw new OutreachError(400, 'That is not a state.');
    const record = await this.mine(userId, targetId);
    if (record.seed.fit !== 'fit') throw new OutreachError(409, 'This company is not a fit; it has no state to change.');
    const touches = await this.deps.store.touches(userId, targetId);
    const wrote = touches.some((touch) => touch.kind === 'sent');
    if (state === 'not-contacted' && wrote) throw new OutreachError(409, 'A letter has gone: it cannot be Not contacted again.');
    if (state === 'sent' && !wrote) throw new OutreachError(409, 'Nothing has been sent yet. Send the first letter from here.');
    return this.move(userId, record, state);
  }

  private async move(userId: string, record: OutreachTargetRecord, state: OutreachState, at?: string): Promise<OutreachTargetRecord> {
    if (record.state === state) return record;
    const stamp = at ?? this.now().toISOString();
    const next = { ...record, state, stateAt: stamp };
    await this.deps.store.putTarget(next);
    await this.touch(userId, record.id, { kind: 'state', from: record.state, to: state, at: stamp });
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
        mail = await outbox.send({ userId, to: targetEmail(record), subject, text, ...(senderName ? { senderName } : {}) });
      } else {
        // In the thread: under the latest letter of ours to them.
        const last = touches.find((touch): touch is Extract<OutreachTouch, { kind: 'sent' }> => touch.kind === 'sent');
        mail = await outbox.followUp({ userId, messageId: last!.mailId, text, ...(senderName ? { senderName } : {}) });
      }
      const touch = await this.touch(userId, targetId, {
        kind: 'sent', step, mailId: mail.id, to: mail.to?.[0]?.address ?? targetEmail(record) ?? '', subject: mail.subject, text: mail.wrote ?? text,
        at: mail.receivedAt,
      });
      if (step === 'first') await this.move(userId, record, 'sent', mail.receivedAt);
      return { touch, mailId: mail.id };
    } finally {
      this.sending.delete(key);
    }
  }

  /**
   * A letter arrived at somebody's address. If it is the Outreach owner's and
   * it came from a company's address or domain, it goes on that company's
   * timeline, and a company at Sent (or never written to) moves to Replied.
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
      if (!opts.suspicious && (record.state === 'sent' || record.state === 'not-contacted')) {
        await this.move(mailbox.userId, record, 'replied', arrival.receivedAt);
      }
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
      await this.move(record.userId, record, 'installed');
    }
  }
}

export function stepWords(step: OutreachStep): string {
  return step === 'first' ? 'first letter' : step === 'day4' ? 'day-4 follow-up' : 'day-11 follow-up';
}
