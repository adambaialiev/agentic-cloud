import type { ReactNode } from 'react';
import SiteFooter from '../components/SiteFooter';
import { FOOTER_PITCH } from '../lib/product-copy';
import LiveChief from '../components/LiveChief';
import LiveAgent from '../components/LiveAgent';
import { LiveKnowledge, LiveSecrets } from '../components/LiveSurfaces';
import { H2, PrimaryLink, Screen } from '../components/landing-kit';
import LiveFleet from '../components/LiveFleet';
import LivePeople from '../components/LivePeople';
import WorkplaceArt from '../components/WorkplaceArt';
import { FLEET } from '../components/live/fixture';
import HomeFilm, { type Film, type Section } from '../components/HomeFilm';
import { filmUrl, PRODUCT_FILM_PATH, PRODUCT_FILM_TALL_PATH } from '../lib/films';
import productFilmPoster from '../assets/films/bookface-2006-home-film-framed-poster.jpg';
import productFilmTallPoster from '../assets/films/bookface-2006-home-film-vertical-framed-poster.jpg';
import { BUILD_YOURS, ForYourTeam, HowToStart, OwnCloud, TalkToUs } from './PrivateCopy';

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
   others. Since note #951 it names the page's one action, "Build your own
   Agentic Cloud", and opens the section headed with the same words (it said
   "How to start" until then, which did not say what you start). Null leaves
   nothing under the line. */
const HERO_DOOR: string | null = BUILD_YOURS;

/* The product moving (note #951, the landing piece of the growth note #950).
   Since note #956 (the owner, 3 Nov 2026, 05:40 UTC: "I'm not interested in
   the waitlist. I'm interested in the Facebook 2006 clone. Yes I want a story
   of Facebook clone") it is Iris's film of Bookface 2006 (note #955, 2 min
   41 s): about a minute of the site in use (Amy on a desk, Marcus on a phone,
   filmed 3 Nov 05:44 to 05:48 UTC), then how two people's four agents built
   it on the founder's own Agentic Cloud on 2 Nov: the ask at 17:50, the
   handout at 18:45, the first automatic merge at 18:47, 17 merged by 19:12.
   No waitlist; no code or password in any frame; the audio track is silent.
   Before it: the waitlist journey (notes #951, #952, #954), in Drive and on
   notes #932 and #950. The words beside it quote no clock time
   (entry-server.test: no prerendered clock); since note #958 there are no
   words beside it at all. The MP4's address comes from
   lib/films.ts (note #957), with the install film's; the poster is Iris's own, the site's photo album, with the
   play button in the empty band under the page.
   Since note #965 (the owner, 3 Nov 2026, 18:45 UTC, after Iris's new cut,
   note #963: "This video should be the first thing in the landing page and
   play automatically") it is that cut, made with HyperFrames: "Two people.
   Four agents. One social network, built in under 90 minutes.", 1 min 35 s,
   silent. It opens the page, above the headline, and plays by itself (muted,
   inline, looping; never for a visitor who asks for reduced motion), with no
   heading and no words beside it; its play button, shown only when it is
   not playing by itself, sits in the poster's empty lower left.
   Since note #970 (the owner, 4 Nov 2026, 06:27 UTC, after Iris's fourth
   cut, note #969: "Yes replace with the new one. Also remove controls from
   the video player") it is the fourth cut, 1 min 26 s, same poster, and the
   player never shows its controls. The install film lower down keeps its
   player as it was: his words were about this one. Since note #971 a tap
   pauses and resumes it.
   Since note #973 (the owner, 4 Nov 2026, 07:48 UTC: "Can we make vertical
   version of the video? For phones") a phone gets Iris's tall cut of it
   (note #972, 1 min 28 s) in a tall frame, and a desk the wide one as
   before; HomeFilm.tsx picks one by the page's width and fetches only it.
   Since note #975 (the owner, 4 Nov 2026, 09:44 UTC: "In the video UI
   should be in phone mockups, and full ui should be put inside the mockups
   (phone frames)") both are Iris's framed cuts (note #974), the product's
   screens whole inside phone frames; the rule and the player are as before.
   Null removes the film; a null PRODUCT_FILM_TALL gives a phone the wide
   one. */
