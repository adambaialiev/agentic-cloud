/**
 * Outreach (notes #1089, #1093, #1103): the owner's own site for cold
 * outreach — every target company as a profile, every touch on a timeline,
 * and a Send button that mails as the owner from his address here. Shared by
 * the backend and its tests so the two never count words, read a write or
 * decide what is due differently.
 *
 * What it deliberately is NOT: nothing here sends by itself. A follow-up is
 * DUE on day 4 and day 11, and the site says so; the owner presses. There is
 * no timer that sends and no link rewriting — a letter leaves as the words in
 * the box. Since note #1112 it leaves with an HTML copy of those same words
 * beside the plain text, so the provider's open pixel has somewhere to go
 * (`outreachMailHtml`); what that pixel can and cannot say is on
 * `OutreachLetterFacts.opened`.
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

/**
 * A company's state is what HAPPENED, never what somebody picked (note #1112;
 * Adam, 9 Nov 2026: "I should not be able to change state manually"). It is
 * read off the timeline by `outreachStateFrom`: Not contacted → Sent → Bounced
 * or Marked as spam (each ends it) → Replied → Installed.
 */
export const OUTREACH_STATES = ['not-contacted', 'sent', 'bounced', 'spam', 'replied', 'installed'] as const;
export type OutreachState = (typeof OUTREACH_STATES)[number];
/**
 * Not now and Trying it were picked by hand until note #1112. Nothing sets
 * them any more; a stored record or an old timeline entry may still name one,
 * and the site shows that as history.
 */
export type OutreachPastState = OutreachState | 'not-now' | 'trying';

export const OUTREACH_STATE_WORDS: Record<OutreachPastState, string> = {
  'not-contacted': 'Not contacted',
  sent: 'Sent',
  bounced: 'Bounced',
  spam: 'Marked as spam',
  replied: 'Replied',
  installed: 'Installed',
  'not-now': 'Not now',
  trying: 'Trying it',
};

/** The three letters of a sequence, in order (note #799): the first, then a reply in its thread on day 4 and day 11. */
export const OUTREACH_STEPS = ['first', 'day4', 'day11'] as const;
export type OutreachStep = (typeof OUTREACH_STEPS)[number];
export const FOLLOW_UP_DAYS: Record<Exclude<OutreachStep, 'first'>, number> = { day4: 4, day11: 11 };

/** Note #799 / #788: after about fifteen first sends, look at what is working before sending more. */
export const OUTREACH_REVIEW_AFTER = 15;
/**
 * The ceiling for a first letter, subject line and signature included, counted
 * as written (a {placeholder} is two words, the link it becomes one). 120 from
 * note #799; 200 since Adam's word of 10 Nov 2026 (note #1128). The store
 * refuses a longer first letter and Send refuses to post one.
 */
