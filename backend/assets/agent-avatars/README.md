# Agent avatars

One cartoon pixel-art dog per name in `TELEGRAM_AGENT_NAME_POOL`
(`backend/src/types/user.ts`), keyed by the lowercased name: `nina.jpg`,
`ada.jpg`. The Workspace serves them at `/workspace/avatars/<name>`, so an
agent arrives with a face instead of a blank circle. (They are JPEG because
they were first made for Telegram bot profile photos, which accepted nothing
else.)

The set is **fixed and pre-generated**, not made per agent: a fal call inside
agent creation would add latency and a failure mode to the funnel's most
fragile minute, and the same name would get a different face every time. Nina
is always the same dog, which is what turns the avatar into an identity anchor.
Past 40 agents the name pool wraps (`Kai 41`) and reuses the same image.

**A name in the pool without a file here is a regression, not a partial win.**
Until the pool passed 20 this could not happen: the 21st agent was called
`Kai 21` and got Kai's dog, so every agent had a face. A pool name with no
`.jpg` silently shows no face at all, which reads as broken
avatars rather than a missing file — so grow the pool and generate the images
in the same change. `agent-avatars.test.ts` fails with the list of
faceless names if you don't.

**`workspace-agent.jpg` is the one file that is not a pool name** (note
#434): a Bernese mountain dog reserved from room agents.
`telegramAgentAvatarSlug` admits letters only, so the hyphen keeps this slug
out of the room-agent path by construction. Since note #582, a workplace
chooses its Workspace Agent's face once when the workplace is created, from
the shepherds, sheepdogs and big working dogs listed in
`telegram-agent-avatars.ts`; the reserved Bernese is one candidate and the
fallback for older workplace records. Every candidate is served by the same
`/workspace/avatars/<slug>` route. Regenerate the Bernese alone with
`--workspace-agent`.

Regenerate:

```sh
node scripts/generate-agent-avatars.mjs --print     # prompts only, no key needed
FAL_KEY=... node scripts/generate-agent-avatars.mjs # 1 hero + 39 conditioned on it

# Topping the pool up: reuse the ORIGINAL hero, or the new dogs get their own
# lighting and the litter splits in two. Existing files are skipped already.
FAL_KEY=... node scripts/generate-agent-avatars.mjs --hero-url <the Leo used before>

# The Workspace Agent's reserved face only (skips the pool):
FAL_KEY=... node scripts/generate-agent-avatars.mjs --workspace-agent --force --hero-url <Leo>
```

Style decisions (bust not scene, plain background, breed/coat separation,
circle-safe) live in `scripts/agent-avatar-prompts.mjs` — read that before
changing a prompt.

**Deploy note:** the release artifact is assembled by hand
(`.github/workflows/backend-deploy.yml`) and `tsc` copies no non-TS files, so
the whole `backend/assets` tree is named in that `cp -R`. Keep it there — a new
`.jpg` beside these ships on its own, but drop `assets` from the copy and the
avatars exist locally and are missing in prod, where the failure is silent:
every agent just keeps the grey default.
