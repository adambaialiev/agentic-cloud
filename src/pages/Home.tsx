import type { ReactNode } from 'react';
import SiteHeader from '../components/SiteHeader';
import SiteFooter from '../components/SiteFooter';
import { FOOTER_PITCH } from '../lib/product-copy';
import LiveChief from '../components/LiveChief';
import LiveAgent from '../components/LiveAgent';
import { LiveKnowledge, LiveSecrets } from '../components/LiveSurfaces';
import { ChapterDivider, H2, HOME_SECTION_END, LEAD, PrimaryLink, SECTION } from '../components/landing-kit';
import LiveFleet from '../components/LiveFleet';
import LivePeople from '../components/LivePeople';
import WorkplaceArt from '../components/WorkplaceArt';
import { FLEET } from '../components/live/fixture';
import { ForYourTeam, HowToStart, OwnCloud, TalkToUs } from './PrivateCopy';

/**
 * The one home page, for a stranger and for a CTO who arrives from a cold
 * email. Since note #835 (the owner, 29 Oct 2026, 18:10 UTC) it leads with the
 * product and the problem it solves: "coding agents are great engineers with
 * no workplace around them", in five faces, each answered by the product's own
 * panel (the team view, knowledge pages, Secrets, an agent's own computer, the
 * Chief of Staff and notes). Then the second "wow": all of it runs in your company's own cloud (the deal from
 * /own-cloud, note #829), how to start, for your team, and the close. The
 * long product tour lives on /product only. /own-cloud and /private-copy
 * answer with a permanent redirect to /, and /own-cloud.md, the agent's
 * guide, does not move.
 *
 * Before: note #832 merged the home page and /own-cloud into one page that
 * opened on the data ("What makes your agents good stays yours.", note #830)
 * and the install line; before that, the founder's own system (notes #786,
 * #791), "Agents come and go. Your context stays." (note #790) and the whole
 * ProductPitch (note #789).
 *
 * The founder's week ("The founder runs the company on it.", the live
 * card from his builder page, note #786) came off with note #835 to keep the
 * page its length; /adam still has it.
 */

/* Written from the owner's phrase "coding agents are great engineers with no
   workplace around them" (note #835), never as it (landing-copy-rules). */
const HEADLINE_FIRST = 'Your agents are great engineers.';
const HEADLINE_SECOND = 'Give them a workplace.';
export const HOME_HEADLINE = `${HEADLINE_FIRST} ${HEADLINE_SECOND}`;

/* The people section is the hook (note #926, the owner, 31 Oct 2026, 15:16
   UTC: "people see each other's contribution made by their agent … we
   should pitch it agressively, because it's a hook"). It leads with people
   and what their agents shipped, where it said "See what every agent is
   doing." until then, and its cards carry the product's own This week
   block (note #925). The other heading offered: "Every agent has a person
   behind it. Everyone sees what they shipped." */
export const TEAM_HEADING = 'See what everyone’s agents shipped. Live.';

/* The first screen's one door since note #924, a text link like the page's
   others, to How to start. Null leaves nothing under the line. */
const HERO_DOOR: string | null = 'How to start';

/* One face of the problem (note #835): the heading promises the answer, the
   paragraph names the problem it answers, and the real panel proves it.
   Since note #839 (the owner, 30 Oct, 12:33 UTC: five sections in a row
   looked the same) the rhythm varies on a desk: the panel takes the left
   side every other section (side="left"). Since note #924 the Chief of
   Staff's chat sits beside its words too, as every other panel does; it ran
   wide under them, centred, with blank space to its right. A phone reads
   every one words first. */
type FaceSide = 'right' | 'left';
function Face({ id, heading, children, panel, side = 'right' }: { id: string; heading: string; children: string; panel: ReactNode; side?: FaceSide }) {
  return (
    <section id={id} className={`${SECTION} ${HOME_SECTION_END}`}>
      <ChapterDivider tight />
      <div className={`grid gap-6 sm:gap-7 lg:items-center lg:gap-14 ${side === 'left' ? 'lg:grid-cols-[1.2fr_0.8fr]' : 'lg:grid-cols-[0.8fr_1.2fr]'}`}>
        <div data-face-words className={side === 'left' ? 'lg:order-2' : undefined}>
          <h2 className={`[text-wrap:balance] ${H2}`}>{heading}</h2>
          <p className={`mt-4 max-w-[30rem] [text-wrap:pretty] sm:mt-5 ${LEAD}`}>{children}</p>
        </div>
        <div className={`min-w-0 ${side === 'left' ? 'lg:order-1' : ''}`}>{panel}</div>
      </div>
    </section>
  );
}

