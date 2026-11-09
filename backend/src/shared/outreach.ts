/**
 * Outreach (note #1089): the owner's own screen for cold outreach — every
 * target company as a profile, every touch on a timeline, and a Send button
 * that mails as the owner from his address here. Shared by the backend and
 * the Workspace so the two never count words, read a seed or decide what is
 * due differently.
 *
 * What it deliberately is NOT: nothing here sends by itself. A follow-up is
 * DUE on day 4 and day 11, and the screen says so; the owner presses. There
 * is no timer that sends, no tracking pixel and no link rewriting — a letter
 * leaves as the plain words in the box.
 *
 * The words a prospect reads live on note #799 and arrive here only through
 * an import of the seed file made from it (`parseOutreachSeed`). Nothing on
 * this side writes a sentence for a prospect: a template's placeholders are
 * left showing until the owner fills them, and a letter that still carries
 * one is refused.
 */

export const OUTREACH_STATES = ['not-contacted', 'sent', 'replied', 'not-now', 'trying', 'installed'] as const;
export type OutreachState = (typeof OUTREACH_STATES)[number];

export const OUTREACH_STATE_WORDS: Record<OutreachState, string> = {
  'not-contacted': 'Not contacted',
  sent: 'Sent',
  replied: 'Replied',
  'not-now': 'Not now',
  trying: 'Trying it',
  installed: 'Installed',
};

/** The three letters of a sequence, in order (note #799): the first, then a reply in its thread on day 4 and day 11. */
export const OUTREACH_STEPS = ['first', 'day4', 'day11'] as const;
export type OutreachStep = (typeof OUTREACH_STEPS)[number];
export const FOLLOW_UP_DAYS: Record<Exclude<OutreachStep, 'first'>, number> = { day4: 4, day11: 11 };

/** Note #799 / #788: after about fifteen first sends, look at what is working before sending more. */
export const OUTREACH_REVIEW_AFTER = 15;
/** Note #799's ceiling for a first email, subject line and signature included. */
export const OUTREACH_MAX_WORDS = 120;

/**
 * Words, the way note #799 counts them: the subject line and the body
 * (signature included), split on white space — and a link's `#anchor`
 * counts as a word of its own, so `agenticcloudcomputer.com/#your-agent` is
 * two. That one rule is what makes every count on the note come out exactly
 * (all ten first emails and both follow-ups).
 */
