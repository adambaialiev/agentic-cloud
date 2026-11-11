import type { ReactNode } from 'react';
import SiteHeader from '../components/SiteHeader';
import SiteFooter from '../components/SiteFooter';
import { BODY, CARD, ChapterDivider, H2, H3, LEAD, SECTION, SecondaryLink } from '../components/landing-kit';
import { SidesArt } from '../components/CopyArt';
import { FOOTER_PITCH, faqsFor } from '../lib/product-copy';
import { AgentLine, FOUNDER_EMAIL, INSTALLER_SOURCE_URL, WHY_FLY_PATH } from './PrivateCopy';

/**
 * Self-hosted coding agents in your own cloud (note #1154, the first of the
 * missing topic pages in Iris's search report, note #1144: "the own-cloud
 * pitch under the words people search, with an honest comparison to
 * Anthropic's self-hosted environments and to running Claude Code on a VPS").
 * A DRAFT for Adam to read: on a branch with no proposal, because auto-merge
 * would publish it.
 *
 * The searches it answers: "self-hosted Claude Code", "self-hosted coding
 * agents", "coding agents in your own cloud". The site said none of those
 * words until note #1149.
 *
 * Every sentence about Anthropic carries a source from Anthropic's own pages,
 * read on 11 Nov 2026 (SOURCES). Self-hosted environments are a public beta
 * and moving: re-read them before changing a claim. Anthropic's plans are
 * named only as "company plans" (claims-we-never-make: no team or business
 * plan by name on a customer-facing surface). Our side says only what the
 * home page, the FAQ (src/lib/product-copy.ts), /why-fly and /own-cloud.md
 * already say.
 *
 * An ARTICLE since Adam's reading of the first draft (11 Nov 2026, 13:16 UTC:
 * "it lacks text, I see only table and FAQ. IT should be article with
 * valuable information"): what self-hosting means, how teams do it today,
 * what an agent needs besides itself, where we fit and where we do not, in
 * prose; the comparison table and the questions follow as supporting parts.
 * The look follows /why-fly (note #838): the home page's own drawing of what
 * runs on whose side, the table as the table it is, the questions as a
 * two-column ledger, the agent's line as the one action.
 */

export const SELF_HOSTED_PATH = '/self-hosted-coding-agents';
export const SELF_HOSTED_HEADING = 'Self-hosted coding agents, in your own cloud.';

export const SOURCES = [
  { id: 'sh', label: 'Anthropic, Self-hosted environments', url: 'https://code.claude.com/docs/en/self-hosted-environments' },
  { id: 'rc', label: 'Anthropic, Remote Control', url: 'https://code.claude.com/docs/en/remote-control' },
  ...(INSTALLER_SOURCE_URL ? [{ id: 'installer', label: 'The installer’s code (open source)', url: INSTALLER_SOURCE_URL }] : []),
] as const;

type SourceId = (typeof SOURCES)[number]['id'];
export const SOURCES_READ_ON = '11 November 2026';

function Cite({ ids }: { ids: SourceId[] }) {
  const numbers = ids
    .map((id) => SOURCES.findIndex((source) => source.id === id) + 1)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  if (!numbers.length) return null;
  return (
    <sup className="ml-0.5 whitespace-nowrap type-xs">
      {numbers.map((n, at) => (
        <span key={n}>
          {at ? ',' : null}
          <a href={`#source-${n}`} className="text-hint no-underline hover:text-white" aria-label={`Source ${n}`}>{n}</a>
        </span>
      ))}
    </sup>
  );
}

type Cell = { text: string; cite: SourceId[] };

/* Three ways to run a coding agent on computers you control, need by need.
   Ours is first and in ink, the way /why-fly sets Fly's column. */
const WAYS = [
  ['Your own Agentic Cloud', 'ours'],
  ['Anthropic’s self-hosted environments', 'anthropic'],
  ['Claude Code on a server of yours', 'server'],
] as const;

