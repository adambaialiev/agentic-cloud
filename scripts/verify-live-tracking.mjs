// Checks that the deployed site can still count its own visitors.
//
// Everything the measurement layer is made of fails silently:
//
//  - Cloudflare Pages injects the Web Analytics beacon at build time, not at
//    the edge. Turn analytics on without redeploying and the dashboard says
//    "enabled" while the site collects nothing — which is how this script came
//    to exist. It can also stop being injected on a later build without any
//    signal (there are open Cloudflare community reports of exactly that).
//  - A CTA whose `start` payload is missing, malformed, or over Telegram's 64
//    characters still opens the bot and still works. It just records nothing.
//  - robots.txt, sitemap.xml and llms.txt fall back to the SPA shell when
//    absent, which returns the landing page's HTML with a 200 — a "working"
//    response that is the wrong file entirely.
//
// None of those show up in a browser, in the test suite, or in a build log.
// The only way to know is to ask the live site.
//
//   node scripts/verify-live-tracking.mjs [--url https://agenticcloudcomputer.com]
//
// Exits non-zero if anything that should be measuring is not.

const url = (() => {
  const flag = process.argv.indexOf('--url');
  return (flag !== -1 ? process.argv[flag + 1] : 'https://agenticcloudcomputer.com').replace(/\/$/, '');
})();

const failures = [];
const notes = [];

function check(ok, label, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!ok) {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function fetchText(path) {
  // Cache-busted: a stale edge copy would report the previous deployment's
  // state, which is the one question this script exists to answer.
  const response = await fetch(`${url}${path}${path.includes('?') ? '&' : '?'}_cb=${Date.now()}`, {
    headers: { 'cache-control': 'no-cache' },
  });
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    body: await response.text(),
  };
}

console.log(`Verifying tracking on ${url}\n`);

const home = await fetchText('/');
check(home.status === 200, 'landing page responds', `HTTP ${home.status}`);

// --- Web Analytics beacon -------------------------------------------------
const hasBeacon = /beacon\.min\.js|cloudflareinsights\.com/i.test(home.body);
check(
  hasBeacon,
  'Cloudflare Web Analytics beacon is present',
  'enabled in the dashboard but not injected — Pages adds it at build time, so redeploy',
);

// --- Tracked CTAs ---------------------------------------------------------
const ctas = [...home.body.matchAll(/t\.me\/AgenticCloudComputerBot(\?start=([A-Za-z0-9_-]+))?/g)];
check(ctas.length > 0, 'landing page has Telegram CTAs', 'none found — did the markup change?');

const untracked = ctas.filter((match) => !match[2]).length;
check(untracked === 0, 'every CTA carries a start payload', `${untracked} of ${ctas.length} are bare links`);

const overLong = ctas.filter((match) => match[2] && match[2].length > 64).length;
check(overLong === 0, 'every payload fits Telegram\'s 64 characters', `${overLong} would be silently dropped`);

const campaigns = new Set(
  ctas
    .map((match) => match[2])
    .filter(Boolean)
    .map((token) => {
      const base64 = token.slice('utm_'.length).replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
      try {
        return Buffer.from(padded, 'base64').toString('utf8');
      } catch {
        return null;
      }
    })
    .filter(Boolean),
);
check(
  [...campaigns].every((campaign) => campaign.includes('s=')),
  'every payload decodes to a source',
  'a payload decoded to something without s=',
);
// Distinct payloads are the whole point: identical ones cannot tell us which
// button did the work.
check(campaigns.size === ctas.length, 'each CTA is distinguishable', `${campaigns.size} distinct across ${ctas.length} links`);
notes.push(...[...campaigns].map((campaign) => `      ${campaign}`));

// --- Crawler files --------------------------------------------------------
for (const [path, expectedType, needle] of [
  ['/robots.txt', 'text/plain', 'Sitemap:'],
  ['/sitemap.xml', 'xml', '<urlset'],
  ['/llms.txt', 'text/plain', '# Agentic Cloud Computer'],
]) {
  const file = await fetchText(path);
  const isSpaFallback = /^\s*<!doctype html/i.test(file.body);
  check(
    file.status === 200 && !isSpaFallback && file.contentType.includes(expectedType) && file.body.includes(needle),
    `${path} is a real file`,
    isSpaFallback ? 'served the SPA shell instead' : `HTTP ${file.status}, ${file.contentType}`,
  );
}

if (notes.length > 0) {
  console.log('\n  campaigns currently served:');
  console.log(notes.join('\n'));
}

if (failures.length > 0) {
  console.log(`\n${failures.length} problem(s):`);
  for (const failure of failures) {
    console.log(`  - ${failure}`);
  }
  process.exit(1);
}

console.log('\nAll tracking is live.');