export function outreachWordCount(subject: string, body: string): number {
  return `${subject ?? ''}\n${body ?? ''}`.split(/\s+|\/#/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/** The template's `{first name}` and `{their line}`, or any other `{…}` left in a letter. */
export function outreachPlaceholders(text: string): string[] {
  return [...new Set((text ?? '').match(/\{[^{}\n]{1,40}\}/g) ?? [])];
}

/**
 * Where a city is, for "their time now". Only places whose clock is not a
 * guess: a city, or a country with one time zone. "US" and "US remote" have
 * none — the screen shows no time there and lets the owner set the city.
 */
const ZONES: Record<string, string> = {
  'san francisco': 'America/Los_Angeles',
  'los angeles': 'America/Los_Angeles',
  seattle: 'America/Los_Angeles',
  portland: 'America/Los_Angeles',
  denver: 'America/Denver',
  austin: 'America/Chicago',
  chicago: 'America/Chicago',
  'new york': 'America/New_York',
  boston: 'America/New_York',
  'washington dc': 'America/New_York',
  'washington, dc': 'America/New_York',
  miami: 'America/New_York',
  toronto: 'America/Toronto',
  vancouver: 'America/Vancouver',
  london: 'Europe/London',
  dublin: 'Europe/Dublin',
  amsterdam: 'Europe/Amsterdam',
  berlin: 'Europe/Berlin',
  paris: 'Europe/Paris',
  stockholm: 'Europe/Stockholm',
  copenhagen: 'Europe/Copenhagen',
  helsinki: 'Europe/Helsinki',
  zurich: 'Europe/Zurich',
  lisbon: 'Europe/Lisbon',
  greece: 'Europe/Athens',
  athens: 'Europe/Athens',
  cyprus: 'Asia/Nicosia',
  'tel aviv': 'Asia/Jerusalem',
  singapore: 'Asia/Singapore',
  sydney: 'Australia/Sydney',
  melbourne: 'Australia/Melbourne',
  tokyo: 'Asia/Tokyo',
};

/** The places the city field suggests, as written. */
export const OUTREACH_KNOWN_PLACES = [
  'San Francisco', 'Los Angeles', 'Seattle', 'Portland', 'Denver', 'Austin', 'Chicago', 'New York', 'Boston',
  'Washington DC', 'Miami', 'Toronto', 'Vancouver', 'London', 'Dublin', 'Amsterdam', 'Berlin', 'Paris', 'Stockholm',
  'Copenhagen', 'Helsinki', 'Zurich', 'Lisbon', 'Athens', 'Greece', 'Cyprus', 'Tel Aviv', 'Singapore', 'Sydney',
  'Melbourne', 'Tokyo',
];

export function outreachZone(city: string | null | undefined): string | null {
  const key = (city ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return key ? ZONES[key] ?? null : null;
}

/** "Mon 09:14" in that zone, or null where none is known. */
export function outreachLocalTime(city: string | null | undefined, at: Date): string | null {
  const zone = outreachZone(city);
  if (!zone) return null;
  return new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
}

/** Mail services where a domain says nothing about a company: matched by the whole address only. */
const SHARED_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com', 'me.com',
  'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'hey.com', 'fastmail.com', 'gmx.com', 'gmx.de', 'mail.com',
  'yandex.com', 'zoho.com', 'agenticcloudcomputer.com',
]);

export function addressDomain(address: string | null | undefined): string | null {
  const at = (address ?? '').trim().toLowerCase().lastIndexOf('@');
  if (at < 1) return null;
  const domain = (address ?? '').trim().toLowerCase().slice(at + 1);
  return domain.includes('.') ? domain : null;
}

/** The domain a target is matched on, or null when its address is at a shared mail service. */
export function companyDomain(address: string | null | undefined): string | null {
  const domain = addressDomain(address);
  return domain && !SHARED_MAIL_DOMAINS.has(domain) ? domain : null;
}

/** Is `candidate` (an address) the target's address, or at its company's domain? */
export function addressMatches(target: string | null | undefined, candidate: string | null | undefined): boolean {
  const want = (target ?? '').trim().toLowerCase();
  const got = (candidate ?? '').trim().toLowerCase();
  if (!want || !got) return false;
  if (want === got) return true;
  const domain = companyDomain(want);
  return Boolean(domain) && addressDomain(got) === domain;
}

/** Is a host (a copy's domain) the company's domain or under it? */
export function hostMatches(target: string | null | undefined, host: string | null | undefined): boolean {
  const domain = companyDomain(target);
  const got = (host ?? '').trim().toLowerCase();
  return Boolean(domain && got) && (got === domain || got.endsWith(`.${domain}`));
}

// ---------------------------------------------------------------------------
// The seed: Rowan's file made from note #799 (outreach-targets.json).

export interface OutreachLetter {
  to: string | null;
  recipient: string | null;
  wherePrinted: string | null;
  note: string | null;
  subject: string;
  body: string;
  wordCount: number | null;
}

/** One company as note #799 has it. Every field is the note's, never ours. */
export interface OutreachSeedTarget {
  number: number | null;
  company: string;
  city: string | null;
  size: string | null;
  group: string | null;
  fit: 'fit' | 'not a fit';
  notAFitReason: string | null;
  newOn2Nov: boolean;
  firstBatchOrder: number | null;
  whyOwnCloud: string | null;
  agentSignal: string | null;
  agentSignalSource: string | null;
  person: string | null;
  email: string | null;
  emailWhose: string | null;
  emailWherePrinted: string | null;
  notThisAddress: string | null;
  verification: string | null;
  checkedOn: string | null;
  firstEmail: OutreachLetter | null;
}

export interface OutreachWords {
  /** Where the words came from, as the seed says it. */
  source: string;
  generatedBy: string | null;
  generatedAt: string | null;
  template: { subject: string; body: string };
  followUps: Record<'day4' | 'day11', { text: string; wordCount: number | null }>;
}

export interface OutreachSeed extends OutreachWords {
  targets: OutreachSeedTarget[];
}

const MAX_TARGETS = 500;
const MAX_TEXT = 4000;

/** A stable id for a company across imports: its name, folded. */
export function outreachTargetId(company: string): string {
  return company.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'company';
}

/** Read the seed file, strictly: anything not of its shape is refused with what was wrong. */
export function parseOutreachSeed(json: unknown): { ok: true; seed: OutreachSeed } | { ok: false; error: string } {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, error: 'The file is not a JSON object.' };
  const doc = json as Record<string, unknown>;
  const text = (value: unknown, max = MAX_TEXT): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : null;
  };
  const words = (value: unknown, max = MAX_TEXT): string | null => (typeof value === 'string' && value.trim() ? value.replace(/\r\n/g, '\n').slice(0, max) : null);
  const count = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

  const template = doc.template as Record<string, unknown> | undefined;
  const templateSubject = text(template?.subject, 200);
  const templateBody = words(template?.body);
  if (!templateSubject || !templateBody) return { ok: false, error: 'template.subject and template.body are missing.' };
  const followUps = doc.followUps as Record<string, Record<string, unknown>> | undefined;
  const day4 = words(followUps?.day4?.text);
  const day11 = words(followUps?.day11?.text);
  if (!day4 || !day11) return { ok: false, error: 'followUps.day4.text and followUps.day11.text are missing.' };
  if (!Array.isArray(doc.targets) || doc.targets.length === 0) return { ok: false, error: 'targets is missing or empty.' };
  if (doc.targets.length > MAX_TARGETS) return { ok: false, error: `At most ${MAX_TARGETS} targets.` };

  const targets: OutreachSeedTarget[] = [];
  const seen = new Set<string>();
  for (const [at, raw] of doc.targets.entries()) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: `targets[${at}] is not an object.` };
    const row = raw as Record<string, unknown>;
    const company = text(row.company, 120);
    if (!company) return { ok: false, error: `targets[${at}] has no company.` };
    const id = outreachTargetId(company);
    if (seen.has(id)) return { ok: false, error: `${company} appears twice.` };
    seen.add(id);
    const fit = row.fit === 'not a fit' ? 'not a fit' : row.fit === 'fit' ? 'fit' : null;
    if (!fit) return { ok: false, error: `${company}: fit is neither "fit" nor "not a fit".` };
    const email = text(row.email, 254);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: `${company}: ${email} is not one address.` };
    let firstEmail: OutreachLetter | null = null;
    if (row.firstEmail && typeof row.firstEmail === 'object') {
      const letter = row.firstEmail as Record<string, unknown>;
      const subject = text(letter.subject, 200);
      const body = words(letter.body);
      if (!subject || !body) return { ok: false, error: `${company}: firstEmail needs a subject and a body.` };
      firstEmail = {
        to: text(letter.to, 254),
        recipient: text(letter.recipient, 200),
        wherePrinted: text(letter.wherePrinted),
        note: text(letter.note),
        subject,
        body,
        wordCount: count(letter.wordCount),
      };
    }
    targets.push({
      number: count(row.number),
      company,
      city: text(row.city, 80),
      size: text(row.size, 120),
      group: text(row.group, 8),
      fit,
      notAFitReason: text(row.notAFitReason),
      newOn2Nov: row.newOn2Nov === true,
      firstBatchOrder: count(row.firstBatchOrder),
      whyOwnCloud: text(row.whyOwnCloud),
      agentSignal: text(row.agentSignal),
      agentSignalSource: text(row.agentSignalSource),
      person: text(row.person, 300),
      email,
      emailWhose: text(row.emailWhose, 300),
      emailWherePrinted: text(row.emailWherePrinted),
      notThisAddress: text(row.notThisAddress),
      verification: text(row.verification, 120),
      checkedOn: text(row.checkedOn, 40),
      firstEmail,
    });
  }
  return {
    ok: true,
    seed: {
      source: text(doc.source, 600) ?? 'note #799',
      generatedBy: text(doc.generatedBy, 200),
      generatedAt: text(doc.generatedAt, 40),
      template: { subject: templateSubject, body: templateBody },
      followUps: {
        day4: { text: day4, wordCount: count(followUps?.day4?.wordCount) },
        day11: { text: day11, wordCount: count(followUps?.day11?.wordCount) },
      },
      targets,
    },
  };
}

