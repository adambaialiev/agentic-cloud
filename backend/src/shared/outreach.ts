/**
 * Outreach (notes #1089, #1093, #1103): the owner's own site for cold
 * outreach — every target company as a profile, every touch on a timeline,
 * and a Send button that mails as the owner from his address here. Shared by
 * the backend and its tests so the two never count words, read a write or
 * decide what is due differently.
 *
 * What it deliberately is NOT: nothing here sends by itself. A follow-up is
 * DUE on day 4 and day 11, and the site says so; the owner presses. There is
 * no timer that sends, no tracking pixel and no link rewriting — a letter
 * leaves as the plain words in the box.
 *
 * Where the words live (note #1103): in the platform's own Outreach tables,
 * and nowhere else. The owner's agents write a company — its facts, its
 * profile, its first letter — and the template and follow-ups straight into
 * them with `agentbuilt outreach set --file <file.json>` (`parseOutreachWrite`
 * reads that file); every write is signed with the agent and the time, and the
 * words it replaced stay on the company's timeline. The site reads the tables
 * live on every open. There is no import, no seed file and no note number.
 * Nothing on this side writes a sentence for a prospect: a template's
 * placeholders are left showing until the owner fills them, and a letter that
 * still carries one is refused.
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
// What an agent writes (note #1103): one company, or a batch with the
// template and the follow-ups, in the shape Rowan's outreach-targets.json
// already has. `seed` keeps its name on the stored record (the rows written
// by the old import carry it), but nothing is seeded any more: it is simply
// what the agents last wrote for that company.

export interface OutreachLetter {
  to: string | null;
  recipient: string | null;
  wherePrinted: string | null;
  note: string | null;
  subject: string;
  body: string;
  wordCount: number | null;
  /** The company's own words the letter opens on, with where they said them. */
  opensOn: OutreachQuote | null;
  /** Whether a stated problem of theirs matches what the workplace removes, as the research says it. */
  painMatch: string | null;
}

export interface OutreachQuote {
  quote: string;
  who: string | null;
  source: string | null;
  date: string | null;
}

/**
 * A company's profile as the agent wrote it, kept WHOLE: the fields below are
 * the ones the site lays out, and any other field the agent adds travels with
 * the record and is shown too — the old import dropped what it did not know,
 * and that is how the profiles went missing.
 */
export interface OutreachProfile {
  builds?: string;
  buildsSource?: string;
  team?: string;
  teamSource?: string;
  agentsAndTools?: string;
  problems?: Array<Partial<OutreachQuote>>;
  workplaceFixes?: string;
  match?: string;
  matchNote?: string;
  people?: Array<{ name?: string; role?: string; address?: string | null; where?: string }>;
  recipientChange?: string | null;
  gaps?: string[];
  researchedOn?: string;
  [field: string]: unknown;
}

/** One company as the agents have it. Every field is theirs, never the site's. */
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
  personRole: string | null;
  email: string | null;
  emailWhose: string | null;
  emailWherePrinted: string | null;
  notThisAddress: string | null;
  verification: string | null;
  checkedOn: string | null;
  firstEmail: OutreachLetter | null;
  profile: OutreachProfile | null;
}

/** Who wrote: the agent's id and its name at the time. */
export interface OutreachWriter {
  agentId: string;
  name: string;
}

/** The words every company shares: the template and the two follow-ups. */
export interface OutreachWords {
  /** Where the words came from, as the writer says it. */
  source: string;
  generatedBy: string | null;
  generatedAt: string | null;
  template: { subject: string; body: string } | null;
  followUps: Record<'day4' | 'day11', { text: string; wordCount: number | null } | null>;
  /** The agent that last changed the template or a follow-up. */
  writtenBy?: OutreachWriter | null;
  /** The words they replaced, newest first, at most OUTREACH_WORDS_HISTORY. */
  previous?: Array<{ at: string; by: OutreachWriter | null; template: OutreachWords['template']; followUps: OutreachWords['followUps'] }>;
}

export const OUTREACH_WORDS_HISTORY = 10;

/** What one `agentbuilt outreach set` carries, read strictly. */
export interface OutreachWrite {
  targets: OutreachSeedTarget[];
  /** Present only when the file carries a template or a follow-up. */
  words: {
    source: string | null;
    generatedBy: string | null;
    generatedAt: string | null;
    template?: { subject: string; body: string };
    followUps?: Partial<Record<'day4' | 'day11', { text: string; wordCount: number | null }>>;
  } | null;
}

const MAX_TARGETS = 500;
const MAX_TEXT = 4000;
const MAX_PROFILE_CHARS = 40_000;

/** A stable id for a company across writes: its name, folded. */
export function outreachTargetId(company: string): string {
  return company.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'company';
}