/* The film's five sections (note #977: "switcher to different sections of
   the video. Timeline"), named from the film's own captions: the hook ("Two
   people. Four agents."), the ask ("17:50 One message."), the swarm (from
   "18:45 Two people hand out the work."), the result ("Profiles, friends,
   walls, pokes and photos.") and the payoff (from "Everyone's agents, on one
   page." to "Your cloud."). Each starts at the first clean frame after its
   crossfade, read off the encoded files frame by frame (every 0.2 s): the
   brief's marks (0:09, 0:22, 0:52 or 0:56, 1:11 or 1:14) land mid-fade. */
export const FILM_SECTION_NAMES = ['Two people, four agents', 'One message', 'Four agents at once', 'What they built', 'Your cloud'] as const;
/* On a phone the five share one row, so each name is cut to its caption's
   first words, two lines at most. */
export const FILM_SECTION_SHORT_NAMES = ['Two people', 'One message', 'Four agents', 'What they built', 'Your cloud'] as const;
const sectionsAt = (starts: number[]): Section[] => starts.map((at, i) => ({ at, label: FILM_SECTION_NAMES[i]!, short: FILM_SECTION_SHORT_NAMES[i]! }));
export const PRODUCT_FILM: Film | null = {
  src: filmUrl(PRODUCT_FILM_PATH),
  poster: productFilmPoster,
  length: 85.0,
  sections: sectionsAt([0, 9.2, 22.6, 53.0, 71.6]),
};
export const PRODUCT_FILM_TALL: Film | null = {
  src: filmUrl(PRODUCT_FILM_TALL_PATH),
  poster: productFilmTallPoster,
  length: 88.1,
  sections: sectionsAt([0, 9.2, 22.6, 56.2, 74.8]),
};
/* The site the film is about, live and public (note #958, the owner, 3 Nov
   2026, 12:06 UTC: "remove helper texts and put the link to the bookface
   clone site"). Its front page offers sign-up and prints a demo login, so a
   stranger can look around. Null takes the link off. */
export const BOOKFACE_URL: string | null = 'https://bookface-2006.agents.bookface.site/';
export const BOOKFACE_LINK = 'Open the site they built';

/* One face of the problem (note #835): the heading promises the answer, the
   paragraph names the problem it answers, and the real panel proves it.
   Since note #839 (the owner, 30 Oct, 12:33 UTC: five sections in a row
   looked the same) the rhythm varies on a desk: the panel takes the left
   side every other section (side="left"). Since note #924 the Chief of
   Staff's chat sits beside its words too, as every other panel does; it ran
   wide under them, centred, with blank space to its right. A phone reads
   every one words first. */
type FaceSide = 'right' | 'left';
/* Since note #978 (the owner, 4 Nov 2026, 13:26 UTC: "in the landing page
   each section should be without description text") a face is its heading
   and its panel; the paragraph that named the problem came off (git history
   keeps the words). */
function Face({ id, heading, panel, side = 'right' }: { id: string; heading: string; panel: ReactNode; side?: FaceSide }) {
  return (
    <Screen id={id} className={`grid gap-6 sm:gap-7 lg:items-center lg:gap-14 ${side === 'left' ? 'lg:grid-cols-[1.2fr_0.8fr]' : 'lg:grid-cols-[0.8fr_1.2fr]'}`}>
      <div data-face-words className={side === 'left' ? 'lg:order-2' : undefined}>
        <h2 className={`[text-wrap:balance] ${H2}`}>{heading}</h2>
      </div>
      <div className={`min-w-0 ${side === 'left' ? 'lg:order-1' : ''}`}>{panel}</div>
    </Screen>
  );
}

