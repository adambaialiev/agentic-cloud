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

/* The paths, the same on every host the films have lived on. A new cut gets
   a new path, never an overwrite (the objects are cached for a year). */
/* Since note #965 the home film is Iris's HyperFrames cut (1:35), encoded for
   the page at 1280x720 (H.264, CRF 20, fast start, no audio track: 4.1 MB
   against the 19 MB 1080p master, which stays in Drive). Its poster is in
   the site bundle, as every poster is: a page asks no other address before
   the visitor's film starts (the browser checks block any). A copy sits in
   the bucket at films/bookface-2006-home-film-hyperframes-poster.jpg. */
export const PRODUCT_FILM_PATH = 'films/bookface-2006-home-film-hyperframes-720p.mp4';
export const INSTALL_FILM_PATH = 'private-copy/install-film-2026-10-29.mp4';
