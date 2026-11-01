# Browser simulations

These scenarios drive the shipped UI through the same visible controls a person uses. They are
not component tests and they never need a live control plane.

**CI runs them** (note #533), in the same stage as the `verify-*` harnesses: one retry each, two
at a time, the tour first because it is the long pole. Before that, nothing ran them — so six of
the nine rotted for five unrelated reasons, two of which were real bugs in the shared fixture,
while every CI pip stayed green.

## Run the suite

```bash
npm run simulate            # all of them, sequentially, with a tally
./scripts/run-browser-checks.sh mail workspace-tour   # one or more, the way CI runs them
```

Build `backend/dist/workspace-ui` first (`npm --prefix backend run build`) — the scenarios serve
that directory as the shell they walk, and a stale one invents both failures and passes.

The suite keeps each user journey independent, with a new fixture server and browser for every
scenario:

| Command | Journey |
| --- | --- |
| `npm run simulate:onboarding` | The first experience (note #144, remade by note #726): sign up with a name and land on Home at once — the Chief of Staff's conversation, open on the platform's greeting with three starters under it (a reload says it once); tap a starter and read the sign-in ask with the Claude / Codex card under it; sign ChatGPT in on its own page (the code at once, no cloud to connect) and come back to Home with the plan's receipt said in the chat, no banner; then the Chief of Staff's first turn by itself — the room opened, two agents brought in, the team card at the foot of the log moving from Starting… to Computer being built…, the plan reply — until every agent is ready and the two agents stand in the agents picker. Nothing is furnished at founding: no room, no agent, no gate |
| `npm run simulate:signin` | Returning sign-in with a corrected rotating code and authenticated reload |
| `npm run simulate:recovery` | Invalid code, successful recovery, spent-code replay refusal, and a second recovery |
| `npm run simulate:join` | The invite flow, two browsers at once: the owner taps "Invite to this workplace" in Home's workplace menu, copies the invite link from the invite page and sees it again on the workplace screen; Leo opens it signed out, creates his account at that door, asks to join and waits; the owner sees the request on the overview's workplace half and approves it there; Leo checks, opens the workplace, and lands on Home as a member (the agents on the overview) — and his workplace list also holds the unnamed workplace his account came with |
| `npm run simulate:join-existing` | The same link reaching a person who already has an account and a workplace of their own: the door opens on Sign in, they sign in there, ask to join, wait, are approved, open the team's workplace, and their switcher holds both; and the link opened again while signed in goes straight to the join screen |
| `npm run simulate:handoff` | The day the team is real: a note written from the Workplace window, handed to Ruby; Ruby's message to Milo in Milo's chat; the proposal card in Ruby's chat; the diff; Approve & merge; the site live, the note Live; Milo's knowledge proposal published |
| `npm run simulate:mail` | The inbox behind a person's own address: the door on the overview, the list, a hard-wrapped letter read on a phone, an HTML-only invoice drawn with no picture fetched and no second version offered, and a message whose markup the allowlist refuses falling back to its text; then search (Back from a result lands on the results), archive from the letter, the archive found by a search from the inbox, Trash with an agent's move named, and Restore back to where it was |
| `npm run simulate:tour` | Every screen of the lived-in Workspace, read only, pictured: Home (the Workspace Agent's conversation since 2026-10-10), the agents picker and the Workplace window, both agents and chats, People, a member, the workplace, notes, knowledge, the merged proposal, the repository, the site, Drive, secrets, seats, one seat's usage and pace (the rooms screen went with rooms, note #843) |

## Pictures of every step

Every scenario pictures each of its moments twice — at a desktop width (1280 wide) and at a phone
width (390 wide), both at 2x — into `simulations/shots/<scenario>/` (git-ignored). The files are
numbered in journey order, `03-note-with-hand-row.desktop.png` beside
`03-note-with-hand-row.mobile.png`, and each folder ends with an `index.json` naming them. A whole
run leaves about 120 pictures; `--shots DIR` moves one scenario's folder elsewhere:

```bash
npm run simulate:tour -- --shots /tmp/tour-shots
```

The phone width is a width only. Asking Chrome for a mobile emulation reloads the page, which
would throw away the transient panel a step had just opened, so the pictures are the same document
laid out narrower — which is exactly what the app does on a phone, since it has one column at
every width.

### Faces

Nobody in the pictures is a grey placeholder. Agents wear the **product's own avatars** —
`backend/assets/agent-avatars/ruby.jpg` and `milo.jpg`, the same files a real agent gets, served
by the fixture at `/workspace/avatars/<slug>`, which is the address the real backend serves them
at. The people and the workplace wear pictures committed in `fixtures/faces/` (illustrated
avatars, CC0; see the README beside them — no real person is depicted).

**Before the first run on a new machine, install a sans-serif font:**
`sudo apt-get install -y fonts-liberation fonts-noto-core`. The Workspace asks for the system
sans-serif, and a fresh VM often has none — Chrome then falls back to a monospace face and every
capture comes out looking like a terminal (it happened on 2026-09-07, to all 39 marketing crops).
The runner now checks `fc-match sans-serif` and refuses to start if it resolves to a monospace
family. The shell it photographs is `backend/dist/workspace-ui`, so rebuild that first
(`npm --prefix backend run build:workspace-ui`) or the tour asserts against stale words.

Two things keep it that way. Every capture first asserts that **no image on the page is broken**,
sweeping a long page so its lazy images load before they are photographed; and each journey
asserts the **count of real faces** in the places a face belongs (`assertFaces`), because the app
silently swaps a missing picture for a glyph, which no assertion on text would catch.

Every name, agent, note and line of chat in the pictures is fixture data (Northstar Studio,
Samira, Leo, Ruby, Milo); no customer's work appears in them, which is what makes them usable
in marketing.

## What the fixture serves

The public React application is served locally by Vite, and every `/workspace` address serves the
real Workspace shell as `npm run build` in `backend/` left it under `backend/dist/workspace-ui`
(build it first). Every Workspace API response comes from `fixtures/onboarding.json`. The mock
keeps browser sessions, Workspace provisioning, transient failures, and spent recovery codes as
separate state, so a scenario can assert that one state does not move when another action fails.

An unknown `/workspace` request fails the run. Any request to another origin is blocked and fails
the run, and WebSocket creation does too. Successful authenticated writes must carry both the
fixture session cookie and CSRF token.

Chrome can be selected with `CHROME_PATH`. Otherwise the scenario looks in the standard Puppeteer
cache and common system locations. To choose the final screenshot's destination:

```bash
npm run simulate:signin -- --shot /tmp/signin.png
```

## The lived-in Workspace

The three later scenarios start the mock with `world: 'team'`, which layers `fixtures/team.json`
over the first-day fixture: a second person (Leo), a second agent (Milo, Claude Code), two rooms,
notes, a knowledge page, a repository, secrets, Drive files, a second subscription, and the
transcripts. `support/team-world.mjs` holds its state and answers its requests; the first-day
handlers in `support/mock-workspace.mjs` still serve what they always served.

The world has three stages: `invite` (Leo has no account; the owner is alone), `joined` (Leo is a
member; note #7 is not written; Milo's knowledge proposal waits), and `settled` (everything
landed). Two people can hold sessions at once — each account has its own cookie and CSRF token,
and `newPersona()` in a scenario opens a second browser context for the second person.

**No scenario walks the `invite` stage today.** `team-join` did, and it was retired with the
username-and-authenticator signup it walked (note #531) — so nothing here pictures a member
arriving by invite any more. The stage, its endpoints and `newPersona()` are kept exactly because
that journey is worth rebuilding on the email door, and this is the scaffolding it would use.

As on the first day, the reads are the clock for work that happens off-screen: Ruby's chat polls
are what bring her reply and then the proposal card.

One fixture fact is measured against the reader's own clock rather than written down: a
subscription window's **pace**. `windowPace` compares how much of a window has been spent with how
much of its own length has gone by, so a window with a fixed reset date is simply in the past the
next time anyone runs this, and the meter draws no tick and no line. Each window in `team.json`
therefore carries `elapsedFraction` — how far through itself it is — and `seatWindow` in
`support/team-world.mjs` derives `resetAt` from it when the request is answered. The Claude seat's
week is 61% spent with 35% of the week gone (ahead of an even pace, with a forecast), and its
five-hour window is level with its own clock.

Keep later branches in separate scenarios while sharing these fixture conventions: make the request
contract explicit, advance fixture state only after the expected user action, and assert the visible
outcome rather than stopping at a successful response. Failure scenarios must also assert the state
that did *not* change, the input that remained available, and the control that became retryable.