/**
 * Plain JSON only — words, numbers, yes/no, lists and fields — so a profile
 * is kept as written and can never carry anything the site would run. Null
 * when it is not that, or is far bigger than any profile.
 */
function plainJson(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.replace(/\r\n/g, '\n').slice(0, MAX_TEXT);
  if (depth >= 5) return undefined;
  if (Array.isArray(value)) return value.slice(0, 60).map((item) => plainJson(item, depth + 1)).filter((item) => item !== undefined);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 60)) {
      if (!key || key.length > 60 || key === '__proto__') continue;
      const kept = plainJson(item, depth + 1);
      if (kept !== undefined) out[key] = kept;
    }
    return out;
  }
  return undefined;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const text = (value: unknown, max = MAX_TEXT): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
};
const words = (value: unknown, max = MAX_TEXT): string | null => (typeof value === 'string' && value.trim() ? value.replace(/\r\n/g, '\n').slice(0, max) : null);
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function parseQuote(value: unknown): OutreachQuote | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const quote = value as Record<string, unknown>;
  const said = text(quote.quote);
  return said ? { quote: said, who: text(quote.who, 300), source: text(quote.source, 600), date: text(quote.date, 80) } : null;
}

/** One company, strictly: anything not of its shape is refused with what was wrong. */
function parseTarget(raw: unknown, at: string): Parsed<OutreachSeedTarget> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: `${at} is not an object.` };
  const row = raw as Record<string, unknown>;
  const company = text(row.company, 120);
  if (!company) return { ok: false, error: `${at} has no company.` };
  const fit = row.fit === 'not a fit' ? 'not a fit' : row.fit === 'fit' ? 'fit' : null;
  if (!fit) return { ok: false, error: `${company}: fit is neither "fit" nor "not a fit".` };
  const email = text(row.email, 254);
  if (email && !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email)) return { ok: false, error: `${company}: ${email} is not one address.` };
  let firstEmail: OutreachLetter | null = null;
  if (row.firstEmail !== undefined && row.firstEmail !== null) {
    if (typeof row.firstEmail !== 'object' || Array.isArray(row.firstEmail)) return { ok: false, error: `${company}: firstEmail is not an object.` };
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
      opensOn: parseQuote(letter.opensOn),
      painMatch: text(letter.painMatch, 200),
    };
  }
  let profile: OutreachProfile | null = null;
  if (row.profile !== undefined && row.profile !== null) {
    if (typeof row.profile !== 'object' || Array.isArray(row.profile)) return { ok: false, error: `${company}: profile is not an object.` };
    profile = plainJson(row.profile) as OutreachProfile;
    if (JSON.stringify(profile).length > MAX_PROFILE_CHARS) return { ok: false, error: `${company}: the profile is longer than ${MAX_PROFILE_CHARS.toLocaleString('en-US')} characters.` };
  }
  return {
    ok: true,
    value: {
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
      personRole: text(row.personRole, 300),
      email,
      emailWhose: text(row.emailWhose, 300),
      emailWherePrinted: text(row.emailWherePrinted),
      notThisAddress: text(row.notThisAddress),
      verification: text(row.verification, 120),
      checkedOn: text(row.checkedOn, 40),
      firstEmail,
      profile,
    },
  };
}

/**
 * Read what an agent hands `agentbuilt outreach set`: ONE company (an object
 * with `company`), or a batch — `targets`, and/or `template`, and/or
 * `followUps` — in the shape of outreach-targets.json. Strict: anything not
 * of its shape is refused whole, with what was wrong, and nothing is written.
 */
