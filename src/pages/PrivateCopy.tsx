import { useState, type ReactNode } from 'react';
import { CARD, H2, H3, PrimaryLink, Screen, SecondaryLink } from '../components/landing-kit';
import { InstallFilm, SidesArt } from '../components/CopyArt';
import installFilmPoster from '../assets/private-copy/install-film-poster-2026-10-29.jpg';
import { filmUrl, INSTALL_FILM_PATH } from '../lib/films';

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

/* The installer's code, in the platform's own public repository (note #941):
   agentic-cloud, open source since 1 Nov 2026. Until then it was a GitHub copy
   CI published (note #816), retired with the switch. */
export const INSTALLER_SOURCE_URL: string | null = 'https://agenticcloudcomputer.com/acc/agentic-cloud?path=infra/copy-installer';

/* The whole platform is open source (note #959, the owner, 3 Nov 2026, 12:18
   UTC: "The whole platform is open source, we should talk about it in the
   landing page"): the public repository agentic-cloud, answering signed out
   since 1 Nov 2026, under the GNU AGPL-3.0 (its LICENSE; the README says the
   name and the logo are not under it). The home page links the repository
   and the licence; the installer's folder stays for /why-fly. */
export const PLATFORM_SOURCE_URL = 'https://agenticcloudcomputer.com/acc/agentic-cloud';
export const PLATFORM_LICENSE_URL = `${PLATFORM_SOURCE_URL}?path=LICENSE&file=1`;

/* The film of a real install: Iris's clean run of release 2026.10.29.0 in
   the clean organization ia-scratch-client-2 on 29 Oct 2026, 16:15:52 to
   16:29:16 UTC, 13 min 24 s from one command to ready, every certificate
   issued, cut to 1 min 47 s (note #834, fix 1). It replaced Ada's 28 Oct
   recording (note #827), a 68-minute run that ended before "ready" because
   Fly sat on the code host's certificate. The MP4's address comes from
   lib/films.ts (note #957), with the home film's; the poster is the ready frame, both secrets
   masked, and ships in the site bundle. Source and MP4: Drive, "Install
   film, clean run 29 Oct 2026 (note 834)". Its caption under the player ("A
   real install on 29 Oct 2026: one command, 13 min 24 s …") came off with
   note #958 (the owner: "remove helper texts"); the film's own captions and
   What it takes above say it. Null removes it; the page reads the same
   without it. */
export const INSTALL_FILM: { src: string; poster: string } | null = {
  src: filmUrl(INSTALL_FILM_PATH),
  poster: installFilmPoster,
};


/* Why your own Agentic Cloud runs on Fly, not AWS or Google Cloud (note
   #838): its own page, linked from the own-cloud chapter and the footer. */
export const WHY_FLY_PATH = '/why-fly';

/* The page's one action, in the owner's words of 28 Oct 2026 ("Build your own
   Agentic Cloud", landing-copy-rules): since note #951 the first screen's text
   link says it, and the section it opens, How to start until then, is headed
   with it, so the door lands on its own words. What it hands you is the line
   below, pointing at the guide. */
export const BUILD_YOURS = 'Build your own Agentic Cloud';

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
    <Screen id={id}>
      <h2 className={`[text-wrap:balance] ${H2}`}>{heading}</h2>
      {children}
    </Screen>
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


/* The page's action, at the top of How to start since note #835 (on the first
   screen before it). On a laptop, the line and its Copy button; on a phone,
   where nobody runs it, "Send me the line" and "Write to the founder" (note
   #832). Under both, the qualifier, so a company on another cloud learns it
   before the steps. */
export function OwnCloudAction() {
  return (
    <div id="give-your-agent" className="mt-8 scroll-mt-20">
      <div className="hidden sm:block">
        <h3 className="type-md-sm font-semibold text-white">Give this to your agent</h3>
        <div className="mt-3">
          <AgentLine />
        </div>
        {/* Since note #835 the steps below say what the agent does with it, so
            the paragraph that said it here first is gone. */}
      </div>
      <div className="sm:hidden" id="on-a-phone">
        <h3 className="type-md-sm font-semibold text-white">Your agent sets it up from a laptop</h3>
        <div className="mt-5 flex flex-col items-start gap-4">
          <PrimaryLink href={SEND_ME_THE_LINE}>Send me the line</PrimaryLink>
          <SecondaryLink href={FOUNDER_MAILTO}>Write to the founder</SecondaryLink>
        </div>
      </div>
    </div>
  );
}

/* The second "wow" (note #835, the owner, 29 Oct 2026: "wow the product is
   so great ... and then wow it also will run on my own cloud"). Note #830's
   data line, which opened the page until then, leads it; the drawing of what
   runs on whose side (note #827) moved here from "For your team", under
   "Nothing of yours stays with us" with the open-source platform as the
   proof (the installer alone until note #959). The drawing is not on a phone: the engineers it is for
   read it on a laptop, and its labels are too small there (note #834). */
export const OWN_CLOUD_HEADING = 'And all of it runs in your company’s own cloud.';

export function OwnCloud() {
  return (
    <Chapter id="own-cloud" heading={OWN_CLOUD_HEADING}>
      <div className="mt-6 sm:mt-8">
        <div id="with-us">
          <h3 className={H3}>Nothing of yours stays with us.</h3>
          {/* The platform's code and its licence (note #959; the installer's code
              until then), and why it is Fly (note #838). */}
          <div className="mt-4 flex flex-wrap items-center gap-x-7 gap-y-4">
            <SecondaryLink href={PLATFORM_SOURCE_URL}>Read the code</SecondaryLink>
            <SecondaryLink href={PLATFORM_LICENSE_URL}>The AGPL-3.0 licence</SecondaryLink>
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
   start: no button anywhere jumps here, only the first screen's text link.
   Since note #951 it is headed with the action's own name, which that link
   says too; it was "How to start." until then. */
export function HowToStart() {
  return (
    <Chapter id="start" heading={`${BUILD_YOURS}.`}>
      <OwnCloudAction />
      {/* Since note #978 (the owner, 4 Nov 2026, 13:26 UTC: "in the landing
          page each section should be without description text") the section
          is its heading and its action: the line with Copy on a laptop, the
          two doors on a phone. The three steps, "What it takes" (the clean
          run's 13 min 24 s, the certificate wait), the paste hint and the
          qualifier "Runs in your own Fly account. Free for now." came off;
          they live in git history and in /own-cloud.md. */}
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
          <div className="flex flex-wrap items-center gap-7">
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
    <Screen id="contact">
      {/* The card reaches past the column by its own padding, so its words
          line up with every other section's (note #839). */}
      <div className={`${CARD} -mx-5 max-sm:rounded-none sm:-mx-7 lg:-mx-8 lg:p-8`}>
        <h2 className={`[text-wrap:balance] ${H2}`}>Talk to us.</h2>
        <div className="mt-7">
          <PrimaryLink href={FOUNDER_MAILTO}>Write to the founder</PrimaryLink>
        </div>
      </div>
    </Screen>
  );
}
