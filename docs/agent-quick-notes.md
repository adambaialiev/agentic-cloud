# Quick notes

Decided 2026-08-16. The third store, and the least ceremonious of the three.
A quick note is **one short HTML document an agent writes straight into the
account** — no repository behind it, no proposal in front of it, live the
moment the command returns.

|  | repositories | knowledge pages | quick notes |
|---|---|---|---|
| holds | code an agent runs | pages a user reads | jottings |
| lives on | the git host | the git host | the database |
| format | anything | semantic HTML | semantic HTML |
| changed by | push + approved PR | approved proposal | the agent, directly (the user writes and deletes their own way) |
| addressed by | name | name | number |

The gate is what the other two are *for*. Repos hold work nobody can retype and
knowledge holds facts the next agent will act on, so both are worth a tap. A
note is the wifi code. A gate on that is a gate on a thing nobody would bother
writing down at all — and "I'll remember that" is the promise an agent cannot
keep, because nothing of its context survives its turn.

> Rooms were removed on 30–31 Oct 2026 (note #843). A workplace has ONE notes
> list and one series of numbers; the sections below that describe notes per
> room, moving a note between rooms, or the room wall are kept as history and
> say so where they stand.

## What a note is

One HTML fragment, in **the same HTML a knowledge page is written in** — the
allowlist lives in `backend/src/types/safe-html.ts` and both formats share it,
because two allowlists that are meant to be the same are two allowlists that
drift. Headings, lists, tables, links, inline SVG; no CSS, no JavaScript.

```
agentbuilt note add "<h2>Wifi</h2><p>The code is on the router: 4417.</p>"
```

What a note does **not** need is a page's ceremony: no `<title>`, no
`<meta description>`, no name. It is a fragment, and every field this format
does not have is a field an agent has to think about before jotting.

**Plain prose is valid HTML**, so the quickest possible note still costs one
argument: `note add "Call the plumber back on Tuesday"` is a note. What plain
text no longer buys is line breaks — an agent that wants a list writes `<ul>`,
which is the point of the format change (decided 2026-08-16, hours after notes
first shipped as plain text: the owner reads these rendered beside knowledge
pages, and a text dump next to a typeset page reads as the broken one).

- **Numbered per workplace** (note #741; per room before 12 Oct 2026), like a
  knowledge proposal: `note #3`. The number is the address — `note show 3`,
  `note edit 3 "..."`, `note rm 3` — it survives an edit, and it names exactly
  one note in the workplace. Deleting a note does not reissue its
  number: a number the user read yesterday must not mean something else today.
- **100,000 characters, 500 live notes per workplace** (100 until note #921,
  when rooms had merged into one set per workplace). Anything longer than
  the first wants to be a knowledge page, and the refusal says so. Archived
  notes do not count toward the live ceiling, and the archive has no item
  ceiling. (It was 4000 while notes were plain text, then 8000 as HTML; note
  #676 raised it to fit a whole document — an agent asked for a game plan had
  handed over an 11 KB file, and "save this plan in notes" then had nowhere
  to go. Both note routes get a 1 MB body parser in `index.ts` to match,
  because the default 100 KB would refuse such a note before the route ran.)
- **The title is derived, never stored**: the note's first heading if it has
  one, else its first block, as plain words. One definition in
  `quickNoteTitle`, so the row on home, the note's own screen and the line the
  CLI prints can never disagree.
- **Refuses rather than strips**, like knowledge pages: a note carrying
  `<script>` or a `style` attribute comes back with the rule that refused it,
  named. The Mini App rebuilds every node from its own allowlist regardless —
  a defence that rests on agents following a convention is not one.

## Who can touch one

Notes belong to the **account**, exactly as repos and knowledge do. Every agent
the user owns can read, rewrite and archive any of them, and every note records
both who created it and who last changed it — the Workspace shows the latter,
because that is who to ask about what it says. The user is one of the authors
that field can name (`QUICK_NOTE_AUTHOR_USER`), and a note of theirs reads
"Written by you" rather than naming anybody to go and ask.

### A workplace shares the notes, not the desk (2026-09-22, note #637)

> "If user is not author of a note, user should not be able to move or archive
> note."

Every member of a workplace reads every note in it. What they may DO
with one is decided by the human behind it: the member who wrote it, or the
member whose agent keeps it for them (`updatedByUserId`, falling back to the
writing agent's owner and then to the storage namespace — `noteHumanOwner` in
`routes/workspace.ts`). `describeQuickNote` sends that answer to the screen as
**`yours`**, and the same rule gates the routes, so the buttons a reader is
offered and the requests the server will honour cannot drift apart.

| Verb | Whose note |
| --- | --- |
| Edit the words | the reader's own hand only (agents' words go through the agent) |
| Archive, Restore, Delete for good | the note's own side — the member, or their agents' notes |
| Comment, attach or take off a file, hand it to an agent | any member of the workplace |

The split is the one the margin already ran on: everything that ADDS to a note
leaves it standing where its author put it, and everything that takes it off
their desk does not. The Workspace draws no buttons at all on a teammate's
note — one sentence saying whose it is, over the margin, which is what the
reader has instead. The 403s behind them are a backstop for a pasted address
or a stale page.

The agent CLI is deliberately **not** gated the same way yet: `agentbuilt note
archive` still reaches any note in the workplace. Closing that is a change to the
identity block (and a version bump with it), and it is the owner's call
whether an agent may tidy a teammate's note at its own user's request.

The consequence to state plainly in the agent's own docs: **never put a secret
in a note.** It is readable by every agent on the account and displayed in the
Workspace.

## The Workspace shows them, and writes new ones

Notes sit on home **directly under the agents** (moved there 2026-08-18, note
#21). They spent their first weeks under Knowledge and were wrong there twice
over: a note is not a store you visit when you need something out of it, the way
repositories, pages and keys are — it is the one section on that screen the user
WRITES INTO, which makes it a way in like the fleet above it, and the only one
that can change without anybody being asked. Four cards down is the wrong place
for both of those facts.

A row is the title, a glimpse of the rest, its number and when it last changed;
tapping one renders the note through `renderKnowledgeHtml`, the same allowlist
renderer knowledge pages go through, in the same `.kpage` typography. A note and
a page therefore look like one product, which is the whole reason a note is HTML
at all.

**The card is a glimpse; the screen is the list.** Home draws the most recent
`NOTES_SHOWN` (6) and then one row — "All 9 notes" — onto `screenNotes`, which
holds every one of them. Every note on home made this the tallest section on the
page by some distance, taller than the fleet, the repositories and the knowledge
above it put together, and it is the section a reader scrolls past most often.
The rules that fall out of that, all of them the ones `secretsDoorRow` already
follows:

- The door appears only past six. A row saying "all 6 notes" over the six of
  them is a tap that gives nothing back.
- It says **all** N, not "3 more": the screen behind it is the whole list, the
  six above it included.
- `noteRow(note, from)` builds both surfaces, so a row never says one thing on
  home and another on the list, and `from` is what Back and a delete owe the
  reader afterwards (`noteOrigin`).
- A list that shrinks back under six sends the reader home
  (`refreshOpenNotesScreen`): its door on home is gone, and home now shows every
  note they came to see, so staying would strand them on an unreachable screen.

The screen drops the note's opening heading when its own title already says
exactly that — printed twice it reads as a rendering fault.

**The user can write one** (decided 2026-08-16, the day after notes shipped
agent-only): "Write a note" at the foot of the section opens one box, and
`POST /api/notes` takes what they typed. So the section stands on an empty
account too, unlike Knowledge and Sites — a way in that appears only once
somebody else has been in is no way in. It goes only when the backend has no
note storage at all, which is still `notes: null` rather than `[]`.

- **Plain text in, HTML out.** The route accepts `{ text }` and nothing else,
  and converts with `textToSafeHtml`. A person typing into a box is not writing
  a fragment: they should not have to know what a `<ul>` is, and there is then
  no markup of theirs to smuggle anything through. The typed text is capped at
  `QUICK_NOTE_MAX_TEXT_LENGTH` (50,000) — lower than the HTML limit because it is
  measured on different words, and because the refusal has to be stated in
  units the person typed in.
- **Written by them, and marked as such.** `createdByAgentId` /
  `updatedByAgentId` carry the `QUICK_NOTE_AUTHOR_USER` sentinel — one field,
  not a nullable second one, and it cannot collide with a UUID agent id. Every
  surface reads it back off the summary as `byUser`: the Workspace says
  "Written by you", and `agentbuilt note list` marks it for the agents.

**They can rewrite their OWN note, and delete ANY of them.** The asymmetry is
the design, not an unfinished half of it:

- `PUT /api/notes/:number` refuses a note whose `updatedByAgentId` is not the
  user — with the agent's name in the refusal, and the note's screen says the
  same thing under a Delete-only card rather than just hiding a button. Words an
  agent wrote are words it is still working from: rewritten behind its back, it
  carries on from its own version and contradicts the note on its next turn.
  Asking the agent is also what makes the change reach whatever it is *doing*
  about the note. "Whose note" is read off `updatedByAgentId` — the same field
  "Written by you" comes from — so a note the user started and an agent has
  since rewritten is the agent's now, because the words standing in it are.
- `DELETE /api/notes/:number` takes any of them. A note that is gone says
  nothing, so there is no version left to disagree about; and a store the owner
  can fill but not empty only ever grows. The agents are told the other half in
  their identity block: a note of yours that has gone was deleted on purpose —
  do not write it again.

An edit is offered the text the user typed, never the markup it was stored as:
`GET /api/notes/:number` carries a `text` field for the user's own notes,
`quickNoteEditableText` being the exact inverse of the `textToSafeHtml` that
wrote them. It is absent on an agent's note, which no text box could hold
anyway — a second reason that edit is not on offer.

The list carries titles and previews only; the body arrives when a note is
opened. Home already pays for agents, repos, secrets, proposals and checks —
a hundred note bodies to answer "which one?" is the one way a store this small
could still get expensive.

## Moving a note between rooms (2026-08-29, note #111)

> History. There is no Move note since rooms were removed (note #843): stage
> 1 moved every room's notes onto the workplace's own namespace with this same
> move, which is why `previousLocations` still matters below.

A note's own screen offers **Move note** once the workplace has another
room — on the reader's own notes. The ordinary rooms screen becomes a
destination picker, exactly as it does for an agent, site or repository, and
follows the note into the room the person chose. Moving destroys no words, but
which room a request stands in is part of what its author is saying with it, so
since note #637 it is theirs to change and nobody else's.

The room is the note's storage namespace, not a decorative `roomId`. Moving
therefore changes `userId` on the same document and preserves its id, HTML,
authors, timestamps, comments, files, archive state and structured work state.
Note numbers are workplace-wide (note #741), so a move keeps the number unless
the destination still holds a legacy per-room duplicate of it; then the
workplace series assigns the next one and the confirmation says the new
address. Returning to a room reclaims the note's earlier number when it is
still free.

`previousLocations` records each earlier `{ userId, number }` address. This is
load-bearing in two places:

- a PR made from the note before it moved stays linked as PR / Merged / Live,
  because the proposal records the note's original namespace separately from
  both the repository's physical home and the proposal's decision-queue room;
- attachment bytes may still sit under an earlier room prefix in the org's one
  bucket, so deleting the note for good sweeps every prefix it has occupied.

An active claim refuses the move. An agent working from `note #12` in one room
cannot have that address disappear mid-turn and still make an honest proposal;
the user moves it after the work finishes or the two-hour lease expires. A
live note is checked against the destination's live-note ceiling before it
moves; an archived note moves without an item-limit check.

## The archive (2026-08-19, note #23)

> "Notes should not be delete. It should be archived. And only from archive a
> note can be deleted." — Owner, note #23

Removing a note is now **two decisions, not one**. Archiving takes it out of
every list and leaves it whole — same number, same words, same comments, same
files — and restoring is one call. Deleting only reaches a note that is
already archived, and there is nothing behind that.

The state is `archivedAt` (plus `archivedByAgentId`) **on the note itself**: no
second table, no column, no migration. That is the difference from the repo
trash, which moves bytes into a directory on the git host and runs a 14-day
clock over them — a note has no bytes anywhere else to move, so the cheap
version is the whole version. There is **no clock here**: an archived note
stays until somebody deletes it on purpose, which is what the rule asks for.

An archived note is **read-only** — no edit, no comment, no file on or off,
from either surface. Not to protect it: a note being kept up to date inside the
archive is a live note in the wrong place, and "bring it back first" is a
better answer than a write nobody will read. Reads are untouched; downloading a
file off an archived note is exactly what an archive is for.

### The live ceiling

`QUICK_NOTES_MAX_PER_USER` counts **live notes only**. The archive has no item
ceiling: tidying the desk must always make room without forcing a permanent
delete. Restoring is checked against the live ceiling on the way back, so an
unbounded archive still cannot be used to keep more than five hundred working
notes in a workplace.

### `note rm` archives, and says so

The agent CLI's `DELETE /notes/:number` **archives** and returns a message
saying it archived. `?forever=1` is the destructive half, and it 400s on a note
that has not been archived.

That split is about clients, not taste. Every machine already has a CLI, and
those agents cannot know the rule changed until `TELEGRAM_AGENT_IDENTITY_VERSION`
moves under them — refusing their `note rm` would break it for exactly the
agents with no way to find out why, while archiving lands the safe half of the
new behaviour on an old client for free. Two `note rm`s do NOT delete: the gate
is on the note's STATE, not on how many times the word was typed.

The Workspace's own DELETE **refuses** on a live note instead, because this
page ships with the backend serving it — there is no old client to be kind to,
and an honest 400 beats a silent substitution.

### Numbering

One series per workplace since note #741 (`services/workplace-numbers.ts`).
Each room used to count its own notes from #1, so Platform and Growth both
held a "#205"; a link carried the room beside the number, and a link with the
wrong room opened the wrong note or none — the failure Adam reported. Now the
route that creates a note hands the store a `NumberSeries`: the key
`org:<orgId>` and every namespace of the workplace. The store keeps one
counter row per series (`quick_note_numbers`, the same table as the old
per-room rows), seeded the first time it is asked for from the highest number
any of those namespaces holds **and** the highest any of their room counters
ever issued, so nothing already in use anywhere is ever issued again. Existing
numbers were kept — renumbering would have broken every link and commit
message already written. Until rooms were removed that meant a legacy number
could name two notes, and every reader went through `pickNumbered`: the room
the caller stood in (or the link named) won when it held the number. Stage 1
of note #843 moved every room's notes onto the workplace's one namespace; a
note whose number was already taken there took the series' next number, so a
number names one note now. A moved note's earlier addresses are searched last,
so a link from before the move (an old `&room=` link included) still arrives.
A personal account is its own series.

`highestNumber` must be fed **every** note, archived included. `listByUser`
is live-only, and a counter seeded from that alone hands an archived note's
number to the next note written — while the archived one is still sitting there
holding it, one restore from two notes claiming "#2".

### What the agents are told

The identity block used to say a note missing from the list had been **deleted**
on purpose — the one thing stopping agents from writing it back. "Gone from the
list" now means two things, so that paragraph ships **with** this feature,
restated over both: put away or deleted, either way deliberate, and
`note list --archived` says which. A test in `agent-service.test.ts`
pins it, because shipping the archive without it is how agents resurrect what
their user just put away.

## Searching them (2026-09-01, note #242)

Past a few dozen notes the two lists stop answering the question a reader
brings to them — "where is the one about the wifi?" — so the notes screen and
the archive each carry a search field once the account holds
`NOTE_SEARCH_AT` (6) notes, live and put away counted together. Under that,
every note is already on screen and eyes beat a keyboard.

**One search spans both lists.** A person searching does not remember whether
the note they want is still live, and a search that quietly skipped the
archive would answer "no such note" about a note that is right there. Results
are the same rows every list draws; the ones from the archive wear an
`Archived` badge, on this screen only — in the archive itself every row is
archived and the badge would be wallpaper.

**Indexed, not scanned.** The SQLite store keeps an FTS5 table
(`quick_note_search`) level with `quick_notes` on every write, repairs it at
boot (which is also how notes written before the index existed became
findable), and uses it to narrow. What counts as a match and what order
results come back in live in `types/quick-note-search.ts`, shared with the
in-memory store, so the two implementations cannot drift — the contract tests
in `quick-note-search.test.ts` run against both.

The words in the index are the words a reader saw: the note's text, its
number, the remarks in its margin and the names of its files — never markup.
Every typed term must open a word somewhere in the note ("keyb" finds
"keyboard"); punctuation is dropped, case and diacritics fold. The order is
one sentence: the note named by number, then title matches, then the rest —
live before archived, newest first. The row's second line becomes the part of
the note the query is actually in, because a result showing the note's opening
words cannot say why it is on screen.

`GET /api/notes/search?q=` is the whole of the API, registered above
`/:number` like the archive. A blank query is `{ notes: [] }` — the page
already has the list in front of the reader.

## Comments: the margin

Decided 2026-08-17 (Owner's note #9). A note carries **remarks about it**
that leave the note's own words alone.

It is the same rule as the asymmetry above, pointing the other way. The user
does not rewrite an agent's note; an agent must not rewrite the user's, because
an edit puts its words in their mouth. So what does an agent do when the wifi
code in the user's own jotting is out of date? It says so **under** the note,
signed, leaving what is written above exactly as it was — and whichever agent
opens that note next reads it.

**Two-way since note #64** (2026-08-27; agents-only for the first ten days).
The person writes in the same margin from the note's own screen — plain text
into a collapsed composer, the markup made server-side exactly as the note box
does it — and their remark signs with their name and face, stamped
`COMMENT_AUTHOR_USER` + their user id the way their own notes already are. A
remark **starts nobody**: it reaches an agent when that agent next reads the
margin. Note #179 (2026-08-31) had let an `@Name` picked from the composer
start that agent; note #518 removed it — composer, route, and the
proposal-author start of note #239 with it — so the body is `{ text }` and
nothing in the words or the document picks a recipient. Asking an agent to look
at a comment is a message to that agent, in its chat, where it arrives with the
rest of what that agent is being asked. The archive stays read-only, composer
included.

The same margin now hangs off change proposals, knowledge proposals and
knowledge pages (note #66) — one `MarginComment` shape in `types/comment.ts`,
which notes grew first. A proposal's margin closes when the proposal is
decided, the same moment its files stop; a page's margin lives beside the page
(`knowledge_page_comments`) and dies with it.

- **Semantic HTML**, through the same allowlist as the note it hangs off. A
  plain sentence remains valid HTML, while paragraphs, emphasis and code read
  typeset instead of exposing their tags. New comments are refused when they
  carry unsafe markup, and the Workspace still rebuilds every node from its
  own allowlist so an older unsafe value cannot become live DOM. The latest
  comment on a notes-list row keeps that safe inline formatting too, compacted
  to its first complete sentence; media is omitted and links become inert in
  the tappable row, then render in full after the note opens.
- **On the note document**, as `comments[]` — a comment has no life apart from
  the note, is deleted with it, and the note is already fetched whole. The
  append is `addComment`, a method of its own, because six agents share one
  account: two plain read-modify-writes land one array over the other and lose a
  remark with nothing to show it arrived. The SQLite one does it in a
  transaction.
- **`updatedAt` does not move.** The note's own words did not change, and that
  field is what every surface prints as "updated …" beside who wrote it.
- **1000 characters, 50 per note.** Anything longer belongs in the note.
- **A comment pushes nothing, on any surface** (note #518). It starts no turn
  and sends no message, so `agentbuilt note list` marks a note that carries
  comments and `note show` prints them — that is how an agent finds one. On
  the Workspace's home the row wears an `N comments` badge for the same
  reason. A change or knowledge PROPOSAL is no different now: the author start
  of note #239 went out with the `@Name` start of note #179.
- `note show` writes the note's HTML to **stdout** and the comments to
  **stderr**: an agent that pipes `note show` into a file is holding the note it
  is about to edit, and the margin must not end up inside it.

The agent CLI writes through `POST /api/agent-cli/notes/:number/comments`,
taking `{ text }`. The Workspace writes notes, change proposals, knowledge
proposals and knowledge pages through their four `/workspace/api/.../comments`
routes, taking `{ text }` as well — the same body on both sides, and both
answer with the thread alone. Detail GETs still carry the thread's owning
namespace (a room's until note #843, the workplace's now), which is what scopes
the write. The home row still wears an `N comments` badge
so the note says it has been talked about.

There is no editing or deleting a comment, on purpose: a remark is a thing
somebody said, and the note it hangs off can be deleted whole when it has served
its purpose.

### Atomic work ownership (2026-08-28, note #99, identity v80)

The free-form start comment above failed in exactly the way its rejected claim
framing predicted. Theo read note #87 while it was unclaimed; Ben recorded that
he had started minutes later; Theo continued from the stale snapshot and both
agents implemented the same request. Isolated CI correctly said both branches
worked and had no way to say they meant the same thing.

Ownership is structured state now. `agentbuilt note start <n>` is one atomic
operation that rereads the current body, margin and files while taking an
exclusive two-hour lease. A different active claimant wins whole. The same
agent can run it again to renew, which also refreshes a fingerprint of exactly
what it just reread. A dead turn cannot lock a request forever, and a living
turn cannot silently proceed from an older snapshot.

Every live-note surface shows one of these states:

- **Unclaimed**
- **Handed to Ben**, when the user gave the note to an agent from the Workspace
  and nobody has claimed it yet (notes #234/#258)
- **Working by Ben** (with the lease expiry)
- **PR #307** (including a conflict while it is still the useful pointer)
- **Merged**
- **Live**, once a deployment status proves the merged change ran

Comments keep the history people should read — progress, an outcome, why work
stopped — but they no longer arbitrate ownership. Work that ends without a
proposal uses `note release`; a linked proposal advances the structured state.

The second fence is the proposal. `pr create --note <n>` (repeatable for a
change implementing several notes) links the record, and the backend refuses a
second **open or merged** implementation for any linked number. The explicit
flag is the whole link: “note #N” in a title, body or commit subject is prose,
never a claim. (An inference regex bridged older CLIs until 2026-09-01; it made
every mention a link — a body whose *example* said “note #12” was refused over
an archived note — and was removed in favour of teaching the flag in the
machine docs.) Immediately before creating one, the client fetches current main,
rereads the note, lists open and merged proposals, searches recent main commits
for the number, and warns when main changed a file the branch also changed. The
warning stops proposal creation so the agent can rebase and rerun its checks;
the backend then rechecks that the caller still owns an unexpired lease and that
its fingerprint still matches. If a comment, edit or file arrived after
`note start`, the proposal is refused until the agent starts again and confirms
its implementation still answers the current request.

The old v77 decision was reasonable for notes used only as jottings; note #99
records why it was no longer sufficient once notes became a shared work queue.
The status does not turn every note into a ticket: it appears as Unclaimed until
an agent explicitly starts work from it, and expires on its own.

## Files on a note (2026-08-17)

A note can carry up to **5 files, 100 MB each** (10 MB until note #784; past one 8 MB part a file goes up in parts, see `services/note-file-uploads.ts`) — the menu photo beside the note
about the menu. The bytes live in media storage (the same S3 store chat
attachments use) under `users/<uid>/notes/<noteId>/…`; the note's row carries
only the records, so lists stay cheap, and deleting the note clears its whole
prefix. On a backend with no media store configured, the routes 503 and the
Workspace shows no Files card at all — notes are words-only, as they were.

**Attaching is not editing.** Any agent and the user may attach to (or take a
file off) ANY note, including one whose words they may not rewrite: the edit
gate protects an agent's words (rewritten behind its back, it contradicts the
note), and a file added beside them moves no words. `addedByAgentId` follows
the author fields' convention, `QUICK_NOTE_AUTHOR_USER` included — the
Workspace row says "you attached this".

This is also **how a file crosses between the user and an agent, in both
directions, without a chat upload**: the user attaches in the Workspace and the
agent runs `note fetch <n> <name>`; the agent runs `note attach <n> <file>` and
the user taps the row. File names are strict (`[A-Za-z0-9._-]`, ≤120) because
they are storage path segments and the CLI's handles; the Workspace tames a
phone's name before sending (`safeFileName`), agents are told to rename.
Downloads are signed URLs minted at tap/fetch time, 15-minute expiry.

### Attaching while the note is still being written (2026-08-18)

A note being written has no number, so there is nowhere to send bytes yet. The
composer therefore **holds the picked files in the page** (`noteDraftFiles`)
and uploads them only once the create has come back with a number — one at a
time, so a failure can name the file that failed. Those rows say "goes up when
you save" and carry no open-this tap, because nothing has been stored.

**A picked photo is shown as the photo**, before anything is uploaded — the
same `notephoto` block the note screen draws, filled from an object URL off the
phone's own bytes, so there is no mint and no round trip. It is a `div` and not
a button: there is nothing to open until it has been saved. Those URLs are held
in `noteDraftPreviews` (one per file, not one per repaint) and revoked when the
file is taken off or the save spends the draft — a live object URL pins the
file's bytes in memory.

Two consequences worth keeping:

- **A file that fails does not fail the note.** The create already succeeded;
  unwinding it would send the user back to retype words that are safe. The
  save lands as normal and the banner names what did not attach.
- **The draft's files survive backing out**, exactly as the draft's words do —
  they are one unsaved note. Only a successful save clears them.

The composer offers this while **writing** a note, not while rewriting one: an
edit is about the words, and the note's own screen already keeps its files a
tap away, where they can be seen next to what is already attached. Whether the
card appears at all comes from `noteFiles` on `/api/state` — the capability an
open note answers for itself with its `attachments` list, stated once for the
composer, which has no note to ask.

### Saying that an upload is happening (2026-08-18)

A phone's photo is megabytes over a mobile connection, and before this the
screen said nothing at all for those seconds — which reads as a tap that
missed, and gets tapped again. On the note screen the file gets **a row where
it will land**, with a spinner where its type icon goes and "sending…" where
its size line will be; the attach button goes quiet until it settles, one
upload at a time, so the row answering "is this working?" is never replaced by
a row about a different file. In the composer the same job falls to the save
button, which counts: "Attaching 2 of 3…".

## Handing a note to an agent (2026-08-28, notes #87/#105/#110)

A note is usually a thing somebody has to go and DO, and until this the only
way to say so was to leave the Workspace, open an agent's chat, and type "read
note 87" by hand. Under the words of every live note there is now a sideways
row of **agent cards**: the workplace's agents that are ready and not
mid-turn (the agents of the room being viewed, until rooms were removed —
note #843). Each card shows the face, name, harness (Claude Code or
Codex), effective model, and effective effort, so the choice says what will run
before the tap.
Tapping one opens a message **already written** — `pick up the note #87` — with a
Send.

The rules the row obeys, and why:

- **Idle only.** The platform refuses a handoff to a working agent (there is no
  queue, by design), so a face that could only produce a refusal is not drawn.
  "Idle" here is `status === 'ready' && !working`, which is the page's reading
  of the same state `telegramAgentPeerState` computes on the backend.
- **The room wall (note #85) is gone.** A note was read out of the room the
  page was viewing, so the row offered only that room's agents. Since rooms
  were removed (note #843) every agent of the workplace reads every note, and
  the row offers the whole fleet.
- **Rings, not just faces.** Each face wears its context fill, the same drawing
  the fleet list uses — which is what makes the prefill legible *before* the
  tap.
- **Nothing, or a sentence — never an empty row.** A workplace with no agents
  gets the plate that makes its first one; a fleet whose agents are all busy
  keeps the card and says so,
  because that is a fact about right now rather than a missing feature. An
  archived note draws none either.
- **The poll repaints it.** `load()` re-runs `renderNoteHands` for the open
  note, so a face that picks work up drops out under a reader who has not moved.

### The prefill, and the reset

`noteHandoffText` leads with **"reset chat and"** whenever the agent carries a
measured context fill. Picking a note up is a NEW job: an agent that starts it
holding a conversation about something else spends part of its window on the
old thing and part of its attention re-deciding what it was doing, and a fresh
chat costs one message. An agent with no context gets the plain form — it is
already clean, and asking it to reset would ask it to throw away nothing.

It is a PREFILL, not a decision. The screen it lands on is an editable box, so
the reset is a choice the reader can see and delete rather than something the
app did quietly on their behalf.

### What Send actually does

`POST /workspace/api/agents/:id/message` with `{ message }`. The route checks the
agent is the caller's own (`activeAgent`) and caps the message at
`AGENT_USER_MESSAGE_MAX_LENGTH` (4000, the same number `agentbuilt agent
message` takes and the same the box stops at); everything else is
`messageAgentFromUser` on the agent service.

That method and `messagePeerAgentFromCli` share one core,
`startIdleTelegramAgentTurn` — same idle-only contract, same atomic
`startAgent` as the final check, same "nothing was queued" on every refusal.
What differs is two things, both deliberate:

- **The voice of the refusals** (`audience: 'agent' | 'user'`). A person told
  "not available for agent-to-agent work" has been named a feature they never
  used; they get "Ivy is working right now. Nothing was sent — try another
  agent, or wait for it to finish." A busy agent is **409**, not 400: the row
  was right when it was drawn, and the recovery is a different agent.
- **The framing** (`buildTelegramAgentWorkspaceMessagePrompt`). A peer's message
  is wrapped in JSON because there is an authority boundary to draw; the user's
  is not, because there is none — this is the highest authority the agent has,
  and wrapping it would teach the model to treat its own user as a payload. The
  one thing the framing must say is that the words are **not in the chat
  above**, so the agent opens its reply with what it was handed rather than
  answering a question no one in that conversation can see. The row and the
  recap record it in the **owner's** voice, not the platform's.

## Where it lives

| piece | file |
|---|---|
| what any HTML here may contain | `backend/src/types/safe-html.ts` (shared with knowledge) |
| type, limits, title/preview | `backend/src/types/quick-note.ts` |
| storage interface + in-memory | `backend/src/services/quick-note-storage.ts` |
| SQLite storage | `backend/src/services/sqlite/sqlite-quick-note-storage.ts` |
| agent routes (CRUD) | `backend/src/routes/agent-cli.ts` (`/notes`, `/notes/:n/archive`) |
| workspace routes | `backend/src/routes/workspace.ts` (`GET`/`POST`/`PUT`/`DELETE` `/api/notes`, `/api/notes/archive`) |
| handing a note over | `backend/src/routes/workspace.ts` (`POST /api/agents/:id/message`) → `agent-service.ts` (`messageAgentFromUser`, `startIdleTelegramAgentTurn`, `buildTelegramAgentWorkspaceMessagePrompt`) |
| workspace UI | `backend/workspace-ui/src/screens/notes/` (the list, the archive, one note, its comments, hands and composer) |
| what agents are told | `backend/src/services/agent-service.ts` (identity block; bump `TELEGRAM_AGENT_IDENTITY_VERSION` on any edit) |
| CLI | `cli/agentbuilt/agentbuilt.mjs` (`note`) |

One table, `quick_notes`, keyed by `note_id` with `(user_id, number)` unique —
the same shape `knowledge_proposals` uses, and the index is what stops two
concurrent `note add` calls minting the same `#3`.

Deletes leave **no tombstone**, from either surface — and none is needed, since
the archive above IS the recoverable step and a row only reaches `delete` after
going through it. The repo trash does the same job with a host directory and a
clock; `archivedAt` does it with a field.

### The plain-text rows

Notes shipped as plain text on 2026-08-16 and became HTML the same day, with
real notes already written. Those rows keep a `text` field instead of `html`,
and `normalizeQuickNote` converts them **on read** — escaped, one `<p>` per
block. No migration was run: the conversion is pure, it survives a restore
from a backup taken before the change, and the first edit rewrites the row in
the new shape on its own. The route also still accepts `{ text }` from a CLI
1.8.0 that has not been replaced yet, converting it the same way — refusing it
would break `note add` for exactly the agents that cannot yet know why.

## Notes an agent keeps for itself

Unchanged and deliberately separate: `~/SCRATCHPAD.md` on the agent's own machine is
its private working notebook, shared with nobody and reviewed by nobody. The
three-way choice, as taught in the identity block:

- **quick note** — a fact that would otherwise die with the turn
- **knowledge page** — something the next agent must not get wrong
- **`~/SCRATCHPAD.md`** — what only this agent needs