export function parseOutreachWrite(json: unknown): { ok: true; write: OutreachWrite } | { ok: false; error: string } {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, error: 'The file is not a JSON object.' };
  const doc = json as Record<string, unknown>;
  if (typeof doc.company === 'string') {
    const one = parseTarget(doc, 'The company');
    return one.ok ? { ok: true, write: { targets: [one.value], words: null } } : one;
  }
  const targets: OutreachSeedTarget[] = [];
  if (doc.targets !== undefined) {
    if (!Array.isArray(doc.targets) || doc.targets.length === 0) return { ok: false, error: 'targets is not a list of companies.' };
    if (doc.targets.length > MAX_TARGETS) return { ok: false, error: `At most ${MAX_TARGETS} companies at once.` };
    const seen = new Set<string>();
    for (const [at, raw] of doc.targets.entries()) {
      const one = parseTarget(raw, `targets[${at}]`);
      if (!one.ok) return one;
      const id = outreachTargetId(one.value.company);
      if (seen.has(id)) return { ok: false, error: `${one.value.company} appears twice.` };
      seen.add(id);
      targets.push(one.value);
    }
  }
  let template: { subject: string; body: string } | undefined;
  if (doc.template !== undefined) {
    const raw = doc.template as Record<string, unknown> | null;
    const subject = text(raw?.subject, 200);
    const body = words(raw?.body);
    if (!subject || !body) return { ok: false, error: 'template needs a subject and a body.' };
    template = { subject, body };
  }
  let followUps: Partial<Record<'day4' | 'day11', { text: string; wordCount: number | null }>> | undefined;
  if (doc.followUps !== undefined) {
    const raw = doc.followUps as Record<string, Record<string, unknown> | undefined> | null;
    followUps = {};
    for (const step of ['day4', 'day11'] as const) {
      if (raw?.[step] === undefined) continue;
      const said = words(raw[step]?.text);
      if (!said) return { ok: false, error: `followUps.${step}.text is missing.` };
      followUps[step] = { text: said, wordCount: count(raw[step]?.wordCount) };
    }
    if (!followUps.day4 && !followUps.day11) return { ok: false, error: 'followUps has neither day4 nor day11.' };
  }
  if (!targets.length && !template && !followUps) {
    return { ok: false, error: 'Nothing to write: give one company (an object with "company"), or "targets", "template" or "followUps".' };
  }
  return {
    ok: true,
    write: {
      targets,
      words: template || followUps
        ? { source: text(doc.source, 600), generatedBy: text(doc.generatedBy, 200), generatedAt: text(doc.generatedAt, 40), ...(template ? { template } : {}), ...(followUps ? { followUps } : {}) }
        : null,
    },
  };
}

// ---------------------------------------------------------------------------
// What is kept, and what the site is told.

/** What the owner changed on the site. Absent means the agents' own. */
export interface OutreachEdits {
  person?: string;
  email?: string;
  city?: string;
}

/**
 * The owner's own first letter (note #1103): saved as he edits it on the
 * site, and from then on what the Send box opens with. `basedOn` is the
 * agents' letter he last saw; when an agent writes a different one after it,
 * the site shows that draft BESIDE his and he picks — it never replaces his.
 */
export interface OutreachOwnLetter {
  subject: string;
  body: string;
  at: string;
  basedOn: { subject: string; body: string } | null;
}

export interface OutreachTargetRecord {
  id: string;
  userId: string;
  /** What the agents last wrote for this company (see OutreachSeedTarget). */
  seed: OutreachSeedTarget;
  edits: OutreachEdits;
  state: OutreachState;
  stateAt: string | null;
  /** When the company first came into the store. */
  addedAt?: string;
  /** The last agent write: who and when. Absent on rows the old import made. */
  written?: { at: string; by: OutreachWriter } | null;
  ownLetter?: OutreachOwnLetter | null;
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
  /** An agent wrote the company: which fields changed, and the whole record it replaced (null when it was new). */
  | { kind: 'written'; by: OutreachWriter; added: boolean; fields: string[]; previous: OutreachSeedTarget | null }
  /**
   * The owner and his own letter: `saved` (his first edit; the words are the
   * agents' he started from), `kept` (he kept his over an agent's newer
   * draft; the words are that draft), `took` (he took the agents' letter; the
   * words are his own, set aside).
   */
  | { kind: 'letter'; action: 'saved' | 'kept' | 'took'; subject: string; body: string; by: string | null }
);

export type OutreachTouchKind = OutreachTouch['kind'];

/** The owner's own address for a company: what he set, else the agents'. */
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

const sameLetter = (a: { subject: string; body: string } | null | undefined, b: { subject: string; body: string } | null | undefined) =>
  Boolean(a && b) && a!.subject.trim() === b!.subject.trim() && a!.body.trim() === b!.body.trim();

/** An agent's first letter written after the owner saved his own: it waits beside his. */
export function outreachNewerDraft(record: Pick<OutreachTargetRecord, 'seed' | 'ownLetter'>): OutreachLetter | null {
  const own = record.ownLetter;
  const agents = record.seed.firstEmail;
  if (!own || !agents) return null;
  if (sameLetter(agents, own) || sameLetter(agents, own.basedOn)) return null;
  return agents;
}

/** One company in the list. */
export interface OutreachRow {
  id: string;
  company: string;
  group: string | null;
  fit: 'fit' | 'not a fit';
  firstBatchOrder: number | null;
  city: string | null;
  /** The city's time zone (IANA), only where the city is one we know; the site shows their time from it. */
  zone: string | null;
  person: string | null;
  email: string | null;
  verification: string | null;
  state: OutreachState;
  stateAt: string | null;
  lastTouchAt: string | null;
  next: OutreachNext | null;
  /** True when an agent has written a first letter for this company. */
  written: boolean;
  /** The last agent write. */
  writtenBy: string | null;
  writtenAt: string | null;
  /** The owner has his own version of the first letter. */
  yours: boolean;
  /** An agent wrote a new first letter after his: it waits beside his for him to pick. */
  newerDraft: boolean;
}

