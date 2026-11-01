# Moving the Workspace to React, one screen at a time

**Status:** done — every screen slice (1–8) landed 2026-09-02, and slice 9 removed the legacy page on 2026-09-03
**Date:** 2026-09-02, slices 2–8 the same day; slice 9 on 2026-09-03
**Asked for by:** note #256

> Rooms were removed on 30–31 Oct 2026 (note #843). The slice notes below
> are a record of what each slice moved at the time, and they name the room
> tabs, the room pickers, the `/rooms` screens and the `?room=` scope those
> screens had then. None of that exists today: a workplace is one place with
> one list of agents, notes, keys and pages, and no call or address names a
> room.

The authenticated Workspace lived in `backend/src/miniapp.html`: one file,
~22,000 lines, 27 addressable screens, CSS, API access, rendering, polling,
navigation and mutable global state together. Vanilla JavaScript was not the
problem; one file being all of those things was. This is the plan that
replaced it with React 19 + TypeScript + Vite + React Router without a big
rewrite, the rules every slice followed, and — now that the page is gone —
the record of what each slice moved and what it learned.

## Where things live

| What | Where | Why there |
|---|---|---|
| The React Workspace shell | `backend/workspace-ui/` | The backend serves it and packages it, so `backend/` is what the deploy path filter watches (`docs/ci-two-lane-runner.md`); and the tests that read `miniapp.html` are already backend tests. It is still a separate application from the marketing site in `src/`, which stays on Cloudflare Pages. |
| The shared route registry | `backend/src/shared/workspace-routes.ts` | Pure module. The server derives the paths it serves from it and the React router derives its route table from it. |
| The shared API types | `backend/src/shared/workspace-api.ts` | Handlers `satisfies` these shapes; the client's `api<T>()` is parameterized by them. A renamed field fails to compile on both sides. |
| The API client | `backend/workspace-ui/src/api/client.ts` | The legacy `api()` / `authApi()` pair as an importable module: cookie credentials, CSRF header read fresh per call. (Calls carried a `?room=` scope too, until rooms were removed — note #843.) |
| Workspace state and refresh | `backend/workspace-ui/src/workspace/` | `WorkspaceProvider` is the legacy `load()` / `pollLive()` / `refreshNotifications()` trio; `live.ts` is the pure half (the live tick, unread grouping), tested on its own. |
| Home | `backend/workspace-ui/src/screens/home/` | One component per section; `agent-words.ts` is the row's vocabulary, ported function for function. |
| The agent's own screen | `backend/workspace-ui/src/screens/agent/` | The screen, its model/effort leaf (a room leaf stood beside it until note #843), and `agent-facts.ts` — the words the facts say, pure and testable. |
| The chat | `backend/workspace-ui/src/screens/chat/` | The screen, the composer, one row renderer, and two pure halves: `chat-notice.ts` (who is speaking, and what a platform row says) and `transcript.ts` (how a read joins the rows on screen). |
| Making and erasing an agent | `backend/workspace-ui/src/workspace/FleetProvider.tsx` | Both change the FLEET rather than one screen: a delete starts on the agent's screen and finishes as a row leaving Home, a create starts on Home and is answered several reads later. |
| Markdown, safely | `backend/workspace-ui/src/ui/markdown-parse.ts` + `markdown.tsx` | The parser emits DATA and the renderer turns data into elements, so there is no string path from a message to the page. |
| The toast, and who owns Back | `backend/workspace-ui/src/chrome/` | `Banner` is the legacy `banner()`; `BackProvider` is what lets a transient leaf answer Back before a history entry is spent. |
| Notes | `backend/workspace-ui/src/screens/notes/` | The three note screens and the two transient leaves they open; `note-words.ts` is the row's and the header's vocabulary, ported sentence for sentence, and `note-previews.ts` is the session's minted-URL map (note #198). |
| The hand-off row and its Send | `backend/workspace-ui/src/ui/HandRow.tsx`, `HandoffSend.tsx`, `handoff.ts` | Notes, knowledge pages and both proposal review screens ask the same question — who does this? — so one row, one message screen and one set of sentences answer it, in `ui/` where every screen reaches them rather than inside any one. Slices 5 and 6 ran in parallel and both wrote this row; slice 5 took slice 6's copy verbatim while both were still proposals, so the two branches merge without a conflict. |
| Decisions | `backend/workspace-ui/src/screens/decisions/` | The two proposal screens and what they share: the check vocabulary, the landing sequence, the margin, the pinned bar. The sentences and the arithmetic are pure modules beside the components, so both are tested on their own. |
| Knowledge | `backend/workspace-ui/src/screens/knowledge/` | The page list, one page rendered, and the row both lists draw. `knowledge-words.ts` is the shelf's vocabulary. |
| Chrome documents share | `backend/workspace-ui/src/ui/` | The hand-off row and its Send belong to notes, knowledge pages and proposal reviews, so they live beside the icons and the context ring rather than inside whichever slice needed them first. |
| The secure renderers | `backend/workspace-ui/src/render/` | Markdown, the unified diff, and the knowledge/note HTML allowlist. Nothing agent-written ever becomes markup: the first two build React elements, the third builds DOM node by node (see rule 4). |
| The persistent header and scroll memory | `backend/workspace-ui/src/chrome/` | Back and Home over every destination but Home, and between them `HeadPresence` — whether the agent whose screen this is, is working (note #240); where each history entry was scrolled to. |
| Serving both shells | `backend/src/routes/workspace-ui.ts` | The per-browser switch, the shell loader, its Content-Security-Policy and the asset route. |
| The build | `npm run build` in `backend/` | `tsc -b` for the server, then `build:workspace-ui` (typecheck + `vite build`) into `backend/dist/workspace-ui`. The deploy tarball copies `backend/dist` whole, so the shell rides the same artifact as the server. |
| Tests | `backend/workspace-ui/src/**/*.test.tsx` (jsdom) and `backend/src/test/unit/workspace-*.test.ts` (Node) | One `vitest run` in `backend/` runs both projects (`backend/vitest.config.ts`), so CI and the deploy build needed no new command. |

## How the shell is served

Every registered Workspace address (`shared/workspace-routes.ts`) answers with
the one built `index.html` under `backend/dist/workspace-ui`, and the hashed
assets are served under `/workspace/app/assets` (`routes/workspace-ui.ts`).
A backend built without the shell answers 404 with a JSON error rather than
a blank. The shell's policy is `script-src 'self'` with no inline hashes,
because the shell has no inline script; the loader refuses a build that grew
one.

Until slice 9 the shell answered beside the single-file page on the same
addresses, chosen per browser by a cookie that `?ui=react|legacy` set, with
`WORKSPACE_UI_DEFAULT` deciding for browsers that never chose. The page is
gone and the setting with it; `?ui=` on a link is now only cleaned (the
cookie expired, the browser redirected to the same address without it), so
an old link that carries it still lands.

## Rules for every slice

1. **One registry.** A new destination is added to
   `shared/workspace-routes.ts` and nowhere else.
2. **Ownership is the serializer's boundary.** Account routes carry no
   workplace; workplace routes carry `org`. (Room routes carried `org` and
   `room` until rooms were removed, note #843.) Forms, editors and pickers
   stay transient — no address.
3. **Truth comes from the server.** A sign-in form finishing is not a session;
   `auth/session` is, and the enrollment screen reads the authenticator's
   digits and period from `auth/enroll/start`. Every record API authorizes the
   workplace and object it is asked for; a URL names a place, it
   never grants access to one.
4. **No `dangerouslySetInnerHTML`.** The secure markdown, diff, file and
   knowledge renderers build DOM safely today. Port them as components that
   build elements, or wrap the existing safe DOM construction — never as a
   string into `innerHTML`.
5. **Keep the CSS.** The stylesheet the screens were ported against is
   `backend/workspace-ui/src/workspace.css` — the old page's one `<style>`
   block, moved whole in slice 9 (until then a Vite plugin extracted it from
   the page at build time so one edit landed in both shells). Screens use its
   class vocabulary; `app.css` carries only what the shell needs beyond it.
6. **Keep the tests honest.** A screen left the legacy page only when its
   React equivalent had tests covering what the page's `grab()`-based tests
   covered for it, and the browser-history behaviour the knowledge page
   `miniapp-navigation` describes is preserved. That rule still holds for a
   new screen: its tests land with it.
7. **Remove last.** The monolithic page and its compatibility layer were
   deleted only after every screen had an equivalent, tested replacement and
   the shell had been used in production — slice 9, below.

## The slices

| # | Slice | State |
|---|---|---|
| 1 | Foundation: standalone authentication (sign in, create access, authenticator setup, recovery codes, recovery, invite preview and redeem, sign out), URL routing over the shared registry, the API client, shared types, the shell switch and its delivery tests | **landed** |
| 2 | Home / Overview: the workplace header, the room tabs, the unread-replies queue, the decision queue, the fleet with its live line, the three refresh rules (`workspace-miniapp-refresh`), the persistent header and Back, scroll memory | **landed** (see below) |
| 3 | Agent and chat: agent details, chat transcript, composer, attachments, stop, model and room pickers, agent creation, the mid-delete row states | **landed** (see below) |
| 4 | Decisions: change proposals (diff, files, comments, decision) and knowledge proposals | **landed** (see below) |
| 5 | Notes: list, archive, note, comments, files, editor | **landed** (see below) |
| 6 | Knowledge: list, page, comments, files | **landed** (see below) |
| 7 | Repositories: overview, content, file, history, contributors, commit, checks, CI secrets | **landed** (see below) |
| 8 | Workplaces, rooms, seats and seat sign-in, sites, secrets, profile and browser sessions | **landed** (see below) |
| 9 | Remove the legacy page, the CSS extraction plugin and every `grab()` test | **landed** (see below) |

Every slice has landed. The React shell is the Workspace.

## What slice 2 did and did not move

Home in the React shell draws what the legacy home draws for the sections
that belong to this slice, with the legacy ids, because the shared stylesheet
keys its spacing and the room-switch veil on them. The sibling order was the
legacy one (`#screenHome > #orgSection + #seatsHomeSection + #roomsHead +
#roomSection + …`) until note #404 divided Home into two tab panels
(`#screenHome > #orgSection + #homeTabs + #homeWorkplace + #roomsHead +
#roomSection + #homeRoom`); the ids are unchanged and the stylesheet's two
chains were rewritten around the panels.

- **Moved:** the workplace header (three flat doors and the switch), the
  rooms row (tabs, attention dot, Manage rooms), Unread messages, Waiting for
  your decision (change proposals first, then knowledge proposals, only
  those this reader decides), Agents (every state line, recap with its
  arrival animation, the Now line, the setup meter, the context ring, the
  session-limit mark, counts for the viewed room), the persistent Back/Home
  header, and scroll memory per history entry.
- **Refresh:** `WorkspaceProvider` keeps the three rules: the full read
  re-arms every five seconds only while an agent is between states or a
  check is running; the live tick patches the working rows and buys one full
  read when the working set moves; notifications refresh after every full
  read and every thirty seconds. Both timers stop while the document is
  hidden and catch up on `visibilitychange`. A room switch is guarded by a
  monotonic serial and the room each request asked for.
- **Not moved, on purpose:** seats (slice 8), the Notes glimpse (5),
  Repositories (7), Sites and Secrets (8), Knowledge (6 — landed since; Home
  draws its card now). Home ends on one card naming whatever is still in the
  classic Workspace, which opens at the same address.
  Creating an agent is a transient flow (slice 3), so the New agent door is
  a real link to the classic Workspace until then; the mid-delete row states
  come with the agent screen that starts a delete. Sign out stays on Home
  until the profile screen moves.
- **Taps** go to registered destinations only: an agent row to
  `/agents/<id>` (or `/seats?org=` for a paused agent with no matching
  sign-in), an unread row to `/chat/<id>`, a proposal to
  `/decisions/pr/<id>` or `/decisions/knowledge/<id>`, the header to
  `/profile`, `/workplace?org=` and `/workplaces`, the rooms row to
  `/rooms?org=`. Each of those is still a "not yet moved" card that opens
  the classic Workspace; the address is already right.
- **Back** spends a history entry when this page session pushed one, and
  replaces a pasted or reloaded address with Home when it did not — the
  same answer the legacy page synthesizes.
- **The client** gained a per-call scope (`api(path, init, { room })`) in
  place of a context installed at construction: the room is a fact the
  screen owns at the moment it asks, and a scripted test can see it.

## What slice 3 did and did not move

The agent's own screen (`/agents/<id>`) and its conversation (`/chat/<id>`)
are React now, with the legacy ids and class vocabulary so the shared
stylesheet draws both shells alike.

- **The agent screen:** the header with its context ring, the recap and the
  exact Last reply (Markdown, built as elements), the Chat door, every facts
  row the legacy screen writes (the session-limit card and its Resume, who
  drives it, Room, Subscription, Machine, Working / Last worked, Working on,
  Turns, Recap from, Thinks with, Its site), the version card with its two
  update actions and their busy locks, the context bar and the reset ask, the
  proposal history, and the delete.
- **The chat:** the pinned identity header (which is why the persistent header
  steps aside here), the transcript with a renderer per role — the owner's
  words verbatim, an agent's and a peer's as Markdown, a platform event as a
  receipt — day dividers, the typing bubble and Stop, the composer with its
  cap, counter and attachments, and the arrival animations.
- **Also moved with this slice, because they belong to these screens:** making
  an agent (the harness chooser, the missing-subscription walk to the seats
  screen, the pending plate), and the mid-delete row states on Home.
- **Warm first.** Both screens open on what the state read already carried —
  the agent's version seed and its `lastReply` — and refresh underneath. A
  failed refresh leaves rows that were true a moment ago standing; only a
  screen with nothing on it says why.
- **Live where it matters.** `busy` and the context reading come off the fleet
  row, which the live tick patches, so the update buttons unlock the moment a
  turn ends. The chat keeps its own three-second poll, because an open
  conversation is the one surface where a reply has to arrive by itself.
- **Two transient leaves.** The model/effort picker and the agent's room move
  keep the screen's address underneath them (`miniapp-navigation`), so Back
  closes them rather than spending a history entry — which is what lets the
  chat come back to its own transcript and its unsent draft. `BackProvider` is
  the port of `goBack()`'s "ask a transient leaf first" rule.
- **Chat's Back is the one exception.** A chat this page session opened spends
  its entry; a pasted or reloaded one has no Agent entry beneath it, so Back
  REPLACES it with the agent rather than pushing a duplicate.
- **Scroll after the commit, never beside the setState (note #273).** The
  port had kept the legacy page's `scrollTo(scrollHeight)` right after the
  read — but the legacy page appended DOM synchronously and React commits
  later, so the call measured a document the rows were not in yet: the chat
  opened at its FIRST message, and a send was never followed. A read now only
  ASKS for a follow (`follow.current`), and a layout effect keyed on the rows
  carries it out once they are on the page. The same shape fixed the live
  row's entrance, the leaf's parked line (restored only once the persistent
  header the leaf brought out is gone — it stands above the screen and moves
  every line by 48px), the composer's auto-grow (a layout effect on the
  text, as `HandoffSend` already did) and its reserve (a `ResizeObserver` on
  the bar rather than a re-sync on the row count). Two more the same note
  found: the box was `disabled` during a send, which drops focus — and on a
  phone the keyboard — before the focus() after it could run, so it is
  `readOnly` now and Send declines the focus its tap would take; and the
  runtime picker REPLACED the screen instead of covering it, so the unsent
  draft died with the composer — the screen stays mounted and `hidden` under
  the leaf. `body.agent-chat-open`, which the stylesheet keys the page's
  bottom padding on, was never set by the shell; it is now, and the browser
  frame gives its padding up under it too. Chrome sees all of this and jsdom
  none of it: `verify-workspace-react-agent-chat.mts` seeds a transcript
  long enough to scroll and checks where the chat opens, what a send
  follows, what the leaf gives back and how the box grows.
- **Not moved, on purpose:** the full-screen picture and file viewers. They are
  shared with notes, knowledge and repositories and move with those slices; a
  chat file opens where the legacy viewer's own Download sends it until then.
  (Slice 7 moved the viewer and moved every caller but this one; note #294
  finished the chat — see below.)
  Pinning a specific seat is still the seats screen's job (slice 8), so the
  Subscription row names the pin it can read off the state and opens the
  registered seats address.
## What slice 4 did and did not move

The two screens behind Home's decision queue: `/decisions/pr/<id>` and
`/decisions/knowledge/<id>`. Both keep the legacy ids (`#screenPr`,
`#screenPrDiff`, `#screenKp`, `#screenKnowledgePage`, `#prDecide`) and the
legacy class vocabulary, because the shared stylesheet keys the decision bar's
inset (`.hasbar`), the summary card's row borders and the diff's colours on
exactly those.

- **Moved:** the proposal header (repository, number, both branches, the status
  pill and when, the signature with its runtime line, the agent's face as a
  door), the write-up with its fold, the notes the change implements, the
  attachments (a photo shown whole, everything else a row), the summary card
  (size, commits, Actions with its log tails), the diff on a screen of its own,
  the approve/reject bar with the required-checks gate and the line that says
  what approving would do, the CI poll, the post-merge landing sequence with
  its own endpoint and quiet window, the margin and its composer,
  and — on the knowledge side — the change cards leading with an open diff
  built in the browser from both versions, the "Read the page" rendering, the
  moved-page guard and the publish/reject bar.
- **Transient leaves, not addresses (rule 2):** the diff and the proposed-page
  rendering keep the proposal's address underneath them and spend a history
  entry at it, so the persistent header's Back closes the leaf and returns the
  reader to the row they opened it from, with their reading line.
- **After a decision** the screen calls the provider's `reload()` rather than
  re-reading anything itself, so Home's queue is right behind it. A knowledge
  decision then lands the reader on Home with the sentence for what happened,
  exactly as the legacy screen does.
- **Not moved, on purpose:** the full-screen image viewer, which is shared
  chrome three stores borrow (a proposal, a note, a knowledge page) and belongs
  with the last of them; a tap on an attachment opens it in a new tab
  meanwhile. The chat door and the agent face write `/chat/<id>` and
  `/agents/<id>` — registered addresses whose screens are slice 3. The
  repository, commit and note doors likewise write their registered addresses
  (slices 5 and 7).
- **Parity is measured, not asserted.** `scripts/verify-workspace-react-decisions.mts`
  opens the SAME proposal record in both shells and compares what each says —
  eyebrow, title, pill, branches, signature, write-up, summary rows, the
  approve hint, the bar — and where each part SITS, since the stylesheet is
  shared and a box in a different place means a node the CSS was not expecting.
  That check is what caught the chat door: `.btn` is a flex box either way, but
  an anchor inherits the page's line-height where a form control does not, and
  the four pixels it bought moved every card under it.

## What slice 6 did and did not move

The room's knowledge base: Home's glimpse card, `/knowledge` and
`/knowledge/<name>`. All three keep the legacy ids and class vocabulary
(`#knowledgeHead`, `#knowledgeCard`, `#knowledge`, `#screenKnowledge`,
`#knowledgeList`, `#screenKnowledgePage`, `#kpageTitle`, `#kpageBody`,
`#kpageHands`, `#kpageComments`), because the shared stylesheet keys the row
borders, the `.facerow` scroller and the page's own typography on exactly
those.

- **Moved:** Home's card (the recent six, the agent that last landed each page
  in front of what the page is for, the door that says how many there are in
  all, the empty-room state and the two ways the section is absent); the
  Knowledge screen behind that door with every page on it; and the page
  itself — its words built node by node through the allowlist, its own
  attached pictures, the row of idle agents it can be handed to with the Send
  that opens from it, and the margin.
- **Home's card replaces the classic hand-off for that section.** The
  "Everything else" card at the foot of Home no longer names knowledge.
- **Warm first.** The page opens on the title and description the room's list
  already carried and fills in the words underneath, so a tap from Home paints
  the heading it was tapped on rather than a slug and a spinner. A failed read
  leaves those standing and says why in the body.
- **The list says nothing about how full the shelf is until it has been
  read.** A pasted `/knowledge` link arrives before the state does, and "0
  pages" over the empty-base sentence is a claim rather than a wait — this is
  the one behaviour that is deliberately *better* than the legacy screen,
  which can only be reached from Home and so never had the problem.
- **The Send is a transient leaf (rule 2):** it keeps the page's address
  underneath it and spends no history entry, so Back closes it and returns the
  reader to the page at their reading line. Nothing typed becomes a copied URL.
- **Shared with slice 5, deliberately.** The hand-off row, its create plate,
  the Send and the handoff sentences are `ui/HandRow.tsx`, `ui/HandoffSend.tsx`
  and `ui/handoff.ts` — one renderer for both documents that carry the row, as
  the legacy `renderHandRow` is. `noteHandoffText` sits beside
  `kpageHandoffText` there, unused by this slice, so the Notes slice imports it
  rather than writing a second copy. `ui/EmptyState.tsx` and `ui/AgentLine.tsx`
  are the same move: Home's fleet used a private copy of the first, and the
  site and note rows will want the second.
- **Not moved, on purpose:** the full-screen picture viewer, which is shared
  chrome three stores borrow (a proposal, a note, a knowledge page, a
  repository file) and belongs with the last of slices 5–7; a tap on a page's
  picture opens it in a new tab meanwhile. The margin's person door writes the
  registered `/workplace/members/<id>?org=` address, whose screen is slice 8.
- **Parity is measured, not asserted.**
  `scripts/verify-workspace-react-knowledge.mts` opens the SAME page in both
  shells and compares what each says — title, description, body, the hand
  tiles and their harness line, the hint, the tile's aria-label, the margin —
  and where each of eleven parts SITS. Home's card is compared by SHAPE
  (each box measured from `#knowledgeHead`) rather than by absolute top:
  Notes, Repositories and Sites still stand above Knowledge in the legacy page
  and arrive with slices 5, 7 and 8, so the whole card sits higher in the
  React shell until they do.
- **Two traps the harness found**, worth knowing before writing the next one:
  a room that does not ADOPT its workplace's base namespace leaves the
  Workspace in the `needsRoomForExistingWork` state, where it stands in no room
  at all and never writes the `?room=` half of a room-scoped address; and an
  workplace with no live seat makes every agent `needs-seat`, so the
  hand-off row correctly offers nobody. Both read as bugs in the screen and are
  neither. Also: a `const` arrow function declared inside `page$.evaluate` is
  compiled with tsx's `keepNames` shim, which is not defined in the page —
  `__name is not defined`. Inline the expression instead.
## What slice 8 did and did not move

The administration screens: `/workplaces`, `/workplace`,
`/organization/spending`, `/organization/people` (note #328), `/organization/members/<id>`, `/rooms`,
`/rooms/<id>`, `/seats`, `/seats/sign-in`, `/seats/<id>`, `/sites/<name>`,
`/secrets`, `/secrets/<name>` and `/profile` — and Home's seats, Sites and
Secrets cards. All keep the legacy ids and class vocabulary.

- **Moved:** the workplace picker with the founder door; the workplace
  (members, invites, the cloud account and its deploy-token form, the code
  host with backups and the grow-storage action, membership, the sole-admin
  delete behind typing the name); cloud spending; the member screen with
  role change and removal; the rooms list with press-and-hold reordering
  (`rooms/room-drag.ts`, plain DOM work by design, committed to React only
  on the drop), the naming form in its four shapes, the room screen with
  rename and delete; the seats list with available sign-ins, the seat with
  its recovery card, usage windows and fallback order; the sign-in ceremony
  with its 2.5-second poll; the site with the room move and the delete
  behind typing its name; the secrets list, the secret with copy-in-the-tap,
  describe, replace and delete, and the add-a-secret leaf; the profile with
  the name editor that opens itself only when there is no name, the
  picture, browser sessions and their revocations,
  and sign out — which is where it lives on the legacy page, so Home's
  sign-out button went.
- **Transient leaves, not addresses (rule 2):** founding a workplace,
  naming a room, moving a site to a room, adding or replacing a secret. Each
  keeps the screen that opened it underneath and Back closes it.
- **The seats cache** (`workspace/SeatsProvider.tsx`) is read once and kept,
  single-flight; every seat mutation drops it BEFORE the address is replaced
  with the list, or the list walks back one seat short (the legacy rule the
  sign-in test asserts). Opening the list reads again so usage is fresh; a
  seat paints from the cache when it is warm — unless the cache is older
  than Home's row for it. Both reads stamp a subscription with the server's
  last change (`updatedAt`), so the seat and the list draw the newer copy and
  ask again for the one that is behind (`workspace/seat-copies.ts`, note
  #697); Home's row carries every word a usage row says, so the page can
  draw that reading whole while its own read is out.
- **After a mutation** the child address is REPLACED, never left in place:
  a deleted room becomes the rooms list, a seat mutation the seats list, a
  deleted site or secret Home. Switching or founding a workplace drops
  the viewed room before the next state read, so the old workplace's
  room cannot ride into the new one.
- **Room-bound calls carry the room.** Sites and secrets pass the viewed room
  as the call's scope; workplace, room, seat and profile calls do not.
- **Not moved, on purpose:** the agent-seat picker on the agent screen stays
  as slice 3 left it; the full-screen picture viewer is still shared chrome
  for slices 5–7.

## What slice 7 did and did not move

The last screen slice. Every registered destination now has a React screen,
Home draws every one of its sections, and the "Everything else" card that
handed the reader to the classic Workspace is **gone** — there is nothing left
behind it. Only slice 9 remains: deleting the legacy page.

- **Moved:** Home's Repositories card (the activity line with its branch rule,
  the contributors' faces, the delete/CI/PR badges, the storage line and the
  git key at the foot of the list); the repository's own screen with its two
  TABS; the tree with its crumb, branch bar, newest-commit row and README; the
  file view; the history; one commit's diff; the contributors; the room
  grants and their picker; and the type-the-name delete with the two requests
  an agent can leave beside it.
- **Overview and Content are tabs on one place.** The selection rides the
  history entry's own state, not a second URL, so it is restored with the
  entry and costs no extra Back. A folder is the same kind with a `path`
  query and always restores Content; choosing Overview from inside a folder
  walks back to the root, which is what brings the root-only cards back.
- **The full-screen picture viewer finally moved.** Slices 4, 5 and 6 each
  wrote "it belongs with the last of us"; this is the last of us. It lives in
  `ui/ImageViewer.tsx` as a provider over the whole app, and a proposal's
  photos, a note's photos, a knowledge page's diagrams and a repository's
  images all open in it. Each caller passes a GALLERY built from the pictures
  already on screen, so stepping between them costs no further requests.
- **Two things it deliberately does not carry over.** The viewer's PINCH and
  SWIPE gesture machine: the buttons do everything the gestures did, the
  browser's own pinch still zooms, and a second unverified copy of a
  pointer-event state machine is worse than none. And **syntax highlighting**
  — see below, because that one is a CSP decision rather than a preference.
- **Dropping a behaviour means dropping the DOM it needed (note #274).** The
  gesture machine went; the carousel's markup did not. The picture stayed
  wrapped in the rail (`.ivtrack` — `position: absolute; inset: 0;
  display: flex`) and lost the class that fits it (`.ivimage`), so the rail's
  flex layout sized it instead of the stylesheet: stretched to the full height
  of the stage whatever its shape. Blink re-derives the width from the ratio
  and blows the picture up until it is cropped; WebKit does not, and squashes
  it out of shape — which is what the owner photographed on an iPhone. Being
  `inset: 0`, the rail also lay over the stage and swallowed the
  tap-beside-the-picture that closes the viewer. Nothing threw and no test
  failed; it just came out wrong. The picture is now a direct child of the
  stage, and the two rules that decide its shape carry a comment saying so.
- **A square fixture cannot catch a viewer that stretches.** The repository
  harness opened the viewer on a 1×1 pixel, where correct and stretched are
  the same picture, and the check read only the file's name. `logo.png` is a
  640×160 chequerboard around a circle now, and the harness measures the
  PAINTED box — `object-fit` decides how much of the element box the reader
  actually sees, so a check that reads the box alone passes a viewer that
  stretches its contents to fill it.
- **A crumb jump is always a forward door.** The legacy page replays browser
  Back when the target is the one PROVEN parent entry and walks forward
  otherwise; here the persistent header's Back already owns the one-hop
  return, and a crumb that sometimes went back and sometimes forward was the
  subtler of the two to keep honest.
- **Every screen is keyed by what it shows** (`App.tsx`), so walking from one
  commit to another rebuilds rather than leaving the first one's patch under
  the second one's sha. That is also what let the react-compiler lint's
  `set-state-in-effect` rule be satisfied honestly rather than worked around:
  the reset a fetch effect wanted to do at its top is a REMOUNT.
- **Not moved:** nothing. The legacy page keeps every screen until slice 9
  deletes it. `NotYetMovedScreen` still existed at this point as a fallback;
  note #304 later removed it and made the screen map exhaustive, so a newly
  registered route without a screen now fails the build.

### Syntax highlighting cannot come across, and should not

The legacy file view fetches highlight.js from cdnjs at the moment a code file
is opened. Its Content-Security-Policy allows that
(`script-src 'self' https://cdnjs.cloudflare.com …`); the React shell's says
`script-src 'self'` and nothing else, which is a property it was given on
purpose and the reason its loader refuses a build that grew an inline script.

So the React file view has the text, the line numbers, the wrap rule for
prose, the markdown/raw toggle and Copy — and no colours. Widening the shell's
CSP to a third-party origin to colour a listing is the wrong trade, and
bundling a highlighter would put ~100 KB on every reader who never opens a
file. If the colours are wanted later, the honest options are a small
self-hosted grammar set bundled with the shell, or highlighting on the server;
both are their own piece of work.

## What slice 9 removed

Asked for on 2026-09-03, after a day of the shell in use ("UI works much
better now"), and done in one proposal:

- **The page.** `backend/src/miniapp.html` (22,299 lines) and the build
  step that copied it into `dist/`. `routes/workspace.ts` no longer
  reads, hashes or compresses a page: every registered address serves the
  built shell, and a backend without a build answers 404 with a JSON error.
- **The switch.** `WORKSPACE_UI_DEFAULT`, the `workspaceUiDefault`
  dependency, `parseWorkspaceUiChoice` / `workspaceUiChoice` /
  `handleWorkspaceUiSwitch`, and the shell's "Open in the classic Workspace"
  link (`classicWorkspaceHref`). What stays is
  `handleRetiredWorkspaceUiSwitch`: a link that still says `?ui=` has the
  choice cookie expired and is redirected to the same address without it.
  Old links in chats and notes therefore still land.
- **The CSS extraction.** `vite-plugin-legacy-css.ts` and the
  `virtual:legacy-workspace.css` module. The stylesheet now lives at
  `backend/workspace-ui/src/workspace.css`, imported by `main.tsx` ahead of
  `app.css`, byte for byte the page's `<style>` block with the two-space
  indent removed.
- **Every `grab()` test.** `telegram-miniapp-page.test.ts` (11,343 lines)
  and the nine `telegram-miniapp-*.test.ts` files beside it that lifted
  functions out of the page's inline script, `miniapp-delivery.test.ts`
  (the page's brotli/gzip/ETag delivery), the registry parity test in
  `workspace-routes.test.ts`, and the `pipClass` test in
  `git-commit-status.test.ts`. `workspace-ui-delivery.test.ts` now covers
  the one shell: every address, any leftover cookie, the `?ui=` clean-up,
  the CSP, the assets and the no-build answer. The suite went from 182 to
  171 files.
- **The page-driving harnesses.** Nineteen `scripts/verify-*.mjs` scripts
  that loaded `miniapp.html` straight into Chrome, and
  `scripts/shoot-workspace-outreach.mjs` with its `npm run shoot:workspace`
  (the marketing screenshots under `public/workspace-screenshots` are kept
  as they were shot; re-shooting them from the shell is its own piece of
  work). The React harnesses (`scripts/verify-workspace-react-*.mts`) lost
  their "both shells say the same" sections — there is one shell to ask —
  and keep every other check.
- **The simulations** (`simulations/`) now serve the built shell from
  `backend/dist/workspace-ui` at `/workspace/signup`, with its assets, so
  `npm run build` in `backend/` comes before `npm run simulate`. Three of
  their assertions described the old page's DOM and request pattern rather
  than the product: a hidden sign-in gate the shell does not draw at all
  (`hiddenOrAbsent` now), and exactly two session reads where the shell —
  by rule 3, "truth comes from the server" — reads the session again after a
  form finishes. The mock also stopped claiming `/workspace-screenshots/*`
  (the landing page's images) as Workspace requests.

Running them found one thing slice 1 had dropped: the old page said
"Signed in with a recovery code. That code cannot be used again." after a
recovery sign-in, and the shell said nothing. `BannerProvider` now sits
above the sign-in gate as well as the screens, so the recovery panel can
show that toast on the Home it lands on.

`NotYetMovedScreen` survived this slice without the classic link. Note #304
later removed it and made the route-to-screen map a full `Record`, turning a
missing screen into a compile error instead of a runtime fallback. The
`miniapp` word in route file names, log prefixes and the `/miniapp` path stays;
that is history, not a page.

## What slice 9 dropped without noticing: voice-to-text

Found on 2026-09-03 from note #233, which asked for a sound-wave indicator on
the microphone button — and the microphone button was gone.

The legacy page gave EVERY prose field a mic by walking the document with a
MutationObserver (`installVoiceFields`) and wrapping each field in a
`.voicefield` holder. None of that walked across into the shell, because it
could not: inserting a parent between a field and the node React believes is
its parent breaks the next insert or remove React makes there. So the port had
no place to put it, and the flow left with the page.

What made it invisible for a day:

- **The CSS survived.** `.voicefield`, `.voicebtn`, `.voicespin` and
  `@keyframes voicepulse` moved with the rest of the stylesheet, so grepping
  for "voice" in the shell finds a complete-looking implementation with
  nothing at all creating those elements.
- **The backend survived.** `POST /workspace/api/transcribe`,
  `VoiceTranscriptionService` and its tests are untouched and green. The
  route's own tests pass against a caller that no longer exists.
- **No test covered it.** The mic was installed by a document-level observer
  rather than rendered by a screen, so it belonged to no screen's tests and
  no screen's tests missed it.

The lesson worth keeping: **when a large page is deleted wholesale, the CSS
and the server routes it used are the orphans to hunt.** A class with no
element and a route with no caller are both cheap to grep for, and both would
have caught this the day it happened.

### What replaced it

`backend/workspace-ui/src/voice/` — `voice-input.ts` (the pure half:
container choice, transcript merging, the level curve, the strip) and
`VoiceField.tsx` (the holder, the permission, the recorder, the analyser). A
screen opts a field in by wrapping it:

```tsx
<VoiceField onTranscript={setText}><textarea value={text} … /></VoiceField>
```

`onTranscript` hands back the field's WHOLE new value, merged at the selection
the field had when recording started, plus the caret — so a controlled
component stays controlled and nothing writes to `.value` behind React's back.
Ten fields are wrapped: the chat composer, the note composer, a proposal or
page comment, a handoff message, a secret's description, a room name, an
workplace name, both profile names, and the two search boxes.

The exact-value fields are deliberately NOT wrapped — a secret's name and
value, the org deploy token, the Claude sign-in code, and the type-to-confirm
box. They are the same set that declares `spellcheck=false`, and the rule is
the route's own (`routes/workspace.ts`): recognition must never
almost-match a credential or a deletion confirmation. `Slice8.test.tsx` holds
the add-secret form to it.

### The wave (what note #233 actually asked for)

A recording indicator that pulses on a timer looks identical whether the
microphone is picking up a voice or is muted, pointed at a wall, or held by a
browser that granted the permission and then handed over silence. So the strip
is the microphone's own signal: an `AnalyserNode` on the recording stream, the
RMS of the last few milliseconds through a perceptual curve, one bar per
40ms step, scrolling right to left over 28 bars — about a second of history,
which is roughly a spoken word.

- The bars are driven imperatively (`style.transform` on each span) rather
  than through state: 25 renders a second of the screen the composer sits on
  is not what React is for.
- The ring around the button follows the same number through a
  `--voicelevel` custom property, and the `metered` class turns the timed
  pulse off once the analyser is actually running — so the timer is the
  fallback for a browser with no Web Audio, and for `prefers-reduced-motion`.
- The analyser is NOT connected onward to the destination. That would play the
  microphone back through the speakers, which is a feedback loop, not a
  feature.
- The strip sits on the field's LAST line rather than over the whole box, so a
  five-row note stays readable while it is dictated into, and it is tall
  enough to cover a one-line field whole.

`scripts/verify-workspace-react-voice.mts` drives the whole thing in Chrome
against a real audio signal — see its header for why the signal is an
oscillator rather than Chrome's fake capture device — and checks the one claim
jsdom cannot: that the bars are tall while the sound is loud and fall to their
floor when it stops.

## What the note assumed that was no longer true

Note #256 said the page still carried Telegram initialization and `tma`
authentication. By 2026-09-01 (`docs/standalone-workspace-web-app.md`) it
did not: there is no `Telegram.WebApp`, no `initData` and no `tma` header
left in `miniapp.html`, only a vestigial `tg` parameter threaded through a
few helpers and their tests. There was no Telegram layer to port, and none
was.

## What slice 5 did and did not move

Notes are React now — home's glimpse card, `/notes`, `/notes/archive` and
`/notes/<n>` — with the legacy ids and class vocabulary, because the shared
stylesheet keys the swipe's transform, the file carousel's slides and the
hand-off plates on exactly those.

- **Moved:** home's glimpse (the counts, the recent six, the door onto the
  rest, the archive door and "Write a note"), the notes screen, the archive,
  the search across both, and one note whole: its words through the same
  allowlist a knowledge page uses, the line that names it and says who wrote
  it, the row of agents it can be handed to, the margin, the files, and the
  Edit / Move / Archive / Restore / Delete pair for each side of the archive.
- **Transient, not addresses (rule 2):** the composer (writing one and
  rewriting one of your own), the message a note hands an agent, and the room
  move. Each keeps the list's or the note's address underneath it, so Back
  closes the leaf rather than spending a history entry — and a saved note
  lands on the note itself with Home or the list still one Back away.
- **The persistent header now comes out for a leaf over Home.** Home and the
  chat carry no header of their own, so a transient leaf standing over one of
  them had no way out at all: it has no address, so the browser's own Back is
  not it either. `BackProvider` publishes `claimed`, and `PageHead` draws
  itself for exactly as long as a leaf is up. The chat's runtime picker used
  to render a second `PageHead` by hand for this; it does not any more.
- **The draft outlives the box.** `NoteDraftProvider` holds the half-written
  note and its picked files above the screens, which is what the legacy page's
  module state bought: back out of a half-written note, cross to Home and
  come back, and the words and the photograph are still there. Only a save
  empties it, and an edit never touches it.
- **One minted URL per photograph** (note #198). `note-previews.ts` is the
  session's map of signed preview URLs, so home's glimpse and the notes
  screen draw the same picture from one request and a rebuilt row puts its
  photograph straight back rather than flashing the file glyph. A URL with no
  readable expiry is used once and never held.
- **The renderer learned one note-shaped rule.** A note's title IS its first
  line, so `dropTitle` may drop a leading paragraph and not only an `<h1>`
  (`titleIsFirstLine`); and a document that was ONLY its own title renders
  empty rather than saying "This note is empty.", because the screen's heading
  is already showing every word of it.
- **The two `window.confirm` questions became the shell's own ask card** —
  taking a file off a note, and the one delete in the product. Same words,
  same two answers, and the same backdrop-is-no rule every other question
  here follows; the delete's answer is red, which is the whole of the warning
  it carries.
- **Not moved, on purpose:** the full-screen picture and file viewer, which is
  shared chrome three stores borrow (a proposal, a note, a knowledge page) and
  lands with the last of slices 5–7; a tap on a note's file opens it where the
  legacy viewer's own Download sends it meanwhile. A note's author door writes
  `/workplace/members/<id>` and its agent door `/agents/<id>` — registered
  addresses whose screens are slices 8 and 3.
- **The shared pieces came from slice 6, not from here.** Knowledge and Notes
  carry the same hand-off row, the same message screen and the same empty-state
  block, and both slices were open at once. Rather than land a second copy and
  pay for it at merge — which is what slices 3 and 4 did — this slice took
  `ui/HandRow.tsx`, `ui/HandoffSend.tsx`, `ui/handoff.ts`, `ui/EmptyState.tsx`
  and `ui/AgentLine.tsx` from that branch verbatim. A note's Send passes its
  own door through `HandoffSend`'s `send`, because a note records the handoff
  in the same request that admits the turn and a page has no state to record.
  **The rule this leaves for the next pair: before writing a helper the legacy
  page shares between two screens, read the other slice's branch.**
- **Parity is measured, not asserted.** `scripts/verify-workspace-react-notes.mts`
  opens the SAME note in both shells and compares what each says — title, the
  line under it, the words, the remark and its signature, the actions, the
  hand-off row and its hint — and where each part SITS. It caught the port's
  one real drift immediately: a typographic apostrophe in the hand-off hint
  where the legacy sentence has a straight one.

## The one caller the viewer missed: the chat (note #294)

Slice 7 moved the full-screen picture viewer and gave it to a proposal, a
note, a knowledge page and a repository file. The CHAT kept the placeholder
slice 3 had left — `window.open(url)` — so on the one screen where pictures
arrive every day, tapping one left the Workspace for a browser tab (or, on a
phone, a download). The owner sent a screenshot of exactly that.

- **A picture in the transcript opens in the shared viewer**, and the
  message's OTHER pictures are its gallery: one message carries up to five
  files, and the second of them was otherwise reachable only by closing the
  first and finding it again. Per MESSAGE rather than per conversation on
  purpose — stepping out of today's screenshot into one from three weeks ago
  is not what the arrow promises.
- **The gallery is built from what PAINTED, not from what was minted.**
  `FilePicture` hands its URL up in `onLoad` and hands `''` up in `onError`,
  so the row holds exactly the pictures the reader can see. A picture whose
  bytes never arrived is showing its NAME, and tapping it goes out to the
  browser like any other file — a viewer opened on a URL that draws nothing
  would be a black screen with a filename on it.
- **The label says which of the two will happen**: `Open shot.png full
  screen` on a row with a picture on it, `Open notes.md` on a row without.
  The old label promised "full screen" for every file and delivered a
  download.
- **The composer's picked files got the same treatment.** A picture chosen
  but not yet sent opens in the viewer off the object URL the draft already
  minted; anything else still goes out to the browser, which is the only way
  to look at a picked PDF.
- **Everything else still leaves through `ChatScreen.openFile`**, whose URL is
  minted at the TAP. That is deliberate: a file's access URL lives 15 minutes,
  and a chat is a screen people leave open. The pictures accept that bound in
  exchange for opening instantly — the same trade the note files card makes.
- **A markdown image inside an agent's reply is still just an `<img>`.**
  `render/Markdown.tsx` has no `onImage` hook the way `KnowledgeHtml` does,
  and adding one touches every markdown surface in the app, so it was left
  out of this change rather than done halfway on one screen.
- **Chrome, not jsdom, is what proves it.** The chat is the one screen with a
  pinned header and a composer of its own, so the harness measures that the
  viewer covers both, that the wide fixture letterboxes rather than fills the
  stage, that the step arrow reaches the tall one, and that Escape gives the
  conversation back where it was left. `verify-workspace-react-agent-chat.mts`
  builds its two PNGs arithmetically (`png(width, height, colour)`) instead of
  carrying a kilobyte of base64.

## Working on the shell

```
cd backend
npm run build:workspace-ui        # typecheck + build into dist/workspace-ui
npm run dev:workspace-ui          # rebuild on change; the backend serves it
npx vitest run --project workspace-ui
```

Then open the Workspace with `?ui=react` once; `?ui=legacy` switches back.
The shell reads the same cookies the legacy page does, so a session carries
across the switch in both directions.

Three Chrome harnesses drive the built shell against an in-memory backend and
take screenshots into `~/mini-preview/`:
`scripts/verify-workspace-react-auth.mts` (the door),
`scripts/verify-workspace-react-home.mts` (Home with a seeded fleet) and
`scripts/verify-workspace-react-decisions.mts` (both proposal screens, and the
same record drawn by both shells side by side),
`scripts/verify-workspace-react-agent-chat.mts` (the agent screen, its
pickers, and the chat end to end) and
`scripts/verify-workspace-react-notes.mts` (home's glimpse, the list, the
archive, the search, one note whole with a real photograph on it, the
composer, and the same note drawn by both shells). The last two resolve
whichever Chrome puppeteer downloaded rather than pinning a version, and take
`--shell <dir>` to run against a different built shell — production's own
bytes, say, which is this shell's equivalent of pointing `--page` at the
deployed miniapp.
