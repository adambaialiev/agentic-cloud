// Turn the built SPA into real HTML, one file per public route.
//
// Why: the site is a React SPA, so `curl` — and every crawler that does not run
// JavaScript — used to receive an empty <div id="root">. Google renders JS but
// queues it separately from crawling, which delays indexing by days; Bing and
// the AI crawlers (GPTBot, ClaudeBot, PerplexityBot) largely do not render at
// all. For pages that are 100% static prose, that is a self-inflicted wound.
//
// How: `vite build --ssr` compiles src/entry-server.tsx into dist-ssr/, this
// script imports it, renders each route, and writes dist/<route>/index.html
// with the markup inlined and per-route <title>/description/canonical. The
// client bundle still loads and hydrates, so behaviour is unchanged — the HTML
// is just no longer blank on arrival.
//
// Cloudflare Pages serves dist/terms/index.html for /terms, and falls back
// to dist/index.html for anything unmatched, which is what keeps the SPA's
// catch-all redirect working.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nofollowDemoLinks, pageFingerprint } from './prerender-lib.mjs';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const distDir = join(root, 'dist');

const { ROUTES, DOCS, APP_PAGES, render, structuredData } = await import(join(root, 'dist-ssr/entry-server.js'));

const SITE_ORIGIN = 'https://agenticcloudcomputer.com';