export interface OutreachListAnswer {
  /** The newest agent write anywhere: what the site says the list is "as of". Null before anything is written. */
  lastWrite: { at: string; by: string } | null;
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
  /** Where the words came from: the owner's own version, the letter an agent wrote for this company, the template, or a follow-up. */
  from: 'yours' | 'written' | 'template' | 'follow-up';
  /** The agent that wrote these words, where an agent did. */
  by: string | null;
  /** The writer's own count, where it gives one. */
  noteWordCount: number | null;
  /** An agent's first letter newer than his own, shown beside it for him to pick. */
  newer: { subject: string; text: string; by: string | null; at: string | null; noteWordCount: number | null } | null;
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

/** What `agentbuilt outreach set` did, company by company. */
export interface OutreachWriteAnswer {
  added: string[];
  updated: Array<{ company: string; fields: string[] }>;
  unchanged: string[];
  refused: Array<{ company: string; reason: string }>;
  /** The template and follow-ups: written, unchanged, or not in this write. */
  words: 'written' | 'unchanged' | null;
}

/** What an agent may read back: the words and facts it wrote, the state as a word, never a reply, a note or a sent letter. */
export interface OutreachAgentRow {
  id: string;
  company: string;
  fit: 'fit' | 'not a fit';
  firstBatchOrder: number | null;
  state: OutreachState;
  letter: boolean;
  profile: boolean;
  /** A first letter has gone: its words, its address and its fit are fixed now. */
  firstLetterGone: boolean;
  /** The owner has his own version of the first letter; a new one from an agent waits beside it. */
  ownerEdited: boolean;
  writtenBy: string | null;
  writtenAt: string | null;
}

export interface OutreachAgentTarget extends OutreachAgentRow {
  written: OutreachSeedTarget;
  /** Every agent write, newest first: who, when, which fields. */
  writes: Array<{ at: string; by: string; added: boolean; fields: string[] }>;
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

/** The letter the Send box opens with, from the owner's own words or the agents' — never the site's. */
export function outreachDraft(record: OutreachTargetRecord, words: OutreachWords | null, touches: OutreachTouch[], next: OutreachNext | null): OutreachDraft | null {
  const to = targetEmail(record);
  if (!next || !to) return null;
  const by = record.written?.by.name ?? null;
  if (next.step === 'first') {
    const written = record.seed.firstEmail;
    const own = record.ownLetter;
    if (own) {
      const newer = outreachNewerDraft(record);
      return {
        step: 'first', to, subject: own.subject, text: own.body, from: 'yours', by: null, noteWordCount: null,
        newer: newer ? { subject: newer.subject, text: newer.body, by, at: record.written?.at ?? null, noteWordCount: newer.wordCount } : null,
      };
    }
    if (written) return { step: 'first', to, subject: written.subject, text: written.body, from: 'written', by, noteWordCount: written.wordCount, newer: null };
    if (!words?.template) return null;
    return { step: 'first', to, subject: words.template.subject, text: words.template.body, from: 'template', by: words.writtenBy?.name ?? null, noteWordCount: null, newer: null };
  }
  const followUp = words?.followUps[next.step];
  if (!followUp) return null;
  const first = touches.find((touch): touch is Extract<OutreachTouch, { kind: 'sent' }> => touch.kind === 'sent' && touch.step === 'first');
  return {
    step: next.step,
    to: first?.to ?? to,
    subject: followUpSubject(first?.subject ?? words?.template?.subject ?? ''),
    text: followUp.text,
    from: 'follow-up',
    by: words?.writtenBy?.name ?? null,
    noteWordCount: followUp.wordCount,
    newer: null,
  };
}

/** The list's order: the first batch in its order, then the rest by group and number, the dropped last. */
export function sortOutreachRows<Row extends Pick<OutreachRow, 'id' | 'fit' | 'firstBatchOrder' | 'company'>>(rows: Row[], numbers: Map<string, number | null>): Row[] {
  const rank = (row: Row) => (row.fit !== 'fit' ? 3 : row.firstBatchOrder !== null ? 0 : 1);
  return [...rows].sort((a, b) => rank(a) - rank(b)
    || (a.firstBatchOrder ?? 0) - (b.firstBatchOrder ?? 0)
    || (numbers.get(a.id) ?? 9999) - (numbers.get(b.id) ?? 9999)
    || a.company.localeCompare(b.company));
}
