# The road to a first result

**Status:** shipped with note 132 (Growth), 2026-09-06 — **retired 2026-09-20**
**Where (while it stood):** `backend/workspace-ui/src/screens/home/first-result.ts`, `FirstResult.tsx`, `ui/SetupTrail.tsx`

## Retired, 2026-09-20 (the owner)

The guide card on Home and its stepper (`SetupTrail`, "Step 2 of 4 · Cloud")
are gone, with the `first-result` simulation that drove them. What made them
unnecessary is note #144's founding: a person cannot reach the Workspace
before the cloud, a subscription and the founding are all in, so they land in
a workplace whose team is already built and already working. A card counting
steps toward a first result was counting a road already walked — and for a
founded workplace it never drew at all (`org.founded` answered null).

The setup road itself still stands, in the gate (`onboarding/RequiredSetup.tsx`)
— connect Fly, sign in a subscription, watch the team arrive — and it has worn
no step counter since 2026-09-18. Since 2026-09-22 each step has its own
address: `/setup/cloud`, `/setup/subscription` (with
`/claude` and `/chatgpt` pages under it) and `/setup/team`. The
server's facts still choose the step; the gate moves any other address to it,
remembers where the reader was going, and sends them there once set up. The account already made “Samira’s workplace”
style wording its default; cloud plus subscription now accept that name without
a second form. Everything below is
the record of what the card did while it stood.

Rooms were removed on 30–31 Oct 2026 (note #843): the founding's two rooms
and the card's `room` step below are history too. A workplace is one list of
agents, and nothing asks anyone to create a room.

## Why

Emma's live first-user test on 2026-09-06 proved the journey works — a real account went from signup to a downloadable checklist — and also that it only worked with an expert coaching every step. Her assessment (note 132) asked for four things before more features: explain the setup requirements up front; give each setup screen one clear next action and show progress toward the first useful task; preserve progress through interruptions and explain failures with a recovery action; then watch three strangers try it without coaching.

This document records how the first three were built so the fourth can be judged against it.

## The trail

Four waypoints since note #144, in the order the owner chose, named the same everywhere the first journey passes through:

1. Cloud
2. Subscription
3. Workplace
4. First job

`SetupTrail` draws them as the segments of an agent's own setup meter (filled behind, held or breathing here, empty ahead) with "Step n of 4 · name" under it, on the guide card on Home.

The workplace is made WITH the account and already carries a first-name-based default. It stays marked `unnamed` while it is merely the spare every account receives, so somebody following an invite is not made the founder of a workplace they never wanted. The setup gate (`RequiredSetup`) asks a founder only to connect Fly and sign in a subscription. The moment both are in, `foundIfReady` accepts the default name and FOUNDS the workplace (note #144): two rooms — Room 1 and Room 2, two agents each (four and two until 2026-09-24) — as records, then all four computers together (`AgentService.setUpPlannedAgents`). The arrival screen shows those rooms while every computer is setting up; once the founder steps in, Home opens on the workplace. The founding used to start the Workspace Agent too, with a greeting turn that built its private machine; since note #656 the Workspace Agent is hidden and the founding makes none.

A second workplace (the founder door) is named at creation and founded the same way once its own cloud and a subscription are in. Workplaces from before founding carry no `foundingPending` stamp and are never furnished.

The SUBSCRIPTION waypoint, for a workplace with no founding agents, signs in first and creates after — for both providers. (Until 2026-09-22 Codex created first, because the ChatGPT sign-in ran on the agent's own machine; the backend now asks OpenAI itself, as it does Anthropic.)

## The guide card on Home

`firstResultNext()` is a pure function over what Home already holds — the workplace, its rooms, the fleet, the create in flight, and (only when it is the thing in the way) the cloud read. It answers one of:

| Next | When | The one action |
| --- | --- | --- |
| room | no rooms (a pre-#144 workplace) | Create a room (opens the rooms screen with the form up); drawn without the trail |
| founding | founding agents waiting, cloud and subscription in | none — the segment breathes; the computers are being built together |
| subscription | founding agents waiting, cloud connected, no subscription (a build that failed) | Sign in a subscription — their computers are built the moment it lands |
| cloud-admin / cloud-member | no agent, Fly not connected | walk to the Fly card Home already draws / ask an admin |
| create | no agent, cloud connected | the same harness chooser the fleet's New agent plate uses (`useNewAgent`) |
| creating / preparing / finishing | an agent mid-setup | none — the segment breathes, the card says it carries on without you |
| sign-in | an agent paused with no matching seat | Sign in ChatGPT/Claude — the sign-in screen opens **with that provider already chosen** |
| choose-seat | paused, but a seat of that provider exists | open the agent |
| attention | the provider paused the subscription | open the subscriptions |
| first-job | a ready agent that has never worked | a suggested brief, put into the agent's conversation as an editable draft |

The card is gone the moment any non-retired agent has worked (`working`, `lastActiveAt`, `recap` or `lastReply`). It is scaffolding for the first journey, not a fixture.

### Why it survives interruptions

Nothing is stored. Every fact on the card is the server's, so closing the tab mid-setup and coming back a day later lands on the same step, and a step finished elsewhere — the cloud form, the sign-in screen, the agent's row coming up — moves the card on with the next full read. This is also why the card does not poll the cloud for the life of the fleet: the cloud read is made only while no agent exists.

## Failures name their way out

- A failed sign-in's **Start again** restarts the same provider; the picker is a second, quieter choice. The provider was chosen when the agent was, and a retry that asks again reads as the choice not having taken.
- The sign-in screen's refusals (no machine, a read that failed) now carry **Try again** and **Back to Home** rather than a sentence and nothing.

## Signup explains itself first

The hero says what this is (Create your Workspace, not "browser access"), the card names the step (Choose your username), the copy says there is no password, and lists what the visitor will need before any field: an authenticator app, a ChatGPT or Claude subscription, a Fly.io account — with the honest line that the Workspace itself has no charge and the providers are paid directly. The authenticator panel explains what such an app is, and covers the same-phone case (an `otpauth://` link plus "enter a setup key"). The recovery-codes panel says what comes next.

## How it is proven

The owner decided on 2026-09-06 that the first journey is proven by browser simulations, not by watching recruited people. `npm run simulate:first-result` drove the shipped shell through the guide's one next action at each step — cloud, agent, a reload mid-setup, the subscription sign-in with an expired first attempt and *Start again*, the suggested brief sent, the reply with its link, the guide gone — against the fixture server in `simulations/support/mock-workspace.mjs`. It was removed with the card on 2026-09-20; `npm run simulate:onboarding` is the journey that remains, and it covers the road a founder actually walks.

## What this does not do

It does not measure anything. Signup → agent ready → first task sent → first result returned is the funnel worth tracking, and the guide's states are the natural stamps for it, but no counter was added here.
