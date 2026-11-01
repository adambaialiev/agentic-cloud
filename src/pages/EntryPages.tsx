import SiteHeader from '../components/SiteHeader';
import SiteFooter from '../components/SiteFooter';
import { BODY, CARD, ChapterDivider, H2, LEAD, PrimaryLink, SECTION, SecondaryLink } from '../components/landing-kit';
import { FOOTER_PITCH, type Faq } from '../lib/product-copy';
import {
  AGENTS_FOR_YOUR_TEAM,
  CLAUDE_CODE_IN_THE_CLOUD,
  CODEX_IN_THE_CLOUD,
  type EntrySpec,
} from '../lib/entry-specs';
import { PRIVATE_COPY_DOOR, PRIVATE_COPY_URL, WORKSPACE_SIGN_IN_URL } from '../lib/workspace-link';
import firstJob from '../assets/landing/first-job.png';

/**
 * The entry pages: three addresses for three questions people arrive with,
 * each answered with the running product (note 139).
 *
 * What this is NOT is a second product tour. The front page is canonical and
 * says everything; these pages each answer ONE question a search brings
 * someone in with, using that page's own claims, its own live panels and its
 * own door — then send the reader to the front page for the rest. Every
 * sentence here is either the landing's or checkable against the product; the
 * FAQ answers are quoted from lib/product-copy.ts rather than rewritten, so
 * there is one copy of each answer on the whole site.
 *
 * Why these three, on 2026-09-07 evidence rather than a guess: the twelve
 * retired /guides articles are the only record we have of which doors we ever
 * opened (there is no analytics build-out and no Search Console — see
 * the go-to-market strategy, kept privately, "Measurement"). Their slugs cluster into
 * exactly two intents that this product honestly answers — running a coding
 * CLI on a machine that stays up (claude-code-in-the-cloud, -on-a-vps,
 * keep-claude-code-running, background-agents), and a company wanting agents
 * for its team (ai-agent-for-a-small-business, what-to-hand-an-ai-engineer).
 * Codex gets its own address because the h1 names it and its readers search
 * for it by name, not for Claude Code. The three guides that had to be
 * corrected or removed for lying (hire-an-ai-engineer's monthly fee,
 * openclaw-hosting's one-bot-per-agent) are deliberately NOT rebuilt.
 */

function FaqGrid({ faqs }: { faqs: Faq[] }) {
  return (
    <dl className="mt-10 grid gap-4 sm:mt-12 lg:grid-cols-2 lg:gap-5">
      {faqs.map(({ question, answer, docs }) => (
        <div key={question} className="rounded-2xl bg-panel-soft p-5 sm:p-6">
          <dt className="type-base font-semibold text-white">{question}</dt>
          <dd className={`mt-2 max-w-[560px] ${BODY}`}>
            {answer}{' '}
            <a href={docs} className="whitespace-nowrap text-hint underline decoration-white/20 underline-offset-2 hover:text-white">More in the docs</a>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function EntryPage({ spec }: { spec: EntrySpec }) {
  return (
    <main
      className="landing-page min-h-dvh overflow-hidden bg-panel text-white"
      style={{ fontFamily: 'var(--font-ui)' }}
    >
      <SiteHeader ctaTarget="none" tone="dark" />

      <section className={`${SECTION} pt-14 sm:pt-20`}>
        <h1 className="max-w-[1040px] type-lg text-white sm:type-xl lg:type-2xl">{spec.h1}</h1>
        <p className={`mt-6 max-w-[760px] ${LEAD}`}>{spec.lead}</p>
        <div className="mt-8 flex flex-wrap items-center gap-7">
          <PrimaryLink href={PRIVATE_COPY_URL}>{PRIVATE_COPY_DOOR}</PrimaryLink>
          {/* Every entry page owes the reader the whole story somewhere, and
              it is one page away rather than retold here. */}
          <SecondaryLink href="/product">See the whole product</SecondaryLink>
        </div>
      </section>

      {spec.blocks.map((block) => (
        <section key={block.heading} className={`${SECTION} pb-8 pt-10 sm:pb-10 sm:pt-14`}>
          <ChapterDivider />
          <div
            className={`grid gap-10 lg:items-center lg:gap-14 ${
              block.panelFirst ? 'lg:grid-cols-[1.1fr_0.9fr]' : 'lg:grid-cols-[0.9fr_1.1fr]'
            }`}
          >
            <div className={block.panelFirst ? 'lg:order-2' : undefined}>
              <h2 className={H2}>{block.heading}</h2>
              {block.body ? <p className={`mt-5 max-w-[470px] ${LEAD}`}>{block.body}</p> : null}
            </div>
            <div className={`min-w-0 ${block.panelFirst ? 'lg:order-1' : ''}`}>{block.panel}</div>
          </div>
        </section>
      ))}

      {spec.faqs ? (
        <section className={`${SECTION} pb-8 sm:pb-10`}>
          <ChapterDivider />
          <h2 className={H2}>The questions people actually ask.</h2>
          <FaqGrid faqs={spec.faqs} />
        </section>
      ) : null}

      <section className={`${SECTION} pb-16 sm:pb-24`}>
        <ChapterDivider />
        <div className={`${CARD} grid gap-8 lg:grid-cols-[1fr_auto] lg:items-center lg:gap-14 lg:p-10`}>
          <div>
            <h2 className={`max-w-[700px] ${H2}`}>{spec.closing}</h2>
            <div className="mt-7 flex flex-wrap items-center gap-7">
              <PrimaryLink href={PRIVATE_COPY_URL}>{PRIVATE_COPY_DOOR}</PrimaryLink>
              <SecondaryLink href={WORKSPACE_SIGN_IN_URL}>Sign in</SecondaryLink>
            </div>
          </div>
          <img
            src={firstJob}
            alt="A pixel-art copper-red Irish Setter sitting in a relaxed three-quarter pose and looking toward the viewer."
            width={181}
            height={181}
            className="pixel-art w-[176px] justify-self-start lg:w-[264px] lg:justify-self-end"
          />
        </div>
      </section>

      <SiteFooter pitch={FOOTER_PITCH} tone="dark" />
    </main>
  );
}

export default function ClaudeCodeInTheCloud() {
  return <EntryPage spec={CLAUDE_CODE_IN_THE_CLOUD} />;
}

export function CodexInTheCloud() {
  return <EntryPage spec={CODEX_IN_THE_CLOUD} />;
}

export function AiAgentsForYourTeam() {
  return <EntryPage spec={AGENTS_FOR_YOUR_TEAM} />;
}
