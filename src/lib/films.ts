/**
 * Where the site's films are served from: the one place both film addresses
 * are made (note #957). The home page's films (Home.tsx, PRODUCT_FILM and
 * PRODUCT_FILM_TALL) name only their path here, so moving every film is a
 * change to FILMS_ORIGIN and nothing else. The install film (INSTALL_FILM,
 * private-copy/install-film-2026-10-29.mp4) left the page with note #984;
 * its object is still in the bucket.
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
   the bucket at films/bookface-2006-home-film-hyperframes-poster.jpg.
   Since note #970 it is Iris's fourth cut (note #969, 1:26), encoded the
   same way: 2.7 MB against the 12 MB master in Drive. Its poster is the
   same picture as the HyperFrames cut's, byte for byte, so the bundled
   poster did not change. */
/* Since note #975 (the owner, 4 Nov 2026, 09:44 UTC: "In the video UI should
   be in phone mockups, and full ui should be put inside the mockups (phone
   frames)") both are Iris's framed cuts (note #974): the wide one 1:25,
   1280x720, 2.7 MB; the tall one 1:28, 720x1280, 4.3 MB; same encode, new
   posters from the framed masters in the bundle. */
export const PRODUCT_FILM_PATH = 'films/bookface-2006-home-film-framed-1280x720.mp4';
/* Since note #973 a phone gets the tall cut of the same film (Iris, note
   #972, 1:28, 1080x1920 master in Drive), encoded the same way at 720x1280:
   4.9 MB. Its poster is in the site bundle, as every poster is. */
export const PRODUCT_FILM_TALL_PATH = 'films/bookface-2006-home-film-vertical-framed-720x1280.mp4';