export const OUTREACH_MAX_WORDS = 200;

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
  // The rest of North America (Adam, 10 Nov 2026: San Antonio showed no time). Richmond stays out: Virginia, California and BC all have one.
  'san antonio': 'America/Chicago',
  dallas: 'America/Chicago',
  houston: 'America/Chicago',
  'fort worth': 'America/Chicago',
  minneapolis: 'America/Chicago',
  'st. louis': 'America/Chicago',
  'saint louis': 'America/Chicago',
  'kansas city': 'America/Chicago',
  nashville: 'America/Chicago',
  'new orleans': 'America/Chicago',
  milwaukee: 'America/Chicago',
  madison: 'America/Chicago',
  'oklahoma city': 'America/Chicago',
  memphis: 'America/Chicago',
  omaha: 'America/Chicago',
  atlanta: 'America/New_York',
  philadelphia: 'America/New_York',
  pittsburgh: 'America/New_York',
  raleigh: 'America/New_York',
  durham: 'America/New_York',
  charlotte: 'America/New_York',
  baltimore: 'America/New_York',
  cleveland: 'America/New_York',
  columbus: 'America/New_York',
  cincinnati: 'America/New_York',
  orlando: 'America/New_York',
  tampa: 'America/New_York',
  jacksonville: 'America/New_York',
  brooklyn: 'America/New_York',
  'jersey city': 'America/New_York',
  newark: 'America/New_York',
  providence: 'America/New_York',
  'new haven': 'America/New_York',
  princeton: 'America/New_York',
  'washington d.c.': 'America/New_York',
  'washington, d.c.': 'America/New_York',
  detroit: 'America/Detroit',
  'ann arbor': 'America/Detroit',
  indianapolis: 'America/Indiana/Indianapolis',
  louisville: 'America/Kentucky/Louisville',
  'salt lake city': 'America/Denver',
  boulder: 'America/Denver',
  albuquerque: 'America/Denver',
  'colorado springs': 'America/Denver',
  phoenix: 'America/Phoenix',
  scottsdale: 'America/Phoenix',
  tempe: 'America/Phoenix',
  tucson: 'America/Phoenix',
  'san diego': 'America/Los_Angeles',
  'san jose': 'America/Los_Angeles',
  oakland: 'America/Los_Angeles',
  berkeley: 'America/Los_Angeles',
  'palo alto': 'America/Los_Angeles',
  'mountain view': 'America/Los_Angeles',
  'menlo park': 'America/Los_Angeles',
  sunnyvale: 'America/Los_Angeles',
  'santa monica': 'America/Los_Angeles',
  irvine: 'America/Los_Angeles',
  sacramento: 'America/Los_Angeles',
  'santa barbara': 'America/Los_Angeles',
  'las vegas': 'America/Los_Angeles',
  'redwood city': 'America/Los_Angeles',
  honolulu: 'Pacific/Honolulu',
  anchorage: 'America/Anchorage',
  montreal: 'America/Toronto',
  ottawa: 'America/Toronto',
  'quebec city': 'America/Toronto',
  waterloo: 'America/Toronto',
  kitchener: 'America/Toronto',
  calgary: 'America/Edmonton',
  edmonton: 'America/Edmonton',
  winnipeg: 'America/Winnipeg',
  halifax: 'America/Halifax',
  'mexico city': 'America/Mexico_City',
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
  // Europe, for sending in the owner's own daytime (note #1113): cities, and countries with one clock.
  manchester: 'Europe/London',
  edinburgh: 'Europe/London',
  glasgow: 'Europe/London',
  bristol: 'Europe/London',
  cambridge: 'Europe/London',
  oxford: 'Europe/London',
  leeds: 'Europe/London',
  birmingham: 'Europe/London',
  belfast: 'Europe/London',
  brighton: 'Europe/London',
  'united kingdom': 'Europe/London',
  uk: 'Europe/London',
  england: 'Europe/London',
  scotland: 'Europe/London',
  cork: 'Europe/Dublin',
  galway: 'Europe/Dublin',
  limerick: 'Europe/Dublin',
  ireland: 'Europe/Dublin',
  munich: 'Europe/Berlin',
  hamburg: 'Europe/Berlin',
  frankfurt: 'Europe/Berlin',
  cologne: 'Europe/Berlin',
  stuttgart: 'Europe/Berlin',
  dusseldorf: 'Europe/Berlin',
  leipzig: 'Europe/Berlin',
  dresden: 'Europe/Berlin',
  karlsruhe: 'Europe/Berlin',
  nuremberg: 'Europe/Berlin',
  heidelberg: 'Europe/Berlin',
  potsdam: 'Europe/Berlin',
  germany: 'Europe/Berlin',
  vienna: 'Europe/Vienna',
  graz: 'Europe/Vienna',
  linz: 'Europe/Vienna',
  salzburg: 'Europe/Vienna',
  austria: 'Europe/Vienna',
  geneva: 'Europe/Zurich',
  basel: 'Europe/Zurich',
  bern: 'Europe/Zurich',
  lausanne: 'Europe/Zurich',
  zug: 'Europe/Zurich',
  lugano: 'Europe/Zurich',
  switzerland: 'Europe/Zurich',
  lyon: 'Europe/Paris',
  carpentras: 'Europe/Paris',
  marseille: 'Europe/Paris',
  toulouse: 'Europe/Paris',
  nantes: 'Europe/Paris',
  angers: 'Europe/Paris',
  bordeaux: 'Europe/Paris',
  lille: 'Europe/Paris',
  grenoble: 'Europe/Paris',
  nice: 'Europe/Paris',
  montpellier: 'Europe/Paris',
  rennes: 'Europe/Paris',
  strasbourg: 'Europe/Paris',
  france: 'Europe/Paris',
  brussels: 'Europe/Brussels',
  antwerp: 'Europe/Brussels',
  ghent: 'Europe/Brussels',
  leuven: 'Europe/Brussels',
  liege: 'Europe/Brussels',
  belgium: 'Europe/Brussels',
  rotterdam: 'Europe/Amsterdam',
  utrecht: 'Europe/Amsterdam',
  'the hague': 'Europe/Amsterdam',
  eindhoven: 'Europe/Amsterdam',
  delft: 'Europe/Amsterdam',
  groningen: 'Europe/Amsterdam',
  netherlands: 'Europe/Amsterdam',
  luxembourg: 'Europe/Luxembourg',
  madrid: 'Europe/Madrid',
  barcelona: 'Europe/Madrid',
  valencia: 'Europe/Madrid',
  seville: 'Europe/Madrid',
  malaga: 'Europe/Madrid',
  bilbao: 'Europe/Madrid',
  zaragoza: 'Europe/Madrid',
  porto: 'Europe/Lisbon',
  braga: 'Europe/Lisbon',
  coimbra: 'Europe/Lisbon',
  milan: 'Europe/Rome',
  forli: 'Europe/Rome',
  rome: 'Europe/Rome',
  turin: 'Europe/Rome',
  bologna: 'Europe/Rome',
  florence: 'Europe/Rome',
  naples: 'Europe/Rome',
  italy: 'Europe/Rome',
  gothenburg: 'Europe/Stockholm',
  malmo: 'Europe/Stockholm',
  uppsala: 'Europe/Stockholm',
  lund: 'Europe/Stockholm',
  sweden: 'Europe/Stockholm',
  oslo: 'Europe/Oslo',
  bergen: 'Europe/Oslo',
  trondheim: 'Europe/Oslo',
  stavanger: 'Europe/Oslo',
  norway: 'Europe/Oslo',
  aarhus: 'Europe/Copenhagen',
  odense: 'Europe/Copenhagen',
  espoo: 'Europe/Helsinki',
  tampere: 'Europe/Helsinki',
  oulu: 'Europe/Helsinki',
  turku: 'Europe/Helsinki',
  finland: 'Europe/Helsinki',
  reykjavik: 'Atlantic/Reykjavik',
  iceland: 'Atlantic/Reykjavik',
  tallinn: 'Europe/Tallinn',
  tartu: 'Europe/Tallinn',
  estonia: 'Europe/Tallinn',
  riga: 'Europe/Riga',
  latvia: 'Europe/Riga',
  vilnius: 'Europe/Vilnius',
  kaunas: 'Europe/Vilnius',
  lithuania: 'Europe/Vilnius',
  warsaw: 'Europe/Warsaw',
  krakow: 'Europe/Warsaw',
  wroclaw: 'Europe/Warsaw',
  gdansk: 'Europe/Warsaw',
  poznan: 'Europe/Warsaw',
  lodz: 'Europe/Warsaw',
  katowice: 'Europe/Warsaw',
  poland: 'Europe/Warsaw',
  prague: 'Europe/Prague',
  brno: 'Europe/Prague',
  czechia: 'Europe/Prague',
  'czech republic': 'Europe/Prague',
  bratislava: 'Europe/Bratislava',
  kosice: 'Europe/Bratislava',
  slovakia: 'Europe/Bratislava',
  budapest: 'Europe/Budapest',
  hungary: 'Europe/Budapest',
  bucharest: 'Europe/Bucharest',
  'cluj-napoca': 'Europe/Bucharest',
  cluj: 'Europe/Bucharest',
  iasi: 'Europe/Bucharest',
  timisoara: 'Europe/Bucharest',
  romania: 'Europe/Bucharest',
  sofia: 'Europe/Sofia',
  plovdiv: 'Europe/Sofia',
  bulgaria: 'Europe/Sofia',
  ljubljana: 'Europe/Ljubljana',
  slovenia: 'Europe/Ljubljana',
  zagreb: 'Europe/Zagreb',
  split: 'Europe/Zagreb',
  croatia: 'Europe/Zagreb',
  belgrade: 'Europe/Belgrade',
  'novi sad': 'Europe/Belgrade',
  serbia: 'Europe/Belgrade',
  thessaloniki: 'Europe/Athens',
  kyiv: 'Europe/Kiev',
  kiev: 'Europe/Kiev',
  lviv: 'Europe/Kiev',
  kharkiv: 'Europe/Kiev',
  odesa: 'Europe/Kiev',
  dnipro: 'Europe/Kiev',
  istanbul: 'Europe/Istanbul',
  ankara: 'Europe/Istanbul',
  izmir: 'Europe/Istanbul',
  turkiye: 'Europe/Istanbul',
  turkey: 'Europe/Istanbul',
  valletta: 'Europe/Malta',
  malta: 'Europe/Malta',
  nicosia: 'Asia/Nicosia',
  limassol: 'Asia/Nicosia',
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
  'Melbourne', 'Tokyo', 'San Antonio', 'Dallas', 'Houston', 'Atlanta', 'Philadelphia', 'San Diego', 'Phoenix', 'Montreal', 'Munich', 'Hamburg', 'Vienna', 'Oslo', 'Gothenburg', 'Tallinn', 'Riga', 'Vilnius', 'Warsaw', 'Krakow',
  'Prague', 'Budapest', 'Bucharest', 'Sofia', 'Madrid', 'Barcelona', 'Porto', 'Milan', 'Brussels', 'Rotterdam', 'Manchester',
  'Edinburgh', 'Kyiv', 'Istanbul',
];

