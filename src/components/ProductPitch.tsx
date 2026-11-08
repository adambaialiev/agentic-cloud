import LiveNotes from './LiveNotes';
import { LiveInbox } from './LiveMail';
import LiveSubscriptions from './LiveSeats';
import { LiveKnowledge, LiveRepositories, LiveSecrets, LiveSites, LiveStorage } from './LiveSurfaces';
import LiveDrive from './LiveDrive';
import LiveRepo from './LiveRepo';
import LivePhone from './LivePhone';
import LiveChief from './LiveChief';
import LiveApps from './LiveApps';
import { BUILT_IN_LINE, PRODUCT_HEADLINE } from '../lib/product-copy';
import { BODY, CARD, ChapterDivider, H2, H3, LEAD, PrimaryLink, SECTION } from './landing-kit';

/**
 * The product pitch, whole: one copy rendered in two places (note #789, the
 * owner, 2026-10-25: "let's put the whole /product page content" on the home
 * page). /product draws it under the site header with its headline as the
 * page's h1; the home page draws it after the apps and the founder's card,
 * with the headline as an h2. Change a word here and both pages change, so
 * they cannot drift. The one deliberate difference: the home page leaves out
 * the fixture app catalogue ("Built here. Found here."), because it already
 * opens on the real one.
 */

/* Everything an agent needs, built in (note #787, the owner, 2026-10-25).
   "A cloud computer", "beyond the laptop" and "works with your laptop
   closed" stopped being a reason to choose us once Claude Code and Codex ran
   tasks in the cloud themselves, so the page leads on what those stop short
   of: the git, the hosting, the storage, the inbox, the files, the task list
   and the memory, all already there. The Email card says what an agent does
   with the inbox, not that it answers it (the owner, 2026-10-27: "they don't
   write reply, they inform you ... agent can do search, etc."): it tells you
   what matters, searches, keeps the files; a letter goes out only on a tap. Eight cards, two by two, each the
   product's own screen. Until then the page opened on "Every agent gets a
   computer. You get a team." with four cards (a computer, the team, the
   gate, memory) and the film, and had "Code, sites, pages and files, in one
   place." and the keys as sections of their own. */
const builtIn = [
  {
    title: 'Git',
    body: 'Code hosting made for agents, with CI/CD built in. Every push is tested, a change waits for your yes or merges itself once you turn on auto-merge, and you’re told either way.',
    live: 'git',
  },
  {
    title: 'Hosting',
    body: 'Put a website or a full app online, each at its own address on your domain, running in your own cloud account.',
    live: 'hosting',
  },
  {
    title: 'Storage',
    body: 'Space for uploads and exports, ready the moment an agent needs it. Private unless you make it public.',
    live: 'storage',
  },
  {
    title: 'Email',
    body: 'Your own email address, with an agent keeping an eye on it. It tells you what arrived and what matters, finds any old thread and saves the attachments where the team can use them. Nothing goes out until you tap Send.',
    live: 'email',
  },
  {
    title: 'Drive',
    body: 'One shared place for files. Drop in a brief or a photo and any agent can use it.',
    live: 'drive',
  },
  {
    title: 'Notes',
    body: 'Write a task down once and hand it to an agent. The note shows how it is going: in progress, waiting for your review, live.',
    live: 'notes',
  },
  {
    title: 'Memory',
    body: 'Agents write what they learn into knowledge pages, read them before every job and keep them up to date. Nothing for you to manage.',
    live: 'memory',
  },
  {
    title: 'Keys',
    body: 'Save an API key or password once and agents use it by name. Nobody pastes it into a chat.',
    live: 'keys',
  },
] as const;

function BuiltInPanel({ live }: { live: (typeof builtIn)[number]['live'] }) {
  switch (live) {
    case 'git': return <LiveRepositories />;
    case 'hosting': return <LiveSites />;
    case 'storage': return <LiveStorage />;
    case 'email': return <LiveInbox />;
    case 'drive': return <LiveDrive />;
    case 'notes': return <LiveNotes />;
    case 'memory': return <LiveKnowledge />;
    case 'keys': return <LiveSecrets />;
  }
}

