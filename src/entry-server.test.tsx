import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROUTES, render } from './entry-server';
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
      '/docs',
      ...CHAPTERS.map((chapter) => `/docs/${chapter.slug}`),
      '/og-preview',
    ]);
    expect(ROUTES.find((route) => route.path === '/og-preview')?.noindex).toBe(true);
  });

  it('carries the product page’s headline and what is built in into its public metadata', () => {
    const home = ROUTES.find((route) => route.path === '/');

    // Note #787 (the owner, 2026-10-25): the cloud computer and the closed
    // laptop stopped being the reason to choose us, so the title names what
    // is built in, and the description opens on the page's own headline and
    // sub-line and ends on the price. Before it, note #182's "A team of
    // Claude Code and Codex agents in the cloud".
    expect(home?.title).toBe('Claude Code and Codex agents with git, hosting, storage and email built in — Agentic Cloud Computer');
    expect(home?.description).toMatch(/^Everything an agent needs to finish the job\./);
    expect(home?.description).not.toMatch(/second brain/);
    expect(home?.description).not.toMatch(/cloud computer|laptop|a cloud to work in/i);
    expect(home?.description).toMatch(/Git with CI\/CD, hosting, storage, email, Drive, notes and memory/);
    // Since note #822 it ends on where it runs: only the private copy is
    // offered, and a copy is free only in its trial (claims-we-never-make).
    expect(home?.description).toMatch(/In your own cloud account, on the plan you already pay for\.$/);
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
      '/guides/claude-code-on-a-vps',
      '/guides/openclaw-hosting',
      '/guides/what-to-hand-an-ai-engineer',
      '/guides/claude-code-alternatives',
      '/guides/claude-code-pricing',
      '/guides/claude-code-on-your-phone',
      '/guides/background-agents',
      '/guides/ai-agent-for-a-small-business',
      '/guides/hire-an-ai-engineer',
      '/open-source',
      '/open-source/',
      // The public Leaderboard, taken down on 2026-10-28 (note #824).
      '/leaderboard',
      '/leaderboard/',
    ];

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
    // The headline (note #835; note #830's "What makes your agents good stays
    // yours." until then).
    ['/', 'Give them a workplace.'],
    ['/product', 'Everything an agent needs to finish the job.'],
    ['/terms', 'Terms of Service'],
    ['/privacy', 'Privacy Policy'],
    ['/claude-code-in-the-cloud', 'Run Claude Code in the cloud'],
    ['/codex-in-the-cloud', 'beside your Claude Code agents'],
    ['/ai-agents-for-your-team', 'A whole team of AI agents, run by one person'],
    ['/four-phases', 'One agent becomes a team.'],
    ['/why-fly', 'Questions your team will ask.'],
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
    expect(html).toContain('Set up our own Agentic Cloud by following https://agenticcloudcomputer.com/own-cloud.md');
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
