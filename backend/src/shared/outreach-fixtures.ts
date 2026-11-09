/**
 * A made-up seed for Outreach's tests and browser check (note #1089), shaped
 * exactly like the file made from note #799. Every company, person and
 * address here is invented — the real list lives on a note in the workplace,
 * never in this public repository — and the cities are the seven the note
 * asks the local time to be right for.
 */

const SIGNATURE = 'Adam\nFounder, Agentic Cloud Computer';

/** A ready first email the way note #799 writes one: 120 words with the subject and the signature. */
function letter(first: string, line: string): string {
  return `Hi ${first},\n\n${line} Coding agents are great engineers with no workplace around them: nobody sees what anyone else's agents are doing, and every session starts from zero.\n\n`
    + 'I built that workplace: a team view of every agent, knowledge pages they write and read before each job, and notes to hand out the work. The film on our home page shows it at work: agenticcloudcomputer.com\n\n'
    + 'It runs in your own cloud. None of your data comes to us, only a daily report. Free for now.\n\n'
    + `Start a guest agent, no account: agenticcloudcomputer.com/#your-agent\n\n${SIGNATURE}`;
}

interface FixtureCompany { company: string; city: string | null; first: string; person: string; email: string | null; line?: string; source?: string | null; fit?: 'fit' | 'not a fit'; group?: string }

const COMPANIES: FixtureCompany[] = [
  { company: 'Northwind Health', city: 'San Francisco', first: 'Mara', person: 'Mara Quill, CEO', email: 'mara@northwind-health.test', line: 'Your job post says your team ships with a fleet of agents.' },
  { company: 'Fernhill Labs', city: 'Seattle', first: 'Otto', person: 'Otto Brandt, founder', email: 'founders@fernhill.test', line: 'Your blog says every engineer runs three agents at once.' },
  { company: 'Lakeview Data', city: 'Chicago', first: 'Ines', person: 'Ines Okafor, CTO', email: 'ines@lakeview-data.test', line: 'Your careers page says agents write most of your code.' },
  { company: 'Harbor & Pine', city: 'New York', first: 'Leo', person: 'Leo Marsh, CEO', email: 'leo@harborpine.test', line: 'Your post says your agents work the night shift.' },
  { company: 'Capitol Ledger', city: 'Washington DC', first: 'Ruth', person: 'Ruth Adeyemi, co-founder', email: 'ruth@capitol-ledger.test', line: 'Your README says Claude Code reviews every change.' },
  { company: 'Aurora Clinic', city: 'Helsinki', first: 'Sami', person: 'Sami Laine, CEO', email: 'sami@aurora-clinic.test', line: 'Your careers page says agents plan, code and review.' },
  { company: 'Juniper Works', city: 'US remote', first: 'Jo', person: 'Jo Park, founder', email: 'hello@juniper.test', line: 'Your talk said agents take the overnight queue.' },
  { company: 'Quarry Software', city: null, first: 'Bea', person: 'Bea Holm, CEO', email: 'bea@quarry.test', line: 'Your newsletter says nobody writes code by hand now.' },
  { company: 'Tallow & Co', city: 'Austin', first: 'Ned', person: 'Ned Fox, founder', email: 'ned@tallow.test', line: 'Your post says five agents run per engineer.' },
  { company: 'Meridian Policy', city: 'Washington DC', first: 'Ada', person: 'Ada Kim, CEO', email: 'ada@meridian-policy.test', line: 'Your post says you run ten sessions at a time.' },
  { company: 'Kestrel Systems', city: 'Amsterdam', first: 'Kai', person: 'Kai de Vries, founder', email: 'hello@kestrel.test', group: 'B' },
  { company: 'Solace Studio', city: null, first: 'Pia', person: 'Pia Lund', email: null, group: 'B', source: null },
  { company: 'Gleam Tools', city: 'Berlin', first: 'Uwe', person: 'Uwe Stahl, CEO', email: 'contact@gleam.test', group: 'C' },
  { company: 'Bigfirm Inc', city: null, first: '', person: '', email: null, fit: 'not a fit' },
];

export function fixtureOutreachSeed(): Record<string, unknown> {
  let batch = 0;
  return {
    source: 'A made-up seed shaped like note #799 (test fixture)',
    generatedBy: 'test',
    generatedAt: '2026-11-09',
    rules: { channel: 'email only', maxWords: 120, wordCountIncludes: 'subject line and signature' },
    template: {
      subject: 'Your agents need a workplace',
      body: `Hi {first name},\n\n{their line}. Coding agents are great engineers with no workplace around them.\n\nStart a guest agent, no account: agenticcloudcomputer.com/#your-agent\n\n${SIGNATURE}`,
      placeholders: ['{first name}', '{their line}'],
    },
    followUps: {
      day4: { text: 'One question, if it helps: which hurts most today? Reply with it and I\'ll answer in writing.', wordCount: 17, send: 'day 4' },
      day11: { text: 'I\'ll leave it here. Thank you for reading.', wordCount: 8, send: 'day 11' },
    },
    targets: COMPANIES.map((company, at) => {
      const fit = company.fit ?? 'fit';
      const order = fit === 'fit' && company.line ? ++batch : null;
      return {
        number: fit === 'fit' ? at + 1 : null,
        company: company.company,
        city: company.city,
        size: fit === 'fit' ? `${5 + at} people` : null,
        group: fit === 'fit' ? company.group ?? 'A' : null,
        fit,
        ...(fit === 'not a fit' ? { notAFitReason: 'too big' } : {}),
        newOn2Nov: false,
        firstBatchOrder: order,
        whyOwnCloud: fit === 'fit' ? 'Customer data; a small team with many agents' : null,
        agentSignal: fit === 'fit' ? `"${company.line ?? 'We run agents all day.'}"` : null,
        agentSignalSource: fit === 'fit' ? (company.source === null ? null : 'their careers page') : null,
        person: company.person || null,
        personRole: null,
        email: company.email,
        emailWhose: company.email ? company.person : null,
        emailWherePrinted: company.email ? 'their contact page' : null,
        notThisAddress: at === 0 ? 'Not support@northwind-health.test: that is their patient line.' : null,
        verification: fit === 'fit' ? 'VERIFIED' : 'DROPPED',
        checkedOn: '2026-11-02',
        firstEmail: order && company.line && company.email
          ? (() => {
            const body = letter(company.first, company.line);
            return { to: company.email, recipient: company.person, wherePrinted: 'their contact page', note: null, subject: 'Your agents need a workplace', body, wordCount: null };
          })()
          : null,
      };
    }),
  };
}
