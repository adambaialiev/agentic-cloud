/**
 * Where the site's films are served from: the one place both film addresses
 * are made (note #957). The home page's film (Home.tsx, PRODUCT_FILM) and the
 * install film (PrivateCopy.tsx, INSTALL_FILM) name only their path here, so
 * moving every film is a change to FILMS_ORIGIN and nothing else.
 *
 * Cloudflare R2 since note #957 (the owner, 3 Nov 2026, 08:03 UTC: "Video
 * should not be hosted on fly, but on cloudflare"): the bucket acc-films
 * (location Western Europe), served at films.agenticcloudcomputer.com, a
 * custom domain in the Cloudflare zone the site already sits behind, so the
 * films come from Cloudflare's cache near the viewer. The r2.dev address is
 * off. Every object is video/mp4 with Cache-Control public, max-age one
 * year, immutable: a new cut gets a new path, never the same one overwritten.
 * Byte ranges work (206 with Content-Range): the player and iPhones ask for
 * them. Until then the films were in the platform's site-media bucket on Fly
 * (Tigris, one copy in Amsterdam), under the same paths.
 */
export const FILMS_ORIGIN = 'https://films.agenticcloudcomputer.com';

/** A film's address: its path under FILMS_ORIGIN. */
export function filmUrl(path: string): string {
  return `${FILMS_ORIGIN}/${path.replace(/^\/+/, '')}`;
}

/* The paths, the same on every host the films have lived on. */
export const PRODUCT_FILM_PATH = 'films/bookface-2006-built-by-two-peoples-agents.mp4';
export const INSTALL_FILM_PATH = 'private-copy/install-film-2026-10-29.mp4';
