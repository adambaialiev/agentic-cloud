import { useState, type ReactNode } from 'react';
import { BODY, CARD, ChapterDivider, H2, H3, HOME_SECTION_END, LEAD, PrimaryLink, SECTION, SecondaryLink } from '../components/landing-kit';
import { InstallFilm, SidesArt } from '../components/CopyArt';
import installFilmPoster from '../assets/private-copy/install-film-poster-2026-10-29.jpg';

/**
 * Your own Agentic Cloud: the parts of the one home page (note #832, the
 * owner, 29 Oct 2026, 14:05 UTC, "yes to all": merge / and /own-cloud into
 * one page for cold email). Until then this file was the page at /own-cloud,
 * for the leader who decides, set up by their own agent (note #829); before
 * that /private-copy, for the engineer (notes #818 and #827). Both addresses
 * now answer with a permanent redirect to / (public/_redirects), and the
 * home page (Home.tsx) draws these parts after the product (note #835): the
 * own cloud (what stays yours, what stays with us), how to start with the
 * action at its top, for your team, and the close. Inside the code the old names stay
 * (PrivateCopy, PRIVATE_COPY_URL), as landing-copy-rules says.
 *
 * The page's main action is one line to hand a terminal agent, pointing at
 * /own-cloud.md (public/own-cloud.md), the guide written for that agent. The
 * guide does not move: it is pinned and tested (PrivateCopy.test holds it to
 * install.mjs). No price (claims-we-never-make): free for now, no licence
 * (note #935).
 */

/* The installer's public repository (note #816), public since 28 Oct 2026.
   CI publishes infra/copy-installer there whenever it changes on main. */
export const INSTALLER_SOURCE_URL: string | null = 'https://github.com/adambaialiev/private-copy-installer';

/* The film of a real install: Iris's clean run of release 2026.10.29.0 in
   the clean organization ia-scratch-client-2 on 29 Oct 2026, 16:15:52 to
   16:29:16 UTC, 13 min 24 s from one command to ready, every certificate
   issued, cut to 1 min 47 s (note #834, fix 1). It replaced Ada's 28 Oct
   recording (note #827), a 68-minute run that ended before "ready" because
   Fly sat on the code host's certificate. The MP4 and the poster are in our
   public bucket site-media; the poster is the ready frame, both secrets
   masked, and ships in the site bundle. Source and MP4: Drive, "Install
   film, clean run 29 Oct 2026 (note 834)". Null removes it; the page reads
   the same without it. */
export const INSTALL_FILM: { src: string; poster: string; caption: string } | null = {
  src: 'https://iabkt-bd72d0602f96.fly.storage.tigris.dev/private-copy/install-film-2026-10-29.mp4',
  poster: installFilmPoster,
  caption:
    'A real install on 29 Oct 2026: one command, 13 min 24 s from a clean Fly organization to ready, shown in 1 min 47 s. No sound; the captions are in the picture.',
};


/* Why your own Agentic Cloud runs on Fly, not AWS or Google Cloud (note
   #838): its own page, linked from the own-cloud chapter and the footer. */
export const WHY_FLY_PATH = '/why-fly';

/* The one line a leader hands to their terminal agent, and where it points. */
export const AGENT_GUIDE_PATH = '/own-cloud.md';
export const AGENT_LINE = `Set up our own Agentic Cloud by following https://agenticcloudcomputer.com${AGENT_GUIDE_PATH}`;

/* The line, set as code, with a Copy button. Copying is the page's main
   action, so the button says what it did ("Copied") for a moment, and a
   screen reader hears it too. Without clipboard access the line is still
   plain text to select. */
export function AgentLine() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(AGENT_LINE);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2400);
    } catch {
      /* No clipboard here: the line stays selectable. */
    }
  };
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-panel-soft p-3 sm:flex-row sm:items-center sm:gap-4 sm:p-3 sm:pl-5">
      <code id="agent-line" className="min-w-0 flex-1 break-words font-mono type-sm leading-relaxed text-white sm:type-base">
        {AGENT_LINE}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-describedby="agent-line"
        className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 self-start rounded-xl bg-white px-5 type-sm font-semibold text-panel transition-colors hover:bg-white/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:self-auto"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {copied ? <path d="M5 12.5l4.5 4.5L19 7.5" /> : <><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8" /></>}
        </svg>
        <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
      </button>
    </div>
  );
}

export function Chapter({ id, heading, children }: { id: string; heading: string; children: ReactNode }) {
  return (
    <section id={id} className={`${SECTION} ${HOME_SECTION_END}`}>
      <ChapterDivider tight />
      <h2 className={`max-w-[760px] [text-wrap:balance] ${H2}`}>{heading}</h2>
      {children}
    </section>
  );
}


