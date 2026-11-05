import SiteFooter from '../components/SiteFooter';
import { FOOTER_PITCH } from '../lib/product-copy';
import { Screen } from '../components/landing-kit';
import WorkplaceArt from '../components/WorkplaceArt';
import HomeFilm, { type Film, type Section } from '../components/HomeFilm';
import { filmUrl, PRODUCT_FILM_PATH, PRODUCT_FILM_TALL_PATH } from '../lib/films';
import { HowToStart, OwnCloud } from './PrivateCopy';

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
   brief's marks (0:09, 0:22, 0:52 or 0:56, 1:11 or 1:14) land mid-fade.
   Since note #985 the starts are the fifth cut's, read the same way (Iris's
   marks 9.0 / 20.7 / 47.0 or 55.0 / 67.2 or 75.2 s are each fade's start;
   the first clean frame is 0.2 s later). The ask beat's caption is still
   "One message.", so the names stay.
   Since note #988 the film is the sixth cut, in a new order (one person
   starts, then two, then what they built, then the close), so the sections
   are its acts: "One person" (from "One person. One message."), "Two
   people" (from "Then two. Each hands out the work.", through the merges,
   Maya's photo message and the contributors page), "What they built" (from
   "Profiles, friends, walls, pokes and photos.") and "Your cloud" (from
   "Two people. Four agents." to the mark). The note offered a fifth stop,
   "Seventeen merges", inside the second act, with four as the fallback if
   five crowd a phone: "Seventeen" is one word 61 px wide at the phone's
   type, so it touched its neighbour on a 430x744 iPhone and ran into it on
   a 375 px one, and the film has four stops on every screen. Iris's starts
   (wide 12.5 / 53.8 / 78.8 s, tall 12.5 / 61.1 / 86.1 s) are each
   crossfade's middle, so the jumps use the first clean frame after it,
   read the same way; the close fades through the blank page first, so its
   jump lands on the settled "Two people. Four agents." card.
   Since note #990 the film is the seventh cut, narrated (from "Let's watch
   two people and four agents build a social network in under 90
   minutes."), with the same four acts and names: the opening card is
   inside "One person"; "Two people" from "Maya joins."; "What they built"
   from "Here's Bookface: profiles, friends, walls and pokes."; "Your cloud"
   from "Your team." Iris's starts (wide 17.5 / 49.8 / 75.7 s, tall 17.5 /
   57.1 / 83.0 s) are again each crossfade's middle, read the same way; the
   close's words come in one by one, so its jump lands once "Your team."
   is fully drawn.
   Since note #992 the film is the eighth cut: the same four acts and
   names, "Two people" now ending on the Workplace window ("And it all
   lives in one workplace: ..."). Iris's starts (wide 17.5 / 48.6 / 74.5 s,
   tall 17.5 / 55.9 / 81.8 s) are read the same way.
   Since note #996 the film is the ninth cut and the timeline has three
   stops, named by the owner (5 Nov 2026, 06:49 and 06:54 UTC; "Your cloud"
   is not a section of its own, it folds into the last): "The ask" (the
   opening card, Iris's one message and the starting point), "The team"
   (from "Maya joins." through the merges, auto-merge and the Workplace
   window) and "The result" (from "Here's Bookface: ..." through the photos
   and the close, "Your team. Your agents. Your cloud. Your rules."). Iris's
   cut points (wide 17.5 / 50.2 s, tall 17.5 / 57.5 s) are each crossfade's
   start; the jumps land on the first clean frame after it. */
export const FILM_SECTION_NAMES = ['The ask', 'The team', 'The result'] as const;
/* On a phone the three share one row, two lines at most. The sixth cut's
   names are short enough to read there whole, so they are the same. */
export const FILM_SECTION_SHORT_NAMES = FILM_SECTION_NAMES;
const sectionsAt = (starts: number[]): Section[] => starts.map((at, i) => ({ at, label: FILM_SECTION_NAMES[i]!, short: FILM_SECTION_SHORT_NAMES[i]! }));
/* The film's own background colour, read off the encoded files (every
   frame of the opening card and the blank first frame, both shapes: RGB
   252, 252, 249; Chrome paints 251, 252, 249). It is the placeholder until
   the film's first frame is drawn (note #998): no poster. A new cut that
   changes its background changes this. */
export const FILM_BACKGROUND = '#fcfcf9';
export const PRODUCT_FILM: Film | null = {
  src: filmUrl(PRODUCT_FILM_PATH),
  background: FILM_BACKGROUND,
  length: 78.97,
  sections: sectionsAt([0, 17.9, 50.6]),
};
export const PRODUCT_FILM_TALL: Film | null = {
  src: filmUrl(PRODUCT_FILM_TALL_PATH),
  background: FILM_BACKGROUND,
  length: 86.27,
  sections: sectionsAt([0, 17.9, 57.9]),
};
/* The site the film is about, live and public (note #958, the owner, 3 Nov
   2026, 12:06 UTC: "remove helper texts and put the link to the bookface
   clone site"). Its front page offers sign-up and prints a demo login, so a
   stranger can look around. Null takes the link off. */
export const BOOKFACE_URL: string | null = 'https://bookface-2006.agents.bookface.site/';
export const BOOKFACE_LINK = 'Open the site they built';

/* The film's one door (note #981, the owner, 4 Nov 2026, 13:58 UTC: "Open
   the site they built should have different design and open in new tab").
   It is the first screen's one action, so it is not set like the page's
   underlined text links: an outlined pill in the page's own ink, 44 px tall
   for a thumb, with an arrow pointing out of the page, under the timeline
   as part of the film block. It opens the site in a new tab (noopener,
   noreferrer) so the film stays where the visitor left it, and says so to a
   screen reader. Of the two shown on the proposal it is the outline, not
   the filled ink pill: a filled button is the one shape this page has
   turned down twice (the owner, 2026-09-07: it "read as a sticker"; note
   #924 took "Build yours" off), and beside a light film an outline reads as
   part of the player, not as a call to buy. */
function SiteLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group inline-flex min-h-11 items-center gap-2.5 rounded-full border border-white/30 px-5 type-sm font-semibold text-white transition-colors hover:border-white hover:bg-white/[0.04] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:type-base"
    >
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
      <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4 transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5" fill="none">
        <path d="M7 13l6-6M8 6.5h5.5V12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </a>
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

      {/* The page's one h1, for a screen reader and the document outline,
          not drawn since note #984 took its screen off. */}
      <h1 className="sr-only">{HOME_HEADLINE}</h1>

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
              260 px from sm up (250 until the 44 px link of note #981). */}
          <div
            data-film-box
            className="mx-auto w-[min(100%,calc((100svh_-_175px)*9/16))] sm:w-[min(100%,calc((min(100svh,900px)_-_260px)*16/9))]"
          >
            <HomeFilm
              wide={PRODUCT_FILM}
              tall={PRODUCT_FILM_TALL}
              label="Play the film of Bookface 2006, built by two people’s agents, no sound"
            />
            {BOOKFACE_URL ? (
              <div id="film-site" className="mt-4 sm:mt-5">
                <SiteLink href={BOOKFACE_URL}>{BOOKFACE_LINK}</SiteLink>
              </div>
            ) : null}
          </div>
        </Screen>
      ) : null}

      {/* Since note #984 (the owner, 4 Nov 2026, 14:07 UTC, on the storyboard,
          note #982) the page is five screens: the film, the workplace
          drawing, the own cloud, how to build yours, the footer. The
          headline screen ("Your agents are great engineers. Give them a
          workplace." with two agent cards and the door to #start), the
          People cards, "No session starts from zero.", "Add a key once.
          Every agent can use it.", "A desk for every agent.", "Hand out work
          from one chat.", "For your team." (the install film) and "Talk to
          us." came off; git history keeps them. The headline stays as the
          page's one h1, first in the page and not drawn (as from PR #1274
          to #1279). */}
      {/* ── The whole workplace, at a glance (note #841) ──────────────────── */}
      {/* The owner, 30 Oct 2026, 13:31 UTC: "We should have some illustration
          that illustrated the workplace around agents." Since note #984 the
          drawing stands alone in its screen: "Here's the workplace." came
          off; the plan's own labels carry it. */}
      <Screen id="workplace">
        <div className="min-w-0">
          <WorkplaceArt />
        </div>
      </Screen>

      {/* ── The second wow: all of it in your own cloud ─────────────────── */}
      <OwnCloud />
      <HowToStart />

      <SiteFooter pitch={FOOTER_PITCH} tone="dark" wide />
    </main>
  );
}