export function outreachZone(city: string | null | undefined): string | null {
  // ł has no decomposition (Wrocław, Łódź): folded by hand.
  const key = (city ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ł/gi, 'l').trim().toLowerCase().replace(/\s+/g, ' ');
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

/**
 * Who a record is (note #1115; Adam, 10 Nov 2026: "we should also outreach
 * not only customers, but investors also. We should aim for early stage
 * pre-seed round."; then, 07:19 UTC: pitch them the product and "just ask
 * them to try us"). A company to sell to, or an investor (an early-stage
 * fund, an angel, a scout) asked to try the product, themselves and with
 * their founders. A record with no audience is a customer: every record
 * written before note #1115 is one, unchanged.
 */
export const OUTREACH_AUDIENCES = ['customer', 'investor'] as const;
export type OutreachAudience = (typeof OUTREACH_AUDIENCES)[number];

/**
 * An investor's fit, in the words the research uses (note #1115): their
 * public thesis matches (they back developer tools, AI infrastructure or
 * agent tooling at pre-seed), partly, or no public thesis. "No public
 * thesis" is kept so it is not added again, and has no Send, like a
 * customer that is not a fit.
 */
export const OUTREACH_THESIS = ['thesis match', 'partly', 'no public thesis'] as const;
export type OutreachThesis = (typeof OUTREACH_THESIS)[number];

/** A record's audience: absent means customer. */
export const outreachAudience = (seed: Pick<OutreachSeedTarget, 'audience'> | null | undefined): OutreachAudience => (seed?.audience === 'investor' ? 'investor' : 'customer');

/**
 * How well a record matches, as the research wrote it (note #1145): the
 * profile's `match`, else the first letter's `painMatch`. Kept as written
 * ("matches", "matches, but they built their own", "partly", "no sourced
 * pain", "thesis match"); the site turns it into a level. Null where neither
 * is written.
 */
export function outreachMatch(seed: Pick<OutreachSeedTarget, 'profile' | 'firstEmail'>): string | null {
  const said = [seed.profile?.match, seed.firstEmail?.painMatch].find((value) => typeof value === 'string' && value.trim());
  return typeof said === 'string' ? said.trim() : null;
}

/** One company (or investor) as the agents have it. Every field is theirs, never the site's. */
export interface OutreachSeedTarget {
  number: number | null;
  /** The company's name; for an investor, the fund's or the angel's name. */
  company: string;
  city: string | null;
  size: string | null;
  group: string | null;
  /** Present only on an investor (note #1115); absent is a customer. */
  audience?: 'investor';
  /** An investor's fit in its own words; `fit` follows it ("no public thesis" is not a fit). */
  thesis?: OutreachThesis;
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
  /** An investor's portfolio (note #1124): the companies it backs. Present only on an investor that has one. */
  portfolio?: OutreachPortfolioCompany[];
}

/**
 * One company in an investor's portfolio (note #1124; Adam, 10 Nov 2026: "In
 * outreach app let's build graphs of contacts. Let's start from investment
 * funds and go down to their portfolio companies"). Only the name is
 * required. Whether it is also a customer in Outreach is NOT stored: it is
 * matched at read time by name or website (`outreachGraph`), so the link
 * follows the store and is never kept twice.
 */
export interface OutreachPortfolioCompany {
  name: string;
  /** Its own site, as the fund prints it. */
  website: string | null;
  /** One line on what it builds, in the fund's or the company's words. */
  builds: string | null;
  /** Where it was read: the fund's portfolio page. */
  source: string | null;
  /** When it was read. */
  readOn: string | null;
}

export const OUTREACH_MAX_PORTFOLIO = 400;

/** A website as a bare host for matching: "https://www.Example.com/about" → "example.com". */
export function websiteHost(value: string | null | undefined): string | null {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  const host = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0]!.replace(/^www\./, '').replace(/:\d+$/, '').replace(/\.$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
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
  /** The investors' own template and follow-ups (note #1115). */
  investors?: OutreachAudienceWords | null;
}

export const OUTREACH_WORDS_HISTORY = 10;

/**
 * The investors' own template and follow-ups (note #1115), kept beside the
 * customers' in the same outreach_words record. Written by agents the same
 * way (`agentbuilt outreach set` with "audience": "investor"); an investor's
 * letter never falls back to the customers' words.
 */
export interface OutreachAudienceWords {
  source: string;
  generatedBy: string | null;
  generatedAt: string | null;
  template: { subject: string; body: string } | null;
  followUps: OutreachWords['followUps'];
  writtenBy?: OutreachWriter | null;
  writtenAt?: string | null;
  previous?: Array<{ at: string; by: OutreachWriter | null; template: OutreachWords['template']; followUps: OutreachWords['followUps'] }>;
}

/** The words an audience's letters are drawn from: the customers' are the record itself, the investors' its `investors`. */
export function outreachWordsFor(words: OutreachWords | null | undefined, audience: OutreachAudience): Pick<OutreachAudienceWords, 'template' | 'followUps' | 'writtenBy'> | null {
  if (!words) return null;
  if (audience === 'investor') return words.investors ?? null;
  return words;
}

/** What one `agentbuilt outreach set` carries, read strictly. */
export interface OutreachWrite {
  targets: OutreachSeedTarget[];
  /** Present only when the file carries a template or a follow-up. */
  words: {
    /** Whose template and follow-ups these are: the file's "audience", customer when absent. */
    audience: OutreachAudience;
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
/** A file's or a record's "audience": absent is the default, anything but the two words is refused. */
function parseAudience(value: unknown, fallback: OutreachAudience): OutreachAudience | null {
  if (value === undefined || value === null) return fallback;
  return value === 'investor' || value === 'customer' ? value : null;
}

function parseTarget(raw: unknown, at: string, audienceDefault: OutreachAudience = 'customer'): Parsed<OutreachSeedTarget> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: `${at} is not an object.` };
  const row = raw as Record<string, unknown>;
  const company = text(row.company, 120);
  if (!company) return { ok: false, error: `${at} has no company.` };
  const audience = parseAudience(row.audience, audienceDefault);
  if (!audience) return { ok: false, error: `${company}: audience is neither "customer" nor "investor".` };
  let fit: 'fit' | 'not a fit' | null;
  let thesis: OutreachThesis | null = null;
  if (audience === 'investor') {
    thesis = (OUTREACH_THESIS as readonly unknown[]).includes(row.fit) ? row.fit as OutreachThesis : null;
    if (!thesis) return { ok: false, error: `${company}: an investor's fit is "thesis match", "partly" or "no public thesis".` };
    fit = thesis === 'no public thesis' ? 'not a fit' : 'fit';
  } else {
    if ((OUTREACH_THESIS as readonly unknown[]).includes(row.fit)) return { ok: false, error: `${company}: "${String(row.fit)}" is an investor's fit; add "audience": "investor", or use "fit" / "not a fit" for a customer.` };
    fit = row.fit === 'not a fit' ? 'not a fit' : row.fit === 'fit' ? 'fit' : null;
  }
  if (!fit) return { ok: false, error: `${company}: fit is neither "fit" nor "not a fit".` };
  let portfolio: OutreachPortfolioCompany[] | null = null;
  if (row.portfolio !== undefined && row.portfolio !== null) {
    if (audience !== 'investor') return { ok: false, error: `${company}: only an investor has a portfolio; add "audience": "investor".` };
    const parsed = parsePortfolio(row.portfolio, company);
    if (!parsed.ok) return parsed;
    portfolio = parsed.value;
  }
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
      ...(audience === 'investor' ? { audience: 'investor' as const, thesis: thesis! } : {}),
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
      ...(portfolio ? { portfolio } : {}),
    },
  };
}