/* ── The parts of the one home page (note #832) ─────────────────────────── */

/* The founder's own address, for the phone's second door and the close
   (note #832, the owner, 29 Oct 2026, 14:05 UTC: "Write to the founder"). */
export const FOUNDER_EMAIL = 'adam@agenticcloudcomputer.com';
const FOUNDER_MAILTO = `mailto:${FOUNDER_EMAIL}?subject=${encodeURIComponent('Our own Agentic Cloud')}`;
/* "Send me the line" (note #832): a cold email is read on a phone, where the
   line cannot run. This opens the reader's own mail with the line in it, to
   send to themselves for the laptop. No address: theirs goes in the To. */
export const SEND_ME_THE_LINE = `mailto:?subject=${encodeURIComponent('Set up our own Agentic Cloud')}&body=${encodeURIComponent(`Paste this into Claude Code, Codex or any agent with a terminal:\n\n${AGENT_LINE}\n`)}`;

const INLINE_LINK = 'text-white underline decoration-white/35 underline-offset-2 hover:decoration-white';

/* The page's action, at the top of How to start since note #835 (on the first
   screen before it). On a laptop, the line and its Copy button; on a phone,
   where nobody runs it, "Send me the line" and "Write to the founder" (note
   #832). Under both, the qualifier, so a company on another cloud learns it
   before the steps. */
export function OwnCloudAction() {
  return (
    <div id="give-your-agent" className="mt-8 max-w-[1040px] scroll-mt-20">
      <div className="hidden sm:block">
        <h3 className="type-md-sm font-semibold text-white">Give this to your agent</h3>
        <div className="mt-3">
          <AgentLine />
        </div>
        {/* Since note #835 the steps below say what the agent does with it, so
            the paragraph that said it here first is gone. */}
        <p className={`mt-3 max-w-[36rem] [text-wrap:pretty] ${BODY}`}>
          Paste it into Claude Code, Codex or any agent that works in a terminal.
        </p>
      </div>
      <div className="sm:hidden" id="on-a-phone">
        <h3 className="type-md-sm font-semibold text-white">Your agent sets it up from a laptop</h3>
        <p className={`mt-2 [text-wrap:pretty] ${BODY}`}>
          Send yourself the one line it needs, or ask the founder anything first.
        </p>
        <div className="mt-5 flex flex-col items-start gap-4">
          <PrimaryLink href={SEND_ME_THE_LINE}>Send me the line</PrimaryLink>
          <SecondaryLink href={FOUNDER_MAILTO}>Write to the founder</SecondaryLink>
        </div>
      </div>
      <p id="qualifier" className="mt-6 type-sm font-semibold text-white">
        Runs in your own Fly account. Free for now.
      </p>
    </div>
  );
}

/* The second "wow" (note #835, the owner, 29 Oct 2026: "wow the product is
   so great ... and then wow it also will run on my own cloud"). Note #830's
   data line, which opened the page until then, leads it; the drawing of what
   runs on whose side (note #827) moved here from "For your team", under
   "Nothing of yours stays with us" with the open-source installer as the
   proof. The drawing is not on a phone: the engineers it is for
   read it on a laptop, and its labels are too small there (note #834). */
export const OWN_CLOUD_HEADING = 'And all of it runs in your company’s own cloud.';

export function OwnCloud() {
  return (
    <Chapter id="own-cloud" heading={OWN_CLOUD_HEADING}>
      <div className="mt-5 grid gap-8 lg:grid-cols-2 lg:gap-14">
        <p id="own-cloud-lead" className={`max-w-[640px] [text-wrap:pretty] ${LEAD}`}>
          What makes your agents good stays yours: your code, their conversations, your knowledge,
          your keys and your decisions. The whole system runs in your own cloud account, on your
          domain.
        </p>
        <div id="with-us">
          <h3 className={H3}>Nothing of yours stays with us.</h3>
          <p className={`mt-3 max-w-[640px] [text-wrap:pretty] ${BODY}`}>
            We keep our source code and the releases. Your messages, code, files, mail, keys and logs
            never reach us. The installer is open source, so anyone on your team can read exactly what
            it creates and what it sends.
          </p>
          {/* The installer's code, and why it is Fly (note #838). */}
          <div className="mt-5 flex flex-wrap items-center gap-x-7 gap-y-4">
            {INSTALLER_SOURCE_URL ? (
              <SecondaryLink href={INSTALLER_SOURCE_URL}>Read the installer’s code</SecondaryLink>
            ) : null}
            <SecondaryLink href={WHY_FLY_PATH}>Why it runs on Fly</SecondaryLink>
          </div>
        </div>
      </div>
      {/* On a phone too since note #839: SidesArt draws its stacked
          version there (what is in your cloud, then what is with us). */}
      <div id="your-side" className="min-w-0">
        <SidesArt />
      </div>
    </Chapter>
  );
}