const ROWS: { need: string; ours: Cell; anthropic: Cell; server: Cell }[] = [
  {
    need: 'Which agents.',
    ours: { text: 'Claude Code, Codex and OpenCode, side by side, each with a name and a job.', cite: [] },
    anthropic: { text: 'Claude Code sessions, started from claude.ai, the Claude apps or the terminal.', cite: ['sh'] },
    server: { text: 'Whatever you install on it.', cite: [] },
  },
  {
    need: 'Who can have it.',
    ours: { text: 'Anyone with a Fly account. Free for now: no licence, no key and no charge from us.', cite: [] },
    anthropic: { text: 'Organizations on Anthropic’s company plans, in public beta, off until an Owner turns it on.', cite: ['sh'] },
    server: { text: 'Anyone with a paid Claude plan. Remote Control lets you steer it from a phone or a browser.', cite: ['rc'] },
  },
  {
    need: 'What runs on your side.',
    ours: { text: 'All of it: the Workspace, every agent’s computer, git with CI/CD, sites, files and, once you turn it on, email.', cite: ['installer'] },
    anthropic: { text: 'The sessions: checkouts, build artifacts, secrets and the files a session makes. The queue and the screens stay with Anthropic.', cite: ['sh'] },
    server: { text: 'Claude Code itself, on the one computer you rent.', cite: ['rc'] },
  },
  {
    need: 'What leaves it.',
    ours: { text: 'What your agents send their AI provider, on your own plan. To us, only a daily report of counts, which your admin can turn off.', cite: [] },
    anthropic: { text: 'The conversation: prompts, responses and tool results go to Anthropic, which keeps the transcript.', cite: ['sh'] },
    server: { text: 'What Claude Code sends Anthropic, as on a laptop.', cite: [] },
  },
  {
    need: 'What you build and keep running.',
    ours: { text: 'Nothing to build. One command installs it, an admin upgrades it from the Workspace, and an upgrade that fails puts the old release back by itself.', cite: ['installer'] },
    anthropic: { text: 'The runner image, the fleet and its network. Sessions check out from GitHub or GitHub Enterprise Server; another git host only from the terminal.', cite: ['sh'] },
    server: { text: 'The server, its updates, and tmux so a session outlives your connection. The computer has to stay on.', cite: ['rc'] },
  },
  {
    need: 'Many agents at once.',
    ours: { text: 'Each agent on a computer of its own, all reading the same notes, knowledge pages and code.', cite: [] },
    anthropic: { text: 'A runner serves one person at a time, so the fleet grows with the people working at once.', cite: ['sh'] },
    server: { text: 'Every session shares the one computer.', cite: [] },
  },
];

/* The questions an engineering lead asks before a yes, kept short since the
   article answers the rest. The cost, GitHub and install answers are the
   FAQ's own (src/lib/product-copy.ts); the data answer is
   claims-we-never-make's one true sentence. */
const [COST, GITHUB, NEEDS] = faqsFor(['cost', 'github', 'needs']);

const QUESTIONS: { q: string; a: ReactNode }[] = [
  {
    q: 'Does our code reach you?',
    a: 'No. None of your data comes to us: only a daily report of counts and the contact you chose, which your admin sees and can turn off. Your agents’ AI provider reads what they send it, under your own plan.',
  },
  {
    q: 'What does it cost?',
    // The installer's own estimate at Fly's published prices, as /why-fly
    // says it (note #1013).
    a: `${COST.answer} The installer estimates about $0.57 a day at Fly’s published prices for the Workspace, the code host and the router, plus about $0.09 an hour for each awake agent.`,
  },
  { q: 'Can our agents keep working on GitHub?', a: GITHUB.answer },
  { q: 'What do we need to start?', a: NEEDS.answer },
];

/* An inline link inside the article's prose. */
function A({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} className="text-white underline decoration-white/35 underline-offset-2 hover:decoration-white">
      {children}
    </a>
  );
}

/* One part of the article: a heading and its paragraphs, at reading width. */
function Part({ id, heading, children }: { id: string; heading: string; children: ReactNode }) {
  return (
    <section id={id} className={`${SECTION} pb-8 sm:pb-10`}>
      <ChapterDivider />
      <h2 className={`max-w-[760px] [text-wrap:balance] ${H2}`}>{heading}</h2>
      <div className={`mt-6 max-w-[36rem] space-y-5 [text-wrap:pretty] ${LEAD}`}>{children}</div>
    </section>
  );
}

function Way({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div className="pt-3">
      <h3 className={H3}>{heading}</h3>
      <p className="mt-2">{children}</p>
    </div>
  );
}

const FOUNDER_MAILTO = `mailto:${FOUNDER_EMAIL}?subject=${encodeURIComponent('Self-hosted coding agents')}`;