/** An investor's portfolio, strictly (note #1124): a list of companies, each with a name. */
function parsePortfolio(value: unknown, company: string): Parsed<OutreachPortfolioCompany[]> {
  if (!Array.isArray(value)) return { ok: false, error: `${company}: portfolio is not a list of companies.` };
  if (value.length > OUTREACH_MAX_PORTFOLIO) return { ok: false, error: `${company}: at most ${OUTREACH_MAX_PORTFOLIO} companies in a portfolio.` };
  const out: OutreachPortfolioCompany[] = [];
  const seen = new Set<string>();
  for (const [at, raw] of value.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: `${company}: portfolio[${at}] is not an object.` };
    const row = raw as Record<string, unknown>;
    const name = text(row.name, 120);
    if (!name) return { ok: false, error: `${company}: portfolio[${at}] has no name.` };
    const key = outreachTargetId(name);
    if (seen.has(key)) return { ok: false, error: `${company}: ${name} is in its portfolio twice.` };
    seen.add(key);
    const website = text(row.website, 300);
    if (website && !websiteHost(website)) return { ok: false, error: `${company}: ${name}'s website "${website}" is not a web address.` };
    out.push({ name, website, builds: text(row.builds, 400), source: text(row.source, 600), readOn: text(row.readOn, 40) });
  }
  return { ok: true, value: out };
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
  // A batch's "audience" (note #1115) is whose template and follow-ups it carries, and its companies' unless one says otherwise.
  const audience = parseAudience(doc.audience, 'customer');
  if (!audience) return { ok: false, error: 'audience is neither "customer" nor "investor".' };
  const targets: OutreachSeedTarget[] = [];
  if (doc.targets !== undefined) {
    if (!Array.isArray(doc.targets) || doc.targets.length === 0) return { ok: false, error: 'targets is not a list of companies.' };
    if (doc.targets.length > MAX_TARGETS) return { ok: false, error: `At most ${MAX_TARGETS} companies at once.` };
    const seen = new Set<string>();
    for (const [at, raw] of doc.targets.entries()) {
      const one = parseTarget(raw, `targets[${at}]`, audience);
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
        ? { audience, source: text(doc.source, 600), generatedBy: text(doc.generatedBy, 200), generatedAt: text(doc.generatedAt, 40), ...(template ? { template } : {}), ...(followUps ? { followUps } : {}) }
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
  /**
   * The state as last settled from the timeline (`outreachStateFrom`). A
   * record written before note #1112 may still hold Not now or Trying it;
   * every read derives the state afresh, so that word is history only.
   */
  state: OutreachPastState;
  stateAt: string | null;
  /** When the company first came into the store. */
  addedAt?: string;
  /** The last agent write: who and when. Absent on rows the old import made. */
  written?: { at: string; by: OutreachWriter } | null;
  ownLetter?: OutreachOwnLetter | null;
  /** The company's two short codes (note #1106): see OutreachLinks. Given at its first read or write. */
  links?: OutreachLinkCodes;
}

/* ── The links in a letter (note #1106) ─────────────────────────────────
   Adam, 9 Nov 2026, 17:48 UTC: the letters "lack a shortened link with utm
   data they lead to our landing page for agents and humans. also we should
   provide link optimized for agent to see all functionality of our
   workplace." Every company has two short codes of its own, on our own
   domain: agenticcloudcomputer.com/go/<code>. One opens the home page, the
   other the page written for agents (/workplace.md); each answers with a
   redirect carrying the same UTM data, and each visit is a touch on that
   company's timeline: when, which link, and whether the reader looked like
   a browser, an agent (a program reading it) or a mail system checking the
   link before anyone opened it. Nothing personal: no address, no IP, only
   the client's own product word ("Chrome", "curl", "Claude-User"). */
export type OutreachLink = 'home' | 'agents' | 'install';
/**
 * A company's codes. `install` (note #1120; Adam, 10 Nov 2026: "I want three
 * links. To the landing page, to workplace.md and to install instructions
 * for agent") came later: a record from before gets it the first time it is
 * read or written, and its other two never change.
 */
export interface OutreachLinkCodes { home: string; agents: string; install?: string }
/**
 * `preview` (note #1148): a chat or social app fetching the link to draw its
 * preview card, which means somebody pasted it into a conversation. It is
 * neither a person opening it nor a mail system's check.
 */
export type OutreachReader = 'browser' | 'agent' | 'check' | 'preview';

/** Where the letters' links live: the public front door, whatever host serves the routes. */
export const OUTREACH_LINK_ORIGIN = 'https://agenticcloudcomputer.com';
export const OUTREACH_LINK_PATH = '/go/';
/** Where each link leads. */
export const OUTREACH_LINK_TARGETS: Record<OutreachLink, string> = { home: '/', agents: '/workplace.md', install: '/own-cloud.md' };
/** The UTM data every link carries; utm_content is the company's id. Kept stable: analytics group by them. */
export const OUTREACH_UTM = { source: 'outreach', medium: 'email', campaign: 'cold-email' } as const;
/** A short code: six letters and digits with no look-alikes (no 0/o, 1/l/i), lower case. */
export const OUTREACH_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const OUTREACH_CODE_LENGTH = 6;
export const isOutreachCode = (code: string): boolean => new RegExp(`^[${OUTREACH_CODE_ALPHABET}]{${OUTREACH_CODE_LENGTH}}$`).test(code);

export interface OutreachLinks { home: string; agents: string; install?: string }
/** The short links of a company, as they go into a letter: home, agents and (note #1120) install. */
export function outreachLinks(codes: OutreachLinkCodes, origin = OUTREACH_LINK_ORIGIN): OutreachLinks {
  return {
    home: `${origin}${OUTREACH_LINK_PATH}${codes.home}`,
    agents: `${origin}${OUTREACH_LINK_PATH}${codes.agents}`,
    ...(codes.install ? { install: `${origin}${OUTREACH_LINK_PATH}${codes.install}` } : {}),
  };
}

/** Where a visit is sent: the link's page with the UTM data. */
export function outreachLinkTarget(link: OutreachLink, targetId: string, origin = OUTREACH_LINK_ORIGIN): string {
  const url = new URL(OUTREACH_LINK_TARGETS[link], origin);
  url.searchParams.set('utm_source', OUTREACH_UTM.source);
  url.searchParams.set('utm_medium', OUTREACH_UTM.medium);
  url.searchParams.set('utm_campaign', OUTREACH_UTM.campaign);
  url.searchParams.set('utm_content', targetId);
  return url.toString();
}

/**
 * Where a short link in a letter really goes (note #1147; Adam, 11 Nov 2026,
 * 09:03 UTC: "I'm worried about them. I want to see extended links in the
 * interface to be sure that the links are correct"). Read from the store the
 * redirect itself reads (OutreachService.checkLinks, the same lookup as
 * visit), never guessed from the text, and checked live: the destination
 * must answer 200 and its utm_content must name the company the letter is
 * for. Reading it records no visit.
 */
export interface OutreachLinkCheck {
  code: string;
  /** Which of the company's links the code is; null for a code no company of the owner's has. */
  link: OutreachLink | null;
  /** The company the code belongs to. */
  targetId: string | null;
  company: string | null;
  /** Where /go/<code> redirects, with its UTM data; null for an unknown code. */
  destination: string | null;
  /** The destination's live answer (after its own redirects), or null when it could not be reached or was not tried. */
  status: number | null;
  /** What is wrong; null when the link is right. */
  problem: 'unknown-code' | 'other-company' | 'not-found' | 'unreachable' | null;
}

/** A short link as it stands in a letter, with or without the scheme. */
export const OUTREACH_SHORT_LINK = /(?:https?:\/\/)?(?:www\.)?agenticcloudcomputer\.com\/go\/([A-Za-z0-9_-]+)/gi;
/** The codes in a letter, each once, in the order they stand. */
export function outreachShortCodes(text: string | null | undefined): string[] {
  return [...new Set([...String(text ?? '').matchAll(OUTREACH_SHORT_LINK)].map((match) => match[1]!.toLowerCase()))];
}
/** At most this many codes are checked in one ask. */
export const OUTREACH_MAX_LINK_CHECKS = 20;

/* A mail system that opens links to check them before the person does: its
   own words in the User-Agent. Microsoft's Safe Links and some others look
   like an ordinary browser; those are counted as a browser, which is why the
   site says "looked like". */
const CHECKERS: Array<[RegExp, string]> = [
  [/proofpoint/i, 'Proofpoint'], [/mimecast/i, 'Mimecast'], [/barracuda/i, 'Barracuda'], [/symantec|broadcom/i, 'Symantec'],
  [/googleimageproxy|google-safety|feedfetcher/i, 'Google'], [/cisco|ironport/i, 'Cisco'], [/fortinet|fortiguard/i, 'Fortinet'],
  [/trendmicro/i, 'Trend Micro'], [/sophos/i, 'Sophos'], [/forcepoint/i, 'Forcepoint'],
];

/* ── Link previews (note #1148) ─────────────────────────────────────────
   Adam, 11 Nov 2026, 09:27 UTC: "If customer shares a link that it received
   through our email, I want the links to have preview". A chat or social app
   fetches a pasted link to draw its card; each is named by the word in its
   own User-Agent. Apple's iMessage says both facebookexternalhit and
   Twitterbot, so it is matched first. Signal fetches as "WhatsApp", so a
   Signal share reads as WhatsApp. These get an HTML page of preview tags
   instead of the redirect (outreachLinkPreviewPage); people and agents still
   get the redirect. */
const PREVIEW_APPS: Array<[RegExp, string]> = [
  [/facebookexternalhit.*twitterbot|twitterbot.*facebookexternalhit/i, 'iMessage'],
  [/telegrambot/i, 'Telegram'], [/whatsapp/i, 'WhatsApp'], [/facebookexternalhit|facebot|meta-externalagent/i, 'Facebook'],
  [/slackbot|slack-imgproxy/i, 'Slack'], [/discordbot/i, 'Discord'], [/linkedinbot/i, 'LinkedIn'], [/twitterbot/i, 'X'],
  [/skypeuripreview/i, 'Teams or Skype'], [/microsoftpreview/i, 'Microsoft'], [/google-pagerenderer|google-chat|googlechat/i, 'Google Chat'],
  [/viber/i, 'Viber'], [/mastodon/i, 'Mastodon'], [/bluesky|cardyb/i, 'Bluesky'], [/vkshare/i, 'VK'], [/redditbot/i, 'Reddit'],
  [/pinterest/i, 'Pinterest'], [/snapchat/i, 'Snapchat'], [/embedly/i, 'Embedly'], [/iframely/i, 'Iframely'],
];
/** The app drawing a link preview, by its User-Agent; null for anything else. */
export function outreachPreviewApp(userAgent: string | null | undefined): string | null {
  const ua = (userAgent ?? '').trim();
  for (const [pattern, name] of PREVIEW_APPS) if (pattern.test(ua)) return name;
  return null;
}

/** The share picture of the site (og-image.png, square-safe since note #1137). Kept equal to index.html by outreach-links.test. */
export const OUTREACH_PREVIEW_IMAGE = {
  url: 'https://agenticcloudcomputer.com/og-image.png?v=33',
  width: 2400,
  height: 1260,
  alt: 'Your team. Your agents. Your cloud. Your rules. The all-in-one workplace for Claude Code, Codex and OpenCode agents.',
} as const;
/**
 * Each link's card, in the site's own words (landing-copy-rules). The home
 * link's is the home page's own (index.html, held equal by the test); the
 * other two say which page for agents it is. Nothing names the company.
 */
export const OUTREACH_LINK_PREVIEWS: Record<OutreachLink, { title: string; description: string }> = {
  home: {
    title: 'One workplace for Claude Code, Codex and OpenCode agents',
    description: 'Each agent works on a computer of its own in your company’s cloud. None of your data comes to us. Git, hosting and email are built in.',
  },
  agents: {
    title: 'Agentic Cloud Computer: what it does, for agents',
    description: 'Every part of the workplace, what it does and how an agent there uses it, on one page an agent reads in one fetch.',
  },
  install: {
    title: 'Agentic Cloud Computer: setup guide for agents',
    description: 'The steps an AI agent follows to set up your own Agentic Cloud in your company’s Fly.io account, with your yes before it changes anything.',
  },
};

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The page a link-preview app gets for /go/<code> (note #1148): the link's
 * card, with og:url the short link itself so the card opens through it, and
 * a plain link back through the short link for anyone who lands here. The
 * page carries nothing of the company: not its name, not its id.
 */
export function outreachLinkPreviewPage(link: OutreachLink, shortUrl: string): string {
  const { title, description } = OUTREACH_LINK_PREVIEWS[link];
  const image = OUTREACH_PREVIEW_IMAGE;
  const meta = (key: string, value: string | number) =>
    `<meta ${key.startsWith('og:') ? 'property' : 'name'}="${key}" content="${escapeHtml(String(value))}">`;
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    meta('description', description),
    meta('robots', 'noindex'),
    meta('og:type', 'website'),
    meta('og:site_name', 'Agentic Cloud Computer'),
    meta('og:title', title),
    meta('og:description', description),
    meta('og:url', shortUrl),
    meta('og:image', image.url),
    meta('og:image:width', image.width),
    meta('og:image:height', image.height),
    meta('og:image:alt', image.alt),
    meta('twitter:card', 'summary_large_image'),
    meta('twitter:title', title),
    meta('twitter:description', description),
    meta('twitter:image', image.url),
    meta('twitter:image:alt', image.alt),
    '</head><body>',
    `<p><a href="${escapeHtml(shortUrl)}">${escapeHtml(title)}</a></p>`,
    '</body></html>',
  ].join('\n');
}
/* A program reading the page: an AI agent's fetcher, a coding agent's HTTP
   client, a library. Named by its own product word. */
const AGENTS: Array<[RegExp, string]> = [
  [/claude-user|claude-web|claudebot|anthropic/i, 'Claude'], [/chatgpt-user|oai-searchbot|gptbot|openai/i, 'ChatGPT'], [/perplexity/i, 'Perplexity'],
  [/gemini|google-extended|googleother/i, 'Gemini'], [/mistral/i, 'Mistral'], [/cohere/i, 'Cohere'], [/\bcodex\b/i, 'Codex'], [/opencode/i, 'OpenCode'],
  [/^curl\//i, 'curl'], [/^wget\//i, 'wget'], [/python-requests|python-urllib|aiohttp|httpx|python\//i, 'Python'], [/node-fetch|undici|axios|^node\b|got \(/i, 'Node'],
  [/go-http-client/i, 'Go'], [/okhttp|java\//i, 'Java'], [/^ruby|faraday/i, 'Ruby'], [/postman|insomnia|httpie/i, 'HTTP client'],
];
const BROWSERS: Array<[RegExp, string]> = [
  [/edg\//i, 'Edge'], [/opr\/|opera/i, 'Opera'], [/firefox\//i, 'Firefox'], [/chrome\/|crios\//i, 'Chrome'], [/safari\//i, 'Safari'],
];

/** Who opened a link, as far as its User-Agent and method say. */
export function outreachReader(userAgent: string | null | undefined, method = 'GET'): { reader: OutreachReader; client: string | null } {
  const ua = (userAgent ?? '').trim();
  const preview = outreachPreviewApp(ua);
  if (preview) return { reader: 'preview', client: preview };
  for (const [pattern, name] of CHECKERS) if (pattern.test(ua)) return { reader: 'check', client: name };
  for (const [pattern, name] of AGENTS) if (pattern.test(ua)) return { reader: 'agent', client: name };
  if (method === 'HEAD') return { reader: 'check', client: null };
  if (/^mozilla\//i.test(ua) && !/bot|crawler|spider|headless/i.test(ua)) {
    for (const [pattern, name] of BROWSERS) if (pattern.test(ua)) return { reader: 'browser', client: name };
    return { reader: 'browser', client: null };
  }
  if (/bot|crawler|spider|headless/i.test(ua)) return { reader: 'agent', client: ua.split(/[\s/;(]/)[0]?.slice(0, 40) || null };
  return { reader: 'agent', client: ua ? ua.split(/[\s/;(]/)[0]!.slice(0, 40) : null };
}

export type OutreachTouch = {
  id: string;
  targetId: string;
  at: string;
} & (
  /**
   * A letter he sent. `providerId` is the mail provider's id for it, kept so
   * its delivery events find it (note #1112; absent on letters sent before);
   * `measured` says it went with an HTML copy, so an open could be seen.
   */
  | { kind: 'sent'; step: OutreachStep; mailId: string; to: string; subject: string; text: string; providerId?: string; measured?: boolean }
  | { kind: 'reply'; mailId: string; from: string; subject: string; suspicious?: boolean }
  | { kind: 'note'; text: string }
  | { kind: 'state'; from: OutreachPastState; to: OutreachPastState }
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
  /** Somebody opened one of the company's links (note #1106): which, and what it looked like. */
  | { kind: 'visit'; link: OutreachLink; reader: OutreachReader; client: string | null }
  /**
   * What the mail provider said about one of his letters (note #1112), by its
   * signed webhook: which letter (`mailId`, `step`), and the provider's own
   * event id so the same event twice is one touch. `detail` is the provider's
   * reason for a bounce; `permanent` is false for a bounce it calls passing.
   */
  | { kind: 'mail'; event: OutreachMailEvent; mailId: string; step: OutreachStep; eventId: string; detail?: string | null; permanent?: boolean }
  /**
   * A visitor who arrived through one of the company's links started a guest
   * agent on the home page (note #1139): its name and id (the conversation is
   * in the owner's Guests group) and Cloudflare's country for the visit.
   */
  | { kind: 'guest'; agentId: string; name: string; country: string | null }
);

/**
 * The provider's word for what happened to a letter (note #1112): delivered to
 * their server, delayed, bounced, marked as spam by the reader, its pictures
 * loaded (`opened`), refused before it left (`failed`), or not sent because
 * the address is on the provider's do-not-send list (`suppressed`).
 */
export const OUTREACH_MAIL_EVENTS = ['delivered', 'delayed', 'bounced', 'spam', 'opened', 'failed', 'suppressed'] as const;
export type OutreachMailEvent = (typeof OUTREACH_MAIL_EVENTS)[number];

/** Resend's event names, as its webhook sends them, for the ones Outreach records. */
export const RESEND_OUTREACH_EVENTS: Record<string, OutreachMailEvent> = {
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delayed',
  'email.bounced': 'bounced',
  'email.complained': 'spam',
  'email.opened': 'opened',
  'email.failed': 'failed',
  'email.suppressed': 'suppressed',
};

/** A bounce, failure or suppression that means nothing more reaches this address. */
const endsIt = (touch: OutreachTouch): boolean => touch.kind === 'mail'
  && ((touch.event === 'bounced' && touch.permanent !== false) || touch.event === 'failed' || touch.event === 'suppressed');

/**
 * The state, from what happened and nothing else (note #1112). Installed when
 * the company's own copy reported in; Replied when a letter came back from
 * their address or domain (a possibly forged one does not count); Marked as
 * spam, or Bounced, when the provider said so of one of his letters; Sent
 * once a letter has gone; else Not contacted. A Not now or Trying it picked
 * by hand before note #1112 is not a fact, so it moves nothing here.
 */
export function outreachStateFrom(touches: OutreachTouch[]): OutreachState {
  if (touches.some((touch) => touch.kind === 'installed')) return 'installed';
  if (touches.some((touch) => touch.kind === 'reply' && !touch.suspicious)) return 'replied';
  if (touches.some((touch) => touch.kind === 'mail' && touch.event === 'spam')) return 'spam';
  if (touches.some(endsIt)) return 'bounced';
  if (touches.some((touch) => touch.kind === 'sent')) return 'sent';
  return 'not-contacted';
}

/**
 * What we know about one letter, as facts with their times (note #1112). Null
 * means nothing has been heard, never that something went wrong.
 */
export interface OutreachLetterFacts {
  step: OutreachStep;
  mailId: string;
  sentAt: string;
  to: string;
  subject: string;
  /**
   * Whether an open could be seen at all: the letter went with an HTML copy
   * for the provider's pixel (from note #1112 on). The ten plain letters sent
   * before that have no pixel, so for them "opened" is unknowable.
   */
  measured: boolean;
  /** Whether the provider's id was kept at send time, so its events can find it. */
  traced: boolean;
  /** Their mail server accepted it. Not that anybody read it. */
  delivered: string | null;
  /** The provider is still trying (a passing problem at their end). */
  delayed: string | null;
  bounced: { at: string; detail: string | null; permanent: boolean } | null;
  /** The reader pressed "spam" on it. */
  spam: string | null;
  /**
   * The pictures in it were loaded: the provider's one-pixel image was
   * fetched. That is NOT "read": Apple Mail fetches every picture of every
   * letter for privacy, read or not; Gmail fetches through its own proxy;
   * a reader who blocks pictures, and an agent reading the text, never
   * fetches it. `times` counts loads at least an hour apart.
   */
  opened: { first: string; last: string; times: number } | null;
}

/** What we know about a company: each letter, then the facts that belong to the company, not to one letter. */
export interface OutreachKnown {
  letters: OutreachLetterFacts[];
  /** One of its two links was opened by something that looked like a browser or an agent (a mail system's check is not counted). */
  followed: { first: string; last: string; times: number; latest: { link: OutreachLink; reader: OutreachReader; client: string | null } } | null;
  /** A mail system opened a link to check it before anyone did. */
  checked: number;
  /** A chat or social app drew a preview of a link (note #1148): it was pasted into a conversation. */
  shared: number;
  replied: string | null;
  installed: string | null;
}

/** The facts of a company's letters, oldest letter first, from its timeline (newest first, as the store gives it). */
export function outreachKnown(touches: OutreachTouch[]): OutreachKnown {
  const oldestFirst = [...touches].reverse();
  const letters: OutreachLetterFacts[] = oldestFirst
    .filter((touch): touch is Extract<OutreachTouch, { kind: 'sent' }> => touch.kind === 'sent')
    .map((sent) => {
      const events = oldestFirst.filter((touch): touch is Extract<OutreachTouch, { kind: 'mail' }> => touch.kind === 'mail' && touch.mailId === sent.mailId);
      const first = (event: OutreachMailEvent) => events.find((touch) => touch.event === event)?.at ?? null;
      // The one that ends it, where there is one; else a passing bounce.
      const bounce = events.find(endsIt) ?? events.find((touch) => touch.event === 'bounced');
      const opens = events.filter((touch) => touch.event === 'opened');
      return {
        step: sent.step,
        mailId: sent.mailId,
        sentAt: sent.at,
        to: sent.to,
        subject: sent.subject,
        measured: sent.measured === true,
        traced: Boolean(sent.providerId),
        delivered: first('delivered'),
        delayed: first('delayed'),
        bounced: bounce ? { at: bounce.at, detail: bounce.detail ?? null, permanent: endsIt(bounce) } : null,
        spam: first('spam'),
        opened: opens.length ? { first: opens[0]!.at, last: opens.at(-1)!.at, times: opens.length } : null,
      };
    });
  const visits = oldestFirst.filter((touch): touch is Extract<OutreachTouch, { kind: 'visit' }> => touch.kind === 'visit');
  const follows = visits.filter((touch) => touch.reader !== 'check' && touch.reader !== 'preview');
  const latest = follows.at(-1);
  return {
    letters,
    followed: latest
      ? { first: follows[0]!.at, last: latest.at, times: follows.length, latest: { link: latest.link, reader: latest.reader, client: latest.client } }
      : null,
    checked: visits.filter((touch) => touch.reader === 'check').length,
    shared: visits.filter((touch) => touch.reader === 'preview').length,
    replied: oldestFirst.find((touch) => touch.kind === 'reply' && !touch.suspicious)?.at ?? null,
    installed: oldestFirst.find((touch) => touch.kind === 'installed')?.at ?? null,
  };
}

/** The list's glance at a company: when each fact was first known, across all its letters. */
export interface OutreachGlance {
  delivered: string | null;
  opened: string | null;
  followed: string | null;
  replied: string | null;
  installed: string | null;
  bounced: string | null;
  spam: string | null;
}

export function outreachGlance(known: OutreachKnown): OutreachGlance {
  const earliest = (values: Array<string | null | undefined>) => values.filter((value): value is string => Boolean(value)).sort()[0] ?? null;
  return {
    delivered: earliest(known.letters.map((letter) => letter.delivered)),
    opened: earliest(known.letters.map((letter) => letter.opened?.first)),
    followed: known.followed?.first ?? null,
    replied: known.replied,
    installed: known.installed,
    bounced: earliest(known.letters.map((letter) => letter.bounced?.at)),
    spam: earliest(known.letters.map((letter) => letter.spam)),
  };
}

/**
 * The letter as HTML, for the provider's open pixel (note #1112): the same
 * words as the plain text, nothing added — paragraphs, line breaks, links as
 * links (never rewritten: click tracking stays off, our /go links already do
 * that), and the quoted letter under a follow-up as a quote. No styles, no
 * pictures of ours; the pixel is the provider's.
 */
export function outreachMailHtml(text: string): string {
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const linked = (line: string) => escape(line).replace(/https?:\/\/[^\s<>"]+[^\s<>".,;:!?)']/g, (url) => `<a href="${url}">${url}</a>`);
  const blocks: string[] = [];
  const lines = String(text ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  let paragraph: string[] = [];
  let quote: string[] = [];
  const flushParagraph = () => { if (paragraph.length) blocks.push(`<p>${paragraph.map(linked).join('<br>\n')}</p>`); paragraph = []; };
  const flushQuote = () => { if (quote.length) blocks.push(`<blockquote>${outreachMailHtml(quote.join('\n'))}</blockquote>`); quote = []; };
  for (const line of lines) {
    if (/^>/.test(line)) { flushParagraph(); quote.push(line.replace(/^> ?/, '')); continue; }
    flushQuote();
    if (!line.trim()) { flushParagraph(); continue; }
    paragraph.push(line);
  }
  flushParagraph();
  flushQuote();
  return blocks.join('\n');
}

export type OutreachTouchKind = OutreachTouch['kind'];

/** The owner's own address for a company: what he set, else the agents'. */
const edited = (record: Pick<OutreachTargetRecord, 'seed' | 'edits'>, field: keyof OutreachEdits): string | null =>
  (field in record.edits ? record.edits[field] || null : record.seed[field]);
export const targetEmail = (record: Pick<OutreachTargetRecord, 'seed' | 'edits'>): string | null => edited(record, 'email');
export const targetPerson = (record: Pick<OutreachTargetRecord, 'seed' | 'edits'>): string | null => edited(record, 'person');
export const targetCity = (record: Pick<OutreachTargetRecord, 'seed' | 'edits'>): string | null => edited(record, 'city');

export interface OutreachNext {
  step: OutreachStep;
  /** When it may go; null for a first letter, which may go now. */
  dueAt: string | null;
  due: boolean;
}

/**
 * What may be sent next, if anything. A first letter while nothing has gone;
 * then day 4, then day 11, each from the first letter's time, and only while
 * the company is still at Sent — a reply, a bounce, a spam mark or an install
 * ends the sequence. After day 11: nothing, as note #799 says ("then stop").
 * The state is read from the timeline (`outreachStateFrom`), never from a
 * word that was picked by hand.
 */
export function outreachNext(record: Pick<OutreachTargetRecord, 'seed' | 'edits'>, touches: OutreachTouch[], now: Date): OutreachNext | null {
  const state = outreachStateFrom(touches);
  if (record.seed.fit !== 'fit') return null;
  const sent = touches.filter((touch): touch is Extract<OutreachTouch, { kind: 'sent' }> => touch.kind === 'sent');
  const first = sent.find((touch) => touch.step === 'first');
  if (!first) {
    if (state !== 'not-contacted' || !targetEmail(record)) return null;
    return { step: 'first', dueAt: null, due: true };
  }
  if (state !== 'sent') return null;
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
  /** Customer or investor (note #1115). */
  audience: OutreachAudience;
  /** An investor's fit in its own words; null for a customer. */
  thesis: OutreachThesis | null;
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
  /**
   * How well they match, in the research's own words (note #1145): the
   * profile's `match`, else the first letter's `painMatch`; null where neither
   * is written. The site's Next view ranks by it.
   */
  match: string | null;
  /** What happened, read off the timeline (note #1112). */
  state: OutreachState;
  stateAt: string | null;
  /** When each fact was first known, for the list (note #1112). */
  glance: OutreachGlance;
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

/**
 * Whether the provider's delivery facts reach us (note #1112): `off` while the
 * backend holds no webhook signing secret, `waiting` until the first signed
 * event arrives, `on` after (with when the last one did).
 */
export interface OutreachMailFacts { status: 'off' | 'waiting' | 'on'; lastEventAt: string | null }

export interface OutreachListAnswer {
  /** The newest agent write anywhere: what the site says the list is "as of". Null before anything is written. */
  lastWrite: { at: string; by: string } | null;
  mailFacts: OutreachMailFacts;
  rows: OutreachRow[];
  /** First letters sent so far, for the review reminder. */
  firstSends: number;
  reviewAfter: number;
  /**
   * Every letter that has gone, newest first (note #1150; Adam, 11 Nov 2026:
   * "in the header I want to see how much emails I've already sent today and
   * last hour"): when, which letter, and to whom by audience. Read off the
   * sent touches, the same facts as the timeline and firstSends. The site
   * counts "today" in his own browser's time zone and "last hour" as the
   * last 60 minutes.
   */
  sends: Array<{ at: string; step: OutreachStep; audience: OutreachAudience }>;
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
  /** The company's two short links for its letters (note #1106). */
  links: OutreachLinks;
  /** What we know about each letter, and about the company (note #1112). */
  known: OutreachKnown;
  mailFacts: OutreachMailFacts;
  /** Every letter that has gone to this company, in the order sent, as it left (note #1130). */
  sent: OutreachSentLetter[];
}

/**
 * A letter that has gone, as it LEFT (note #1130, Adam: "Why I don't see
 * email that was sent? I want to see all emails."). Read from his Sent, the
 * mail row the send stored under its own id, never from the store's current
 * letter, which agents may have rewritten since. `words` is what he sent;
 * `quoted` is what a follow-up carried under it (the earlier letter). Where
 * the row is gone from his Sent, the words kept with the send's own record
 * are shown instead, and `from` says so.
 */
export interface OutreachSentLetter {
  step: OutreachStep;
  mailId: string;
  at: string;
  from: { address: string; name: string | null } | null;
  to: string;
  cc: string[];
  subject: string;
  words: string;
  quoted: string | null;
  /** The mail service's own id, kept since note #1112; null for the letters of 9 Nov. */
  providerId: string | null;
  /** Where the words were read: his Sent, or (the row gone) the send's own record. */
  source: 'sent-mail' | 'record';
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
  audience: OutreachAudience;
  thesis: OutreachThesis | null;
  /** An investor's portfolio size (note #1124); null where none is written. */
  portfolio: number | null;
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
  /** The two short links to put in this company's letters (note #1106). */
  links: OutreachLinks;
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
/**
 * The two link placeholders (note #1106): `{home link}` and `{agents link}`
 * in any letter, the shared template and follow-ups included, become this
 * company's own short links in the Send box. So one follow-up text carries
 * each company's own links, and a letter that goes never holds a brace.
 */
export const OUTREACH_LINK_PLACEHOLDERS = { home: '{home link}', agents: '{agents link}', install: '{install link}' } as const;
export function fillOutreachLinks(text: string, codes: OutreachLinkCodes | undefined): string {
  if (!codes) return text;
  const links = outreachLinks(codes);
  const filled = text.split(OUTREACH_LINK_PLACEHOLDERS.home).join(links.home).split(OUTREACH_LINK_PLACEHOLDERS.agents).join(links.agents);
  // The setup guide's link (note #1120); a record not yet given its code keeps the placeholder, so Send stays off.
  return links.install ? filled.split(OUTREACH_LINK_PLACEHOLDERS.install).join(links.install) : filled;
}

export function outreachDraft(record: OutreachTargetRecord, words: OutreachWords | null, touches: OutreachTouch[], next: OutreachNext | null): OutreachDraft | null {
  const draft = draftWords(record, words, touches, next);
  if (!draft) return null;
  const fill = (text: string) => fillOutreachLinks(text, record.links);
  return { ...draft, subject: fill(draft.subject), text: fill(draft.text), newer: draft.newer ? { ...draft.newer, subject: fill(draft.newer.subject), text: fill(draft.newer.text) } : null };
}

function draftWords(record: OutreachTargetRecord, all: OutreachWords | null, touches: OutreachTouch[], next: OutreachNext | null): OutreachDraft | null {
  // An investor's letters come from the investors' words, never the customers' (note #1115).
  const words = outreachWordsFor(all, outreachAudience(record.seed));
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
  const followUp = words?.followUps?.[next.step];
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

// ---------------------------------------------------------------------------
// The graph of contacts (note #1124): from the funds down to their companies.

/** A company in the graph: one node however many funds back it. */
export interface OutreachGraphCompany {
  /** Stable within one read: the Outreach record's id when it is in Outreach, else "p:" and its name folded. */
  key: string;
  name: string;
  website: string | null;
  builds: string | null;
  /** The customer record it matched, by name or website, with what happened there; null when it is not in Outreach. */
  record: { id: string; company: string; state: OutreachState; fit: 'fit' | 'not a fit' } | null;
  /** The funds that back it, by record id. */
  funds: string[];
}

export interface OutreachGraphFund {
  id: string;
  name: string;
  thesis: OutreachThesis | null;
  state: OutreachState;
  city: string | null;
  /** False until an agent writes its portfolio. */
  written: boolean;
}

export interface OutreachGraphEdge {
  fund: string;
  company: string;
  /** The fund's own words for it, and where and when they were read. */
  builds: string | null;
  source: string | null;
  readOn: string | null;
}

export interface OutreachGraph { funds: OutreachGraphFund[]; companies: OutreachGraphCompany[]; edges: OutreachGraphEdge[] }

/**
 * The graph, read whole (note #1124): every investor as a fund at the top,
 * every company in their portfolios once, and an edge per fund that backs
 * it. A company is matched to a customer in the store by its website's host
 * or, failing that, by its name folded the way record ids are; companies of
 * different funds with the same host or folded name are the same node. The
 * match is made here on every read and never stored.
 *
 * A name links a portfolio company to a customer only where one side has no
 * website, or the two are the same site (10 Nov 2026, Alex on note #1124): a
 * fund's 'Reflex' at workreflex.com is not our customer Reflex at reflex.dev,
 * while Personio at personio.de is the one at personio.com. Portfolio
 * companies of several funds still merge by name, as before (most of the
 * same names there with two sites are one company, checked on the live store
 * on 10 Nov 2026), but never into a customer whose site said no.
 */
/**
 * Two hosts are one company's site (note #1124): the same host, one under the
 * other (studio.playgoals.com and playgoals.com), or the same name under
 * another ending (personio.de and personio.com). workreflex.com and
 * reflex.dev are not.
 */
export function sameSite(a: string, b: string): boolean {
  if (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)) return true;
  const name = (host: string) => {
    const labels = host.split('.');
    // co.uk, com.au and the like: the name sits one label further in.
    const inner = labels.length > 2 && /^(co|com|org|net|ac|gov|edu)$/.test(labels[labels.length - 2]!) ? 3 : 2;
    return labels[labels.length - inner] ?? host;
  };
  return name(a) === name(b);
}

export function outreachGraph(rows: Array<{ record: OutreachTargetRecord; state: OutreachState }>): OutreachGraph {
  const customers = rows.filter((row) => outreachAudience(row.record.seed) === 'customer');
  const byName = new Map<string, (typeof customers)[number]>();
  const byHost = new Map<string, (typeof customers)[number]>();
  // Every host a customer is known by: its address's domain, its website and domain.
  const hostsOf = new Map<(typeof customers)[number], Set<string>>();
  for (const row of customers) {
    byName.set(outreachTargetId(row.record.seed.company), row);
    const hosts = new Set<string>();
    const host = companyDomain(targetEmail(row.record));
    if (host) hosts.add(host);
    for (const field of ['website', 'domain'] as const) {
      const site = websiteHost((row.record.seed as unknown as Record<string, unknown>)[field] as string | undefined)
        ?? websiteHost((row.record.seed.profile as Record<string, unknown> | null)?.[field] as string | undefined);
      if (site) hosts.add(site);
    }
    for (const one of hosts) byHost.set(one, row);
    hostsOf.set(row, hosts);
  }
  const funds: OutreachGraphFund[] = [];
  const companies = new Map<string, OutreachGraphCompany>();
  const keyOfName = new Map<string, string>();
  const keyOfHost = new Map<string, string>();
  const edges: OutreachGraphEdge[] = [];
  const investors = rows.filter((row) => outreachAudience(row.record.seed) === 'investor')
    .sort((a, b) => a.record.seed.company.localeCompare(b.record.seed.company));
  for (const { record, state } of investors) {
    const portfolio = record.seed.portfolio ?? [];
    funds.push({ id: record.id, name: record.seed.company, thesis: record.seed.thesis ?? null, state, city: targetCity(record), written: Boolean(record.seed.portfolio) });
    for (const one of portfolio) {
      const host = websiteHost(one.website);
      const folded = outreachTargetId(one.name);
      // By the same name only where one side has no website to tell them apart.
      const named = byName.get(folded);
      const match = (host ? byHost.get(host) : undefined)
        ?? (named && (!host || !hostsOf.get(named)!.size || [...hostsOf.get(named)!].some((one) => sameSite(one, host))) ? named : undefined);
      // Never into the customer of that name by the back door, once its site said no.
      const sameName = keyOfName.get(folded);
      const key = match ? match.record.id
        : (host && keyOfHost.get(host)) || (sameName && sameName !== named?.record.id ? sameName : undefined) || `p:${folded}`;
      let node = companies.get(key);
      if (!node) {
        node = {
          key, name: match ? match.record.seed.company : one.name, website: one.website, builds: one.builds,
          record: match ? { id: match.record.id, company: match.record.seed.company, state: match.state, fit: match.record.seed.fit } : null,
          funds: [],
        };
        companies.set(key, node);
      }
      node.website ??= one.website;
      node.builds ??= one.builds;
      if (host) keyOfHost.set(host, key);
      keyOfName.set(folded, key);
      if (!node.funds.includes(record.id)) {
        node.funds.push(record.id);
        edges.push({ fund: record.id, company: key, builds: one.builds, source: one.source, readOn: one.readOn });
      }
    }
  }
  return {
    funds,
    // Companies backed by more funds first, then the ones in Outreach, then by name.
    companies: [...companies.values()].sort((a, b) => b.funds.length - a.funds.length || Number(Boolean(b.record)) - Number(Boolean(a.record)) || a.name.localeCompare(b.name)),
    edges,
  };
}