// ---------------------------------------------------------------------------
// What is kept, and what the screen is told.

/** What the owner changed on the screen. Absent means the note's own. */
export interface OutreachEdits {
  person?: string;
  email?: string;
  city?: string;
}

export interface OutreachTargetRecord {
  id: string;
  userId: string;
  seed: OutreachSeedTarget;
  edits: OutreachEdits;
  state: OutreachState;
  stateAt: string | null;
  importedAt: string;
  /** False when the latest import no longer had this company: kept, with its touches. */
  inLatestImport: boolean;
}

export type OutreachTouch = {
  id: string;
  targetId: string;
  at: string;
} & (
  | { kind: 'sent'; step: OutreachStep; mailId: string; to: string; subject: string; text: string }
  | { kind: 'reply'; mailId: string; from: string; subject: string; suspicious?: boolean }
  | { kind: 'note'; text: string }
  | { kind: 'state'; from: OutreachState; to: OutreachState }
  | { kind: 'installed'; copyId: string; domain: string; contact: string }
  | { kind: 'edit'; field: keyof OutreachEdits; from: string | null; to: string | null }
);

export type OutreachTouchKind = OutreachTouch['kind'];

/** The owner's own address for a company: what he set, else the note's. */
const edited = (record: Pick<OutreachTargetRecord, 'seed' | 'edits'>, field: keyof OutreachEdits): string | null =>
  (field in record.edits ? record.edits[field] || null : record.seed[field]);