export default function SelfHosted() {
  return (
    <main
      className="landing-page copy-page min-h-dvh overflow-x-clip bg-panel text-white"
      style={{ fontFamily: 'var(--font-ui)' }}
    >
      <SiteHeader ctaTarget="none" tone="dark" />

      {/* ── What you get ────────────────────────────────────────────────── */}
      <section id="self-hosted-top" className={`${SECTION} pb-10 pt-14 sm:pb-12 sm:pt-20`}>
        <h1 className={`max-w-[900px] [text-wrap:balance] ${H2}`}>{SELF_HOSTED_HEADING}</h1>
        <p className={`mt-5 max-w-[36rem] [text-wrap:pretty] ${LEAD}`}>
          Claude Code, Codex and OpenCode agents, each on a computer of its own in your company’s
          cloud account, on your own domain. Git, hosting, storage, email, Drive, notes and memory
          come built in. None of your data comes to us, only a daily report. Your agent installs the
          whole thing with one command.
        </p>
      </section>

      {/* ── The article (Adam, 11 Nov 2026, 13:16 UTC: "it lacks text … IT
          should be article with valuable information"): what self-hosting
          means, how teams do it today, what an agent needs besides itself,
          where we fit and where we do not. The table and the questions
          follow as supporting parts. ──────────────────────────────────── */}
      <Part id="what-it-means" heading="What self-hosting a coding agent means.">
        <p>
          A coding agent is not a chat window. It reads your code, runs commands, installs packages,
          holds keys to your repositories and pushes changes. Where it does that work is a real
          decision: on a developer’s laptop, on its vendor’s computers, or on computers your company
          controls. Self-hosting is the third choice.
        </p>
        <p>
          Claude Code’s cloud sessions, for example, run on Anthropic’s computers unless your company
          sets up its own.<Cite ids={['sh']} /> That is the easy path, and for many teams the right one.
          Teams self-host when the work has to sit on their side: the checkouts, the build artifacts,
          the keys an agent uses and the files it makes. Some need their agents to reach internal
          services. Some answer to a security team that asks where the code lives. Some want one bill
          they can read themselves.
        </p>
        <p>
          One thing self-hosting does not change is the model. Claude and GPT still run at Anthropic
          and OpenAI, and what an agent sends the model, your code included, goes there under your
          plan’s terms. Self-hosting moves where the agent works, not where the model thinks.
        </p>
      </Part>

      <Part id="today" heading="How teams do it today.">
        <p>Three ways come up again and again. Each is a fair answer to a different question.</p>
        <Way heading="A server of your own.">
          Rent a virtual server, install Claude Code or Codex, and run it inside tmux so a session
          survives when you disconnect. Anthropic’s Remote Control lets you steer that session from a
          phone or a browser, as long as the computer stays on and the process keeps
          running.<Cite ids={['rc']} /> It is cheap and quick. It is also one computer: every session
          shares its disk and its keys, and everything around the agent, from where code is pushed to
          how a person approves it, is yours to wire up and keep patched.
        </Way>
        <Way heading="Anthropic’s self-hosted environments.">
          Anthropic’s own answer, in public beta for organizations on its company plans, runs Claude
          Code’s cloud sessions on runners inside your network. Developers keep the claude.ai screens
          they know and pick your environment when they start a session. Checkouts, build artifacts,
          secrets and the files a session makes stay on your machines. The conversation does not:
          prompts, responses and tool results go to Anthropic, which keeps the transcript, and the
          queue and the screens run on Anthropic’s side. You build the runner image and run the fleet
          and its network, and each runner serves one person at a time.<Cite ids={['sh']} /> It runs
          Claude Code, and only Claude Code.
        </Way>
        <Way heading="A platform you build yourself.">
          Larger teams often assemble their own: a container or virtual machine per agent, a git
          server, a CI system, a review step, and a way to hand keys to an agent without pasting them
          into a chat. It fits exactly, because they made it to fit. What it takes is further down.
        </Way>
      </Part>

      <Part id="needs" heading="What an agent needs to finish the job.">
        <p>
          Whichever way you choose, the agent is the small part. To take a job from one sentence to
          something live, it needs a computer that keeps its files between turns, a repository to push
          to, checks that run on every push, and a person’s yes before protected code lands. It needs
          somewhere to publish what it built, a way to use your keys without seeing them in a chat,
          and the notes and decisions your team already wrote down, so it does not start from zero
          every morning. Often it needs an email address too.
        </p>
        <p>
          On a bare server, each of those is a project. Together they are the difference between an
          agent that suggests a change and one that finishes the job.
        </p>
      </Part>

      {/* Adam, 11 Nov 2026, 13:29 UTC: "let's unpack the reasoning about
          building it yourself. It's quite large system to build and support
          for yourself, because company should be focused on it's own product
          or service, not on workplace for agents". The list is the one above;
          the size is this repository's own, counted on 11 Nov 2026 (code and
          scripts tracked in git, tests counted apart; re-count before
          quoting it again); the update document is
          docs/machine-update-channels.md. */}
      <Part id="build-it-yourself" heading="What building it yourself takes.">
        <p>
          Every piece on that list can be built, and teams with strong engineers often start to.
          Count what it adds up to. A computer for each agent that keeps its files, sleeps when idle
          and wakes when work arrives. A git host with protected branches, checks on every push, and
          a proposal a person can approve from a phone. Somewhere to publish a site on your own
          domain, with its certificates. A store for keys that hands an agent the value without
          showing it in a chat. Notes and pages the agents read before a job and write back to after
          it. Mail addresses that send and receive. And one place where people talk to all of it.
        </p>
        <p>
          Then it has to keep working. Claude Code, Codex and OpenCode change under you, with new
          versions, new settings and new ways to sign in, and every agent’s computer has to follow
          without losing its work. Keys have to stay encrypted and out of transcripts, and an agent
          must not be able to merge its own change or widen its own access. The disks need backups
          you have actually restored, and an upgrade needs a way back when it fails. Someone on your
          team owns all of it, including when it breaks at night.
        </p>
        <p>
          We know the size because we built it. The <A href="/open-source">open-source repository</A>{' '}
          holds more than 230,000 lines of code, with close to 400 test files beside them, and a whole
          document on how an update reaches agents’ computers that are already running. It is a large
          system to build, and a larger one to keep.
        </p>
        <p>
          That is the real cost of building it yourself: not the first version, but the attention
          after it. A company’s attention belongs on its own product or service. A workplace for
          agents is something your agents need, not something your customers buy.
        </p>
        <p>
          Building it yourself is still the right call in some cases. If agent infrastructure is your
          product, build it. If your agents must live inside a network or a cloud you cannot leave,
          or you need controls this does not have, such as single sign-on, you may have no other
          choice. If you need one agent for one job, such as a review in the CI you already run, a
          step in that CI is smaller than any platform. And if you want most of this but not all of
          it, the code is open source under the AGPL-3.0: start from ours and change what you need.
        </p>
      </Part>

      <Part id="fit" heading="Where your own Agentic Cloud fits.">
        <p>
          Your own Agentic Cloud is all of that, installed in one Fly organization of yours, on your
          own domain, by one command. Each agent gets a computer of its own that sleeps after about
          three quiet minutes and wakes in seconds when there is work. Claude Code, Codex and OpenCode
          work side by side, each on your people’s own Claude, ChatGPT or OpenCode Go plan. Around
          them sit git with CI/CD, sites on your domain, Drive, notes, knowledge pages and, once an
          admin turns it on, email. A change to protected code waits for a person’s yes, or merges by
          itself once the owner turns on auto-merge, and the owner is told either way.
        </p>
        <p>
          None of your data comes to us: only a daily report of counts and the contact you chose,
          which your admin sees and can turn off. Our clean run on 29 October took 13 min 24 s from a
          new Fly organization to ready. An admin upgrades from the Workspace, and an upgrade that
          fails puts the old release back by itself.<Cite ids={['installer']} /> It is free for now,
          with no licence and no key, and the whole platform is{' '}
          <A href="/open-source">open source under the AGPL-3.0</A>, so your team can read what it
          creates before anyone says yes.
        </p>
      </Part>
      {/* The home page's drawing of what runs on whose side. */}
      <div className={`${SECTION} pb-8 sm:pb-10`}>
        <SidesArt />
      </div>

      <Part id="not-fit" heading="Where it does not fit.">
        <p>
          Know these before you install. It runs on Fly, not on AWS or Google Cloud, so credits with
          those clouds do not apply; <A href={WHY_FLY_PATH}>why it runs on Fly</A> is its own page.
          The installer does not join it to your company’s existing network, so agents that must
          reach an internal database need a way in that you set up. There is no single sign-on:
          people sign in with a name and a password, and an authenticator code if they choose.
        </p>
        <p>
          The models are Anthropic’s and OpenAI’s, reached through your own plans, so this is not a
          way to keep code away from a model provider. And if one developer wants one agent on one
          laptop, Claude Code on its own is simpler.
        </p>
      </Part>

      {/* ── Three ways ──────────────────────────────────────────────────── */}
      <section id="compare" className={`${SECTION} pb-8 sm:pb-10`}>
        <ChapterDivider />
        <h2 className={`max-w-[760px] [text-wrap:balance] ${H2}`}>The three ways, side by side.</h2>
        <table className="mt-10 hidden w-full table-fixed border-collapse text-left lg:table">
          <thead>
            <tr>
              <td className="w-[19%] pb-4" />
              {WAYS.map(([way, key]) => (
                <th key={key} scope="col" className={`pb-4 pl-6 align-bottom type-sm font-semibold ${key === 'ours' ? 'text-white' : 'text-hint'}`}>{way}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.need} className="border-t border-hint/16 align-top">
                <th scope="row" className={`py-6 pr-4 [text-wrap:pretty] ${H3}`}>{row.need}</th>
                {WAYS.map(([way, key]) => (
                  <td key={way} className={`py-6 pl-6 [text-wrap:pretty] type-sm ${key === 'ours' ? 'text-white' : 'text-hint'}`}>
                    {row[key].text}<Cite ids={row[key].cite} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-8 lg:hidden">
          {ROWS.map((row) => (
            <div key={row.need} className="border-t border-hint/16 py-6">
              <h3 className={`[text-wrap:pretty] ${H3}`}>{row.need}</h3>
              <dl className="mt-4 grid gap-4">
                {WAYS.map(([way, key]) => (
                  <div key={way}>
                    <dt className={`type-sm font-semibold ${key === 'ours' ? 'text-white' : 'text-hint'}`}>{way}</dt>
                    <dd className={`mt-1 [text-wrap:pretty] type-sm ${key === 'ours' ? 'text-white' : 'text-hint'}`}>{row[key].text}<Cite ids={row[key].cite} /></dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </section>

      {/* ── Questions your team will ask ────────────────────────────────── */}
      <section id="questions" className={`${SECTION} pb-8 sm:pb-10`}>
        <ChapterDivider />
        <h2 className={`max-w-[760px] [text-wrap:balance] ${H2}`}>Questions your team will ask.</h2>
        <dl className="mt-8">
          {QUESTIONS.map(({ q, a }) => (
            <div key={q} className="grid gap-2 border-t border-hint/16 py-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
              <dt className={`[text-wrap:balance] ${H3}`}>{q}</dt>
              <dd className={`max-w-[36rem] [text-wrap:pretty] ${LEAD}`}>{a}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* ── The door: the agent's line itself ───────────────────────────── */}
      <section id="door" className={`${SECTION} pb-10 sm:pb-12`}>
        <ChapterDivider />
        <div className={`${CARD} lg:p-8`}>
          <h2 className={`max-w-[700px] [text-wrap:balance] ${H2}`}>Build your own Agentic Cloud.</h2>
          <h3 className="mt-7 type-md-sm font-semibold text-white">Give this to your agent</h3>
          <div className="mt-3 max-w-[760px]">
            <AgentLine />
          </div>
          <div className="mt-7 flex flex-wrap items-center gap-7">
            <SecondaryLink href={FOUNDER_MAILTO}>Write to the founder</SecondaryLink>
          </div>
        </div>
      </section>

      {/* ── Sources ──────────────────────────────────────────────────────── */}
      <section id="sources" className={`${SECTION} pb-16 sm:pb-24`}>
        <h2 className={`[text-wrap:balance] ${H3}`}>Sources, each read on {SOURCES_READ_ON}</h2>
        <ol className={`mt-4 list-decimal space-y-2 pl-5 ${BODY} marker:text-hint/70`}>
          {SOURCES.map((source, at) => (
            <li key={source.id} id={`source-${at + 1}`} className="min-w-0 scroll-mt-20 break-words [text-wrap:pretty]">
              <a href={source.url} className="text-hint underline decoration-hint/35 underline-offset-2 hover:text-white">{source.label}</a>
            </li>
          ))}
        </ol>
      </section>

      <SiteFooter pitch={FOOTER_PITCH} tone="dark" />
    </main>
  );
}
