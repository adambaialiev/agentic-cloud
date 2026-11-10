/* The share preview of the home page (note #1004, the owner, 5 Nov 2026,
   14:16 UTC: "'Your team. Your agents. Your cloud. Your rules.' sounds good.
   We should say about the problem we solve: we give all-in-one workplace for
   Claude Code, Codex and OpenCode agents"; variant A, words only, picked at
   14:30 UTC). The card (OgPreview, shot to public/og-image.png), the home
   page's <title> and metas (ROUTES in entry-server.tsx, index.html) and the
   image's alt text all read from here, and the tests hold index.html to it. */

/** The card's one big line: the film's closing words. */
export const SHARE_HEADLINE = 'Your team. Your agents. Your cloud. Your rules.';
/** The line under it: the problem we solve. */
export const SHARE_LINE = 'The all-in-one workplace for Claude Code, Codex and OpenCode agents.';
/** og:title and twitter:title of the home page (56 characters). */
export const SHARE_TITLE = 'One workplace for Claude Code, Codex and OpenCode agents';
/** The home page's <title>: the share title, then the name (81). */
export const HOME_TITLE = `${SHARE_TITLE} — Agentic Cloud Computer`;
/** The meta, og and twitter description of the home page (134). Since note
 *  #1137 (Adam, 10 Nov 2026, 15:33 UTC, "Fix all") it says what the title
 *  does not, instead of naming the three agents a second time: where each
 *  agent works, that none of the data comes to us (the daily report is
 *  Privacy Policy material, note #1135), and what is built in. */
export const SHARE_DESCRIPTION =
  'Each agent works on a computer of its own in your company’s cloud. None of your data comes to us. Git, hosting and email are built in.';
/** og:image:alt: the card's own words (116). */
export const SHARE_IMAGE_ALT = `${SHARE_HEADLINE} ${SHARE_LINE}`;
/** Bump with every new public/og-image.png: X, Slack, iMessage and Telegram
 *  cache the picture by its URL. */
export const SHARE_IMAGE_VERSION = 33;