export const targetEmail = (record: Pick<OutreachTargetRecord, 'seed' | 'edits'>): string | null => edited(record, 'email');
export const targetPerson = (record: Pick<OutreachTargetRecord, 'seed' | 'edits'>): string | null => edited(record, 'person');
export const targetCity = (record: Pick<OutreachTargetRecord, 'seed' | 'edits'>): string | null => edited(record, 'city');

/** States the owner may set by hand. Sent, Replied and Installed are what happened. */
export const OUTREACH_HAND_STATES: OutreachState[] = ['not-now', 'trying'];

export interface OutreachNext {
  step: OutreachStep;
  /** When it may go; null for a first letter, which may go now. */
  dueAt: string | null;
  due: boolean;
}

/**
 * What may be sent next, if anything. A first letter while nothing has gone;
 * then day 4, then day 11, each from the first letter's time, and only while
 * the company is still at Sent — a reply, a "not now", a try or an install
 * ends the sequence. After day 11: nothing, as note #799 says ("then stop").
 */
export function outreachNext(record: Pick<OutreachTargetRecord, 'seed' | 'edits' | 'state'>, touches: OutreachTouch[], now: Date): OutreachNext | null {
  if (record.seed.fit !== 'fit') return null;
  const sent = touches.filter((touch): touch is Extract<OutreachTouch, { kind: 'sent' }> => touch.kind === 'sent');
  const first = sent.find((touch) => touch.step === 'first');
  if (!first) {
    if (record.state !== 'not-contacted' || !targetEmail(record)) return null;
    return { step: 'first', dueAt: null, due: true };
  }
  if (record.state !== 'sent') return null;
  for (const step of ['day4', 'day11'] as const) {
    if (sent.some((touch) => touch.step === step)) continue;
    const dueAt = new Date(Date.parse(first.at) + FOLLOW_UP_DAYS[step] * 86_400_000);
    return { step, dueAt: dueAt.toISOString(), due: now.getTime() >= dueAt.getTime() };
  }
  return null;
}