function escapeAttribute(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Replace the value of a tag that already exists in index.html, rather than
// appending a second one: two <title>s or two canonicals is worse than a wrong
// one, because which wins is up to the crawler.
function replaceMeta(html, pattern, replacement) {
  if (!pattern.test(html)) {
    throw new Error(`prerender: index.html no longer contains ${pattern} — meta injection would silently do nothing`);
  }
  return html.replace(pattern, replacement);
}

// The JSON-LD blocks of a route (src/lib/structured-data.ts, note #1149),
// written into its <head>. `<` is escaped so no string in the data can close
// the script element early.
function structuredDataTags(path) {
  return structuredData(path)
    .map((block) => `    <script type="application/ld+json">${JSON.stringify(block).replace(/</g, '\\u003c')}</script>\n`)
    .join('');
}

// When each page last changed, for the sitemap's <lastmod> (note #1149). The
// build machine has no history to ask (it fetches one commit), and stamping
// every page with the build's own date teaches a search engine to ignore the
// field. So the dates are recorded: src/lib/sitemap-lastmod.json holds, per
// route, a fingerprint of the page's words and the day they last changed. A
// page whose words still match keeps its recorded day; a page that changed
// since is dated today, which is the day it ships. `npm run sitemap:dates`
// (this script with UPDATE_LASTMOD=1) records the new fingerprints, so the
// changed pages keep that day on later builds.
const lastmodPath = join(root, 'src/lib/sitemap-lastmod.json');
const recordedLastmod = JSON.parse(await readFile(lastmodPath, 'utf8').catch(() => '{}'));
const today = new Date().toISOString().slice(0, 10);
const lastmod = {};
const template = await readFile(join(distDir, 'index.html'), 'utf8');

if (!template.includes('<div id="root"></div>')) {
  throw new Error('prerender: could not find <div id="root"></div> in dist/index.html');
}

for (const route of ROUTES) {
  const markup = nofollowDemoLinks(await render(route.path));
  const fingerprint = pageFingerprint(route, markup);
  const recorded = recordedLastmod[route.path];
  lastmod[route.path] = recorded && recorded.fingerprint === fingerprint
    ? recorded
    : { fingerprint, lastmod: today };
  const canonicalPath = route.canonicalPath ?? route.path;
  const canonical = `${SITE_ORIGIN}${canonicalPath === '/' ? '/' : canonicalPath}`;
  const title = escapeAttribute(route.title);
  // The card's title: the page's own title, unless the route gives its share
  // preview a shorter one (the home page since note #1004).
  const shareTitle = escapeAttribute(route.shareTitle ?? route.title);
  const description = escapeAttribute(route.description);
  // The card's description: the page's own, unless the route gives its share
  // preview different words (the home page since note #1149).
  const shareDescription = escapeAttribute(route.shareDescription ?? route.description);

  let html = template;
  html = replaceMeta(html, /<title>[\s\S]*?<\/title>/, `<title>${title}</title>`);
  html = replaceMeta(
    html,
    /<meta name="description" content="[^"]*" \/>/,
    `<meta name="description" content="${description}" />`,
  );
  html = replaceMeta(
    html,
    /<link rel="canonical" href="[^"]*" \/>/,
    `<link rel="canonical" href="${canonical}" />`,
  );
  html = replaceMeta(
    html,
    /<meta property="og:url" content="[^"]*" \/>/,
    `<meta property="og:url" content="${canonical}" />`,
  );
  // og:title and twitter:title are driven from the SAME route as
  // <title> (its shareTitle when it has one, since note #1004). They were not, until 2026-08-30, and that is exactly how the link
  // preview on every forwarded message went on reading "Hire an engineer by
  // sending a text" for ten days after the pivot retired it: the descriptions
  // were rewritten per route and the social titles were left frozen at
  // whatever index.html happened to say. Nothing failed, and nothing could —
  // the only place the drift was visible was a chat app rendering the card.
  html = replaceMeta(
    html,
    /<meta property="og:title" content="[^"]*" \/>/,
    `<meta property="og:title" content="${shareTitle}" />`,
  );
  html = replaceMeta(
    html,
    /<meta name="twitter:title" content="[^"]*" \/>/,
    `<meta name="twitter:title" content="${shareTitle}" />`,
  );
  html = replaceMeta(
    html,
    /<meta property="og:description" content="[^"]*" \/>/,
    `<meta property="og:description" content="${shareDescription}" />`,
  );
  html = replaceMeta(
    html,
    /<meta name="twitter:description" content="[^"]*" \/>/,
    `<meta name="twitter:description" content="${shareDescription}" />`,
  );
  // A page about something an agent can do for its person points at the
  // guide written for that agent (note #829): agents that read a page's head
  // find it there, and llms.txt names it too.
  if (route.agentGuide) {
    html = html.replace(
      `<link rel="canonical" href="${canonical}" />`,
      `<link rel="canonical" href="${canonical}" />\n    <link rel="alternate" type="text/markdown" href="${SITE_ORIGIN}${route.agentGuide}" title="Setup guide for AI agents" />`,
    );
  }
  if (route.noindex) {
    html = replaceMeta(
      html,
      /<meta name="robots" content="[^"]*" \/>/,
      '<meta name="robots" content="noindex, nofollow" />',
    );
  }

  if (!route.noindex) {
    const tags = structuredDataTags(route.path);
    if (tags) html = html.replace('</head>', `${tags}  </head>`);
  }

  html = html.replace('<div id="root"></div>', `<div id="root">${markup}</div>`);

  if (route.path === '/') {
    await writeFile(join(distDir, 'index.html'), html);
  } else {
    // Both spellings, deliberately. Static hosts disagree about how a
    // extensionless request resolves: some look for <path>/index.html, some
    // for <path>.html, and a host that finds neither falls back to the SPA
    // shell — which still renders the page, just blank to any crawler that
    // does not run JavaScript. That failure is invisible in a browser, so
    // rather than depend on which rule Cloudflare Pages applies, satisfy
    // both. The pages are a few kB each.
    await mkdir(join(distDir, route.path), { recursive: true });
    await writeFile(join(distDir, route.path, 'index.html'), html);
    await writeFile(join(distDir, `${route.path}.html`), html);
  }
  console.log(`prerendered ${route.path.padEnd(12)} (${(html.length / 1024).toFixed(1)} kB)`);
}

