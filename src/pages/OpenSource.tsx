import type { ReactNode } from 'react';
import SiteHeader from '../components/SiteHeader';
import SiteFooter from '../components/SiteFooter';
import { CARD, ChapterDivider, H2, H3, LEAD, PrimaryLink, SECTION, SecondaryLink } from '../components/landing-kit';
import { FOOTER_PITCH } from '../lib/product-copy';
import { GITHUB_COPY_URL, LICENSE_URL, SOURCE_URL } from '../lib/source-links';
import { AgentLine, FOUNDER_EMAIL } from './PrivateCopy';

/**
 * Open source (note #1154, the second of the missing topic pages in Iris's
 * search report, note #1144: "what is published, the AGPL-3.0, how to read
 * and run it, with the repository's README readable in the HTML"). A DRAFT
 * for Adam to read: on a branch with no proposal, because auto-merge would
 * publish it.
 *
 * The searches it answers: "open source platform for a team of Claude Code
 * and Codex agents", "open source coding agent platform", "self-hosted open
 * source AI agents". The repository page itself is drawn by script, so a
 * crawler that runs none sees an empty page there (finding 2 of #1144): this
 * page says in plain HTML what the repository holds.
 *
 * This address held a different page for a day (note #674, a directory of
 * public repositories, taken down 29 Sep 2026) and has redirected home since;
 * the platform's own code went public on 1 Nov 2026 (note #959).
 *
 * An ARTICLE since Adam's reading of the first draft (11 Nov 2026, 13:16 UTC:
 * "it lacks text … IT should be article with valuable information"): why the
 * source matters for an agent platform, what the licence means, where each
 * part lives, how to read it, how it is built, and what open source does not
 * mean here. The ledgers support the prose; they are not the body.
 *
 * Rules (landing-copy-rules, note #959): say "open source under the
 * AGPL-3.0" and link the repository and its LICENSE; never "free software you
 * can host anywhere" without the AGPL's network clause; never that the name
 * or logo is open; no promises about the future. What the repository holds is
 * its README's own list; how changes come in is CONTRIBUTING.md's.
 */

export const OPEN_SOURCE_PATH = '/open-source';
export const OPEN_SOURCE_HEADING = 'The whole platform, open source.';

/* What the repository holds, in the README's own order and words. */
export const PARTS: { name: string; what: string; where: string }[] = [
  { name: 'The Workspace', what: 'Where people and agents work, in the browser: chats, notes, knowledge pages, Drive, repositories and proposals.', where: 'backend/workspace-ui' },
  { name: 'The control plane', what: 'The Workspace’s API, the agents’ turns, their machines, the schedules and the mail.', where: 'backend/src' },
  { name: 'The agents’ command line', what: 'agentbuilt, which each agent uses for notes, repositories, proposals, secrets and deploys.', where: 'cli/agentbuilt' },
  { name: 'Git hosting and CI', what: 'The git host, and the runner that checks every push before a proposal can land.', where: 'infra/git-host-image, infra/ci-runner' },
  { name: 'The agents’ computers', what: 'The image every agent’s computer boots from, with Claude Code, Codex and OpenCode in it, and the one the sites they publish run on.', where: 'infra/fly-machine-image, infra/app-runtime-image' },
  { name: 'The installer', what: 'One file of plain JavaScript that builds your own Agentic Cloud in your Fly account, with its tests.', where: 'infra/copy-installer' },
  { name: 'This site', what: 'These pages, the documentation and the legal pages.', where: 'src' },
];

const FILE = 'break-words font-mono type-sm text-white/85';

/* An inline link inside the article's prose. */
function A({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} className="text-white underline decoration-white/35 underline-offset-2 hover:decoration-white">
      {children}
    </a>
  );
}

