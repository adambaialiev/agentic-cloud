# The product pictures on the public site

> Status (2026-11-06): still true of the Workspace screens on the site. Since note #965 the home page also opens with a film of the product in use (`src/lib/films.ts`), a recording rather than a live panel.

There are none left, and that is the point.

Every screen of the Workspace on agenticcloudcomputer.com is the Workspace's
own component, rendered on the page with fixture data — not a picture of one.
The landing page moved to live panels on 2026-09-07; the social card, the last
capture on the site, followed on 2026-09-14.

## How a screen gets onto the site now

`src/components/Live*.tsx` mount the real components from
`backend/workspace-ui/` inside `LiveWorkspace`, which supplies the contexts they
expect from `src/components/live/fixture.tsx`. `LivePanel` is the fence around
one: `inert`, `aria-hidden`, a `sr-only` sentence saying what it shows, and a
zoom class for the scale it is drawn at. See the knowledge page
`landing-live-panels` for the rules and the traps.

The win is that a panel cannot go stale. A capture had to be re-shot,
re-cropped and committed every time the screen changed, and nothing failed when
nobody did it: the social card shipped a fixture hostname and a conversation
that opened mid-sentence for eight days before anyone looked at it.

## What went with the captures (2026-09-14)

- `public/shots/*.webp` — 30 committed crops, one of which was still in use.
- `src/lib/shots.ts` and `src/components/Shot.tsx` — the generated manifest and
  the component that rendered a crop in a window or phone frame.
- `scripts/marketing-shots.mjs` — the cropper that wrote both.

`simulations/` is untouched: the eight browser journeys are how every Workspace
flow is proven (owner's decision, 2026-09-06 — see the knowledge page
`onboarding-observation-protocol`), and their captures in
`simulations/shots/**` are still where a picture for outreach or a bug report
comes from. They are git-ignored, 138 files and 30 MB, and are regenerated with
`npm run simulate`.

## The social card

`/og-preview` composes the card at a fixed 1200×630: the landing's headline and
lede word for word, and the live chat panel beside them.
`scripts/shoot-og-image.mjs` screenshots `#og-canvas` at 2x into
`public/og-image.png`.

```
npm run build && npm run preview
CHROME_PATH=/path/to/chrome node scripts/shoot-og-image.mjs http://localhost:4173/og-preview
```

**Bump the `?v=` on `og:image` and `twitter:image` in `index.html` every time**,
or Telegram, X and Slack go on serving the bytes they cached under the old URL.

## What is in the fixtures

Northstar Studio, James, Leo, and the agents Ruby, Milo, Otis and Ada. Agents
wear the product's own avatar files; the people wear CC0 illustrated avatars
committed under `simulations/fixtures/faces/`, and no real person is depicted.
No customer's work appears anywhere on the public site, which is what makes
every page safe to forward.