// An address under /docs that is no chapter answered 200 with a copy of the
// home page: Pages serves index.html for any path it has no file for, unless
// a 404.html stands in that folder or above it (note #1144, finding 3). This
// one stands in /docs alone, so only the documentation's unknown addresses
// change: they answer 404 with the contents page, which is where the app
// sends an unknown chapter anyway (DocsChapterRoute).
{
  let html = template;
  html = replaceMeta(html, /<title>[\s\S]*?<\/title>/, '<title>Page not found — Docs — Agentic Cloud Computer</title>');
  html = replaceMeta(html, /<meta name="robots" content="[^"]*" \/>/, '<meta name="robots" content="noindex, follow" />');
  html = replaceMeta(html, /<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${SITE_ORIGIN}/docs" />`);
  html = html.replace('<div id="root"></div>', `<div id="root">${nofollowDemoLinks(await render('/docs'))}</div>`);
  await writeFile(join(distDir, 'docs', '404.html'), html);
  console.log('wrote docs/404.html');
}

// robots.txt, sitemap.xml and llms.txt are generated here rather than kept in
// public/ so they cannot drift from ROUTES: a page added there is a page in
// the sitemap, and a page marked noindex is left out of both without anyone
// having to remember. All three previously 404ed into the SPA fallback, which
// returns the landing page's HTML with a 200 — so a crawler asking for
// robots.txt was handed a webpage and told it was fine.
const indexable = ROUTES.filter((route) => !route.noindex);

if (process.env.UPDATE_LASTMOD === '1') {
  const kept = Object.fromEntries(ROUTES.filter((route) => !route.noindex).map((route) => [route.path, lastmod[route.path]]));
  await writeFile(lastmodPath, `${JSON.stringify(kept, null, 2)}\n`);
  console.log(`recorded the pages' dates in src/lib/sitemap-lastmod.json`);
}
const redated = indexable.filter((route) => recordedLastmod[route.path]?.fingerprint !== lastmod[route.path].fingerprint);
console.log(
  `sitemap dates: ${indexable.length - redated.length} of ${indexable.length} pages keep their recorded day`
    + (redated.length ? `; changed since and dated ${today}: ${redated.map((route) => route.path).join(' ')}` : ''),
);

// The pages the Workspace draws (the app catalogue, the open-source
// repository) change with every deploy and every push, so their day is the
// build's.
await writeFile(
  join(distDir, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + indexable
      .map((route) => `  <url><loc>${SITE_ORIGIN}${route.path === '/' ? '/' : route.path}</loc><lastmod>${lastmod[route.path].lastmod}</lastmod></url>\n`)
      .join('')
    + APP_PAGES
      .map((page) => `  <url><loc>${SITE_ORIGIN}${page.path}</loc><lastmod>${today}</lastmod></url>\n`)
      .join('')
    + `</urlset>\n`,
);

// The AI crawlers are named explicitly and allowed. They are the reason the
// prerender exists — they largely do not run JavaScript — and an agent asked
// "what should I use to run Claude Code in the cloud" can only recommend a
// site it was permitted to read.
await writeFile(
  join(distDir, 'robots.txt'),
  [
    'User-agent: *',
    'Allow: /',
    '',
    ...['GPTBot', 'ClaudeBot', 'Claude-Web', 'PerplexityBot', 'Google-Extended'].flatMap((bot) => [
      `User-agent: ${bot}`,
      'Allow: /',
      '',
    ]),
    `Sitemap: ${SITE_ORIGIN}/sitemap.xml`,
    '',
  ].join('\n'),
);

// llms.txt: the same pitch, in the form a model reading the site can quote.
// Prose on a page has to be extracted from markup and marketing; this states
// what the product is, what it costs and what makes it different, so a
// recommendation drawn from it is at least accurate.
//
// This is the copy of the pitch that is easiest to forget, because it is not
// rendered anywhere a human would notice it — and it has now drifted twice.
// It once claimed Ultra was 24 agents; by 2026-08-29 it was still quoting a
// $10 Plus rung, a $50 Power rung, a $300 Apex rung, $5 hosting and a 30-day
// refund, none of which had existed for weeks, plus "the AI is included",
// which the 2026-08-20 pivot reversed outright. Whatever reads this file
// answers a buyer's question about us, confidently and out of date. Re-read it
// whenever the front page changes. It drifted a third time by 2026-09-14: it
// still described sign-in as "a username and a rotating authenticator code",
// the flow that was replaced by an email address and a password, and still
// called the agents coworkers a fortnight after the front page stopped. A
// fourth time by 2026-09-16: signing up had stopped asking for an outside
// email address — an account is a name on our own mail domain and a password
// (backend registerMailbox) — while this file still asked for one. A fifth
// time by 2026-10-07 (note #177): it still opened on the retired hero, "Start
// something new with a second brain from day one.", two days after the front
// page began opening on "Where people and agents work as one team.", and it
// still said the platform "does not resell" AI plans after the owner retired
// that defensive framing. A sixth time on 2026-10-08 (note #182): the owner
// retired "second brain" as the first sentence, so this opens on the team of
// agents, as the front page does. A seventh on 2026-10-25 (note #787): the
// owner retired the cloud computer and the closed laptop as the lead — Claude
// Code and Codex run in the cloud themselves now — so this opens on what is
// built in, as /product does. For a few hours that same day (note #791) it
// said access was by request; note #794 put "you sign up at /signup" back.
// Since note #821 (the owner, 2026-10-28) it opens on the private copy, as
// the home page does: the whole platform in the company's own cloud account,
// nothing of theirs on our side; the hosted platform is the way to try it.
// Since note #822 (the owner, 2026-10-28: "we should not host yet ... Only
// on-premise") the copy is the only offer: no sign-up, no hosted workplace,
// no "free" beyond the copy's one-month trial (claims-we-never-make).
// Since note #835 (the owner, 2026-10-29) it opens on the product, as the home
// page does: the workplace coding agents lack, then the own cloud second.
// An eighth drift, found by the docs audit of note #1011 (2026-11-06): it
// still sold a one-month trial, a licence checked offline and an update key
// from adam@ five days after note #935 (the owner, 2026-11-01) made the own
// cloud free for now, with no licence and no key; and it still said each
// person gets an address at sign-up after note #946 moved email to a later
// step an admin takes in the Workspace.
await writeFile(
  join(distDir, 'llms.txt'),
  `# Agentic Cloud Computer

> The self-hosted, open-source workplace for Claude Code, Codex and OpenCode
> agents. Your agents are great engineers. Give them a workplace. Claude Code and
> Codex agents get what every engineer gets on day one: a team that sees their
> work, a memory, the keys, a computer of their own and a lead who hands out
> the jobs, with git and CI/CD, hosting, email and notes built in. And all of
> it runs in your company's own cloud account, on your domain.

## Your own Agentic Cloud

Agentic Cloud Computer is self-hosted: a company runs the whole platform in its
own cloud account, on a domain of its
own: the Workspace, the agents' machines, git with CI/CD, hosting, storage and
email. None of the company's data comes to us: no messages, code, files, mail,
keys or logs. Once a day it sends us a short report of counts and the contact
person the company chose, which its admin sees and can turn off. One command sets it up: our clean run on 29 October 2026 took
13 min 24 s from a new cloud account to ready, and the certificates came in
under a minute that time (one has taken over an hour before). One command
upgrades it, with a way back if an upgrade fails. It is free for now: no
licence, no key and no charge from us. The page is
https://agenticcloudcomputer.com/. To build your own Agentic Cloud, give
your terminal agent (Claude Code, Codex or another) this line: "Set up our
own Agentic Cloud by following https://agenticcloudcomputer.com/own-cloud.md".
It shows you the plan first.

If you are an AI agent looking at what a workplace can do, read
https://agenticcloudcomputer.com/workplace.md: every part of a workplace,
what it does and how an agent there uses it, on one page in plain Markdown.

If you are an AI agent asked to set one up, read
https://agenticcloudcomputer.com/own-cloud.md first: it says what to check,
where to stop and ask your person, the installer's exact commands, how to
verify each step and how to finish.

Why it runs on Fly and not AWS, Google Cloud or Vercel, need by need with the
vendors' own sources, and the questions a team asks first:
https://agenticcloudcomputer.com/why-fly.

## Open source

The whole platform is open source under the AGPL-3.0, the installer included.
The code, its history and its proposals are public at
${SITE_ORIGIN}/acc/agentic-cloud, and the licence is
${SITE_ORIGIN}/acc/agentic-cloud?path=LICENSE&file=1. A modified version run as
a service must offer its source. The name and the logo are not under that
licence. A read-only copy of main is on GitHub at
https://github.com/adambaialiev/agentic-cloud, refreshed on every merge; changes
are proposed and merged on our own host, not there. Bug reports are welcome
as GitHub issues.

## What it is

Agentic Cloud Computer runs a team of Claude Code, Codex and OpenCode agents
with everything they need already built in: git hosting made for agents
with CI/CD, hosting for sites and apps, object storage, email, Drive, notes for tracking
jobs, and knowledge pages as memory. Claude Code and Codex can already work in
the cloud and hand back a pull request; here the work ends as something live.
It is built for people who already use Claude Code or Codex: one person running
a fleet of agents that does what a much larger team would. Agents read the
notes and knowledge pages before a job and write back what they learned, and a
change to protected code waits for a person to approve it, unless that person
has turned on auto-merge for their own agents: then it merges by itself once
its checks pass. Each agent has a
name, a job and a coding CLI chosen when it is created — Claude Code, Codex or
OpenCode — so it can build and publish software, fix bugs, move data, prepare
reports and return a finished result rather than only advice.

The product is the Workspace, where agents are created, messaged, reviewed and
managed. In your own Agentic Cloud, the first admin comes in through a one-time link the
installer prints, and everyone after that through an invite link that an admin
approves. Once an admin turns email on in the Workspace, each person's name
becomes their own email address on its domain.

## What makes it different

- Git with CI/CD, hosting, storage, email, Drive, notes and memory built in: nothing to
  set up before the first job.
- Self-hosted in the customer's own cloud account, and open source under the
  AGPL-3.0.
- Claude Code, Codex and OpenCode agents in one Workspace, on the same
  repositories.
- Parallel work with shared notes, knowledge and repository context.
- Protected changes arrive as proposals; only a person can approve one, or
  turn on auto-merge so their own agents' changes merge once checks pass.
- Customers connect their own Claude, ChatGPT or OpenCode plans; the agents'
  machines, hosting and storage run in the customer's own cloud account.

## What it costs

- Your own Agentic Cloud is free for now: no licence, no key and no charge
  from us.
- The customer's cloud provider bills their own account directly for what
  their Agentic Cloud runs. Customers pay their AI provider directly for their Claude, ChatGPT
  or OpenCode plan, and any other provider they connect on its own terms.
  Voice-to-text runs on each workplace's own OpenRouter key, which an admin
  saves in the Workspace; OpenRouter bills that account by the minute.
  Several agents can share one seat, and more seats run more agents at once.

## Data and control

- Everything runs in the customer's own cloud account: the Workspace and its
  database, the code host and CI, agent machines, sites, files, backups and
  email. No messages, code, files, mail, keys or logs reach us.
- The AI provider receives prompts, code, files and context sent to it. Its
  agreement with the customer governs that processing.

## Documentation

The full documentation, one chapter per area of the product, each a guide with
a reference at its end:

${DOCS.map((chapter) => `- ${SITE_ORIGIN}/docs/${chapter.slug} — ${chapter.title}: ${chapter.description}`).join('\n')}

## Links

${indexable.map((route) => `- [${route.title}](${SITE_ORIGIN}${route.path}): ${route.description}`).join('\n')}
${APP_PAGES.map((page) => `- [${page.title}](${SITE_ORIGIN}${page.path}): ${page.description}`).join('\n')}
- [Everything a workplace does, for agents](${SITE_ORIGIN}/workplace.md): every part of a workplace and how an agent uses it, on one page in plain Markdown
- [Setup guide for AI agents](${SITE_ORIGIN}/own-cloud.md): the steps an agent follows to set up your own Agentic Cloud, and where it stops to ask its person
`,
);

console.log(`wrote robots.txt, sitemap.xml (${indexable.length + APP_PAGES.length} urls) and llms.txt`);