export default function Home() {
  return (
    <main
      className="landing-page copy-page min-h-dvh overflow-x-clip bg-panel text-white"
      style={{ fontFamily: 'var(--font-ui)' }}
    >
      {/* No header since note #977 (the owner, 4 Nov 2026, 12:43 UTC: "Remove
          header"): the film is the first thing. The bar carried only the
          mark and the name, a link to this same page (sign-in left it with
          note #924, and /login still answers); the footer carries the name.
          Every other page keeps its header. */}

      {/* ── The film, first (note #965) ───────────────────────────────── */}
      {/* The owner, 3 Nov 2026, 18:45 UTC: "ok this video should be central
          in our landing page. This video should be the first thing in the
          landing page and play automatically." The page opens on the product
          moving, above the headline; everything else keeps its order under
          it. Until then the film had its own section after the first screen,
          "Watch it work, start to finish." (notes #951 to #958), which went
          when the film moved up; its one link moved with it, a plain text
          link to the site the film is about. No words around the film (note
          #958). */}
      {PRODUCT_FILM ? (
        <Screen id="film" label="The film" first pad="py-5 sm:py-8 lg:py-12">
          {/* One screen holds the film, its timeline and its link (note
              #978): the film is as wide as the screen allows, unless that
              makes it taller than the room left in min(screen, 900 px), and
              then it is sized by that height and centred. On a phone the
              tall cut is sized the same way, so the film and its timeline
              are always the first screen (note #973's judgement). What the
              film leaves for its timeline and link: 175 px on a phone,
              250 px from sm up. */}
          <div
            data-film-box
            className="mx-auto w-[min(100%,calc((100svh_-_175px)*9/16))] sm:w-[min(100%,calc((min(100svh,900px)_-_250px)*16/9))]"
          >
            <HomeFilm
              wide={PRODUCT_FILM}
              tall={PRODUCT_FILM_TALL}
              label="Play the film of Bookface 2006, built by two people’s agents, no sound"
            />
            {BOOKFACE_URL ? (
              <div id="film-site" className="mt-5 sm:mt-6">
                <PrimaryLink href={BOOKFACE_URL}>{BOOKFACE_LINK}</PrimaryLink>
              </div>
            ) : null}
          </div>
        </Screen>
      ) : null}

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
      <Screen id="home-top" className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] lg:items-center lg:gap-x-14 lg:gap-y-7">
        <div>
          {/* One sentence a line, so a phone never breaks "Give" from its
              sentence; the space between keeps the heading's name whole. */}
          <h1 className={`[text-wrap:balance] ${H2}`}>
            <span className="block">{HEADLINE_FIRST}</span>{' '}
            <span className="block">{HEADLINE_SECOND}</span>
          </h1>
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
      </Screen>

      {/* ── The whole workplace, at a glance (note #841) ──────────────────── */}
      {/* The owner, 30 Oct 2026, 13:31 UTC: "We should have some illustration
          that illustrated the workplace around agents." The headline promises
          a workplace and the five sections below show one part each; this
          floor plan shows all of it first, so the page zooms in after it. The
          heading is the section's only words: the plan's own labels carry the
          rest, and its two lines carry the rule (jobs out, proposals back to
          your yes). */}
      <Screen id="workplace">
        <h2 className={`[text-wrap:balance] ${H2}`}>Here’s the workplace.</h2>
        <div className="mt-8 min-w-0 sm:mt-10">
          <WorkplaceArt />
        </div>
      </Screen>

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
      />
      <Face id="memory" side="left" heading="No session starts from zero." panel={<LiveKnowledge />} />
      <Face id="keys" heading="Add a key once. Every agent can use it." panel={<LiveSecrets />} />
      <Face id="computers" side="left" heading="A desk for every agent." panel={<LiveAgent size="tile" showSoftware={false} />} />
      <Face id="work" heading="Hand out work from one chat." panel={<LiveChief />} />

      {/* ── The second wow: all of it in your own cloud ─────────────────── */}
      <OwnCloud />
      <HowToStart />
      <ForYourTeam />
      <TalkToUs />

      <SiteFooter pitch={FOOTER_PITCH} tone="dark" wide />
    </main>
  );
}
