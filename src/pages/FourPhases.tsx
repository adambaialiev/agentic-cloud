import SiteHeader from '../components/SiteHeader';
import SiteFooter from '../components/SiteFooter';
import LiveMarquee from '../components/LiveMarquee';
import PhaseArt, { type Phase } from '../components/PhaseArt';
import { Arrow, BODY, CARD, ChapterDivider, H2, H3, LEAD, PrimaryLink, SECTION, SecondaryLink } from '../components/landing-kit';
import { FOOTER_PITCH } from '../lib/product-copy';
import { PRIVATE_COPY_DOOR, PRIVATE_COPY_URL, WORKSPACE_SIGN_IN_URL } from '../lib/workspace-link';
import firstJob from '../assets/landing/first-job.png';

/**
 * The four phases of AI at work, on a page of their own (the owner, note
 * #199, 2026-10-09).
 *
 * The section stood on the front page from 2026-10-04 (note #172): AI at work
 * has come in four phases, and Agentic Cloud Computer is the fourth. The
 * owner took it off the front page and asked for it here, with more said
 * about each phase. So the row is the section as it was, word for word and
 * drawing for drawing, and under it each phase gets a chapter of its own.
 *
 * The framing is a common one (chat, chat that can see your files, agents
 * with a computer, then the team); the words are ours. The first three are
 * told as what they leave you doing, so the fourth reads as the step past one
 * agent: one person with a team of them. Until note #206 the fourth was a
 * team of agents working with a team of people; inviting is switched off
 * and a workplace is one person's, so the team is the agents. No tool is
 * named for contrast, and phase two must not read as a promise that we
 * connect to anybody's Slack or Drive (claims-we-never-make).
 *
 * Phases one to three are other kinds of tool, so they are words and
 * drawings. The fourth is the product, so its chapter is the only one with a
 * live panel: the moving row of the team at work that opened the front page
 * from note #185 until note #199 — one person, his agents and what passes
 * between them, which is the fourth phase itself.
 */

const phases = [
  { title: 'Chat', body: 'You ask, it answers. Then you do the work.' },
  { title: 'Connected chat', body: 'It reads your files before it answers. You still do the work.' },
  { title: 'Agents with a computer', body: 'An agent does the work on a machine of its own, one job at a time.' },
  { title: 'A team of agents working with you', body: 'Your agents work in one place, together. Every job starts from what all of them know.' },
] as const;

/* One chapter per phase, in the page's calm pitch voice (landing-copy-rules):
   a heading that promises, one paragraph, the last line short. */
const chapters = [
  {
    heading: 'A faster start. The same finish.',
    body:
      'Most of us met AI at work in a chat box. Ask for a draft, an explanation or a fix, and a good one '
      + 'comes back in seconds. Then you copy it out, check it, paste it in and send it. Every answer '
      + 'still had to be carried into the work by hand. By you.',
  },
  {
    heading: 'Better answers. Still yours to carry.',
    body:
      'Then the chat began to read before it answered: the file you attached, the folder you opened, the '
      + 'code on your screen. The answers stopped sounding like anyone’s and started sounding like yours. '
      + 'The conversation still ended the same way, with one person and a list of things to do.',
  },
  {
    heading: 'The work gets done. One job at a time.',
    body:
      'Then the agent got a computer to work on: a terminal, the files, the tests. Ask for a fix and the '
      + 'fix comes back, tested. It is the biggest step yet, and it is still one pair of hands. One agent '
      + 'in one terminal, and everything around the code is still yours to set up.',
  },
  {
    heading: 'One agent becomes a team.',
    body:
      'In the fourth phase you stop working with one agent and start running a team of them. Each has a '
      + 'name, a face and everything it needs built in: git, hosting, storage, email and Drive. They read '
      + 'what your team knows before every job, write back what they learned, and hand work to each other '
      + 'and to you. Every protected change comes back as a proposal. Agents prepare. You decide.',
  },
] as const;