export default function Home() {
  return (
    <main
      className="landing-page copy-page min-h-dvh overflow-x-clip bg-panel text-white"
      style={{ fontFamily: 'var(--font-ui)' }}
    >
      <SiteHeader ctaTarget="none" tone="dark" />

      {/* ── First screen: the problem, and the product ──────────────────── */}
      {/* Note #835 (the owner, 29 Oct, 18:10 UTC): the page leads with the
          product and the problem it solves; the own cloud is the second
          "wow". The headline is written from his phrase "coding agents are
          great engineers with no workplace around them", and the line under
          it names the five faces of that problem in the order the sections
          answer them. Until then the page opened on note #830's data line,
          "What makes your agents good stays yours.", which leads the own-
          cloud chapter now. */}
      {/* Since note #839 the first screen carries a picture on a desk, as
          every section under it does: the Workspace's own agent list, two
          agents mid-job with their line on the latest work (LiveFleet),
          level with the words. A phone keeps the words only. Note #924 (the
          owner, 31 Oct, 14:59 UTC: "I'm worried about 'Build yours' button.
          Sounds confusing. Maybe remove the button at all") took the ink
          button off: the page has no call to action, and its one way to
          start is the How to start section. HERO_DOOR is the plain text link
          offered in its place. */}
      <section id="home-top" className={`${SECTION} grid gap-10 pb-10 pt-14 sm:pb-12 sm:pt-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] lg:items-center lg:gap-x-14 lg:gap-y-7`}>
        <div>
          {/* One sentence a line, so a phone never breaks "Give" from its
              sentence; the space between keeps the heading's name whole. */}
          <h1 className={`max-w-[1000px] [text-wrap:balance] ${H2}`}>
            <span className="block">{HEADLINE_FIRST}</span>{' '}
            <span className="block">{HEADLINE_SECOND}</span>
          </h1>
          <p id="homeWhat" className={`mt-5 max-w-[640px] [text-wrap:pretty] ${LEAD}`}>
            Your Claude Code and Codex agents get what every engineer gets on day one: a team that
            sees their work, a memory, the keys, a computer of their own and a lead who hands out
            the jobs.
          </p>
        </div>
        <div id="home-fleet" className="hidden min-w-0 lg:block">
          <LiveFleet
            size="tile"
            fleet={FLEET.slice(0, 2)}
            says="The Workspace’s agent list: Ruby and Milo, both on Claude Code, each mid-job on its own computer, with the line on its latest work."
          />
        </div>
        {/* A row of its own under the words, so the cards stay level with
            the headline and its line whether or not the door is there. */}
        {HERO_DOOR ? (
          <div id="home-door" className="-mt-3 lg:col-start-1 lg:mt-0">
            <PrimaryLink href="#start">{HERO_DOOR}</PrimaryLink>
          </div>
        ) : null}
      </section>

      {/* ── The whole workplace, at a glance (note #841) ──────────────────── */}
      {/* The owner, 30 Oct 2026, 13:31 UTC: "We should have some illustration
          that illustrated the workplace around agents." The headline promises
          a workplace and the five sections below show one part each; this
          floor plan shows all of it first, so the page zooms in after it. The
          heading is the section's only words: the plan's own labels carry the
          rest, and its two lines carry the rule (jobs out, proposals back to
          your yes). */}
      <section id="workplace" className={`${SECTION} ${HOME_SECTION_END}`}>
        <ChapterDivider tight />
        <h2 className={`[text-wrap:balance] ${H2}`}>Here’s the workplace.</h2>
        <div className="mt-8 min-w-0 sm:mt-10">
          <WorkplaceArt />
        </div>
      </section>

      {/* ── The five faces of the problem (the owner's list, 29 Oct) ──────── */}
      {/* Each is one paragraph, problem then answer (landing-copy-rules), beside
          the product's own panel on the Northstar fixture. Since note #840
          the team view is live too (LivePeople: the People page's own cards
          for two teammates); until then it was a picture shot from the
          Workspace, with a "You" and "Admin" card and a grey outline. The
          fourth face is the workplace itself, a desk where today there is a
          terminal tab (the owner, 29 Oct, 18:59 UTC). Until then it was
          "Close the laptop. The work goes on.", which he called an old
          narrative: the cloud computer is part of the workplace here, never
          "beyond the laptop" as the reason to choose us (claims-we-never-
          make). */}
      <Face
        id="team"
        heading={TEAM_HEADING}
        panel={<LivePeople />}
      >
        One Claude Code per engineer is a dozen private silos. Here each person’s agents sit under
        their name, and the whole team sees who is driving what, what each agent is on, and what
        their agents shipped this week: agent hours, changes merged, tokens written and the latest
        change. Live, for every member of the workplace, not only the lead. Never the chat behind it.
      </Face>
      <Face id="memory" side="left" heading="No session starts from zero." panel={<LiveKnowledge />}>
        A terminal session forgets everything when it closes, so every job begins with you
        explaining it all again. Here agents write what they learn into knowledge pages and read
        them before every job.
      </Face>
      <Face id="keys" heading="Add a key once. Every agent can use it." panel={<LiveSecrets />}>
        Today a key gets pasted into a chat or left in a file on somebody’s laptop. Here your agents
        use it by name, and nobody pastes it anywhere.
      </Face>
      <Face id="computers" side="left" heading="A desk for every agent." panel={<LiveAgent size="tile" showSoftware={false} />}>
        A new engineer gets a desk on day one. Your agent gets a terminal tab. Here every agent
        arrives on a cloud computer of its own, already set up with git, CI and hosting. Nothing
        depends on your laptop.
      </Face>
      <Face id="work" heading="Hand out work from one chat." panel={<LiveChief />}>
        A terminal agent works only while you sit and type to it. Here you write a job down once and
        hand it to an agent, or tell your Chief of Staff what you want and get back only what needs
        your yes. You give it from your phone.
      </Face>

      {/* ── The second wow: all of it in your own cloud ─────────────────── */}
      <OwnCloud />
      <HowToStart />
      <ForYourTeam />
      <TalkToUs />

      <SiteFooter pitch={FOOTER_PITCH} tone="dark" />
    </main>
  );
}
