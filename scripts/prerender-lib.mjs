// The parts of scripts/prerender.mjs that a test can call (it runs the whole
// build at import, so nothing can import it).
import { createHash } from 'node:crypto';

// The live panels are the Workspace's own components drawn from a fixture, so
// their rows are real links: into the demo workplace (`/notes/57?org=
// org_northstar`, which answers with the empty app shell) and to Northstar's
// made-up addresses (`track.agents.northstar.com`, which resolve nowhere, on
// a domain that is somebody else's). A person cannot follow them, because a
// panel is `inert`; a crawler reads the HTML and can (note #1144 found 11
// such addresses linked from up to 8 pages, and 9 dead outbound links on
// /product). So every one is marked rel="nofollow" on the way out (note
// #1149). Only the attribute is added, which hydration leaves alone; the
// markup React compares is untouched.
const DEMO_LINK = /[?&]org=org_northstar\b|^https?:\/\/(?:[a-z0-9-]+\.)*northstar\.com(?:[/:?#]|$)/;
export function nofollowDemoLinks(markup) {
  return markup.replace(/<a\s[^>]*>/g, (tag) => {
    const href = /\shref="([^"]*)"/.exec(tag)?.[1];
    if (href === undefined || !DEMO_LINK.test(href.replace(/&amp;/g, '&'))) return tag;
    const rel = /\srel="([^"]*)"/.exec(tag);
    if (!rel) return tag.replace(/^<a\s/, '<a rel="nofollow" ');
    if (/\bnofollow\b/.test(rel[1])) return tag;
    return tag.replace(rel[0], ` rel="${rel[1]} nofollow"`);
  });
}

// A fingerprint of a page's words (its title, its description and its text
// with the markup taken out), for the sitemap's dates: see prerender.mjs.
export function pageFingerprint(route, markup) {
  const words = markup
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(`${route.title}\n${route.description}\n${words}`).digest('hex').slice(0, 16);
}