/* The line first (note #831): the guide plans without our two files, so the
   page's main action works the moment it is pasted. The agent stops at the
   plan and says how to ask us for them. Since note #835 the line opens this
   chapter, not the first screen. Since note #924 it is the page's one way to
   start: no button anywhere jumps here, only the first screen's text link. */
export function HowToStart() {
  return (
    <Chapter id="start" heading="How to start.">
      <OwnCloudAction />
      <ol className={`mt-6 grid list-decimal gap-x-10 gap-y-3 pl-5 [text-wrap:pretty] ${BODY} marker:text-hint/70 lg:grid-cols-3`}>
        <li>
          Give your agent the line above. It checks your computer and your Fly account, and shows
          you everything it will create and what Fly will bill for it. Nothing is created yet.
        </li>
        <li>
          Say yes, and your agent builds your own Agentic Cloud. Nothing is needed from us: no key,
          no licence.
        </li>
        <li>
          Open the first admin link it hands you. You are the first admin; everyone after you joins
          by an invite link, and an admin approves each person. Company single sign-on is not built
          yet.
        </li>
      </ol>
      {/* What it takes (note #834 folded the four cards of "What it takes
          from you." into one paragraph here; note #924 set that paragraph's
          nine lines as five, one thing each, in the same words). The clock
          (the owner, 29 Oct, 17:00 UTC) leads with the clean run of 29 Oct,
          13 min 24 s from one command to ready, and keeps the certificate
          wait honest and second: in that run Fly issued them in 45 s, but on
          28 Oct the code host's took over an hour. Three runs are too few for
          "usually" (claims-we-never-make). */}
      <div id="takes" className="mt-6 max-w-[1040px] sm:mt-8 rounded-2xl border border-hint/20 px-4 py-4 sm:px-6 sm:py-5">
        <h3 className={H3}>What it takes</h3>
        <ul className={`mt-2 grid list-disc gap-1 pl-4 [text-wrap:pretty] ${BODY} marker:text-hint/70 sm:pl-5`}>
          <li>A Fly account that pays for the machines. Fly bills it directly; nothing of ours is on that bill.</li>
          <li>One domain of your own, such as agents.yourcompany.com.</li>
          <li>One command your agent runs. In our clean run on 29 October it went from a new Fly organization to ready in 13 min 24 s.</li>
          <li>Fly issued the certificates in under a minute that time; one has taken over an hour before, and then your agent simply waits.</li>
          <li>Free for now: no licence, no key and no charge from us.</li>
        </ul>
      </div>
    </Chapter>
  );
}

/* For the engineers who check before a yes: the guide the agent follows,
   the film of a real install, side by side on a desk. The drawing of what
   runs on whose side (note #827) stood under them until note #835 moved it
   into the own-cloud chapter. */
export function ForYourTeam() {
  return (
    <Chapter id="for-your-team" heading="For your team.">
      {/* Words, then the film at the page's width (note #839: beside the
          words the terminal in it read too small, and the heading stood
          alone over an empty gap). */}
      <div className="mt-5">
        <div>
          <p className={`max-w-[36rem] [text-wrap:pretty] ${LEAD}`}>
            What your engineers will want to see before they say yes. The steps your agent follows are
            one page of plain text they can read first.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-7">
            <PrimaryLink href={AGENT_GUIDE_PATH}>Read the guide your agent follows</PrimaryLink>
          </div>
        </div>
        <div id="install" className="min-w-0">
          {INSTALL_FILM ? <InstallFilm {...INSTALL_FILM} /> : null}
        </div>
      </div>
    </Chapter>
  );
}

/* The close: the founder's own address (note #832). */
export function TalkToUs() {
  return (
    <section id="contact" className={`${SECTION} pb-16 sm:pb-20`}>
      <ChapterDivider tight />
      {/* The card reaches past the column by its own padding, so its words
          line up with every other section's (note #839). */}
      <div className={`${CARD} -mx-5 max-sm:rounded-none sm:-mx-7 lg:-mx-8 lg:p-8`}>
        <h2 className={`max-w-[700px] [text-wrap:balance] ${H2}`}>Talk to us.</h2>
        <p className={`mt-5 max-w-[640px] [text-wrap:pretty] ${LEAD}`}>
          Write to Adam, who built it, at <a href={FOUNDER_MAILTO} className={INLINE_LINK}>{FOUNDER_EMAIL}</a>.
          Questions before you decide are welcome.
        </p>
        <div className="mt-7">
          <PrimaryLink href={FOUNDER_MAILTO}>Write to the founder</PrimaryLink>
        </div>
      </div>
    </section>
  );
}
