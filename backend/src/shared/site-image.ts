/**
 * The landing's share picture (og-image.png, square-safe since note #1137),
 * used where the platform draws a card of its own. Kept equal to index.html's
 * og:image tags by site-image.test.ts: a new picture version is changed in both.
 */
export const SITE_PREVIEW_IMAGE = {
  url: 'https://agenticcloudcomputer.com/og-image.png?v=33',
  width: 2400,
  height: 1260,
  alt: 'Your team. Your agents. Your cloud. Your rules. The all-in-one workplace for Claude Code, Codex and OpenCode agents.',
} as const;