export default function FourPhases() {
  return (
    <main
      className="landing-page min-h-dvh overflow-hidden bg-panel text-white"
      style={{ fontFamily: 'var(--font-ui)' }}
    >
      <SiteHeader ctaTarget="none" tone="dark" />

      {/* ── The four phases ─────────────────────────────────────────────── */}
      {/* The front page's section, moved whole: its heading is this page's
          h1. Each phase has a small drawing over its words (the owner asked
          for more visuals, note #172; see PhaseArt); the fourth is ringed in
          ink and carries the product's name, so the row reads as arriving
          here. */}
      <section id="phases" className={`${SECTION} pb-8 pt-14 sm:pb-10 sm:pt-20`}>
        <h1 className="max-w-[1040px] type-lg text-white sm:type-xl lg:type-2xl">
          AI at work has four phases. Start in the fourth.
        </h1>
        <p className={`mt-6 max-w-[640px] ${LEAD}`}>
          The first three made one person faster. The fourth gives that person a team.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-7">
          <PrimaryLink href={PRIVATE_COPY_URL}>{PRIVATE_COPY_DOOR}</PrimaryLink>
          <SecondaryLink href="/product">See the whole product</SecondaryLink>
        </div>
        <ol className="mt-12 grid gap-10 sm:mt-14 sm:grid-cols-2 sm:gap-8 lg:grid-cols-4">
          {phases.map(({ title, body }, index) => {
            const phase = (index + 1) as Phase;
            const here = phase === 4;
            return (
              <li key={title} aria-current={here ? 'step' : undefined} className="min-w-0">
                {/* One height for all four, so the words under them start on
                    one line (less on a phone, where the pictures are wider
                    and shorter). The fourth is ringed in ink, and an arrow
                    walks from each picture to the next where they stand in
                    a row. */}
                <div className={`relative h-[224px] rounded-2xl sm:h-[248px] ${here ? 'ring-2 ring-white' : ''}`}>
                  <PhaseArt phase={phase} />
                  {!here && (
                    <span className="absolute -right-6 top-1/2 hidden -translate-y-1/2 text-hint lg:block" aria-hidden="true">
                      <Arrow />
                    </span>
                  )}
                </div>
                <p className={`mt-5 type-sm font-semibold ${here ? 'text-white' : 'text-hint'}`}>
                  Phase {phase}{here ? ' · Agentic Cloud Computer' : ''}
                </p>
                <h3 className={`mt-2 ${H3}`}>{title}</h3>
                <p className={`mt-2 ${BODY}`}>{body}</p>
              </li>
            );
          })}
        </ol>
      </section>

      {/* ── One chapter per phase ───────────────────────────────────────── */}
      {/* The row says each phase in a sentence; these say what it was like
          to work in it. The label over each heading is the row's own, so a
          reader can find the drawing it belongs to. */}
      {chapters.map(({ heading, body }, index) => {
        const phase = (index + 1) as Phase;
        const here = phase === 4;
        return (
          <section key={heading} id={`phase-${phase}`} className={`${SECTION} pb-8 sm:pb-10`}>
            <ChapterDivider />
            <p className={`type-sm font-semibold ${here ? 'text-white' : 'text-hint'}`}>
              Phase {phase} · {here ? 'Agentic Cloud Computer' : phases[index].title}
            </p>
            <h2 className={`mt-3 max-w-[760px] ${H2}`}>{heading}</h2>
            <p className={`mt-5 max-w-[640px] ${LEAD}`}>{body}</p>
            {/* The fourth phase is the product, so it is the one chapter
                with the product running in it: the team at work, its
                person, its agents and what passes between them, across the
                page's whole width. See LiveMarquee. */}
            {here && (
              <div className="relative left-1/2 mt-10 w-screen -translate-x-1/2 sm:mt-14">
                <LiveMarquee />
              </div>
            )}
          </section>
        );
      })}

      {/* ── The door ─────────────────────────────────────────────────────── */}
      <section id="door" className={`${SECTION} pb-16 sm:pb-24`}>
        <ChapterDivider />
        <div className={`${CARD} grid gap-8 lg:grid-cols-[1fr_auto] lg:items-center lg:gap-14 lg:p-10`}>
          <div>
            <h2 className={`max-w-[700px] ${H2}`}>Step into the fourth phase.</h2>
            <div className="mt-7 flex flex-wrap items-center gap-7">
              <PrimaryLink href={PRIVATE_COPY_URL}>{PRIVATE_COPY_DOOR}</PrimaryLink>
              <SecondaryLink href={WORKSPACE_SIGN_IN_URL}>Sign in</SecondaryLink>
            </div>
          </div>
          {/* One of the pixel-art dogs every agent wears as a face, sat
              waiting before the first brief. */}
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