export default function ProductPitch({ on }: { on: 'product' | 'home' }) {
  const home = on === 'home';
  const Headline = home ? 'h2' : 'h1';
  const CardTitle = home ? 'h3' : 'h2';
  return (
    <>
      {/* ── Everything built in ──────────────────────────────────────────── */}
      {/* The page opens here since note #787 (the owner, 2026-10-25), on the
          headline he picked from three: his "it has everything your agents
          need" said as the outcome. Still no hero above it and no door (note
          #199): the header's two doors are the page's only ones. Before this
          the page's h1 was the sr-only "Give Claude Code a team, and a cloud
          to work in." (note #182) over "Every agent gets a computer. You get
          a team." and the film "Beyond the laptop", which comes back only
          when it is re-cut without the laptop. */}
      {/* On the home page it follows the founder's card, so it is a chapter
          like the others there: an h2 for its headline and h3s for its cards,
          under the page's own h1 (note #789). Since 2026-10-27 (the owner:
          merge it with "Agents come and go. Your context stays.") it is the
          second half of that chapter there: no hairline over it, and neither
          its lead nor its paragraph, so the headline goes straight to the
          cards that prove the idea above. /product keeps both. */}
      <section id="built-in" className={`${SECTION} ${home ? 'pb-8 pt-4 sm:pb-10 sm:pt-6' : 'pb-8 pt-14 sm:pb-10 sm:pt-20'}`}>
        <div className="max-w-[720px]">
          <Headline className={H2}>{PRODUCT_HEADLINE}</Headline>
          {home ? null : (
            <>
              <p className={`mt-5 [text-wrap:pretty] ${LEAD}`}>
                {BUILT_IN_LINE}
              </p>
              <p className={`mt-5 [text-wrap:pretty] ${BODY}`}>
                Claude Code and Codex can already work in the cloud, but they stop at a pull
                request. Everything after that is yours to set up: hosting, storage, email, a place
                to track the work. Here it is all ready before the first job. Your agents take a task
                from a note, push the code, put the app online and write down what they learned.
                Every job ends with something people can actually use.
              </p>
            </>
          )}
        </div>
        <div className="mt-10 grid gap-4 sm:mt-12 lg:grid-cols-2 lg:gap-5">
          {builtIn.map(({ title, body, live }) => (
            <div key={title} className={CARD}>
              <CardTitle className={H3}>{title}</CardTitle>
              <p className={`mt-2 mb-5 max-w-[470px] ${BODY}`}>{body}</p>
              <BuiltInPanel live={live} />
            </div>
          ))}
        </div>
      </section>

      {/* Every section paragraph from here down is a pitch in the page's calm
          voice (the owner, 2026-09-16: the body copy read as reassurance and
          explanation under a bold headline, and the git and email sections
          arrived in a third, combative register). Promise and contrast, no
          mechanism; the mechanism lives in the docs. See the knowledge page
          landing-copy-rules. */}
      {/* On 2026-10-25 (note #787) "Code, sites, pages and files, in one
          place." and the keys section came off: both are cards in the deck the
          page opens on. */}
      {/* The owner simplified the page on 2026-10-08: the ownership deck
          ("It runs on the cloud. What it builds is yours."), what was left of
          the loop ("Capture. Remember. Work. Decide." — its Work and Decide
          chapters), the people section ("A second brain is better with more
          brains in it.", by then "Bring the team in."), the free section,
          the FAQ and the docs section all came off. */}
      {/* And on 2026-10-09 (note #199) the four phases ("AI at work has four
          phases. Start in the fourth.") moved to a page of their own,
          /four-phases, and the closing door ("Give your first agent a job.")
          came off. The header's two doors are the page's only ones now. */}
      {/* ── The app catalogue ────────────────────────────────────────────── */}
      {/* Right after the built-in cards (note #787): the work ends live, and
          here it is found too. The owner, 2026-10-15 (note #756): distribution
          is the problem for vibe-coded apps, and builders stop at a link;
          here an app is made and found in one place, because the deploying
          agent writes its listing. The panel is /apps' own card; the door
          goes to the real catalogue. The catalogue held one app the day this
          was written; see landing-copy-rules for the timing call.
          2026-11-08 (note #1081, claim 48 of the acceptance pass): the page
          sells your own Agentic Cloud, whose /apps is private to the
          workplace (note #1014), so "joins a public catalogue … with your
          name on it" came off; the paragraph says the directory is private,
          and the door goes to the docs section that explains it, not to our
          own public catalogue. */}
      {/* Not on the home page (note #789): it opens on the real catalogue's
          newest apps, and a fixture catalogue under the founder's card would
          put made-up apps on the same page as real ones. */}
      {home ? null : (
            <section id="apps" className={`${SECTION} pb-8 sm:pb-10`}>
        <ChapterDivider />
        <div className="max-w-[640px]">
          <h2 className={H2}>Built here. Found here.</h2>
          <p className={`mt-5 [text-wrap:pretty] ${LEAD}`}>
            Most app builders hand you a link and leave you to keep track of it. Here every app
            your agents ship goes into your workplace&rsquo;s apps directory the moment it goes
            live: its name, a line on what it does, who built it and a picture. Each app is public
            at its own address, and the directory is private to your workplace.
          </p>
          <div className="mt-6">
            <PrimaryLink href="/docs/sites-and-domains#the-app-catalogue">How the directory works</PrimaryLink>
          </div>
        </div>
        <LiveApps className="mt-10 sm:mt-12" />
      </section>
      )}

      {/* ── Git hosting ──────────────────────────────────────────────────── */}
      {/* The platform's own git hosting, right after the deck whose first
          card is a repository. The owner's brief (2026-09-15): it is built
          for fast agentic coding, GitHub and the other hosts are not built
          for agents, and this is the host for high-velocity agentic work.
          The heading is written FROM that, not as it, and the paragraph is
          marketing copy, not explanation (the owner, 2026-09-16: promise
          and contrast, no mechanism). What it adds to git
          is the work around the code — proposals, checks, a gate — so the
          panel is the repository's Overview rather than its files. */}
      <section id="git" className={`${SECTION} pb-8 sm:pb-10`}>
        <ChapterDivider />
        <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-center lg:gap-14">
          <div>
            <h2 className={H2}>Git hosting made for agents.</h2>
            <p className={`mt-5 max-w-[470px] ${LEAD}`}>
              GitHub was built for people. This was built for agents. Your agents can push code
              all day, all at once. Every push is tested, every branch comes to your phone for review,
              and nothing merges until you say so or turn on auto-merge. Git hosting with CI/CD, made for
              fast agentic work.
            </p>
          </div>
          <LiveRepo />
        </div>
      </section>

      {/* ── The Chief of Staff ───────────────────────────────────────────── */}
      {/* The team, the first of the lead's supporting points (note #787): the
          named agents and their machines moved here from the cards the page
          opened on until then. How one person runs twenty.
          Home is the Chief of Staff's conversation (note #715); it hands the
          work out, brings the decisions back as cards (note #724), and, when
          let, acts on its own inside named permissions (note #716). The
          pitch and its reasoning are on Growth's note #204. PROTOTYPE. */}
      <section id="chief" className={`${SECTION} pb-8 sm:pb-10`}>
        <ChapterDivider />
        <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-center lg:gap-14">
          <div>
            <h2 className={H2}>Talk to one agent. It runs the rest.</h2>
            <p className={`mt-5 max-w-[470px] ${LEAD}`}>
              A whole team of agents, each on its own computer, and one chat to run them all.
              Tell your Chief of Staff what you want done. It hands out the work, keeps it moving and
              comes back only when something needs your yes. It never approves anything itself.
              That is always your call.
            </p>
          </div>
          <LiveChief />
        </div>
      </section>

      {/* ── On a phone ───────────────────────────────────────────────────── */}
      {/* One phone with a real phone-width viewport, scaled as one object so
          its larger chat type matches the other live panels; the chat screen
          sits beside the heading like the repository and the keys below.
          Four 242px "phones" stood here before, and
          the app's layouts broke inside a width no phone has. */}
      <section id="phones" className={`${SECTION} pb-8 sm:pb-10`}>
        <ChapterDivider />
        <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-center lg:gap-14">
          <div>
            <h2 className={H2}>Run the whole team from your phone.</h2>
          </div>
          <LivePhone />
        </div>
      </section>

      {/* The heading since 2026-10-25 (the owner: it should say that more
          subscriptions can be added to scale up); "Add a subscription, add a
          fleet." from 2026-09-16 until then. */}
      {/* ── Subscriptions ───────────────────────────────────────────────────── */}
      {/* The scale claim lives here (the owner, 2026-09-16): the Workspace is
          as many times as you have subscriptions for. Each agent has its own
          machine, so model time is the limit, and model time stacks. Since
          note #664 (2026-09-25) the machines are ours and a workplace holds
          twenty agents, so "sign in with ten and run a hundred" and
          "computers are never the limit" went: both became untrue. Since note
          #787 (2026-10-25) it names OpenCode beside the two, and "no per-token
          bill" is gone: an OpenCode plan can be paid by the token. Since
          2026-10-27 the page names no number of agents and never says
          "unlimited" (the owner: "Let's not say 'Up to twenty agents'... we
          dont have limits", "and let's not say 'unlimited' also"): neither
          this section nor the Chief of Staff's says how many. Since note #822
          (2026-10-28, only the private copy is offered) its last line says
          where everything runs, the company's own cloud account, where it
          said "The computers, hosting and storage are on us." */}
      {/* Never last: the own-cloud door follows it on both pages (/product
          since note #818, the home page since note #830), so it closes like
          any chapter. */}
      <section id="subscriptions" className={`${SECTION} pb-8 sm:pb-10`}>
        <ChapterDivider />
        <div className="grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center lg:gap-14">
          <div>
            <h2 className={H2}>More subscriptions, more agents at once.</h2>
            <p className={`mt-5 max-w-[470px] ${LEAD}`}>
              Your agents run the real Claude Code, Codex and OpenCode, on the subscription you
              already pay for. Sign in once and every agent can share it; add a subscription to run
              more of them at once. The computers, hosting and storage run in
              your own cloud account, and the subscriptions stay yours.
            </p>
          </div>
          <LiveSubscriptions />
        </div>
      </section>
    </>
  );
}