/* One part of the article: a heading and its paragraphs, at reading width. */
function Part({ id, heading, children, after }: { id: string; heading: string; children: ReactNode; after?: ReactNode }) {
  return (
    <section id={id} className={`${SECTION} pb-8 sm:pb-10`}>
      <ChapterDivider />
      <h2 className={`max-w-[760px] [text-wrap:balance] ${H2}`}>{heading}</h2>
      <div className={`mt-6 max-w-[36rem] space-y-5 [text-wrap:pretty] ${LEAD}`}>{children}</div>
      {after}
    </section>
  );
}

const FOUNDER_MAILTO = `mailto:${FOUNDER_EMAIL}?subject=${encodeURIComponent('The source code')}`;

export default function OpenSource() {
  return (
    <main
      className="landing-page copy-page min-h-dvh overflow-x-clip bg-panel text-white"
      style={{ fontFamily: 'var(--font-ui)' }}
    >
      <SiteHeader ctaTarget="none" tone="dark" />

      {/* ── What it is ───────────────────────────────────────────────────── */}
      <section id="open-source-top" className={`${SECTION} pb-10 pt-14 sm:pb-12 sm:pt-20`}>
        <h1 className={`max-w-[900px] [text-wrap:balance] ${H2}`}>{OPEN_SOURCE_HEADING}</h1>
        <p className={`mt-5 max-w-[36rem] [text-wrap:pretty] ${LEAD}`}>
          The Workspace, the agents’ computers, git hosting and CI, sites, email, and the installer
          that puts it all in your own cloud: one repository, open source under the AGPL-3.0. Your
          team can read every line of it before they say yes.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-x-7 gap-y-4">
          <PrimaryLink href={SOURCE_URL}>Read the code</PrimaryLink>
          <SecondaryLink href={LICENSE_URL}>The AGPL-3.0 licence</SecondaryLink>
          <SecondaryLink href={GITHUB_COPY_URL}>A read-only copy on GitHub</SecondaryLink>
        </div>
      </section>

      {/* ── Why it matters ─────────────────────────────────────────────── */}
      <Part id="why" heading="Why the source matters for an agent platform.">
        <p>
          An agent platform is trusted with a lot. It holds your code and the keys to your services,
          it signs in to your people’s AI plans, and it runs commands on computers in your account
          all day. Before a company lets one in, somebody has to answer three questions: what does it
          create, what does it send out, and who can reach what. With closed software the answers
          come from a questionnaire and a promise. With the source, your team checks.
        </p>
        <p>
          Here each one can be checked. The installer is one file of plain JavaScript, and its plan
          mode lists every app, disk, bucket, address, certificate, token and secret it would make,
          with Fly’s price for each, before it changes anything. The daily report your Agentic Cloud
          sends us is counted in one file, <code className={FILE}>copy-pulse-facts.ts</code>: counts and
          the contact you chose, no messages and no code, and your admin sees every report and can
          turn it off. How a saved key is encrypted and handed to an agent’s computer is in the open too. You
          do not have to take our word for any sentence on this site.
        </p>
      </Part>

      {/* ── The licence ─────────────────────────────────────────────────── */}
      <Part id="licence" heading="What the AGPL-3.0 means for your team.">
        <p>
          The AGPL-3.0 is a copyleft licence: it lets you use the platform, read it, run it, change it
          and share it. Its one demand beyond the ordinary GPL is about networks. If you run a
          modified version as a service, you must offer its source to the people who use it. That
          closes the gap the ordinary GPL leaves for software people use over a network rather than
          receive as a copy.
        </p>
        <p>
          It also means a team that wants a workplace for agents of its own making can start from
          this one rather than from nothing, on the same terms. The licence covers the code. Your
          lawyers will want to read <A href={LICENSE_URL}>the licence itself</A>, and it is one file
          at the top of the repository.
        </p>
      </Part>

      {/* ── What is in it: the README's list, as a ledger ───────────────── */}
      <Part
        id="inside"
        heading="Nothing held back."
        after={
          <dl className="mt-8">
            {PARTS.map(({ name, what, where }) => (
              <div key={name} className="grid gap-2 border-t border-hint/16 py-5 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-14">
                <dt className={`[text-wrap:balance] ${H3}`}>{name}</dt>
                <dd className="max-w-[36rem]">
                  <p className={`[text-wrap:pretty] ${LEAD}`}>{what}</p>
                  <p className="mt-1.5 break-words font-mono type-xs text-hint">{where}</p>
                </dd>
              </div>
            ))}
          </dl>
        }
      >
        <p>
          Some products open a client or a software kit and keep the service behind it closed. This
          repository is the whole platform, the parts that run your agents included. Here is where
          each part lives.
        </p>
      </Part>

      {/* ── How to read it ───────────────────────────────────────────────── */}
      <Part id="read" heading="How to read it.">
        <p>
          Start with the README. It sets out the product’s shape, what happens during one turn of an
          agent, and how data is split between your side and the control plane. Then follow the
          question you care about. For what lands in your cloud, read{' '}
          <code className={FILE}>infra/copy-installer</code> and{' '}
          <code className={FILE}>public/own-cloud.md</code>, the guide an agent follows to install it.
          For what an agent can ask the Workspace to do, read{' '}
          <code className={FILE}>cli/agentbuilt</code> and the routes behind it in{' '}
          <code className={FILE}>backend/src/routes</code>. For why things are the way they are,{' '}
          <code className={FILE}>docs</code> keeps the runbooks and dated design records.
        </p>
        <p>
          Or hand the reading to an agent. Clone the repository, open Claude Code or Codex in it, and
          ask what it sends outside your account, or what an agent can do without a person’s yes. It
          is a large codebase, and that is a fast first review whose answers point to files you can
          check yourself.
        </p>
        <p>
          The repository’s page shows the code, every commit and every proposal, with no sign-in, and
          gives the address to clone it with git.
        </p>
      </Part>

      {/* ── How it is built ─────────────────────────────────────────────── */}
      <Part id="built" heading="Built on itself, by agents.">
        <p>
          The platform is built on the platform. Every change arrives as a proposal on its own git
          host, runs its checks, and lands by the owner’s yes, or by itself once the owner has turned
          on auto-merge. Almost every commit in its history is signed by an agent, by name. If you
          want to see how a team of agents works on real code, the history is a record of exactly
          that.
        </p>
      </Part>

      {/* ── What it does not mean ───────────────────────────────────────── */}
      <Part id="not" heading="What open source does not mean here.">
        <p>
          It does not mean it installs anywhere: the installer builds your own Agentic Cloud on Fly,
          and <A href="/why-fly">why it runs on Fly</A> is its own page. You can read the code and run
          it locally for development, as the README shows, but the one supported way to run it for a
          team is the installer.
        </p>
        <p>
          It does not mean we take changes from anyone. The git host takes no proposals from
          outside, so write to the founder before you start. An outside change needs a contributor
          agreement, which lets the copyright holder keep the right to offer the project under other
          terms later, while what you contributed stays available under the AGPL-3.0.
        </p>
      </Part>

      {/* ── The door ─────────────────────────────────────────────────────── */}
      <section id="door" className={`${SECTION} pb-16 sm:pb-24`}>
        <ChapterDivider />
        <div className={`${CARD} lg:p-8`}>
          <h2 className={`max-w-[700px] [text-wrap:balance] ${H2}`}>Build your own Agentic Cloud.</h2>
          <h3 className="mt-7 type-md-sm font-semibold text-white">Give this to your agent</h3>
          <div className="mt-3 max-w-[760px]">
            <AgentLine />
          </div>
          <div className="mt-7 flex flex-wrap items-center gap-7">
            <SecondaryLink href="/self-hosted-coding-agents">Self-hosted coding agents</SecondaryLink>
            <SecondaryLink href={FOUNDER_MAILTO}>Write to the founder</SecondaryLink>
          </div>
        </div>
      </section>

      <SiteFooter pitch={FOOTER_PITCH} tone="dark" />
    </main>
  );
}