/** One company in the list. */
export interface OutreachRow {
  id: string;
  company: string;
  group: string | null;
  fit: 'fit' | 'not a fit';
  firstBatchOrder: number | null;
  city: string | null;
  person: string | null;
  email: string | null;
  verification: string | null;
  state: OutreachState;
  stateAt: string | null;
  lastTouchAt: string | null;
  next: OutreachNext | null;
  /** True when the note has a ready first email for this company. */
  written: boolean;
  inLatestImport: boolean;
}

export interface OutreachListAnswer {
  imported: { at: string; source: string; generatedBy: string | null; generatedAt: string | null } | null;
  rows: OutreachRow[];
  /** First letters sent so far, for the review reminder. */
  firstSends: number;
  reviewAfter: number;
}

/** The letter the Send box opens with. */
export interface OutreachDraft {
  step: OutreachStep;
  to: string;
  subject: string;
  text: string;
  /** Where the words came from: the company's own email on note #799, the template, or a follow-up. */
  from: 'written' | 'template' | 'follow-up';
  /** Note #799's own count, where it gives one. */
  noteWordCount: number | null;
}

export interface OutreachTargetAnswer {
  row: OutreachRow;
  seed: OutreachSeedTarget;
  edits: OutreachEdits;
  touches: OutreachTouch[];
  draft: OutreachDraft | null;
  /** Why there is no Send, in words, when there is none. */
  noSend: string | null;
}

export interface OutreachImportAnswer {
  added: number;
  updated: number;
  kept: number;
  total: number;
}

export interface OutreachSendAnswer {
  touch: OutreachTouch;
  mailId: string;
}

/** "Re: subject", once. */
export function followUpSubject(subject: string): string {
  const trimmed = (subject ?? '').trim();
  return /^re\s*:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

/** The letter the Send box opens with, from the note's words only. */
export function outreachDraft(record: OutreachTargetRecord, words: OutreachWords, touches: OutreachTouch[], next: OutreachNext | null): OutreachDraft | null {
  const to = targetEmail(record);
  if (!next || !to) return null;
  if (next.step === 'first') {
    const written = record.seed.firstEmail;
    if (written) return { step: 'first', to, subject: written.subject, text: written.body, from: 'written', noteWordCount: written.wordCount };
    return { step: 'first', to, subject: words.template.subject, text: words.template.body, from: 'template', noteWordCount: null };
  }
  const first = touches.find((touch): touch is Extract<OutreachTouch, { kind: 'sent' }> => touch.kind === 'sent' && touch.step === 'first');
  return {
    step: next.step,
    to: first?.to ?? to,
    subject: followUpSubject(first?.subject ?? words.template.subject),
    text: words.followUps[next.step].text,
    from: 'follow-up',
    noteWordCount: words.followUps[next.step].wordCount,
  };
}

/** The list's order: the first batch in the note's order, then the rest by group and number, the dropped last. */
export function sortOutreachRows(rows: OutreachRow[], numbers: Map<string, number | null>): OutreachRow[] {
  const rank = (row: OutreachRow) => (row.fit !== 'fit' ? 3 : row.firstBatchOrder !== null ? 0 : 1);
  return [...rows].sort((a, b) => rank(a) - rank(b)
    || (a.firstBatchOrder ?? 0) - (b.firstBatchOrder ?? 0)
    || (numbers.get(a.id) ?? 9999) - (numbers.get(b.id) ?? 9999)
    || a.company.localeCompare(b.company));
}
