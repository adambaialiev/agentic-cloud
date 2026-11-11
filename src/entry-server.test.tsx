import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APP_PAGES, ROUTES, render, structuredData } from './entry-server';
// @ts-expect-error a plain Node module of the build, with no types of its own
import { nofollowDemoLinks, pageFingerprint } from '../scripts/prerender-lib.mjs';
import { CHAPTERS } from './docs/chapters';

// The prerender is only worth anything if the HTML it produces actually
// contains the page. Two ways it could silently not:
//
//  1. renderToString-style rendering emits the <Suspense> fallback for the
//     lazy() legal pages, so a crawler gets a spinner. (We use React 19's
//     prerender, which waits — this test is what proves it still does.)
//  2. A component reaches for `window` during render and the whole route
//     throws at build time.
//
// Both look fine in a browser, because the client bundle repairs them.

describe('prerendered routes', () => {
  it('gives every route its own title and description', () => {
    const titles = ROUTES.map((route) => route.title);
    const descriptions = ROUTES.map((route) => route.description);

    expect(new Set(titles).size).toBe(ROUTES.length);
    expect(new Set(descriptions).size).toBe(ROUTES.length);
    expect(ROUTES.map((route) => route.path)).toEqual([
      '/',
      '/product',
      '/teams',
      '/terms',
      '/privacy',
      '/claude-code-in-the-cloud',
      '/codex-in-the-cloud',
      '/ai-agents-for-your-team',
      '/four-phases',
      '/why-fly',
      '/self-hosted-coding-agents',
      '/open-source',
      '/docs',
      ...CHAPTERS.map((chapter) => `/docs/${chapter.slug}`),
      '/og-preview',
    ]);
    expect(ROUTES.find((route) => route.path === '/og-preview')?.noindex).toBe(true);
  });

  // Note #1149, from the search report on note #1144: 7 of 20 titles ran past
  // what a search result shows (one was 108 characters) and 8 descriptions
  // past 160. A title is about 60 characters, 66 at most; a description 160.
  it('keeps every title and description inside what a search result shows', () => {
    for (const route of ROUTES.filter((entry) => !entry.noindex)) {
      expect(route.title.length, `${route.path} title: ${route.title}`).toBeLessThanOrEqual(66);
      expect(route.description.length, `${route.path} description`).toBeLessThanOrEqual(160);
    }
  });

  // The report counted 12 of 20 pages with more than one h1, because every
  // live panel brought its screen's own ("Chief of Staff", "Ruby", "Milo").
  // A panel's title is a PanelTitle now, so each page has exactly its own.
  it('draws exactly one h1 on every page', async () => {
    for (const route of ROUTES.filter((entry) => !entry.noindex)) {
      const html = await render(route.path);
      expect(html.match(/<h1[\s>]/g) ?? [], route.path).toHaveLength(1);
    }
  }, 60_000);

  it('says who we are and what each page is in structured data', async () => {
    const types = (path: string) => structuredData(path).map((block) => (block as { '@type': string })['@type']);
    expect(types('/')).toEqual(['Organization', 'WebSite']);
    const organization = structuredData('/')[0] as { name: string; sameAs: string[]; logo: { url: string } };
    expect(organization.name).toBe('Agentic Cloud Computer');
    expect(organization.sameAs).toEqual(['https://agenticcloudcomputer.com/acc/agentic-cloud', 'https://x.com/AgenticCloud']);
    expect(organization.logo.url).toBe('https://agenticcloudcomputer.com/android-chrome-512x512.png');
    expect(types('/product')).toEqual(['SoftwareApplication']);
    // The price is the sentence on claims-we-never-make, "for now" included.
    const software = structuredData('/product')[0] as { offers: { price: string; description: string } };
    expect(software.offers.price).toBe('0');
    expect(software.offers.description).toMatch(/free for now: no licence, no key and no charge from us/);
    expect(JSON.stringify(structuredData('/product'))).not.toMatch(/free forever|always free/i);
    // A FAQ block only where the page draws the questions, and only the
    // words it draws.
    for (const path of ['/claude-code-in-the-cloud', '/codex-in-the-cloud', '/why-fly']) {
      expect(types(path), path).toEqual(['FAQPage']);
      const text = (await render(path)).replace(/<[^>]*>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
      const page = structuredData(path)[0] as { mainEntity: { name: string; acceptedAnswer: { text: string } }[] };
      expect(page.mainEntity.length, path).toBeGreaterThanOrEqual(3);
      for (const entry of page.mainEntity) {
        expect(text, `${path}: ${entry.name}`).toContain(entry.name);
        expect(text, `${path}: answer to ${entry.name}`).toContain(entry.acceptedAnswer.text.slice(0, 60));
      }
    }
    expect(types('/ai-agents-for-your-team')).toEqual([]);
    expect(types('/docs')).toEqual(['BreadcrumbList']);
    for (const chapter of CHAPTERS) {
      const [crumbs] = structuredData(`/docs/${chapter.slug}`) as { itemListElement: { name: string; item: string }[] }[];
      expect(crumbs.itemListElement.map((item) => item.name)).toEqual(['Agentic Cloud Computer', 'Documentation', chapter.title]);
      expect(crumbs.itemListElement[2].item).toBe(`https://agenticcloudcomputer.com/docs/${chapter.slug}`);
    }
  }, 60_000);

  it('lists the app catalogue and the open-source repository for the sitemap', () => {
    expect(APP_PAGES.map((page) => page.path)).toEqual(['/apps', '/acc/agentic-cloud']);
  });

  // The demo panels' rows are real links a crawler can follow: into the demo
  // workplace, and to Northstar's made-up addresses on a domain that is
  // somebody else's. The build marks each one nofollow and touches no other.
  it('marks the demo panels’ links nofollow on the way out, and no other link', async () => {
    expect(nofollowDemoLinks('<a class="row" href="/notes/57?org=org_northstar">x</a>')).toBe('<a rel="nofollow" class="row" href="/notes/57?org=org_northstar">x</a>');
    expect(nofollowDemoLinks('<a href="/drive/files/drive_1?a=1&amp;org=org_northstar">x</a>')).toContain('rel="nofollow"');
    expect(nofollowDemoLinks('<a href="https://track.agents.northstar.com" target="_blank" rel="noopener">x</a>')).toBe('<a href="https://track.agents.northstar.com" target="_blank" rel="noopener nofollow">x</a>');
    for (const kept of ['<a href="/product">x</a>', '<a href="/login">x</a>', '<a href="https://agenticcloudcomputer.com/acc/agentic-cloud" rel="noopener noreferrer">x</a>', '<a href="https://notnorthstar.com/">x</a>']) {
      expect(nofollowDemoLinks(kept)).toBe(kept);
    }
    // Every link a panel draws is one of the two kinds: nothing inside a
    // fence leads anywhere else that a crawler could follow.
    for (const route of ROUTES.filter((entry) => !entry.noindex)) {
      const html = nofollowDemoLinks(await render(route.path));
      const followed = (html.match(/<a\s[^>]*>/g) ?? []).filter((tag: string) => !/rel="[^"]*nofollow/.test(tag) && /href="\/(notes|drive|agents|knowledge|repos|proposals|secrets|sites|workplace|mail|chief)\b/.test(tag));
      expect(followed, route.path).toEqual([]);
    }
  }, 60_000);

  it('fingerprints a page by its words, not its markup', () => {
    const route = { title: 'T', description: 'D' };
    expect(pageFingerprint(route, '<p class="a">One  two</p>')).toBe(pageFingerprint(route, '<div><span>One</span> two</div>'));
    expect(pageFingerprint(route, '<p>One two</p>')).not.toBe(pageFingerprint(route, '<p>One three</p>'));
    expect(pageFingerprint({ title: 'T2', description: 'D' }, '<p>One two</p>')).not.toBe(pageFingerprint(route, '<p>One two</p>'));
  });

  it('carries the product page’s headline and what is built in into its public metadata', () => {
    const home = ROUTES.find((route) => route.path === '/');

    // Note #787 (the owner, 2026-10-25): the cloud computer and the closed
    // laptop stopped being the reason to choose us, so the title names what
    // is built in, and the description opens on the page's own headline and
    // sub-line and ends on the price. Before it, note #182's "A team of
    // Claude Code and Codex agents in the cloud".
    // Since note #1004 (the owner's pick, 5 Nov 2026, 14:30 UTC) the title
    // names the problem we solve, with the name at its end, and the share
    // preview's title is the same words without the name; the description
    // opens on the film's closing words ("Your cloud." says where it runs)
    // and names what is built in.
    // Since note #1149 (Adam, 11 Nov 2026, agreeing to the search fixes of
    // note #1144) the <title> a search result shows leads with the words
    // people type; the share preview keeps the title of note #1004.
    expect(home?.title).toBe('Self-hosted Claude Code and Codex agents — Agentic Cloud Computer');
    expect(home?.shareTitle).toBe('One workplace for Claude Code, Codex and OpenCode agents');
    // Since note #1137 (10 Nov 2026) the description says what the title
    // does not, and never names the three agents again. The share preview
    // carries those words alone; the search result's opens on "Open source."
    expect(home?.shareDescription).toBe('Each agent works on a computer of its own in your company’s cloud. None of your data comes to us. Git, hosting and email are built in.');
    expect(home?.description).toBe(`Open source. ${home?.shareDescription}`);
    expect(home?.description).not.toMatch(/Claude Code|Codex|OpenCode|daily report/);
    expect(home?.description).not.toMatch(/second brain/);
    expect(home?.description).not.toMatch(/cloud computer|laptop|a cloud to work in/i);
    for (const route of ROUTES) expect(route.description, route.path).not.toMatch(/\bfree\b|at no charge|\bour cloud/i);
    expect(home?.description).not.toMatch(/ask before anything important ships/);
  });

  // Every address we stop publishing needs a rule here, because the SPA
  // fallback answers an unknown path with index.html and a 200 — so a deleted
  // page silently serves the homepage and a crawler files it as a duplicate of
  // the front page rather than dropping it. The tour and the articles were
  // removed on 2026-09-07 and were all indexed.
  it('retires every removed URL at the edge instead of leaving its old static page behind', () => {
    const redirects = readFileSync('public/_redirects', 'utf8');
    const retired = [
      '/pricing',
      '/pricing/',
      '/tour',
      '/guides',
      '/guides/claude-code-in-the-cloud',
      '/guides/claude-code-channels',
      '/guides/keep-claude-code-running',
      '/guides/openclaw-hosting',
      '/guides/what-to-hand-an-ai-engineer',
      '/guides/claude-code-alternatives',
      '/guides/claude-code-pricing',
      '/guides/claude-code-on-your-phone',
      '/guides/background-agents',
      '/guides/ai-agent-for-a-small-business',
      '/guides/hire-an-ai-engineer',
      // The public Leaderboard, taken down on 2026-10-28 (note #824).
      '/leaderboard',
      '/leaderboard/',
    ];

    // Old addresses a new page took over (note #1154): the VPS guide goes to
    // the self-hosted page, and /open-source is a page again.
    expect(redirects).toMatch(/^\/guides\/claude-code-on-a-vps\s+\/self-hosted-coding-agents\s+301$/m);
    expect(redirects).not.toMatch(/^\/open-source\/?\s/m);

    for (const path of retired) {
      expect(ROUTES.some((route) => route.path === path), `${path} is still prerendered`).toBe(false);
      expect(redirects, `${path} has no edge redirect`).toMatch(
        new RegExp(`^${path.replace(/\//g, '\\/')}\\s+\\/\\s+301$`, 'm'),
      );
    }
  });

  // The Request access page (note #791) lived a few hours on 2026-10-25;
  // sign-up came back the same evening (note #794), so its address sends a
  // visitor to the sign-up it stood in for, and no file is left behind.
  it('sends the retired request page to sign-up', () => {
    const redirects = readFileSync('public/_redirects', 'utf8');
    for (const path of ['/request-access', '/request-access/']) {
      expect(ROUTES.some((route) => route.path === path), `${path} is still prerendered`).toBe(false);
      expect(redirects).toMatch(new RegExp(`^${path.replace(/\//g, '\\/')}\\s+\\/signup\\s+301$`, 'm'));
    }
  });

  // The lesson of 2026-08-29, an hour after the pitch moved to the front page.
  // /teams was turned into a router redirect and dropped from ROUTES, so the
  // build stopped emitting a file there — and the CDN went on serving the last
  // copy it had, which was the pre-change page including the self-serve door
  // that change had just removed, for as long as its cache header allowed.
  //
  // A shared address cannot be retired by deleting it. It has to keep
  // publishing something, or whatever a cache is holding becomes the page.
  // The link preview is the most-seen thing we publish — the whole sales
  // motion is a forwarded link, and the card is what a stranger reads first.
  // It is also the only surface with NO way to notice it has gone stale: a
  // picture and two meta tags cannot contradict themselves, no page breaks,
  // and nobody on the team ever sees the card they are sending.
  //
  // That is how og:title sat on "Hire an engineer by sending a text" for the
  // ten days after the 2026-08-20 pivot retired it — on EVERY route, because
  // prerender rewrote each page's description and left the social titles
  // frozen at index.html's copy. This test fails the day a page-specific
  // social tag is added to index.html without teaching prerender to rewrite
  // it per route.
  it('rewrites every page-specific social tag, so no card can freeze', () => {
    const read = (relative: string) =>
      readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
    const indexHtml = read('../index.html');
    const prerender = read('../scripts/prerender.mjs');

    // Tags whose content names THIS page. og:image and og:type are the same on
    // every route by design, so they are deliberately absent from this list.
    const pageSpecific = ['og:title', 'og:description', 'og:url', 'twitter:title', 'twitter:description'];

    for (const tag of pageSpecific) {
      expect(indexHtml, `${tag} missing from index.html`).toContain(`"${tag}"`);
      expect(prerender, `prerender.mjs never rewrites ${tag} per route`).toContain(`"${tag}"`);
    }
  });

  it('still publishes the pitch’s old address, pointing home', async () => {
    const teams = ROUTES.find((route) => route.path === '/teams');
    expect(teams).toBeTruthy();
    // Not competing with the front page for the same search result.
    expect(teams?.noindex).toBe(true);
    // Its canonical is the pitch's own address since note #774.
    expect(teams?.canonicalPath).toBe('/product');

    // And it is the pitch itself, not an empty shell or a bounce: a forwarded
    // link has to work for a reader with no JavaScript.
    const html = await render('/teams');
    expect(html).toContain('Everything an agent needs to finish the job.');
    expect(html).toContain('Build your own Agentic Cloud');
    expect(html.length).toBeGreaterThan(2000);
  });

  // A WALL CLOCK cannot be in the server's HTML. The build machine writes its
  // own hour, in its own timezone, hours or days before anybody loads the
  // page; the visitor's browser computes another one from its own clock, and
  // React reads the difference as a hydration mismatch — a real page error,
  // which `scripts/verify-front-page-redirect.mts` fails on in CI.
  //
  // The live panels are REAL product components (src/components/Live*.tsx), so
  // this is not a rule the page can keep on its own: note #529 gave the inbox
  // row a clock against its right edge, and the landing's mail panel started
  // prerendering the build machine's afternoon. A relative age hides the
  // problem — "14m ago" is the same string on both machines — which is why
  // the first absolute time on any reused screen is the one that breaks it.
  // The fix is always the same and is already the house pattern: the panel
  // draws that part only once `useHydrated()` is true (live/fixture.ts).
  it('prerenders no wall clock, on any route', async () => {
    for (const route of ROUTES) {
      const html = await render(route.path);
      const text = html.replace(/<[^>]*>/g, '\n');
      const clocks = text.match(/\b\d{1,2}:\d{2}(:\d{2})?( ?[AP]M)?\b/g) ?? [];
      expect(clocks, `${route.path} prerenders a clock`).toEqual([]);
    }
  });

  it.each([
    // The front page is the team pitch since 2026-08-29; the needle is the
    // beat that exists nowhere else on the site.
    // The page's h1, which says what the product is since note #1149 (note
    // #835's "Give them a workplace." until then).
    ['/', 'The self-hosted, open-source workplace for Claude Code, Codex and OpenCode agents.'],
    ['/product', 'Everything an agent needs to finish the job.'],
    ['/terms', 'Terms of Service'],
    ['/privacy', 'Privacy Policy'],
    ['/claude-code-in-the-cloud', 'Run Claude Code in the cloud'],
    ['/codex-in-the-cloud', 'beside your Claude Code agents'],
    ['/ai-agents-for-your-team', 'A whole team of AI agents, run by one person'],
    ['/four-phases', 'One agent becomes a team.'],
    ['/why-fly', 'Questions your team will ask.'],
    ['/self-hosted-coding-agents', 'Self-hosting moves where the agent works, not where the model thinks.'],
    ['/open-source', 'Why the source matters for an agent platform.'],
  ])('renders %s to HTML containing its own content', async (path, needle) => {
    const html = await render(path);

    expect(html).toContain(needle);
    // A Suspense fallback would render an empty shell instead of the page.
    expect(html.length).toBeGreaterThan(2000);
  });

  // The reason the tracked CTA links are built in an effect rather than during
  // render. Prerendering happens once, at build time, with no browser and no
  // query string — so a href that consults `window.location` while rendering
  // either throws here or bakes one visitor's campaign into the HTML every
  // later visitor is served. Both were live bugs before; this is the guard.
  // The front page opens the Workspace directly, and must remain deterministic
  // when prerendered.
  it('bakes a constant door into the prerendered HTML', async () => {
    const [first, second] = await Promise.all([render('/'), render('/')]);

    expect(first).toBe(second);
    // Sign-up was the door until note #822 (only the private copy is
    // offered); for a few hours (note #791) it was a request form, and
    // nothing may link that page now. Since note #924 the first screen's
    // door was a text link to How to start, on the same page; since note
    // #984 that screen is gone and the page opens on the film, so the
    // section itself is the door.
    expect(first).toContain('id="start"');
    expect(first).not.toContain('href="#start"');
    expect(first).not.toContain('href="/signup"');
    expect(first).not.toContain('href="/request-access"');
    expect(first).not.toContain('t.me/');
  });


  // Every page carries a route to the product and a call to action, so no page
  // is one a reader gets stranded on.
  it('puts the same navigation on every page', async () => {
    // /og-preview is a bare canvas for screenshotting the social card, not a
    // page anyone navigates to — it is noindex for the same reason.
    for (const route of ROUTES.filter((candidate) => !candidate.noindex)) {
      const html = await render(route.path);

      expect(html).not.toContain('href="/pricing"');
      expect(html).not.toContain('href="/guides"');
      // One door, in one of its forms: How to start on the front page (its
      // own section, note #924), the line for an agent on the pages that
      // pitch it, and the product page from the legal pages. The header
      // carries none of them since note #924, so the help pages, read by
      // people already in a Workspace, keep the mark and the footer.
      if (!route.path.startsWith('/docs')) expect(html, route.path).toMatch(/How to start|Build your own Agentic Cloud|See how it works/);
      // Since note #822 no public page sends a stranger to sign up.
      expect(html, route.path).not.toContain('href="/signup"');
      // Since 2026-10-28, 11:09 UTC (the owner) the offer is "your own
      // Agentic Cloud", never a "copy", on every page (the engineer's page
      // followed with notes #827 and #829).
      expect(html, route.path).not.toMatch(/private copy|your own copy|Get a copy/i);
      expect(html).not.toContain('href="/request-access"');
    }
  });


  it('keeps the front page opening the private copy rather than a personal contact', async () => {
    const html = await render('/');

    // The line for an agent, in How to start (the address every door uses).
    expect(html).toContain('id="give-your-agent"');
    // Since note #1097 the line is set in groups so it wraps well on a
    // phone; its text, tags aside, is still the one line that is copied.
    const line = html.match(/<code id="agent-line"[^>]*>([\s\S]*?)<\/code>/)?.[1] ?? '';
    expect(line.replace(/<[^>]*>/g, '')).toBe('Set up our own Agentic Cloud by following https://agenticcloudcomputer.com/own-cloud.md');
    expect(html).not.toContain('t.me/');
    expect(html).not.toContain('t.me/AgenticCloudComputerBot');
  });



  it('never publishes the operator’s personal identifiers on any page', async () => {
    const personalMarkers = ['Sadd' + 'am', 'Bai' + 'aliev', 'Kyr' + 'gyz Republic', 'Bish' + 'kek', 'a' + 'dam' + '_6421'];
    for (const route of ROUTES) {
      const html = await render(route.path);
      for (const marker of personalMarkers) expect(html).not.toContain(marker);
    }
  });

});
