import React from 'react';
import { render as renderBare, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import Landing from './Landing';

// The live fleet panel is built from the Workspace's own row component, which
// navigates on tap and so needs a router above it — as it has on the site.
const render = (ui: React.ReactElement) => renderBare(<MemoryRouter>{ui}</MemoryRouter>);

describe('Landing', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('leads with what is built in and says plainly what the product is', () => {
    render(<Landing />);

    // Since note #787 (the owner, 2026-10-25) the page opens on what the
    // agents get already built in. "A cloud computer", "beyond the laptop"
    // and "works with your laptop closed" stopped being a reason to choose
    // us once Claude Code and Codex ran in the cloud themselves. The title,
    // the metas and llms.txt open the same way (the shared social card has
    // carried the home page's words since note #1004). Still no hero above it and no door (note #199): the headline is
    // the first section's heading, and the page's one h1.
    const h1 = screen.getByRole('heading', { level: 1, name: 'Everything an agent needs to finish the job.' });
    expect([...document.querySelectorAll('h1')].filter((node) => !node.closest('.ws-live'))).toEqual([h1]);
    const first = document.querySelector('main > section')!;
    expect(first.id).toBe('built-in');
    expect(h1.closest('section')).toBe(first);
    expect(first.textContent).toContain('Git with CI/CD, hosting, storage, email, Drive, notes and memory, built in for Claude Code, Codex and OpenCode agents. In your own cloud account, on the plan you already pay for.');
    expect(first.textContent).toMatch(/they stop at a pull\s+request/);
    expect(document.querySelector('.landing-marquee')).toBeNull();
    expect(screen.queryAllByRole('link', { name: 'Start free' })).toEqual([]);
    // The owner's eight, in his order.
    expect([...first.querySelectorAll('h2')].filter((h) => !h.closest('.ws-live')).map((h) => h.textContent)).toEqual([
      'Git',
      'Hosting',
      'Storage',
      'Email',
      'Drive',
      'Notes',
      'Memory',
      'Keys',
    ]);
  });

  // What the page led on until note #787, and must not say anywhere now.
  it('says nothing about a cloud computer or a closed laptop', () => {
    render(<Landing />);

    // The product's name is the one "cloud computer" the page keeps.
    const body = (document.body.textContent ?? '').replace(/\s+/g, ' ').replaceAll('Agentic Cloud Computer', '');
    expect(body).not.toMatch(/cloud computer|beyond the laptop|laptop clos|close the (lid|laptop)|a cloud to work in/i);
    expect(document.querySelector('#anatomy')).toBeNull();
    expect(document.querySelector('#surfaces')).toBeNull();
    expect(document.querySelector('#keys')).toBeNull();
  });

  it('breaks the long product tour into quiet chapters', () => {
    render(<Landing />);

    const dividers = [...document.querySelectorAll('.landing-chapter-divider')];
    // Sixteen until note #182, eight once the owner simplified the page
    // (2026-10-08), five after note #199, seven with the Chief of Staff and
    // the app catalogue. Five since note #787 (2026-10-25): "Code, sites,
    // pages and files, in one place." and the keys became cards in the deck
    // the page opens on, and the catalogue follows it straight away. Six
    // since note #818: the private copy's door closes the page.
    expect(dividers).toHaveLength(6);
    expect(document.querySelector('#built-in .landing-chapter-divider')).toBeNull();
    expect(dividers.map((divider) => divider.closest('section')?.querySelector('h2')?.textContent)).toEqual([
      'Built here. Found here.',
      'Git hosting made for agents.',
      'Talk to one agent. It runs the rest.',
      'Run the whole team from your phone.',
      'More subscriptions, more agents at once.',
      'Your own Agentic Cloud.',
    ]);
    for (const divider of dividers) {
      expect(divider.textContent).toBe('');
      expect(divider.getAttribute('aria-hidden')).toBe('true');
      expect(divider.className).toContain('w-screen');
      expect(divider.className).toContain('left-1/2');
      expect(divider.className).toContain('-translate-x-1/2');
    }
  });

  // Note #172 (the owner, 2026-10-04) put the four phases of AI at work on
  // this page; note #199 (2026-10-09) moved them to /four-phases, with the
  // moving row and a chapter per phase (see FourPhases.test).
  it('leaves the four phases to their own page, and links it from the footer', () => {
    render(<Landing />);

    expect(document.querySelector('#phases')).toBeNull();
    expect(document.body.textContent).not.toMatch(/AI at work has four phases|Connected chat|Agents with a computer/);
    const footer = document.querySelector('footer')!;
    expect([...footer.querySelectorAll('a')].find((link) => link.getAttribute('href') === '/four-phases')?.textContent)
      .toBe('The four phases of AI at work');
  });

  // Note #818 (the owner, 2026-10-28): a page for the engineer a company
  // sends to check us out, linked from this page (the door is Landing's
  // own, not ProductPitch's). Since note #822 the copy is the only offer,
  // so this section is how a reader gets everything above. The provider's
  // name stays on that page: this one never says it (see the machines test
  // below).
  it('closes on the door to the private copy, the one offer', () => {
    render(<Landing />);

    const section = document.querySelector('#private-copy')!;
    expect(section.querySelector('h2')?.textContent).toBe('Your own Agentic Cloud.');
    expect(section.textContent).toMatch(/Everything on this page runs in your company’s own cloud account/);
    expect(section.querySelector('a')?.textContent).toMatch(/^Build your own Agentic Cloud/);
    expect([...section.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual(['/#give-your-agent']);
    expect(document.querySelector('main > footer')?.previousElementSibling).toBe(section);
  });

  it('draws the built-in cards as the Workspace’s own screens', () => {
    render(<Landing />);

    const deck = document.querySelector('#built-in')!;
    const panels = deck.querySelectorAll('.ws-live');
    expect(panels).toHaveLength(8);
    // Every one at a tile: Home's own sections, and the inbox's own rows.
    for (const panel of panels) {
      expect(panel.className).toContain('ws-tile');
      expect(panel.className).not.toContain('ws-face');
    }
    // Storage is Home's own Storage card over three buckets, one public.
    const buckets = [...deck.querySelectorAll('#storage .crow')];
    expect(buckets.map((row) => row.querySelector('.name')?.textContent)).toEqual(['delivery-photos', 'nightly-exports', 'map-tiles']);
    expect(buckets.map((row) => row.querySelector('.cside')?.textContent)).toEqual(['private', 'private', 'public']);
    expect(deck.querySelector('#storage .quota')?.textContent).toBe('3 buckets · 1 public, readable by anyone with a link');
  });

  // The owner put the film "Beyond the laptop" beside the opening heading on
  // 2026-10-08. Its first twenty seconds tell the laptop story note #787
  // retired (2026-10-25), so it is off the page until it is re-cut; the
  // component (LandingFilm) stays for that.
  it('leaves the Beyond the laptop film off until it is re-cut', () => {
    render(<Landing />);

    expect(document.querySelectorAll('main video')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Play the film/ })).toBeNull();
  });

  it('leaves the removed landing sections out of the page', () => {
    render(<Landing />);

    expect(document.querySelector('#mail')).toBeNull();
    expect(document.querySelector('#oversight')).toBeNull();
    expect(document.querySelector('#people')).toBeNull();
    // Note #182 (2026-10-08): the loop header, its Capture and Remember
    // chapters, and the margin section repeated panels shown elsewhere.
    for (const id of ['loop', 'handoff', 'memory', 'brains', 'margin']) {
      expect(document.querySelector(`#${id}`)).toBeNull();
    }
    // The owner simplified the page the same day: the loop's Work and Decide
    // chapters, the ownership deck, the people section, the free section,
    // the FAQ and the docs section came off too.
    for (const id of ['ask', 'peers', 'proof', 'data', 'team', 'free', 'questions', 'docs']) {
      expect(document.querySelector(`#${id}`)).toBeNull();
    }
    // Note #199 (2026-10-09): the hero, the four phases and the closing
    // door came off.
    for (const id of ['phases', 'door']) {
      expect(document.querySelector(`#${id}`)).toBeNull();
    }
    const body = document.body.textContent ?? '';
    expect(body).not.toMatch(/Capture\. Remember\. Work\. Decide\.|It runs on the cloud\. What it builds is yours\.|more brains in it|Bring the team in|The questions people actually ask|Everything it does, written down|Free to use\. Give your first agent a job today/);
    expect(body).not.toMatch(/Give your first agent a job|A team of Claude Code and Codex agents, each on a cloud computer of its own/);
  });

  it('keeps the selected live sections on the shared product scale', () => {
    render(<Landing />);

    const tileHeadingNames = [
      'More subscriptions, more agents at once.',
    ];
    for (const name of tileHeadingNames) {
      const heading = screen.getByRole('heading', { name });
      const panel = heading.closest('section')!.querySelector('.ws-live')!;
      expect(panel.className).toContain('ws-tile');
      expect(panel.className).not.toContain('ws-face');
    }

    const phone = screen.getByRole('heading', { name: 'Run the whole team from your phone.' })
      .closest('section')!.querySelector('.landing-phone')!;
    expect(phone.className).toContain('landing-phone');
  });

  // The section's claim is that model time stacks (note #143), so the panel
  // beside it has to be a workplace that HAS stacked it: four sign-ins, two
  // of each plan, rather than one of each — which is a picture of the
  // smallest workplace there is and says nothing about adding a second.
  it('shows a workplace that already holds four subscriptions, two of each plan', () => {
    render(<Landing />);

    const section = screen
      .getByRole('heading', { name: 'More subscriptions, more agents at once.' })
      .closest('section')!;
    const plates = [...section.querySelectorAll('#seatsHome .seatcard')];
    expect(plates.map((plate) => [
      plate.querySelector('.name .label')!.textContent,
      plate.querySelector('.name .plan')!.textContent,
    ].join(' '))).toEqual([
      'Claude Max 20x',
      'Claude Max 20x',
      'ChatGPT Pro 5x',
      'ChatGPT Pro 5x',
    ]);
    // Every plate carries its own readings, and the live dot is the app's own
    // join (an agent mid-turn on that seat), not a decoration on the primary.
    for (const plate of plates) expect(plate.querySelectorAll('.seatstat')).toHaveLength(2);
    expect(section.querySelectorAll('#seatsHome .seatcard .seatdot')).toHaveLength(4);
  });

  // The owner's rule for the AI sign-in (2026-10-08): never say that
  // Anthropic or OpenAI allows, approves or permits it, or that an account is
  // safe. Anthropic's Claude Code legal page restricts third parties that
  // store Claude credentials, and the platform stores the token
  // (claims-we-never-make). His own sentence ("You sign in on Claude's own
  // page, and your password never touches us.") is too much for this page,
  // he said the same day; the docs carry it.
  it('never says the AI sign-in is allowed or an account is safe', () => {
    render(<Landing />);

    const body = (document.body.textContent ?? '').replace(/\s+/g, ' ');
    expect(body).not.toMatch(/(Anthropic|OpenAI|Claude|ChatGPT)[^.]{0,80}\b(allows?|approves?|approved|permits?|permitted|endorses?|compliant|complies)\b/i);
    expect(body).not.toMatch(/\b(allowed|approved|permitted|endorsed) by (Anthropic|OpenAI)|within (Anthropic|OpenAI)’?s? terms|account (is|stays) safe/i);
  });

  // The page before this one carried four pictures, all of them of a build of
  // the Workspace that no longer exists and all shrunk past legibility. The
  // point of the redesign is that the product is SHOWN, so the count is part of
  // what the test protects: a rewrite that drops back to a handful of pictures
  // has undone the thing that was wrong.
  // The page before this one carried four pictures, all of them of a build of
  // the Workspace that no longer exists and all shrunk past legibility. The
  // point of the redesign is that the product is SHOWN, and since 2026-09-07
  // it is shown by running its own components on the page: every panel is
  // the Workspace, and there is no capture left to go stale. The count is
  // what the test protects — a rewrite that drops back to a handful of
  // pictures, or to prose, has undone the thing that was wrong.
  it('shows the product itself: the Workspace’s own components, running, and no capture', () => {
    render(<Landing />);

    const shots = screen.queryAllByRole('img').filter((img) => (img.getAttribute('src') ?? '').startsWith('/shots/'));
    expect(shots.length).toBe(0);
    // 22 until the pocket section's four shrunk copies became one real phone,
    // 18 until the owner simplified the page (2026-10-08), 13 until the
    // hero's moving row went to /four-phases with the phases (note #199).
    const live = document.querySelectorAll('.ws-live').length;
    expect(live).toBeGreaterThanOrEqual(12);
    // Every panel is fenced off from the reader's tap and from assistive
    // technology, and says in a sentence what it shows instead.
    for (const panel of document.querySelectorAll('.ws-live')) {
      expect(panel.hasAttribute('inert')).toBe(true);
      const said = panel.previousElementSibling;
      expect(said?.className).toBe('sr-only');
      expect((said?.textContent ?? '').length).toBeGreaterThan(20);
    }
  });

  // The tour and the articles were removed on 2026-09-07: the landing page is
  // the whole public site now, apart from the legal documents. A link left
  // pointing at a retired address is a link into the edge redirect.
  it('links nothing that was retired with the rest of the site', () => {
    render(<Landing />);

    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href') ?? '');
    expect(hrefs.some((href) => href === '/tour' || href.startsWith('/guides'))).toBe(false);
  });

  // The FAQ came off the page on 2026-10-08 (the owner); what must never
  // come back with any copy is the flattering or outdated version of these.
  it('makes none of the claims the page has retired', () => {
    render(<Landing />);

    const body = document.body.textContent ?? '';
    // "Does the AI see my code?" was retired from the page on 2026-09-16 at
    // the owner's request; the split between what the model reads and what we
    // hold lives in /privacy. What must never come back is the flattering
    // version of it — see the "claims we never make" page.
    expect(body).not.toMatch(/never sees your code|your code never leaves/i);
    expect(body).not.toMatch(/An email address and a browser/);
    expect(body).not.toMatch(/fifteen quiet minutes/);
    // The owner, 2026-10-03: the page names no business or team AI plan.
    expect(body).not.toMatch(/business or team plans|Claude Team|ChatGPT (Business|Team|Enterprise)/i);
    // Note #177 (2026-10-07): a seat is personal, so no plan is the team's,
    // and an admin can copy a shared key.
    expect(body).not.toMatch(/what they learned stays|team’s own Claude/);
    expect(body).not.toMatch(/No\. Only an admin can add a key|nothing shows it again/);
  });

  // The promise the product is built on, now that the proposal chapter is
  // gone: the anatomy deck's gate card says it.
  it('keeps the proposal promise the product is built on', () => {
    render(<Landing />);

    // The gate card went with the anatomy deck (note #787); the Git card and
    // the Chief of Staff carry the promise now. Never "every change is a
    // proposal": a site can deploy without a card.
    const body = (document.body.textContent ?? '').replace(/\s+/g, ' ');
    expect(body).toContain('Every push is tested, a change waits for your yes or merges itself once you turn on auto-merge, and you’re told either way.');
    expect(body).toContain('It never approves anything itself. That is always your call.');
    // Knowledge changes land at once since note #746: never say a person
    // approves each one. The agents keep the memory themselves, with nothing
    // for the owner to manage (the owner, 2026-10-25).
    expect(body).toContain('Agents write what they learn into knowledge pages, read them before every job and keep them up to date. Nothing for you to manage.');
    expect(body).not.toMatch(/every page of company knowledge, comes back as a proposal|every change approved by you/);
  });

  it('puts each section’s explanation before its illustration on mobile', () => {
    render(<Landing />);

    // Every section with a panel, since the two that drew theirs on the left
    // (#proof and #ask) came off with the rest of the loop (2026-10-08).
    const sections = [...document.querySelectorAll('main > section[id]')].filter((section) => section.querySelector('.ws-live'));
    expect(sections.length).toBeGreaterThan(4);
    for (const section of sections) {
      const heading = section.querySelector('h2')!;
      const illustration = section.querySelector('.ws-live')!;
      expect(heading.compareDocumentPosition(illustration) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('shows memory, Drive and keys in the deck the page opens on', () => {
    render(<Landing />);

    const deck = document.querySelector('#built-in')!;
    // Home's own Knowledge glimpse: three pages, each signed by the agent
    // that last landed it.
    const pages = [...deck.querySelectorAll('#knowledge .crow')];
    expect(pages.map((row) => row.querySelector('.name')?.textContent)).toEqual([
      'How Northstar is built',
      'On-call for the pings pipeline',
      'What six dispatchers told us',
    ]);
    expect(pages.map((row) => row.querySelector('.cline .keep')?.textContent)).toEqual(['Ruby', 'Otis', 'Ada']);
    // Keys are a card since note #787; until then a section of their own.
    expect(deck.textContent).not.toMatch(/never show|every agent in the room can use it/);
    expect([...deck.querySelectorAll('.ws-live #secrets .crow .name')].map((name) => name.textContent)).toEqual([
      'STRIPE_SECRET_KEY',
      'CLOUDFLARE_API_TOKEN',
      'SLACK_WEBHOOK_URL',
      'DRIVER_SIGNING_KEY',
    ]);
    // The code's home is the platform's own git hosting: no GitHub token.
    expect(deck.textContent).not.toMatch(/GH_TOKEN|GITHUB/);
    expect(deck.querySelector('.ws-live #addBtn')?.textContent).toBe('Add a secret');
    const rows = [...deck.querySelectorAll('#driveItems .driverow')];
    expect(rows.map((row) => row.querySelector('.name')?.textContent)).toEqual([
      'Dispatcher interviews',
      'monday-2000-stops.csv',
      'tunnel-gps-recording.csv',
      'pilot-contract-harbour-freight.pdf',
    ]);
    expect(rows.map((row) => row.querySelector('.cline')?.textContent)).toEqual(['Folder', '3.1 MB', '41.2 MB', '1.2 MB']);
    // The list, not the whole screen: the bar and the search box are the
    // screen's own doors, and the card is the point.
    expect(deck.querySelector('.drivebar')).toBeNull();
    expect(deck.querySelector('.drivesearch')).toBeNull();
  });

  it('shows the platform’s own git hosting as the work around a repository', () => {
    render(<Landing />);

    const git = document.querySelector('#git')!;
    expect(git.querySelector('h2')?.textContent).toBe('Git hosting made for agents.');
    // The section says why: the other hosts were built for people, this
    // one for the pace agents work at (the owner, 2026-09-15).
    const lede = [...git.querySelectorAll('p')].map((p) => p.textContent).join(' ');
    expect(lede).toContain('GitHub was built for people. This was built for agents.');
    expect(lede).toContain('made for fast agentic work');
    // The owner, 2026-10-25: say that the git comes with CI/CD.
    expect(lede).toContain('CI/CD');
    expect(lede).toContain('nothing merges until you say so or turn on auto-merge');
    const panel = git.querySelector('.ws-live')!;
    expect(panel.querySelector('h1')?.textContent).toBe('northstar-routing');
    // No ids on this panel: it is composed so that it can stand beside the
    // files tile, which carries the repository screen's (see LiveRepo).
    expect(panel.querySelector('[id]')).toBeNull();
    const states = [...panel.querySelectorAll('.landing-repo-prs .crow')].map((row) => row.querySelector('.prstate')?.textContent);
    expect(states).toEqual(['Awaiting approval', 'Merged', 'Rejected']);
    expect(panel.querySelectorAll('.landing-repo-checks .checkrow')).toHaveLength(2);
    expect(panel.querySelector('.landing-repo-people .name')?.textContent).toBe('3 contributors');
  });

  // The pocket section is ONE phone at a phone's real width, wearing the chat
  // screen's own shell: head, transcript and compose bar. Four 242px frames
  // stood here before, and the app broke inside a width no phone has.
  it('shows one real phone, with the chat screen as the app draws it there', () => {
    render(<Landing />);

    const section = document.querySelector('#phones')!;
    expect(screen.getByRole('heading', { name: 'Run the whole team from your phone.' })).toBeTruthy();
    expect(section.querySelectorAll('.ws-live').length).toBe(1);
    const phone = section.querySelector('.ws-phone')!;
    expect(phone.querySelector('.chathead .back')).toBeTruthy();
    expect(phone.querySelector('.chathead h1')?.textContent).toBe('Ruby');
    expect(phone.querySelector('.chatbar textarea')?.getAttribute('placeholder')).toBe('Message');
    expect(phone.querySelector('.chatsend')).toBeTruthy();
    expect(section.textContent).not.toMatch(/Open it on your phone and it is the same place/);
    expect(section.textContent).not.toMatch(/Ruby’s conversation on a phone/);
  });

  // The chat runs in the phone's BROWSER — there is no app to install — so
  // the frame wears what a phone shows around a web page: the status bar
  // above, and the browser's bar with the site's address below the app's
  // own compose bar. Without it the mockup read as a native app (note #155).
  // Note #830 (2026-10-29): the demo below a promise of your own cloud
  // showed our hosted product: sites at northstar.agentbuilt.app, a storage
  // quota of ours, "No hosting account to set up". Every address in it is
  // Northstar's own domain now, and no allowance of ours shows.
  it('shows the product as it runs in your own cloud: no address or allowance of ours', async () => {
    render(<Landing />);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const words = document.querySelector('main')!.textContent ?? '';
    expect(words).not.toMatch(/agentbuilt\.app|GB used|No hosting account/);
    expect(words).toContain('Each site is at its own name · agents.northstar.com');
    expect(words).toContain('each at its own address on your domain, running in your own cloud account');
  });

  it('shows the phone chat inside a browser, with the site address under it', () => {
    render(<Landing />);

    const frame = document.querySelector('#phones .landing-phone')!;
    const status = frame.querySelector('.landing-phone-status')!;
    const browser = frame.querySelector('.landing-phone-browser')!;
    expect(status.textContent).toContain('9:41');
    // The Workspace on Northstar's own domain, as in its own Agentic Cloud
    // (note #830): never one of ours.
    expect(browser.textContent).toContain('agents.northstar.com');
    // Order top to bottom: status bar, the app (head … compose bar), browser bar.
    const chatbar = frame.querySelector('.chatbar')!;
    expect(status.compareDocumentPosition(chatbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chatbar.compareDocumentPosition(browser) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The composer is the app's own: the other agents' faces stacked at the
    // left of the box (the switch door), and the mic inside the box. Three
    // faces (the owner, 2026-09-24): the hero's fleet minus Ruby, whose
    // conversation this is.
    expect(chatbar.querySelectorAll('.chatagents .face').length).toBe(3);
    expect(chatbar.querySelector('.chatinput .voicefield .voicebtn')).toBeTruthy();
  });

  it('calls the workers agents throughout the landing page', () => {
    render(<Landing />);

    expect(document.body.textContent).not.toMatch(/\bcoworkers?\b/i);
  });

  it('names no chat app, and no Telegram', () => {
    render(<Landing />);

    const body = document.body.textContent ?? '';
    // The page used to make this point by NEGATION — "they do not each get a
    // Telegram bot" — which was reassurance for readers mid-transition. With
    // Telegram gone (note #313) that sentence raised the question it used to
    // answer, so the claim is stated positively and the page names no chat app
    // at all.
    expect(body).not.toMatch(/Telegram bot|Telegram chat|transition|Telegram access stays available/i);
  });

  // Note #664 (the owner, 2026-09-25): a new workplace connected no cloud
  // of its own, and the page said "The computers, hosting and storage are
  // on us." Since note #822 (the owner, 2026-10-28: "we should not host
  // yet ... Only on-premise") the one offer is the private copy, so the
  // page says everything runs in the company's own cloud account, and
  // nothing offers our cloud or calls the product free.
  it('says the machines run in your own cloud account, and offers no hosting of ours', () => {
    render(<Landing />);

    const body = document.body.textContent ?? '';
    expect(body).toMatch(/The computers, hosting and storage run in\s+your own cloud account, and the subscriptions stay yours\./);
    expect(body).not.toMatch(/on us\b|\bour cloud|at no charge|thirty live sites|\bfree\b/i);
    // The owner, 2026-09-25: the cloud provider is our implementation, not
    // the page's story. The "The cloud is Fly.io" block under the ownership
    // cards went, and nothing on the page names the provider.
    expect(body).not.toMatch(/\bFly\b|Fly\.io|Fly Machine/);
    expect(body).not.toMatch(/token you paste once|The account is yours/i);
    // The page names no number of agents and never says "unlimited" (the
    // owner, 2026-10-27: "Let's not say 'Up to twenty agents'... we dont
    // have limits", "and let's not say 'unlimited' also").
    expect(body).not.toMatch(/no ceiling|never the limit|run a hundred agents|unlimited|free forever/i);
    expect(body).not.toMatch(/up to (twenty|20)|at most (twenty|20)|(twenty|20) agents/i);
    // The owner, 2026-09-25: the "No cloud to connect" card and its Cloud
    // tile went too.
    expect(body).not.toMatch(/No cloud to connect/);
    expect(body).not.toMatch(/nothing of yours resting|we host none of it|conversations? (are|is) not stored/i);
  });

  it('states that the product is free while separating third-party provider costs', () => {
    render(<Landing />);

    const body = document.body.textContent ?? '';
    // The hero said it once after the free section and the FAQ came off
    // (2026-10-08); the hero came off too in note #199 (2026-10-09), so the
    // page says it in its title and description (entry-server.test) and the
    // seats section says whose model time it is. Nothing may put a price
    // back.
    // Since note #787 the seats paragraph says it as "the plan you already
    // pay for" (since 2026-10-27 "the subscription"), and names OpenCode
    // beside the two.
    expect(body).toMatch(/Codex and OpenCode, on the subscription you\s+already pay for/);
    expect(body).not.toMatch(/Bring your AI plan|You pay those providers directly/);
    expect(body).not.toMatch(/one small server|costs the same.*fifty|no per-customer cost|zero marginal/i);
    expect(body).not.toMatch(/\$\s?\d|per seat per month|introductory rate|permanent discount/i);
  });

  // The tone pass (the owner, 2026-09-16): every section paragraph is a
  // pitch, and the mechanism lives in the docs.
  it('keeps the mechanism out of the section pitch', () => {
    render(<Landing />);

    // The section's own prose, not the live seat panel, which is the app's.
    const prose = (id: string) => document.querySelector(`#${id} h2`)!.parentElement!.textContent ?? '';
    expect(prose('subscriptions')).not.toMatch(/five-hour|share one seat/);
  });

  it('does not call any landing-page surface Home', () => {
    render(<Landing />);

    expect(document.body.textContent).not.toMatch(/\bhome\b/i);
  });

  // Rooms left the product on 30–31 Oct 2026 (note #843): the panels are the
  // Workspace's own screens, so none of them may name a room either.
  it('names no room, in the words or in the panels', () => {
    render(<Landing />);

    expect(document.body.textContent).not.toMatch(/\brooms?\b/i);
  });

  it('shows shared memory and work beyond building a website', () => {
    render(<Landing />);

    expect(document.querySelector('#built-in')!.textContent).toMatch(/Agents write what they learn into knowledge pages, read them before every job/);
    expect(document.querySelector('#built-in')!.textContent).toMatch(/Write a task down once and hand it to an agent/);
  });

  // The narrative since 2026-09-15 (the owner): solo workers and small
  // teams, huge output, insanely ambitious work. Until then the same four
  // agents built a one-page site, a headline and a contact form, and the page
  // read as a studio making small websites — not in its headings, in its
  // jobs. So the test pins the jobs: every panel is a piece of one platform
  // with a routing engine, an API, a driver app and a data pipeline, and
  // the small-site work is gone from the page.
  it('tells one ambitious story: a small team building a whole platform, not a website', () => {
    render(<Landing />);

    const body = document.body.textContent ?? '';
    expect(body).toMatch(/Everything an agent needs to finish the job\./);
    expect(body).toMatch(/A whole team of agents, each on its own computer/);
    expect(body).toMatch(/Batch route optimiser for the routing service/);
    expect(body).toMatch(/2,000 stops/);
    expect(body).toMatch(/Usage-based invoicing/);
    expect(body).toMatch(/Pings table partitioned by month/);
    expect(body).toMatch(/Live van map with ETAs/);
    expect(body).toMatch(/northstar-routing/);
    expect(body).toMatch(/northstar-api/);
    expect(body).toMatch(/northstar-driver/);
    expect(body).toMatch(/northstar-pipeline/);
    expect(body).not.toMatch(/one-page (web)?site|pricing page|contact form|homepage headline|brand-voice|northstar-site/i);
  });

  // The billing question ran through the page twice: Ruby asked Milo in the
  // agents' own chat, and Leo asked again in the margin of the billing page.
  // Until 2026-10-03 Milo answered "kilometres driven, return leg included"
  // and the margin settled "per stop, never per kilometre", so the agents
  // were seen agreeing on an answer the people then overturned. Both
  // sections are off the page now; one answer remains: per stop.
  it('bills a route the same way everywhere on the page: per stop', () => {
    render(<Landing />);

    const body = document.body.textContent ?? '';
    // The billing page's margin left the page with its section (note #182),
    // and the agents' own chat with the loop (2026-10-08), so the invoicing
    // note in the anatomy deck is the one place the answer is given now.
    expect(body).toMatch(/Per stop completed, not a flat fee/);
    expect(body).not.toMatch(/kilometres driven|return leg included|stops and kilometres|per kilometre, not|per stop and per kilometre/i);
  });

  it('sends nobody to sign up, and leaves signing in to its own address', () => {
    render(<Landing />);

    // The header's Sign in stood here, for the accounts that already exist,
    // until note #924 (the owner, 31 Oct 2026: "Sign in is not needed, it's
    // only for me"); the sign-in page still answers at /login. Its partner
    // was Sign up (Request access for a few hours of 2026-10-25, note
    // #791); since note #822 only the private copy is offered, so no door on
    // the page leads to sign-up.
    expect(screen.queryAllByRole('link', { name: 'Sign in' })).toEqual([]);
    expect(screen.queryAllByRole('link', { name: /Sign up/ })).toEqual([]);
    expect(screen.getAllByRole('link').filter((link) => link.getAttribute('href') === '/signup')).toEqual([]);
    expect(screen.queryAllByRole('link', { name: /Request access/ })).toEqual([]);

    // None of this name since note #199: the hero's went with the hero, and
    // the free section's on 2026-10-08.
    expect(screen.queryAllByRole('link', { name: 'Start free' })).toEqual([]);
    expect(
      screen.getAllByRole('link').some((link) => (link.getAttribute('href') ?? '').includes('t.me/')),
    ).toBe(false);
  });

  it('offers no self-serve door to the factory bot', () => {
    render(<Landing />);

    const botLinks = screen
      .getAllByRole('link')
      .filter((link) => (link.getAttribute('href') ?? '').includes('t.me/AgenticCloudComputerBot'));
    expect(botLinks).toEqual([]);
  });

  // The header carried no navigation link from 2026-09-16 (the owner): the
  // last one, "Product", went where the mark already goes. Since 2026-10-16
  // it carries Apps and Leaderboard, the two public pages a stranger should
  // reach in one tap (the owner), and still no Product link.
  // Since note #791 (2026-10-25) it carries none again: the site shows the
  // founder's own system. The doors were Sign in and Sign up (Request access
  // for a few hours, until note #794 put sign-up back); since note #822 the
  // second is Build yours (Get a copy until 11:09 UTC), to the engineer's page.
  // Since note #924 (the owner, 31 Oct 2026) it carries neither door: the
  // mark and the name, nothing else.
  it('has a header of the brand alone', () => {
    render(<Landing />);

    const header = document.querySelector('header')!;
    const links = [...header.querySelectorAll('a')].map((link) => (link.textContent ?? '').trim());
    expect(links).toEqual(['Agentic Cloud Computer']);
    expect([...header.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual(['/']);
    expect(header.querySelector('a span')!.className).not.toMatch(/sr-only/);
    // The footer keeps its own Product link; the header is what lost one.
    expect(screen.queryAllByRole('link', { name: 'Product' }).filter((link) => link.closest('header'))).toEqual([]);
    expect(screen.getAllByRole('link').filter((link) => link.getAttribute('href') === '/teams')).toEqual([]);
  });
});
